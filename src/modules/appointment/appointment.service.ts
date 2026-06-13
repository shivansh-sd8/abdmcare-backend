import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { AppointmentType, AppointmentStatus } from '@prisma/client';
import smsService from '../../common/utils/smsService';
import { generateSlots, isValidSlotTime, HospitalScheduleConfig, DoctorScheduleConfig } from '../../common/utils/slotEngine';
import { rethrowServiceError } from '../../common/utils/serviceErrors';
import { hospitalScope } from '../../common/utils/scope';
import { istDayRange, istDayRangeOf } from '../../common/utils/dateRange';

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
  async createAppointment(data: CreateAppointmentRequest, currentUser?: any) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: data.patientId },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: data.doctorId },
        select: { id: true, hospitalId: true },
      });
      if (!doctor) {
        throw new AppError('Doctor not found', 404);
      }

      // Multi-tenant guard: non-SUPER_ADMIN users may only create
      // appointments inside their own hospital. Block any cross-hospital
      // booking — including bookings where patient and doctor straddle
      // different hospitals (which would also be a data-integrity bug).
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
      }
      if (patient.hospitalId && doctor.hospitalId && patient.hospitalId !== doctor.hospitalId) {
        throw new AppError('Patient and doctor must belong to the same hospital', 400);
      }

      const { hospitalConfig, doctorConfig } = await this.loadScheduleConfigs(data.doctorId);

      const appointmentDateTime = new Date(`${data.date}T${data.time}`);

      if (appointmentDateTime < new Date()) {
        throw new AppError('Cannot schedule appointment in the past', 400);
      }

      // Validate against schedule: is this a valid slot time?
      const targetDate = new Date(data.date);
      if (!isValidSlotTime(data.time, targetDate, hospitalConfig, doctorConfig)) {
        throw new AppError('Selected time is outside available scheduling hours', 400);
      }

      // Check booked slots (including overlap via exact time match on generated slots)
      const bookedTimes = await this.getBookedTimesForDate(data.doctorId, targetDate);
      if (bookedTimes.includes(data.time)) {
        throw new AppError('Doctor already has an appointment at this time', 400);
      }

      // Prevent duplicate appointment for same patient + same doctor + same
      // IST calendar day (NOT same UTC day — the receptionist means Jun 11
      // IST when they pick "Jun 11" in the dialog).
      const { start: dayStart, end: dayEnd } = istDayRangeOf(data.date);
      const existingPatientAppt = await prisma.appointment.findFirst({
        where: {
          patientId: data.patientId,
          doctorId: data.doctorId,
          scheduledAt: { gte: dayStart, lte: dayEnd },
          status: { in: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'] },
        },
      });
      if (existingPatientAppt) {
        throw new AppError('Patient already has an active appointment with this doctor today', 400);
      }

      // Check daily capacity
      if (bookedTimes.length >= (doctorConfig.maxPatientsPerDay || 30)) {
        throw new AppError('Doctor has reached maximum appointments for this day', 400);
      }

      const appointment = await prisma.appointment.create({
        data: {
          appointmentId: `APT-${Date.now()}`,
          patientId: data.patientId,
          doctorId: data.doctorId,
          hospitalId: patient.hospitalId,
          scheduledAt: appointmentDateTime,
          type: (data.type as AppointmentType) || AppointmentType.OPD,
          notes: [data.reason, data.notes].filter(Boolean).join('\n---\n') || undefined,
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

      // Fire-and-forget SMS confirmation
      if (appointment.patient.mobile) {
        const apptDate = appointmentDateTime.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const apptTime = appointmentDateTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        smsService.sendAppointmentConfirmation({
          mobile:       appointment.patient.mobile,
          patientName:  `${appointment.patient.firstName} ${appointment.patient.lastName}`,
          doctorName:   `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}`,
          date:         apptDate,
          time:         apptTime,
          hospitalName: 'AbhaAyushman Hospital',
        }).catch((e: any) => logger.warn('SMS send failed', { error: e.message }));
      }

      return {
        success: true,
        data: appointment,
        message: 'Appointment created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create appointment', error);
      rethrowServiceError(error);
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
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
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
      rethrowServiceError(error);
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
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
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
        const VALID: Record<string, string[]> = {
          SCHEDULED:    ['CONFIRMED', 'CANCELLED', 'NO_SHOW', 'IN_PROGRESS'],
          CONFIRMED:    ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
          IN_PROGRESS:  ['COMPLETED', 'CANCELLED'],
          COMPLETED:    [],
          CANCELLED:    [],
          NO_SHOW:      [],
        };
        const next = String(data.status).toUpperCase();
        const allowed = VALID[appointment.status] || [];
        if (appointment.status === next) {
          // no-op transition allowed
        } else if (!allowed.includes(next)) {
          throw new AppError(
            `Cannot move appointment from ${appointment.status} to ${next}`,
            400,
          );
        }
        updateData.status = next;
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
      rethrowServiceError(error);
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
      const limit = Math.min(query.limit || 100, 500);
      const skip = (page - 1) * limit;

      const where: any = {};

      // Effective hospital scope (non-SUPER_ADMIN: their JWT; SUPER_ADMIN
      // with the global "viewing as" scope: that hospital; SUPER_ADMIN
      // unscoped: cross-hospital).
      Object.assign(where, hospitalScope(currentUser));

      // Doctors are scoped to their own worklist — even if no explicit
      // doctorId is in the query string, they only see their own
      // appointments. We use currentUser.doctorId (the Doctor.id from the
      // JWT) — currentUser.id is the User.id and won't match Appointment.doctorId.
      if (currentUser?.role === 'DOCTOR' && currentUser.doctorId) {
        where.doctorId = currentUser.doctorId;
      } else if (query.doctorId) {
        where.doctorId = query.doctorId;
      }

      if (query.patientId) {
        where.patientId = query.patientId;
      }

      if (query.status) {
        where.status = query.status;
      }

      if (query.date) {
        // Parse YYYY-MM-DD parts explicitly to avoid UTC vs local timezone shift
        const [y, m, d] = query.date.split('-').map(Number);
        const startDate = new Date(y, m - 1, d, 0, 0, 0, 0);
        const endDate = new Date(y, m - 1, d, 23, 59, 59, 999);

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
            // Pull just the disposition fields the row badges need so the
            // appointment list can show "Admission recommended" without a
            // second roundtrip per row.
            encounter: {
              select: {
                id: true, status: true,
                admissionRequired: true, admissionReason: true,
                finalDiagnosis: true, provisionalDiagnosis: true,
              },
            },
          },
          orderBy: {
            scheduledAt: 'desc',
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
      rethrowServiceError(error);
    }
  }

  async cancelAppointment(id: string, reason?: string, currentUser?: any) {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id },
      });

      if (!appointment) {
        throw new AppError('Appointment not found', 404);
      }

      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
        if (appointment.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Appointment belongs to a different hospital', 403);
        }
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
      rethrowServiceError(error);
    }
  }

  async checkInAppointment(id: string, currentUser?: any) {
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

      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
        if (appointment.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Appointment belongs to a different hospital', 403);
        }

        // A doctor may only check in appointments where they are the
        // assigned provider — they should never be able to claim another
        // doctor's patient. The Doctor row is identified by either the
        // canonical userId pointer or, as a defensive fallback, by email.
        if (currentUser.role === 'DOCTOR') {
          const doctorRow = await prisma.doctor.findFirst({
            where: {
              hospitalId: currentUser.hospitalId,
              OR: [
                { userId: currentUser.id },
                ...(currentUser.email ? [{ email: currentUser.email as string }] : []),
              ],
            },
            select: { id: true },
          });
          if (!doctorRow || appointment.doctorId !== doctorRow.id) {
            throw new AppError('Access denied: you can only check in your own patients', 403);
          }
        }
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
          type: (['OPD', 'FOLLOW_UP', 'ROUTINE_CHECKUP', 'DIAGNOSTIC', 'SURGERY_CONSULTATION', 'SECOND_OPINION', 'VACCINATION', 'WALK_IN'].includes(appointment.type)
            ? 'OPD'
            : appointment.type === 'IPD'
              ? 'IPD'
              : appointment.type === 'TELECONSULTATION'
                ? 'TELECONSULTATION'
                : appointment.type === 'EMERGENCY'
                  ? 'EMERGENCY'
                  : 'OPD'),
          chiefComplaint: appointment.notes?.split('\n---\n')[0] || 'OPD Visit',
          notes: appointment.notes?.includes('\n---\n') ? appointment.notes.split('\n---\n').slice(1).join('\n') : undefined,
          visitDate: new Date(),
          status: 'CONSULTING',
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

      // Create Care Context for ABHA. We'll create one whenever the patient has
      // any ABHA identity (AbhaRecord row OR scalar abhaNumber / abhaAddress on
      // the patient), so check-ins from quickly-registered patients still
      // trigger ABDM linking. Per-hospital hipId is used (falls back to env).
      const patient: any = appointment.patient;
      const abhaNumber: string | undefined =
        patient.abhaRecord?.abhaNumber || patient.abhaNumber || undefined;
      const abhaAddress: string | undefined =
        patient.abhaRecord?.abhaAddress || patient.abhaAddress || undefined;

      if (abhaNumber || abhaAddress) {
        // Resolve the HIP id for this hospital. If the hospital has no hipId
        // set, the env-level ABDM_HIP_ID is used as a fallback.
        let hipIdForCareContext = process.env.ABDM_HIP_ID || 'default-hip-id';
        try {
          if (appointment.hospitalId) {
            const hospital = await prisma.hospital.findUnique({
              where: { id: appointment.hospitalId },
              select: { hipId: true },
            });
            if (hospital?.hipId) hipIdForCareContext = hospital.hipId;
          }
        } catch (_) { /* ignore — fall back to env */ }

        const careContext = await prisma.careContext.create({
          data: {
            careContextId: `CC-${Date.now()}`,
            patientId: appointment.patientId,
            encounterId: encounter.id,
            display: `OPD Visit - ${encounter.type}`,
            referenceNumber: encounter.encounterId,
            hipId: hipIdForCareContext,
          },
        });

        // Fire-and-forget: initiate ABDM HIP linking only if we have an ABHA
        // number (generate-token requires the 14-digit number).
        if (abhaNumber) {
          setImmediate(async () => {
            try {
              const hipService = (await import('../hip/hip.service')).default;
              const abdmGender =
                patient.gender === 'MALE' ? 'M' : patient.gender === 'FEMALE' ? 'F' : 'O';
              await hipService.generateLinkToken({
                abhaNumber,
                abhaAddress: abhaAddress || '',
                name: `${patient.firstName} ${patient.lastName}`,
                gender: abdmGender,
                yearOfBirth: patient.dob ? new Date(patient.dob).getFullYear() : 2000,
              });
              logger.info('HIP linking initiated (generate-token) for care context', {
                careContextId: careContext.careContextId,
              });
            } catch (err: any) {
              logger.warn('HIP linking failed (non-blocking)', { error: err.message });
            }
          });
        }
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

      // Fire-and-forget check-in SMS
      if (appointment.patient.mobile) {
        smsService.sendCheckInNotification({
          mobile:       appointment.patient.mobile,
          patientName:  `${appointment.patient.firstName} ${appointment.patient.lastName}`,
          doctorName:   `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}`,
          tokenNumber:  opdCardNumber,
          hospitalName: 'AbhaAyushman Hospital',
        }).catch((e: any) => logger.warn('SMS send failed', { error: e.message }));
      }

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
      rethrowServiceError(error);
    }
  }

  async getAppointmentStats(currentUser?: any) {
    try {
      // IST-anchored "today" — server may be running in UTC, but the user
      // expects the dashboard to switch days at IST midnight, not UTC.
      const { start: today, end: dayEnd } = istDayRange(0);

      // Hospital scope first; for DOCTOR role we further narrow to their own
      // appointments so the doctor dashboard "Today's queue / Completed today /
      // Scheduled" reflect only their own worklist instead of the whole hospital.
      const hospitalFilter: any = { ...hospitalScope(currentUser) };
      if (currentUser?.role === 'DOCTOR' && currentUser.doctorId) {
        hospitalFilter.doctorId = currentUser.doctorId;
      }

      const todayWindow = { gte: today, lte: dayEnd };
      const [
        total,
        todayCount,
        scheduled,
        completed,
        cancelled,
        walkins,
        checkedIn,
        inProgress,
      ] = await Promise.all([
        prisma.appointment.count({ where: hospitalFilter }),
        prisma.appointment.count({ where: { ...hospitalFilter, scheduledAt: todayWindow } }),
        prisma.appointment.count({ where: { ...hospitalFilter, status: 'SCHEDULED' } }),
        prisma.appointment.count({ where: { ...hospitalFilter, status: 'COMPLETED' } }),
        prisma.appointment.count({ where: { ...hospitalFilter, status: 'CANCELLED' } }),
        prisma.appointment.count({
          where: {
            ...hospitalFilter,
            type: 'WALK_IN' as any,
            scheduledAt: todayWindow,
          },
        }).catch(() => 0),
        prisma.appointment.count({
          where: {
            ...hospitalFilter,
            scheduledAt: todayWindow,
            checkedInAt: { not: null },
          } as any,
        }).catch(() => 0),
        prisma.appointment.count({ where: { ...hospitalFilter, status: 'IN_PROGRESS' } }).catch(() => 0),
      ]);

      return {
        success: true,
        data: {
          total,
          today: todayCount,
          scheduled,
          completed,
          cancelled,
          walkins,
          checkedIn,
          inProgress,
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch appointment stats', error);
      rethrowServiceError(error);
    }
  }

  // ── Dynamic slot generation ──────────────────────────────────────────────

  private async loadScheduleConfigs(doctorId: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: {
        id: true, firstName: true, lastName: true, specialization: true, isActive: true,
        workingHours: true, slotDuration: true, maxPatientsPerDay: true, breakTimes: true,
        hospitalId: true,
        hospital: {
          select: {
            id: true, name: true,
            operatingHours: true, defaultSlotDuration: true, breakTimes: true,
            holidays: true, is24x7: true,
          },
        },
      },
    });
    if (!doctor) throw new AppError('Doctor not found', 404);
    if (!doctor.isActive) throw new AppError('Doctor is not active', 400);

    const hospitalConfig: HospitalScheduleConfig = {
      operatingHours: doctor.hospital?.operatingHours as any,
      defaultSlotDuration: doctor.hospital?.defaultSlotDuration,
      breakTimes: doctor.hospital?.breakTimes as any,
      holidays: doctor.hospital?.holidays as any,
      is24x7: doctor.hospital?.is24x7,
    };
    const doctorConfig: DoctorScheduleConfig = {
      workingHours: doctor.workingHours as any,
      slotDuration: doctor.slotDuration,
      maxPatientsPerDay: doctor.maxPatientsPerDay,
      breakTimes: doctor.breakTimes as any,
    };
    return { doctor, hospitalConfig, doctorConfig };
  }

  private async getBookedTimesForDate(doctorId: string, date: Date): Promise<string[]> {
    // The booked-times window must be the full IST day for this date —
    // otherwise on a UTC server we'd miss the early-morning IST slots that
    // fall in "yesterday" UTC.
    const { start: dayStart, end: dayEnd } = istDayRangeOf(date);

    const appointments = await prisma.appointment.findMany({
      where: {
        doctorId,
        scheduledAt: { gte: dayStart, lte: dayEnd },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      select: { scheduledAt: true },
    });

    return appointments.map(a => {
      const d = new Date(a.scheduledAt);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
  }

  async getAvailableSlots(doctorId: string, dateStr: string, currentUser?: any) {
    const { doctor, hospitalConfig, doctorConfig } = await this.loadScheduleConfigs(doctorId);

    if (currentUser?.role !== 'SUPER_ADMIN') {
      if (!currentUser?.hospitalId) {
        throw new AppError('Your account is not linked to a hospital', 403);
      }
      if (doctor.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Access denied: Doctor belongs to a different hospital', 403);
      }
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) throw new AppError('Invalid date', 400);

    const bookedTimes = await this.getBookedTimesForDate(doctorId, date);
    const result = generateSlots(date, hospitalConfig, doctorConfig, bookedTimes);

    return {
      slots: result.available,
      booked: result.booked,
      allSlots: result.allSlots,
      slotDuration: result.slotDuration,
      isHoliday: result.isHoliday,
      isClosed: result.isClosed,
      maxPatientsPerDay: result.maxPatientsPerDay,
      capacityReached: result.capacityReached,
      doctor: {
        id: doctor.id,
        name: `Dr. ${doctor.firstName} ${doctor.lastName}`,
        specialization: doctor.specialization,
      },
      hospital: doctor.hospital ? { id: doctor.hospital.id, name: doctor.hospital.name } : null,
      date: dateStr,
    };
  }
}

export default new AppointmentService();
