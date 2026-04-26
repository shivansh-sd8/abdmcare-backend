import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';

interface Medication {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions?: string;
}

interface CreatePrescriptionDTO {
  patientId: string;
  doctorId: string;
  encounterId?: string;
  medications: Medication[];
  diagnosis?: string;
  notes?: string;
  validUntil?: Date;
}

class PrescriptionService {
  async createPrescription(data: CreatePrescriptionDTO) {
    const prescription = await prisma.prescription.create({
      data: {
        patientId: data.patientId,
        doctorId: data.doctorId,
        encounterId: data.encounterId,
        medications: data.medications as any,
        diagnosis: data.diagnosis,
        notes: data.notes,
        validUntil: data.validUntil,
      },
      include: {
        patient: {
          select: {
            id: true,
            uhid: true,
            firstName: true,
            lastName: true,
            gender: true,
            dob: true,
          },
        },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            specialization: true,
            registrationNo: true,
          },
        },
      },
    });

    return prescription;
  }

  async getAllPrescriptions(filters: {
    patientId?: string;
    doctorId?: string;
    encounterId?: string;
    page?: number;
    limit?: number;
  }) {
    const { patientId, doctorId, encounterId, page = 1, limit = 10 } = filters;

    const where: any = {};
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;
    if (encounterId) where.encounterId = encounterId;

    const [prescriptions, total] = await Promise.all([
      prisma.prescription.findMany({
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
              specialization: true,
            },
          },
        },
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.prescription.count({ where }),
    ]);

    return {
      prescriptions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getPrescriptionById(id: string, currentUser?: any) {
    const prescription = await prisma.prescription.findUnique({
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

    if (!prescription) {
      throw new AppError('Prescription not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && prescription.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Prescription belongs to different hospital', 403);
    }

    return prescription;
  }

  async updatePrescription(id: string, data: {
    medications?: Medication[];
    diagnosis?: string;
    notes?: string;
    validUntil?: Date;
  }, currentUser?: any) {
    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: {
        patient: true,
      },
    });

    if (!prescription) {
      throw new AppError('Prescription not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && prescription.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Prescription belongs to different hospital', 403);
    }

    const updated = await prisma.prescription.update({
      where: { id },
      data: {
        medications: data.medications as any,
        diagnosis: data.diagnosis,
        notes: data.notes,
        validUntil: data.validUntil,
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    return updated;
  }

  async deletePrescription(id: string, currentUser?: any) {
    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: {
        patient: true,
      },
    });

    if (!prescription) {
      throw new AppError('Prescription not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && prescription.patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Prescription belongs to different hospital', 403);
    }

    await prisma.prescription.delete({
      where: { id },
    });

    return { message: 'Prescription deleted successfully' };
  }
}

export default new PrescriptionService();
