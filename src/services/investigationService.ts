import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';

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
  async createInvestigation(data: CreateInvestigationDTO) {
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
  }) {
    const { hospitalId, patientId, doctorId, status, testType, page = 1, limit = 10 } = filters;

    const where: any = {};
    if (hospitalId) where.hospitalId = hospitalId;
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
    if (data?.amount !== undefined && data.amount > 0) updateData.amount = data.amount;

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
            status: true, medicinesDispensed: true,
          },
        });
        if (enc) {
          const newLabCharges   = Number(enc.labCharges    ?? 0) + (data?.amount ?? 0);
          const consultationFee = Number(enc.consultationFee ?? 0);
          const medicineCharges = Number(enc.medicineCharges  ?? 0);

          // Check if all investigations for this encounter are now COMPLETED
          const pendingCount = await prisma.investigation.count({
            where: {
              encounterId: encId,
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
              id: { not: id }, // exclude current one (already updated)
            },
          });
          const allLabsDone = pendingCount === 0;

          // Determine next status only if encounter is still LAB_PENDING
          let nextStatus: string | undefined;
          if (allLabsDone && enc.status === 'LAB_PENDING') {
            // Check if there are pending prescriptions (not yet dispensed)
            const pendingRx = await prisma.prescription.count({
              where: { encounterId: encId, status: { not: 'DISPENSED' } },
            });
            nextStatus = pendingRx > 0 ? 'PHARMACY_PENDING' : 'BILLING_PENDING';
          }

          await prisma.encounter.update({
            where: { id: encId },
            data: {
              ...(data?.amount && data.amount > 0
                ? {
                    labCharges:  newLabCharges,
                    totalAmount: consultationFee + newLabCharges + medicineCharges,
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

  async getInvestigationStats(hospitalId?: string, doctorId?: string) {
    const where: any = {};
    if (hospitalId) where.hospitalId = hospitalId;
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
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
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
