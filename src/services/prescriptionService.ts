import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';
import pharmacyService from '../modules/pharmacy/pharmacy.service';
import logger from '../common/config/logger';

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
    hospitalId?: string;
    page?: number;
    limit?: number;
  }, currentUser?: any) {
    const { patientId, doctorId, encounterId, hospitalId, page = 1, limit = 10 } = filters;

    const effectiveHospitalId = currentUser?.role !== 'SUPER_ADMIN' && currentUser?.hospitalId
      ? currentUser.hospitalId
      : hospitalId;

    const where: any = {};
    if (patientId)  where.patientId  = patientId;
    if (doctorId)   where.doctorId   = doctorId;
    if (encounterId) where.encounterId = encounterId;
    if (effectiveHospitalId) where.patient = { hospitalId: effectiveHospitalId };

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

  async dispensePrescription(id: string, data: {
    medicines: Array<{ name: string; price: number; quantity: number; medicineId?: string }>;
    dispensedBy?: string;
    notes?: string;
  }, currentUser?: any) {
    const prescription = await prisma.prescription.findUnique({
      where: { id },
      include: { patient: true },
    });
    if (!prescription) throw new AppError('Prescription not found', 404);
    if (currentUser?.role !== 'SUPER_ADMIN' && prescription.patient.hospitalId !== currentUser?.hospitalId) {
      throw new AppError('Access denied', 403);
    }
    if (prescription.status === 'DISPENSED') throw new AppError('Prescription already dispensed', 400);

    if (!data.medicines || data.medicines.length === 0) {
      throw new AppError('At least one medicine with pricing is required', 400);
    }
    for (const m of data.medicines) {
      if (m.price < 0) throw new AppError(`Invalid price for ${m.name}: must be non-negative`, 400);
      if (m.quantity <= 0) throw new AppError(`Invalid quantity for ${m.name}: must be positive`, 400);
    }

    const totalCharges = data.medicines.reduce((s, m) => s + m.price * m.quantity, 0);

    // Merge prices/quantities back into medications JSON
    const existingMeds = Array.isArray(prescription.medications)
      ? (prescription.medications as any[])
      : [];
    const updatedMeds = existingMeds.map((med) => {
      const match = data.medicines.find((m) => m.name.toLowerCase() === (med.name || med.medicineName || '').toLowerCase());
      return match ? { ...med, price: match.price, quantity: match.quantity } : med;
    });

    const updated = await prisma.prescription.update({
      where: { id },
      data: {
        status:       'DISPENSED',
        dispensedAt:  new Date(),
        dispensedBy:  data.dispensedBy,
        totalCharges,
        medications:  updatedMeds,
        notes:        data.notes || prescription.notes || undefined,
      },
    });

    // Update Encounter.medicineCharges + totalAmount if linked
    if (prescription.encounterId) {
      const enc = await prisma.encounter.findUnique({
        where:  { id: prescription.encounterId },
        select: { consultationFee: true, labCharges: true, medicineCharges: true, scanCharges: true, status: true },
      });
      if (enc) {
        const newMedCharges = Number(enc.medicineCharges ?? 0) + totalCharges;
        const newTotal      = Number(enc.consultationFee ?? 0) + Number(enc.labCharges ?? 0) + newMedCharges + Number(enc.scanCharges ?? 0);

        // Check if all prescriptions for this encounter are now dispensed
        const pendingRx = await prisma.prescription.count({
          where: {
            encounterId: prescription.encounterId,
            status: { not: 'DISPENSED' },
            id: { not: id },
          },
        });
        const allDispensed = pendingRx === 0;
        let nextStatus: string | undefined;
        if (allDispensed && ['PHARMACY_PENDING', 'LAB_PENDING', 'IN_PROGRESS'].includes(enc.status as string)) {
          // Check if labs are also done before advancing
          const pendingLabs = await prisma.investigation.count({
            where: { encounterId: prescription.encounterId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          });
          nextStatus = pendingLabs > 0 ? 'LAB_PENDING' : 'BILLING_PENDING';
        }

        await prisma.encounter.update({
          where: { id: prescription.encounterId },
          data: {
            medicineCharges:    newMedCharges,
            totalAmount:        newTotal,
            medicinesDispensed: allDispensed,
            ...(nextStatus ? { status: nextStatus as any } : {}),
          },
        });
      }
    }

    // Stock deduction for medicines with medicineId (FEFO)
    const stockResults: Array<{ name: string; medicineId?: string; deducted: number; shortfall: number }> = [];
    for (const m of data.medicines) {
      if (m.medicineId) {
        try {
          const result = await pharmacyService.deductStockForDispense(
            currentUser?.hospitalId,
            data.dispensedBy || currentUser?.id || '',
            m.medicineId,
            m.quantity,
            id,
          );
          stockResults.push({ name: m.name, medicineId: m.medicineId, ...result });
        } catch (stockErr: any) {
          logger.warn(`Stock deduction failed for ${m.name}: ${stockErr.message}`);
          stockResults.push({ name: m.name, medicineId: m.medicineId, deducted: 0, shortfall: m.quantity });
        }
      }
    }

    return { ...updated, totalCharges, stockResults };
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
