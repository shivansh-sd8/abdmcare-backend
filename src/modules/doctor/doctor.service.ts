import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

interface CreateDoctorRequest {
  hprId?: string;
  firstName: string;
  lastName: string;
  specialization: string;
  qualification: string;
  registrationNo: string;
  mobile: string;
  email?: string;
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
  async createDoctor(data: CreateDoctorRequest) {
    try {
      const existingDoctor = await prisma.doctor.findFirst({
        where: {
          OR: [{ registrationNo: data.registrationNo }, { email: data.email }, { mobile: data.mobile }],
        },
      });

      if (existingDoctor) {
        throw new AppError('Doctor with this registration number, email, or mobile already exists', 400);
      }

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
          },
        });
      }

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
        },
        include: {
          department: true,
        },
      });

      logger.info('Doctor created successfully', {
        doctorId: doctor.id,
      });

      return {
        success: true,
        data: doctor,
        message: 'Doctor created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create doctor', error);
      throw new AppError(
        error.message || 'Failed to create doctor',
        error.statusCode || 500
      );
    }
  }

  async getDoctorById(id: string) {
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

  async updateDoctor(id: string, data: UpdateDoctorRequest) {
    try {
      const doctor = await prisma.doctor.findUnique({
        where: { id },
      });

      if (!doctor) {
        throw new AppError('Doctor not found', 404);
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

  async searchDoctors(query: { search?: string; specialization?: string; page?: number; limit?: number }) {
    try {
      const page = query.page || 1;
      const limit = query.limit || 10;
      const skip = (page - 1) * limit;

      const where: any = {};

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

  async getDoctorStats() {
    try {
      const [total, hprLinked] = await Promise.all([
        prisma.doctor.count(),
        prisma.doctor.count({
          where: {
            hprId: { not: null },
          },
        }),
      ]);

      const specializations = await prisma.doctor.groupBy({
        by: ['specialization'],
        _count: true,
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
