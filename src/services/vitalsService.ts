import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';
import { getEffectiveHospitalId } from '../common/utils/scope';

interface CreateVitalsDTO {
  patientId: string;
  encounterId?: string;
  temperature?: number;
  bloodPressureSystolic?: number;
  bloodPressureDiastolic?: number;
  heartRate?: number;
  respiratoryRate?: number;
  oxygenSaturation?: number;
  weight?: number;
  height?: number;
  bmi?: number;
  recordedBy?: string;
  notes?: string;
}

class VitalsService {
  async createVitals(data: CreateVitalsDTO, currentUser?: any) {
    // Hospital isolation: verify patient belongs to the user's hospital.
    // Always run when caller is non-SUPER_ADMIN — fail closed if their JWT
    // has no hospitalId.
    if (data.patientId && currentUser && currentUser.role !== 'SUPER_ADMIN') {
      if (!currentUser.hospitalId) {
        throw new AppError('Your account is not linked to a hospital', 403);
      }
      const patient = await prisma.patient.findUnique({
        where: { id: data.patientId },
        select: { hospitalId: true },
      });
      if (!patient) throw new AppError('Patient not found', 404);
      if (patient.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Access denied: Patient belongs to a different hospital', 403);
      }
    }

    // Calculate BMI if height and weight are provided
    let bmi = data.bmi;
    if (data.height && data.weight && !bmi) {
      const heightInMeters = data.height / 100;
      bmi = data.weight / (heightInMeters * heightInMeters);
      bmi = Math.round(bmi * 10) / 10;
    }

    // Auto-link to the patient's active encounter if not provided.
    // We include the most common in-flight states (the visit is "live" until
    // it transitions to COMPLETED/CANCELLED), so vitals taken during a consult
    // — even after labs/scans/pharmacy/billing have been triggered — still
    // attach to the right encounter.
    let encounterId = data.encounterId;
    if (!encounterId && data.patientId) {
      const activeEnc = await prisma.encounter.findFirst({
        where: {
          patientId: data.patientId,
          status: {
            in: [
              'SCHEDULED',
              'CHECKED_IN',
              'CONSULTING',
              'LAB_PENDING',
              'LAB_IN_PROGRESS',
              'LAB_COMPLETED',
              'SCAN_PENDING',
              'SCAN_IN_PROGRESS',
              'SCAN_COMPLETED',
              'PHARMACY_PENDING',
              'BILLING_PENDING',
            ] as any,
          },
        },
        orderBy: { visitDate: 'desc' },
        select: { id: true },
      });
      if (activeEnc) encounterId = activeEnc.id;
    }

    const vitals = await prisma.vitals.create({
      data: {
        patientId: data.patientId,
        encounterId,
        temperature: data.temperature,
        bloodPressureSystolic: data.bloodPressureSystolic,
        bloodPressureDiastolic: data.bloodPressureDiastolic,
        heartRate: data.heartRate,
        respiratoryRate: data.respiratoryRate,
        oxygenSaturation: data.oxygenSaturation,
        weight: data.weight,
        height: data.height,
        bmi,
        recordedBy: data.recordedBy,
        notes: data.notes,
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
      },
    });

    return vitals;
  }

  async getAllVitals(filters: {
    patientId?: string;
    encounterId?: string;
    hospitalId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }, currentUser?: any) {
    const { patientId, encounterId, hospitalId, startDate, endDate, page = 1, limit = 10 } = filters;

    // Effective hospital: non-SUPER_ADMIN → JWT; SUPER_ADMIN → global
    // "viewing as" scope, or explicit ?hospitalId=, otherwise platform-wide.
    const effectiveHospitalId = getEffectiveHospitalId(currentUser) || hospitalId;
    const pageNum  = parseInt(String(page),  10) || 1;
    const limitNum = parseInt(String(limit), 10) || 10;

    const where: any = {};
    if (patientId) where.patientId = patientId;
    if (encounterId) where.encounterId = encounterId;
    if (effectiveHospitalId) where.patient = { hospitalId: effectiveHospitalId };

    if (startDate || endDate) {
      where.recordedAt = {};
      if (startDate) where.recordedAt.gte = startDate;
      if (endDate) where.recordedAt.lte = endDate;
    }

    const [vitals, total] = await Promise.all([
      prisma.vitals.findMany({
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
        },
        orderBy: { recordedAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.vitals.count({ where }),
    ]);

    return {
      vitals,
      total,
      page:       pageNum,
      limit:      limitNum,
      totalPages: Math.ceil(total / limitNum),
    };
  }

  async getVitalsById(id: string, currentUser?: any) {
    const vitals = await prisma.vitals.findUnique({
      where: { id },
      include: {
        patient: {
          include: {
            abhaRecord: true,
          },
        },
      },
    });

    if (!vitals) {
      throw new AppError('Vitals record not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && vitals.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Vitals record belongs to different hospital', 403);
    }

    return vitals;
  }

  async getLatestVitals(patientId: string, currentUser?: any) {
    const vitals = await prisma.vitals.findFirst({
      where: { patientId },
      orderBy: { recordedAt: 'desc' },
      include: {
        patient: {
          select: {
            id: true,
            uhid: true,
            firstName: true,
            lastName: true,
            hospitalId: true,
          },
        },
      },
    });

    // Hospital isolation check
    if (vitals && currentUser && currentUser.role !== 'SUPER_ADMIN' && vitals.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Vitals record belongs to different hospital', 403);
    }

    return vitals;
  }

  async updateVitals(id: string, data: Partial<CreateVitalsDTO>, currentUser?: any) {
    const vitals = await prisma.vitals.findUnique({
      where: { id },
      include: {
        patient: true,
      },
    });

    if (!vitals) {
      throw new AppError('Vitals record not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && vitals.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Vitals record belongs to different hospital', 403);
    }

    // Recalculate BMI if height or weight changed
    let bmi = data.bmi;
    const height = data.height || vitals.height;
    const weight = data.weight || vitals.weight;
    
    if (height && weight && !bmi) {
      const heightInMeters = height / 100;
      bmi = weight / (heightInMeters * heightInMeters);
      bmi = Math.round(bmi * 10) / 10;
    }

    const updated = await prisma.vitals.update({
      where: { id },
      data: {
        ...data,
        bmi,
      },
      include: {
        patient: true,
      },
    });

    return updated;
  }

  async deleteVitals(id: string, currentUser?: any) {
    const vitals = await prisma.vitals.findUnique({
      where: { id },
      include: {
        patient: true,
      },
    });

    if (!vitals) {
      throw new AppError('Vitals record not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && vitals.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Vitals record belongs to different hospital', 403);
    }

    await prisma.vitals.delete({
      where: { id },
    });

    return { message: 'Vitals record deleted successfully' };
  }
}

export default new VitalsService();
