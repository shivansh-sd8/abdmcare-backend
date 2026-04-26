import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { AppointmentType, AppointmentStatus } from '@prisma/client';

interface CreateAppointmentRequest {
  patientId: string;
  doctorId: string;
  date: string;
  time: string;
  type: string;
  reason?: string;
  notes?: string;
}

interface UpdateAppointmentRequest {
  date?: string;
  time?: string;
  status?: string;
  notes?: string;
}

export class AppointmentService {
  async createAppointment(data: CreateAppointmentRequest) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: data.patientId },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: data.doctorId },
      });

      if (!doctor) {
        throw new AppError('Doctor not found', 404);
      }

      const appointmentDateTime = new Date(`${data.date}T${data.time}`);

      const existingAppointment = await prisma.appointment.findFirst({
        where: {
          doctorId: data.doctorId,
          scheduledAt: appointmentDateTime,
          status: {
            not: 'CANCELLED',
          },
        },
      });

      if (existingAppointment) {
        throw new AppError('Doctor already has an appointment at this time', 400);
      }

      const appointment = await prisma.appointment.create({
        data: {
          appointmentId: `APT-${Date.now()}`,
          patientId: data.patientId,
          doctorId: data.doctorId,
          hospitalId: patient.hospitalId,
          scheduledAt: appointmentDateTime,
          type: (data.type as AppointmentType) || AppointmentType.OPD,
          notes: data.notes,
          status: AppointmentStatus.SCHEDULED,
        },
        include: {
          patient: true,
          doctor: true,
        },
      });

      logger.info('Appointment created successfully', {
        appointmentId: appointment.id,
      });

      return {
        success: true,
        data: appointment,
        message: 'Appointment created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create appointment', error);
      throw new AppError(
        error.message || 'Failed to create appointment',
        error.statusCode || 500
      );
    }
  }

  async getAppointmentById(id: string, currentUser?: any) {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id },
        include: {
          patient: {
            include: {
              abhaRecord: true,
            },
          },
          doctor: true,
        },
      });

      if (!appointment) {
        throw new AppError('Appointment not found', 404);
      }

      // Hospital isolation: Non-SUPER_ADMIN users can only access appointments from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (appointment.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Appointment not found', 404);
        }
      }

      return {
        success: true,
        data: appointment,
      };
    } catch (error: any) {
      logger.error('Failed to fetch appointment', error);
      throw new AppError(
        error.message || 'Failed to fetch appointment',
        error.statusCode || 500
      );
    }
  }

  async updateAppointment(id: string, data: UpdateAppointmentRequest, currentUser?: any) {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id },
      });

      if (!appointment) {
        throw new AppError('Appointment not found', 404);
      }

      // Hospital isolation: Non-SUPER_ADMIN users can only update appointments from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (appointment.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Cannot update appointment from another hospital', 403);
        }
      }

      const updateData: any = {
        notes: data.notes,
      };

      if (data.date && data.time) {
        updateData.scheduledAt = new Date(`${data.date}T${data.time}`);
      }

      if (data.status) {
        updateData.status = data.status;
      }

      const updatedAppointment = await prisma.appointment.update({
        where: { id },
        data: updateData,
        include: {
          patient: true,
          doctor: true,
        },
      });

      logger.info('Appointment updated successfully', {
        appointmentId: id,
      });

      return {
        success: true,
        data: updatedAppointment,
        message: 'Appointment updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update appointment', error);
      throw new AppError(
        error.message || 'Failed to update appointment',
        error.statusCode || 500
      );
    }
  }

  async searchAppointments(query: {
    patientId?: string;
    doctorId?: string;
    status?: string;
    date?: string;
    page?: number;
    limit?: number;
  }, currentUser?: any) {
    try {
      const page = query.page || 1;
      const limit = query.limit || 10;
      const skip = (page - 1) * limit;

      const where: any = {};

      // Filter by hospital for non-super-admin users
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.hospitalId = currentUser.hospitalId;
      }

      if (query.patientId) {
        where.patientId = query.patientId;
      }

      if (query.doctorId) {
        where.doctorId = query.doctorId;
      }

      if (query.status) {
        where.status = query.status;
      }

      if (query.date) {
        const startDate = new Date(query.date);
        const endDate = new Date(query.date);
        endDate.setHours(23, 59, 59, 999);

        where.scheduledAt = {
          gte: startDate,
          lte: endDate,
        };
      }

      const [appointments, total] = await Promise.all([
        prisma.appointment.findMany({
          where,
          include: {
            patient: true,
            doctor: true,
          },
          orderBy: {
            scheduledAt: 'asc',
          },
          skip,
          take: limit,
        }),
        prisma.appointment.count({ where }),
      ]);

      return {
        success: true,
        data: appointments,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error: any) {
      logger.error('Failed to search appointments', error);
      throw new AppError(
        error.message || 'Failed to search appointments',
        error.statusCode || 500
      );
    }
  }

  async cancelAppointment(id: string, reason?: string) {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id },
      });

      if (!appointment) {
        throw new AppError('Appointment not found', 404);
      }

      const updatedAppointment = await prisma.appointment.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          notes: reason ? `Cancelled: ${reason}` : 'Cancelled',
        },
        include: {
          patient: true,
          doctor: true,
        },
      });

      logger.info('Appointment cancelled successfully', {
        appointmentId: id,
      });

      return {
        success: true,
        data: updatedAppointment,
        message: 'Appointment cancelled successfully',
      };
    } catch (error: any) {
      logger.error('Failed to cancel appointment', error);
      throw new AppError(
        error.message || 'Failed to cancel appointment',
        error.statusCode || 500
      );
    }
  }

  async checkInAppointment(id: string, _currentUser?: any) {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id },
        include: {
          patient: {
            include: {
              abhaRecord: true,
            },
          },
          doctor: true,
        },
      });

      if (!appointment) {
        throw new AppError('Appointment not found', 404);
      }

      if (appointment.checkedInAt) {
        throw new AppError('Appointment already checked in', 400);
      }

      // Generate OPD card number
      const opdCardNumber = `OPD-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

      // Create Encounter
      const encounterId = `ENC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const encounter = await prisma.encounter.create({
        data: {
          encounterId,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          type: appointment.type === 'OPD' ? 'OPD' : appointment.type === 'IPD' ? 'IPD' : 'EMERGENCY',
          chiefComplaint: appointment.notes || 'OPD Visit',
          visitDate: new Date(),
          status: 'IN_PROGRESS',
        },
      });

      // Create EMR Record (FHIR-compliant)
      await prisma.emrRecord.create({
        data: {
          encounterId: encounter.id,
          resourceType: 'Encounter',
          fhirData: {
            resourceType: 'Encounter',
            id: encounter.encounterId,
            status: 'in-progress',
            class: {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: encounter.type,
              display: encounter.type,
            },
            subject: {
              reference: `Patient/${appointment.patient.uhid}`,
              display: `${appointment.patient.firstName} ${appointment.patient.lastName}`,
            },
            participant: [
              {
                individual: {
                  reference: `Practitioner/${appointment.doctor.registrationNo}`,
                  display: `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}`,
                },
              },
            ],
            period: {
              start: encounter.visitDate.toISOString(),
            },
            reasonCode: [
              {
                text: encounter.chiefComplaint,
              },
            ],
          },
        },
      });

      // Create Care Context for ABHA (if patient has ABHA)
      if (appointment.patient.abhaRecord) {
        await prisma.careContext.create({
          data: {
            careContextId: `CC-${Date.now()}`,
            patientId: appointment.patientId,
            encounterId: encounter.id,
            display: `OPD Visit - ${encounter.type}`,
            referenceNumber: encounter.encounterId,
            hipId: process.env.ABDM_HIP_ID || 'default-hip-id',
          },
        });
      }

      // Update appointment with check-in details
      const updatedAppointment = await prisma.appointment.update({
        where: { id },
        data: {
          checkedInAt: new Date(),
          opdCardNumber,
          encounterId: encounter.id,
          status: 'IN_PROGRESS',
        },
        include: {
          patient: true,
          doctor: true,
          encounter: true,
        },
      });

      logger.info('Appointment checked in successfully', {
        appointmentId: id,
        encounterId: encounter.id,
        opdCardNumber,
      });

      return {
        success: true,
        data: {
          appointment: updatedAppointment,
          encounter,
          opdCardNumber,
        },
        message: 'Patient checked in successfully. OPD card generated.',
      };
    } catch (error: any) {
      logger.error('Failed to check in appointment', error);
      throw new AppError(
        error.message || 'Failed to check in appointment',
        error.statusCode || 500
      );
    }
  }

  async getAppointmentStats(currentUser?: any) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const hospitalFilter = currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId
        ? { hospitalId: currentUser.hospitalId }
        : {};

      const [total, todayCount, scheduled, completed, cancelled] = await Promise.all([
        prisma.appointment.count({ where: hospitalFilter }),
        prisma.appointment.count({
          where: {
            ...hospitalFilter,
            scheduledAt: {
              gte: today,
              lt: tomorrow,
            },
          },
        }),
        prisma.appointment.count({
          where: { ...hospitalFilter, status: 'SCHEDULED' },
        }),
        prisma.appointment.count({
          where: { ...hospitalFilter, status: 'COMPLETED' },
        }),
        prisma.appointment.count({
          where: { ...hospitalFilter, status: 'CANCELLED' },
        }),
      ]);

      return {
        success: true,
        data: {
          total,
          today: todayCount,
          scheduled,
          completed,
          cancelled,
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch appointment stats', error);
      throw new AppError(
        error.message || 'Failed to fetch appointment stats',
        error.statusCode || 500
      );
    }
  }
}

export default new AppointmentService();
