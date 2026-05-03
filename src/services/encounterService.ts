import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';

interface CreateEncounterDTO {
  patientId: string;
  doctorId: string;
  type: string;
  chiefComplaint: string;
  diagnosis?: string;
  notes?: string;
  visitDate?: Date;
  vitalSigns?: any;
  prescription?: any;
}

interface UpdateEncounterDTO {
  chiefComplaint?: string;
  diagnosis?: string;
  notes?: string;
  status?: string;
  vitalSigns?: any;
  prescription?: any;
}

class EncounterService {
  async createEncounter(data: CreateEncounterDTO) {
    const encounterId = `ENC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const encounter = await prisma.encounter.create({
      data: {
        encounterId,
        patientId: data.patientId,
        doctorId: data.doctorId,
        type: data.type as any,
        chiefComplaint: data.chiefComplaint,
        diagnosis: data.diagnosis,
        notes: data.notes,
        visitDate: data.visitDate || new Date(),
        vitalSigns: data.vitalSigns,
        prescription: data.prescription,
        status: 'IN_PROGRESS',
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    return encounter;
  }

  async getAllEncounters(filters: {
    doctorId?: string;
    patientId?: string;
    status?: string;
    type?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const {
      doctorId,
      patientId,
      status,
      type,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = filters;

    const where: any = {};

    if (doctorId) where.doctorId = doctorId;
    if (patientId) where.patientId = patientId;
    if (status) where.status = status;
    if (type) where.type = type;

    if (startDate || endDate) {
      where.visitDate = {};
      if (startDate) where.visitDate.gte = startDate;
      if (endDate) where.visitDate.lte = endDate;
    }

    const [encounters, total] = await Promise.all([
      prisma.encounter.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              uhid: true,
              firstName: true,
              lastName: true,
              gender: true,
              dob: true,
              mobile: true,
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
        orderBy: { visitDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.encounter.count({ where }),
    ]);

    return {
      encounters,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getEncounterById(id: string, currentUser?: any) {
    const encounter = await prisma.encounter.findUnique({
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
      },
    });

    if (!encounter) {
      throw new AppError('Encounter not found', 404);
    }

    // Hospital isolation check - use patient's hospitalId
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && encounter.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Encounter belongs to different hospital', 403);
    }

    return encounter;
  }

  async updateEncounter(id: string, data: UpdateEncounterDTO, currentUser?: any) {
    const encounter = await prisma.encounter.findUnique({
      where: { id },
      include: {
        patient: true,
      },
    });

    if (!encounter) {
      throw new AppError('Encounter not found', 404);
    }

    // Hospital isolation check - use patient's hospitalId
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && encounter.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Encounter belongs to different hospital', 403);
    }

    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        chiefComplaint: data.chiefComplaint,
        diagnosis: data.diagnosis,
        notes: data.notes,
        vitalSigns: data.vitalSigns,
        prescription: data.prescription,
        status: data.status as any,
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    return updated;
  }

  async completeEncounter(id: string, diagnosis: string, notes?: string) {
    const encounter = await prisma.encounter.findUnique({
      where: { id },
    });

    if (!encounter) {
      throw new AppError('Encounter not found', 404);
    }

    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        diagnosis,
        notes,
        status: 'COMPLETED',
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    return updated;
  }

  async collectPayment(id: string, data: {
    paymentMethod: string;
    paymentCollected: number;
    transactionRef?: string;
  }, currentUser?: any) {
    const encounter = await prisma.encounter.findUnique({
      where: { id },
      include: { patient: true },
    });
    if (!encounter) throw new AppError('Encounter not found', 404);
    if (currentUser?.role !== 'SUPER_ADMIN' && encounter.patient.hospitalId !== currentUser?.hospitalId) {
      throw new AppError('Access denied', 403);
    }

    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        paymentStatus:    'PAID',
        paymentCollected: data.paymentCollected,
        paymentMethod:    data.paymentMethod,
        transactionRef:   data.transactionRef,
        status:           'COMPLETED',
        billGenerated:    true,
      },
    });
    return updated;
  }

  async getEncounterStats(doctorId?: string) {
    const where: any = {};
    if (doctorId) where.doctorId = doctorId;

    const [total, inProgress, completed, today] = await Promise.all([
      prisma.encounter.count({ where }),
      prisma.encounter.count({
        where: { ...where, status: 'IN_PROGRESS' },
      }),
      prisma.encounter.count({
        where: { ...where, status: 'COMPLETED' },
      }),
      prisma.encounter.count({
        where: {
          ...where,
          visitDate: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    return {
      total,
      inProgress,
      completed,
      today,
    };
  }
}

export default new EncounterService();
