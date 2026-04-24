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

  async getInvestigationById(id: string) {
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

    return investigation;
  }

  async updateInvestigationStatus(id: string, status: string, data?: {
    results?: any;
    reportUrl?: string;
    notes?: string;
    labTechnicianId?: string;
  }) {
    const investigation = await prisma.investigation.findUnique({
      where: { id },
    });

    if (!investigation) {
      throw new AppError('Investigation not found', 404);
    }

    const updateData: any = { status };

    if (status === 'SAMPLE_COLLECTED') {
      updateData.sampleCollectedAt = new Date();
    } else if (status === 'IN_PROGRESS') {
      updateData.resultEnteredAt = new Date();
    } else if (status === 'COMPLETED') {
      updateData.reportedAt = new Date();
    }

    if (data?.results) updateData.results = data.results;
    if (data?.reportUrl) updateData.reportUrl = data.reportUrl;
    if (data?.notes) updateData.notes = data.notes;
    if (data?.labTechnicianId) updateData.labTechnicianId = data.labTechnicianId;

    const updated = await prisma.investigation.update({
      where: { id },
      data: updateData,
      include: {
        patient: true,
        doctor: true,
      },
    });

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
