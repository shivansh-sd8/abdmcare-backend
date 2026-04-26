import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';

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
  async createVitals(data: CreateVitalsDTO) {
    // Calculate BMI if height and weight are provided
    let bmi = data.bmi;
    if (data.height && data.weight && !bmi) {
      const heightInMeters = data.height / 100;
      bmi = data.weight / (heightInMeters * heightInMeters);
      bmi = Math.round(bmi * 10) / 10;
    }

    const vitals = await prisma.vitals.create({
      data: {
        patientId: data.patientId,
        encounterId: data.encounterId,
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
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const { patientId, encounterId, startDate, endDate, page = 1, limit = 10 } = filters;

    const where: any = {};
    if (patientId) where.patientId = patientId;
    if (encounterId) where.encounterId = encounterId;

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
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.vitals.count({ where }),
    ]);

    return {
      vitals,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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
