import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

interface UpdateConsultationRequest {
  historyOfPresentIllness?: string;
  pastMedicalHistory?: string;
  physicalExamination?: string;
  provisionalDiagnosis?: string;
  finalDiagnosis?: string;
  vitalSigns?: any;
  notes?: string;
  followUpDate?: string;
  admissionRequired?: boolean;
  referralRequired?: boolean;
  prescriptions?: Array<{
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string;
    quantity?: number;
  }>;
  labOrders?: Array<{
    testName: string;
    testType?: string;
    priority?: string;
  }>;
  referrals?: Array<{
    referredToDoctorId: string;
    reason: string;
    notes?: string;
    urgency?: string;
  }>;
}

class EncounterService {
  async getEncounterById(id: string, currentUser?: any) {
    try {
      const encounter = await prisma.encounter.findUnique({
        where: { id },
        include: {
          patient: {
            include: {
              abhaRecord: true,
            },
          },
          doctor: true,
          prescriptions: true,
          labOrders: true,
          referrals: {
            include: {
              referredToDoctor: true,
            },
          },
          appointment: true,
        },
      });

      if (!encounter) {
        throw new AppError('Encounter not found', 404);
      }

      // Hospital isolation check
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (currentUser.hospitalId && encounter.patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied to this encounter', 403);
        }
      }

      return {
        success: true,
        data: encounter,
      };
    } catch (error: any) {
      logger.error('Failed to fetch encounter', error);
      throw new AppError(
        error.message || 'Failed to fetch encounter',
        error.statusCode || 500
      );
    }
  }

  async getDoctorEncounters(doctorId: string, status?: string, currentUser?: any) {
    try {
      let targetDoctorId = doctorId;

      // If doctorId looks like a user ID (UUID format), try to find the doctor record
      if (doctorId && currentUser?.role === 'DOCTOR') {
        // Check if this is a user ID by trying to find a doctor with this userId
        const doctor = await prisma.doctor.findFirst({
          where: {
            OR: [
              { id: doctorId },
              { email: currentUser.email },
            ],
          },
        });

        if (doctor) {
          targetDoctorId = doctor.id;
        }
      }

      const where: any = { doctorId: targetDoctorId };

      if (status) {
        where.status = status;
      }

      // Hospital isolation
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.patient = {
          hospitalId: currentUser.hospitalId,
        };
      }

      const encounters = await prisma.encounter.findMany({
        where,
        include: {
          patient: true,
          appointment: true,
        },
        orderBy: {
          visitDate: 'desc',
        },
      });

      return {
        success: true,
        data: encounters,
      };
    } catch (error: any) {
      logger.error('Failed to fetch doctor encounters', error);
      throw new AppError(
        error.message || 'Failed to fetch encounters',
        error.statusCode || 500
      );
    }
  }

  async updateConsultation(id: string, data: UpdateConsultationRequest, currentUser?: any) {
    try {
      // Verify encounter exists and doctor has access
      const encounter = await prisma.encounter.findUnique({
        where: { id },
        include: {
          patient: true,
        },
      });

      if (!encounter) {
        throw new AppError('Encounter not found', 404);
      }

      // Only the assigned doctor or admin can update
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'ADMIN') {
        if (encounter.doctorId !== currentUser.doctorId) {
          throw new AppError('Only the assigned doctor can update this consultation', 403);
        }
      }

      // Update encounter
      const updatedEncounter = await prisma.encounter.update({
        where: { id },
        data: {
          historyOfPresentIllness: data.historyOfPresentIllness,
          pastMedicalHistory: data.pastMedicalHistory,
          physicalExamination: data.physicalExamination,
          provisionalDiagnosis: data.provisionalDiagnosis,
          finalDiagnosis: data.finalDiagnosis,
          vitalSigns: data.vitalSigns,
          notes: data.notes,
          followUpDate: data.followUpDate ? new Date(data.followUpDate) : undefined,
          admissionRequired: data.admissionRequired,
          referralRequired: data.referralRequired,
        },
      });

      // Add prescriptions
      if (data.prescriptions && data.prescriptions.length > 0) {
        await prisma.encounterPrescription.createMany({
          data: data.prescriptions.map((rx) => ({
            encounterId: id,
            ...rx,
          })),
        });
      }

      // Add lab orders
      if (data.labOrders && data.labOrders.length > 0) {
        await prisma.labOrder.createMany({
          data: data.labOrders.map((order) => ({
            encounterId: id,
            orderId: `LAB-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            testName: order.testName,
            testType: order.testType,
            priority: (order.priority as any) || 'ROUTINE',
          })),
        });
      }

      // Add referrals
      if (data.referrals && data.referrals.length > 0) {
        await prisma.referral.createMany({
          data: data.referrals.map((ref) => ({
            encounterId: id,
            referralId: `REF-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            referredToDoctorId: ref.referredToDoctorId,
            reason: ref.reason,
            notes: ref.notes,
            urgency: (ref.urgency as any) || 'ROUTINE',
          })),
        });
      }

      // Update EMR record
      await prisma.emrRecord.updateMany({
        where: { encounterId: id },
        data: {
          fhirData: {
            resourceType: 'Encounter',
            id: encounter.encounterId,
            status: 'finished',
            diagnosis: data.finalDiagnosis,
            prescriptions: data.prescriptions,
            labOrders: data.labOrders,
          },
        },
      });

      logger.info('Consultation updated successfully', { encounterId: id });

      return {
        success: true,
        data: updatedEncounter,
        message: 'Consultation updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update consultation', error);
      throw new AppError(
        error.message || 'Failed to update consultation',
        error.statusCode || 500
      );
    }
  }

  async completeConsultation(id: string, data?: { diagnosis?: string; notes?: string }, _currentUser?: any) {
    try {
      const encounter = await prisma.encounter.findUnique({
        where: { id },
        include: {
          appointment: true,
          patient: true,
        },
      });

      if (!encounter) {
        throw new AppError('Encounter not found', 404);
      }

      // Update encounter with diagnosis and mark as completed
      const updatedEncounter = await prisma.encounter.update({
        where: { id },
        data: {
          diagnosis: data?.diagnosis || encounter.diagnosis,
          notes: data?.notes || encounter.notes,
          status: 'COMPLETED',
        },
      });

      // Also update appointment status to COMPLETED
      if (encounter.appointment) {
        await prisma.appointment.update({
          where: { id: encounter.appointment.id },
          data: {
            status: 'COMPLETED',
          },
        });
      }

      // Update EMR with final diagnosis
      await prisma.emrRecord.updateMany({
        where: { encounterId: id },
        data: {
          fhirData: {
            resourceType: 'Encounter',
            id: encounter.encounterId,
            status: 'finished',
            diagnosis: data?.diagnosis,
            subject: {
              reference: `Patient/${encounter.patient.uhid}`,
              display: `${encounter.patient.firstName} ${encounter.patient.lastName}`,
            },
          },
        },
      });

      logger.info('Consultation completed', { encounterId: id, diagnosis: data?.diagnosis });

      return {
        success: true,
        data: updatedEncounter,
        message: 'Consultation completed successfully',
      };
    } catch (error: any) {
      logger.error('Failed to complete consultation', error);
      throw new AppError(
        error.message || 'Failed to complete consultation',
        error.statusCode || 500
      );
    }
  }
}

export default new EncounterService();
