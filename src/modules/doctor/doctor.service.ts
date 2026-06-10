import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import bcrypt from 'bcryptjs';
import { rethrowServiceError } from '../../common/utils/serviceErrors';

interface CreateDoctorRequest {
  hprId?: string;
  firstName: string;
  lastName: string;
  specialization: string;
  qualification: string;
  registrationNo: string;
  mobile: string;
  email?: string;
  password: string;
  consultationFee?: number;
  experience?: number;
}

interface UpdateDoctorRequest {
  firstName?: string;
  lastName?: string;
  specialization?: string;
  qualification?: string;
  mobile?: string;
  email?: string;
  consultationFee?: number;
  experience?: number;
  // Scheduling fields editable from the Doctor profile UI.
  workingHours?: any;       // { mon: { start, end }, tue: ... } — JSON blob
  slotDuration?: number;    // minutes
  maxPatientsPerDay?: number;
  breakTimes?: any;         // [{ day, start, end, label }, …] — JSON blob
  isActive?: boolean;
}

export class DoctorService {
  async createDoctor(data: CreateDoctorRequest, currentUser?: any) {
    try {
      const existingDoctor = await prisma.doctor.findFirst({
        where: {
          OR: [{ registrationNo: data.registrationNo }, { email: data.email }, { mobile: data.mobile }],
        },
      });

      if (existingDoctor) {
        throw new AppError('Doctor with this registration number, email, or mobile already exists', 400);
      }

      // Check if user with this email already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ email: data.email }, { username: data.email }],
        },
      });

      if (existingUser) {
        throw new AppError('User with this email already exists', 400);
      }

      // Set hospitalId from currentUser for non-SUPER_ADMIN users
      const hospitalId = currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId
        ? currentUser.hospitalId
        : null;

      let facility = await prisma.facility.findFirst();
      if (!facility) {
        facility = await prisma.facility.create({
          data: {
            name: 'Default Hospital',
            type: 'HOSPITAL',
            address: {},
            contact: {},
          },
        });
      }

      const departmentCode = data.specialization.toUpperCase().replace(/\s+/g, '_');
      let department = await prisma.department.findFirst({
        where: { code: departmentCode },
      });

      if (!department) {
        department = await prisma.department.create({
          data: {
            name: data.specialization,
            code: departmentCode,
            description: `${data.specialization} Department`,
            facilityId: facility.id,
            hospitalId,
          },
        });
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(data.password, 10);

      // Create user account for the doctor
      const user = await prisma.user.create({
        data: {
          username: data.email || data.registrationNo,
          email: data.email || `${data.registrationNo}@hospital.com`,
          password: hashedPassword,
          firstName: data.firstName,
          lastName: data.lastName,
          role: 'DOCTOR',
          hospitalId,
          isActive: true,
        },
      });

      // Create doctor record
      const doctor = await prisma.doctor.create({
        data: {
          hprId: data.hprId,
          firstName: data.firstName,
          lastName: data.lastName,
          specialization: data.specialization,
          qualification: data.qualification,
          registrationNo: data.registrationNo,
          mobile: data.mobile,
          email: data.email || '',
          departmentId: department.id,
          hospitalId,
        },
        include: {
          department: true,
        },
      });

      logger.info('Doctor and user account created successfully', {
        doctorId: doctor.id,
        userId: user.id,
        hospitalId,
      });

      return {
        success: true,
        data: {
          doctor,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
          },
        },
        message: 'Doctor and login credentials created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create doctor', error);
      rethrowServiceError(error);
    }
  }

  async getDoctorById(id: string, currentUser?: any) {
    try {
      const doctor = await prisma.doctor.findUnique({
        where: { id },
        include: {
          appointments: {
            include: {
              patient: true,
            },
            orderBy: {
              createdAt: 'desc',
            },
            take: 10,
          },
        },
      });

      if (!doctor) {
        throw new AppError('Doctor not found', 404);
      }

      // Hospital isolation: Non-SUPER_ADMIN users can only access doctors from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (doctor.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Doctor not found', 404);
        }
      }

      return {
        success: true,
        data: doctor,
      };
    } catch (error: any) {
      logger.error('Failed to fetch doctor', error);
      rethrowServiceError(error);
    }
  }

  async updateDoctor(id: string, data: UpdateDoctorRequest, currentUser?: any) {
    try {
      const doctor = await prisma.doctor.findUnique({
        where: { id },
      });

      if (!doctor) {
        throw new AppError('Doctor not found', 404);
      }

      // Hospital isolation: Non-SUPER_ADMIN users can only update doctors from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (doctor.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Cannot update doctor from another hospital', 403);
        }
      }

      // Build a partial update so callers can ship just the fields they care
      // about (e.g. only consultationFee from the "set fee" dialog, or only
      // workingHours from the schedule editor) without nulling everything else.
      const updateData: any = {};
      if (data.firstName !== undefined)         updateData.firstName = data.firstName;
      if (data.lastName !== undefined)          updateData.lastName = data.lastName;
      if (data.specialization !== undefined)    updateData.specialization = data.specialization;
      if (data.qualification !== undefined)     updateData.qualification = data.qualification;
      if (data.mobile !== undefined)            updateData.mobile = data.mobile;
      if (data.email !== undefined)             updateData.email = data.email;
      if (data.consultationFee !== undefined)   updateData.consultationFee = data.consultationFee;
      if (data.workingHours !== undefined)      updateData.workingHours = data.workingHours as any;
      if (data.slotDuration !== undefined)      updateData.slotDuration = data.slotDuration;
      if (data.maxPatientsPerDay !== undefined) updateData.maxPatientsPerDay = data.maxPatientsPerDay;
      if (data.breakTimes !== undefined)        updateData.breakTimes = data.breakTimes as any;
      if (data.isActive !== undefined)          updateData.isActive = data.isActive;

      const updatedDoctor = await prisma.doctor.update({
        where: { id },
        data: updateData,
      });

      logger.info('Doctor updated successfully', {
        doctorId: id,
      });

      return {
        success: true,
        data: updatedDoctor,
        message: 'Doctor updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update doctor', error);
      rethrowServiceError(error);
    }
  }

  async searchDoctors(query: { search?: string; specialization?: string; page?: number; limit?: number }, currentUser?: any) {
    try {
      const page = query.page || 1;
      const limit = query.limit || 10;
      const skip = (page - 1) * limit;

      const where: any = {};

      // Filter by hospital for non-super-admin users
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.hospitalId = currentUser.hospitalId;
      }

      if (query.search) {
        where.OR = [
          { firstName: { contains: query.search, mode: 'insensitive' } },
          { lastName: { contains: query.search, mode: 'insensitive' } },
          { registrationNo: { contains: query.search } },
        ];
      }

      if (query.specialization) {
        where.specialization = { contains: query.specialization, mode: 'insensitive' };
      }

      const [doctors, total] = await Promise.all([
        prisma.doctor.findMany({
          where,
          include: {
            department: true,
            hospital: {
              select: {
                name: true,
                code: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          skip,
          take: limit,
        }),
        prisma.doctor.count({ where }),
      ]);

      return {
        success: true,
        data: doctors,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error: any) {
      logger.error('Failed to search doctors', error);
      rethrowServiceError(error);
    }
  }

  async deleteDoctor(id: string) {
    try {
      const doctor = await prisma.doctor.findUnique({
        where: { id },
      });

      if (!doctor) {
        throw new AppError('Doctor not found', 404);
      }

      await prisma.doctor.delete({
        where: { id },
      });

      logger.info('Doctor deleted successfully', {
        doctorId: id,
      });

      return {
        success: true,
        message: 'Doctor deleted successfully',
      };
    } catch (error: any) {
      logger.error('Failed to delete doctor', error);
      rethrowServiceError(error);
    }
  }

  async getDoctorStats(currentUser?: any) {
    try {
      const hospitalFilter = currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId
        ? { hospitalId: currentUser.hospitalId }
        : {};

      const [total, hprLinked] = await Promise.all([
        prisma.doctor.count({ where: hospitalFilter }),
        prisma.doctor.count({
          where: {
            ...hospitalFilter,
            hprId: { not: null },
          },
        }),
      ]);

      const specializations = await prisma.doctor.groupBy({
        by: ['specialization'],
        _count: true,
        where: hospitalFilter,
      });

      return {
        success: true,
        data: {
          total,
          hprLinked,
          specializations: specializations.map(s => ({
            name: s.specialization,
            count: s._count,
          })),
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch doctor stats', error);
      rethrowServiceError(error);
    }
  }

  async getDoctorProfile(doctorId: string, currentUser?: any) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: {
        department: true,
        hospital: { select: { id: true, name: true, city: true, state: true } },
      },
    });
    if (!doctor) throw new AppError('Doctor not found', 404);
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId && doctor.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied', 403);
    }

    const [encounters, appointments, prescriptions] = await Promise.all([
      prisma.encounter.findMany({
        where: { doctorId },
        include: {
          patient: { select: { id: true, firstName: true, lastName: true, uhid: true, gender: true, mobile: true } },
        },
        orderBy: { visitDate: 'desc' },
      }),
      prisma.appointment.findMany({
        where: { doctorId },
        include: {
          patient: { select: { id: true, firstName: true, lastName: true, uhid: true } },
        },
        orderBy: { scheduledAt: 'desc' },
      }),
      prisma.prescription.findMany({
        where: { doctorId },
        orderBy: { issuedAt: 'desc' },
        take: 50,
      }),
    ]);

    // Distinct patients
    const patientMap = new Map<string, any>();
    encounters.forEach((e) => {
      const p = e.patient;
      if (!patientMap.has(p.id)) {
        patientMap.set(p.id, { ...p, lastVisit: e.visitDate, lastDiagnosis: e.finalDiagnosis || e.diagnosis || e.chiefComplaint, visitCount: 0 });
      }
      patientMap.get(p.id)!.visitCount++;
    });
    const patientsSeen = Array.from(patientMap.values()).sort((a, b) => new Date(b.lastVisit).getTime() - new Date(a.lastVisit).getTime());

    // Earnings: a doctor only earns the **consultation fee** per encounter,
    // capped by what the patient actually paid. The encounter's
    // `paymentCollected` is the *total* money received (consult + lab +
    // medicine + scan) so summing it whole inflated earnings with pharmacy
    // and lab revenue that belongs to the hospital's other budgets.
    //
    // Standard accounting convention: when a patient makes a partial
    // payment, the consultation fee is collected first — everything beyond
    // the consult is operational income (pharmacy/lab/scan) that doesn't
    // accrue to the doctor.
    //
    // Returned alongside totalEarnings so the UI can show the breakdown:
    //   • totalEarnings  — what the doctor actually earned (capped consult)
    //   • totalCollected — total cash collected against the doctor's encounters
    //   • totalAncillary — pharmacy + lab + scan collected (= the gap)
    let totalEarnings = 0;
    let totalCollected = 0;
    const monthlyEarnings: Record<string, number> = {};
    encounters.forEach((e: any) => {
      const collected   = parseFloat(e.paymentCollected || '0');
      const consultFee  = parseFloat(e.consultationFee  || '0');
      // Doctor earns at most the consult fee; if patient paid less, only
      // what they paid counts.
      const doctorShare = Math.min(consultFee, collected);
      totalEarnings  += doctorShare;
      totalCollected += collected;
      const month = new Date(e.visitDate).toISOString().substring(0, 7);
      monthlyEarnings[month] = (monthlyEarnings[month] || 0) + doctorShare;
    });
    const totalAncillary = Math.max(0, totalCollected - totalEarnings);

    const earningsSummary = Object.entries(monthlyEarnings)
      .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 12);

    return {
      doctor,
      summary: {
        totalPatientsSeen: patientsSeen.length,
        totalEncounters: encounters.length,
        totalAppointments: appointments.length,
        totalPrescriptions: prescriptions.length,
        // Doctor's actual earnings (capped consult fee per encounter).
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        // Total money the front desk collected against this doctor's
        // encounters — useful as a sanity-check for the breakdown.
        totalCollected: Math.round(totalCollected * 100) / 100,
        // Pharmacy + labs + scans collected that DON'T accrue to the doctor.
        totalAncillary: Math.round(totalAncillary * 100) / 100,
      },
      encounters,
      appointments,
      patientsSeen,
      earningsSummary,
    };
  }

  async getDoctorAvailability(doctorId: string, date?: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: {
        id: true, firstName: true, lastName: true, specialization: true, isActive: true,
        workingHours: true, slotDuration: true, maxPatientsPerDay: true, breakTimes: true,
        hospital: {
          select: {
            operatingHours: true, defaultSlotDuration: true, breakTimes: true,
            holidays: true, is24x7: true,
          },
        },
      },
    });
    if (!doctor) throw new AppError('Doctor not found', 404);

    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate); dayEnd.setHours(23, 59, 59, 999);

    const appointments = await prisma.appointment.findMany({
      where: {
        doctorId,
        scheduledAt: { gte: dayStart, lte: dayEnd },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      select: {
        id: true, scheduledAt: true, status: true,
        patient: { select: { firstName: true, lastName: true, uhid: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    const bookedTimes = appointments.map(a => {
      const d = new Date(a.scheduledAt);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    });

    const { generateSlots } = await import('../../common/utils/slotEngine');
    const hospitalConfig = {
      operatingHours: doctor.hospital?.operatingHours as any,
      defaultSlotDuration: doctor.hospital?.defaultSlotDuration,
      breakTimes: doctor.hospital?.breakTimes as any,
      holidays: doctor.hospital?.holidays as any,
      is24x7: doctor.hospital?.is24x7,
    };
    const doctorConfig = {
      workingHours: doctor.workingHours as any,
      slotDuration: doctor.slotDuration,
      maxPatientsPerDay: doctor.maxPatientsPerDay,
      breakTimes: doctor.breakTimes as any,
    };

    const slotResult = generateSlots(targetDate, hospitalConfig, doctorConfig, bookedTimes);
    const isAvailable = doctor.isActive && slotResult.available.length > 0;

    return {
      doctor: { id: doctor.id, firstName: doctor.firstName, lastName: doctor.lastName, specialization: doctor.specialization },
      date: dayStart.toISOString().split('T')[0],
      isAvailable,
      bookedCount: bookedTimes.length,
      remainingSlots: slotResult.available.length,
      maxSlots: slotResult.maxPatientsPerDay,
      slotDuration: slotResult.slotDuration,
      availableSlots: slotResult.available,
      appointments,
      message: isAvailable
        ? `Dr. ${doctor.firstName} ${doctor.lastName} is available. ${slotResult.available.length} slot(s) remaining.`
        : `Dr. ${doctor.firstName} ${doctor.lastName} has no available slots for this date.`,
    };
  }

  async updateSchedule(doctorId: string, data: {
    workingHours?: any;
    slotDuration?: number | null;
    maxPatientsPerDay?: number;
    breakTimes?: any;
  }) {
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) throw new AppError('Doctor not found', 404);

    if (data.slotDuration && ![10, 15, 20, 30, 45, 60].includes(data.slotDuration)) {
      throw new AppError('Slot duration must be 10, 15, 20, 30, 45, or 60 minutes', 400);
    }
    if (data.maxPatientsPerDay !== undefined && (data.maxPatientsPerDay < 1 || data.maxPatientsPerDay > 200)) {
      throw new AppError('Max patients per day must be between 1 and 200', 400);
    }

    const updateData: any = {};
    if (data.workingHours !== undefined) updateData.workingHours = data.workingHours;
    if (data.slotDuration !== undefined) updateData.slotDuration = data.slotDuration;
    if (data.maxPatientsPerDay !== undefined) updateData.maxPatientsPerDay = data.maxPatientsPerDay;
    if (data.breakTimes !== undefined) updateData.breakTimes = data.breakTimes;

    const updated = await prisma.doctor.update({ where: { id: doctorId }, data: updateData });
    return { success: true, data: updated, message: 'Doctor schedule updated successfully' };
  }

  async getSchedule(doctorId: string) {
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: {
        id: true, firstName: true, lastName: true,
        workingHours: true, slotDuration: true, maxPatientsPerDay: true, breakTimes: true,
        hospital: {
          select: {
            id: true, name: true, operatingHours: true, defaultSlotDuration: true,
            breakTimes: true, holidays: true, is24x7: true,
          },
        },
      },
    });
    if (!doctor) throw new AppError('Doctor not found', 404);
    return { success: true, data: doctor };
  }
}

export default new DoctorService();
