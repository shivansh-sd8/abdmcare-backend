import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import bcrypt from 'bcryptjs';

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
      throw new AppError(
        error.message || 'Failed to create doctor',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to fetch doctor',
        error.statusCode || 500
      );
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

      const updatedDoctor = await prisma.doctor.update({
        where: { id },
        data: {
          firstName: data.firstName,
          lastName: data.lastName,
          specialization: data.specialization,
          qualification: data.qualification,
          mobile: data.mobile,
          email: data.email,
        },
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
      throw new AppError(
        error.message || 'Failed to update doctor',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to search doctors',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to delete doctor',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to fetch doctor stats',
        error.statusCode || 500
      );
    }
  }
}

export default new DoctorService();
