import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';
import { getEffectiveHospitalId } from '../common/utils/scope';
import { istDayRange } from '../common/utils/dateRange';

interface CreateInvestigationDTO {
  patientId: string;
  doctorId: string;
  hospitalId: string;
  encounterId?: string;
  testName: string;
  testType: string;
  instructions?: string;
  priority?: string;
}

class InvestigationService {
  async createInvestigation(data: CreateInvestigationDTO, currentUser?: any) {
    // Multi-tenant guard: ensure the patient and doctor belong to the
    // caller's hospital. Without this check, a doctor at hospital A could
    // attach lab orders to hospital B's patient by passing their UUID.
    const [patient, doctor] = await Promise.all([
      prisma.patient.findUnique({
        where: { id: data.patientId },
        select: { id: true, hospitalId: true },
      }),
      prisma.doctor.findUnique({
        where: { id: data.doctorId },
        select: { id: true, hospitalId: true },
      }),
    ]);
    if (!patient) throw new AppError('Patient not found', 404);
    if (!doctor) throw new AppError('Doctor not found', 404);

    if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      if (!currentUser.hospitalId) {
        throw new AppError('Your account is not linked to a hospital', 403);
      }
      if (patient.hospitalId && patient.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Patient does not belong to your hospital', 403);
      }
      if (doctor.hospitalId && doctor.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Doctor does not belong to your hospital', 403);
      }
      if (data.hospitalId && data.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Cannot create investigation in another hospital', 403);
      }
    }
    if (patient.hospitalId && doctor.hospitalId && patient.hospitalId !== doctor.hospitalId) {
      throw new AppError('Patient and doctor must belong to the same hospital', 400);
    }

    const investigation = await prisma.investigation.create({
      data: {
        patientId: data.patientId,
        doctorId: data.doctorId,
        hospitalId: data.hospitalId,
        encounterId: data.encounterId,
        testName: data.testName,
        testType: data.testType,
        instructions: data.instructions,
        priority: data.priority || 'ROUTINE',
        status: 'ORDERED',
      },
      include: {
        patient: {
          select: {
            id: true,
            uhid: true,
            firstName: true,
            lastName: true,
          },
        },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            specialization: true,
          },
        },
      },
    });

    return investigation;
  }

  async getAllInvestigations(filters: {
    hospitalId?: string;
    patientId?: string;
    doctorId?: string;
    status?: string;
    testType?: string;
    page?: number;
    limit?: number;
  }, currentUser?: any) {
    const { hospitalId, patientId, doctorId, status, testType, page = 1, limit = 10 } = filters;

    // Resolve effective hospital: non-SUPER_ADMIN → JWT; SUPER_ADMIN → the
    // global "viewing as" scope, or explicit ?hospitalId=, otherwise platform-wide.
    const effectiveHospitalId = getEffectiveHospitalId(currentUser) || hospitalId;

    const where: any = {};
    if (effectiveHospitalId) where.hospitalId = effectiveHospitalId;
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;
    if (status) where.status = status;
    if (testType) where.testType = testType;

    const [investigations, total] = await Promise.all([
      prisma.investigation.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              uhid: true,
              firstName: true,
              lastName: true,
            },
          },
          doctor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { orderedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.investigation.count({ where }),
    ]);

    return {
      investigations,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getInvestigationById(id: string, currentUser?: any) {
    const investigation = await prisma.investigation.findUnique({
      where: { id },
      include: {
        patient: {
          include: {
            abhaRecord: true,
          },
        },
        doctor: {
          include: {
            department: true,
          },
        },
        hospital: true,
      },
    });

    if (!investigation) {
      throw new AppError('Investigation not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && investigation.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Investigation belongs to different hospital', 403);
    }

    return investigation;
  }

  async updateInvestigationStatus(id: string, status: string, data?: {
    results?: any;
    reportUrl?: string;
    notes?: string;
    labTechnicianId?: string;
    amount?: number;
  }, currentUser?: any) {
    const investigation = await prisma.investigation.findUnique({
      where: { id },
    });

    if (!investigation) {
      throw new AppError('Investigation not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && investigation.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Investigation belongs to different hospital', 403);
    }

    const updateData: any = { status };

    if (status === 'SAMPLE_COLLECTED') {
      updateData.sampleCollectedAt = new Date();
    } else if (status === 'IN_PROGRESS') {
      updateData.resultEnteredAt = new Date();
    } else if (status === 'COMPLETED') {
      updateData.reportedAt = new Date();
    }

    if (data?.results)           updateData.results           = data.results;
    if (data?.reportUrl)         updateData.reportUrl         = data.reportUrl;
    if (data?.notes)             updateData.notes             = data.notes;
    if (data?.labTechnicianId)   updateData.labTechnicianId   = data.labTechnicianId;
    if (data?.amount !== undefined) {
      if (data.amount < 0) throw new AppError('Investigation amount must be non-negative', 400);
      if (data.amount > 0) updateData.amount = data.amount;
    }

    const updated = await prisma.investigation.update({
      where: { id },
      data: updateData,
      include: { patient: true, doctor: true },
    });

    // When completed — update Encounter billing + advance encounter status if all tests done
    if (status === 'COMPLETED') {
      const encId = investigation.encounterId;

      // Sync the originating LabOrder row so EHR timeline shows accurate status
      if (encId) {
        await prisma.labOrder.updateMany({
          where: { encounterId: encId, testName: investigation.testName },
          data:  { status: 'COMPLETED' },
        });
      }

      if (encId) {
          const enc = await prisma.encounter.findUnique({
            where: { id: encId },
            select: {
              labCharges: true, consultationFee: true, medicineCharges: true,
              scanCharges: true, status: true, medicinesDispensed: true,
            },
          });
        if (enc) {
          const invAmount       = data?.amount ?? 0;
          const isRadiology     = investigation.testType === 'RADIOLOGY';
          const curLabCharges   = Number(enc.labCharges      ?? 0);
          const curScanCharges  = Number((enc as any).scanCharges ?? 0);
          const newLabCharges   = isRadiology ? curLabCharges : curLabCharges + invAmount;
          const newScanCharges  = isRadiology ? curScanCharges + invAmount : curScanCharges;
          const consultationFee = Number(enc.consultationFee ?? 0);
          const medicineCharges = Number(enc.medicineCharges ?? 0);

          // Check if all investigations for this encounter are now COMPLETED
          const pendingCount = await prisma.investigation.count({
            where: {
              encounterId: encId,
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
              id: { not: id },
            },
          });
          const allLabsDone = pendingCount === 0;

          // Determine next status if all labs are done and encounter is in a pending state
          let nextStatus: string | undefined;
          if (allLabsDone && ['LAB_PENDING', 'IN_PROGRESS'].includes(enc.status as string)) {
            const pendingRx = await prisma.prescription.count({
              where: { encounterId: encId, status: { not: 'DISPENSED' } },
            });
            nextStatus = pendingRx > 0 ? 'PHARMACY_PENDING' : 'BILLING_PENDING';
          }

          await prisma.encounter.update({
            where: { id: encId },
            data: {
              ...(invAmount > 0
                ? {
                    labCharges:  newLabCharges,
                    scanCharges: newScanCharges,
                    totalAmount: consultationFee + newLabCharges + newScanCharges + medicineCharges,
                  }
                : {}),
              labTestsCompleted: allLabsDone,
              ...(nextStatus ? { status: nextStatus as any } : {}),
            },
          });
        }
      }
    }

    return updated;
  }

  async getInvestigationStats(hospitalId?: string, doctorId?: string, currentUser?: any) {
    const effectiveHospitalId = getEffectiveHospitalId(currentUser) || hospitalId;

    const where: any = {};
    if (effectiveHospitalId) where.hospitalId = effectiveHospitalId;
    if (doctorId) where.doctorId = doctorId;

    const [total, ordered, inProgress, completed, today] = await Promise.all([
      prisma.investigation.count({ where }),
      prisma.investigation.count({
        where: { ...where, status: 'ORDERED' },
      }),
      prisma.investigation.count({
        where: { ...where, status: 'IN_PROGRESS' },
      }),
      prisma.investigation.count({
        where: { ...where, status: 'COMPLETED' },
      }),
      prisma.investigation.count({
        where: {
          ...where,
          orderedAt: {
            gte: istDayRange(0).start,
          },
        },
      }),
    ]);

    return {
      total,
      ordered,
      inProgress,
      completed,
      today,
    };
  }
}

export default new InvestigationService();
