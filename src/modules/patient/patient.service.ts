import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { Prisma, Gender } from '@prisma/client';

interface CreatePatientRequest {
  firstName: string;
  middleName?: string;
  lastName: string;
  gender: Gender;
  dob: string;
  mobile: string;
  email?: string;
  address?: any;
  bloodGroup?: string;
  emergencyContact?: any;
  abhaId?: string;
}

interface UpdatePatientRequest {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  address?: any;
  bloodGroup?: string;
  emergencyContact?: any;
}

interface SearchPatientQuery {
  search?: string;
  abhaLinked?: boolean;
  gender?: string;
  page?: number;
  limit?: number;
}

export class PatientService {
  async createPatient(data: CreatePatientRequest, currentUser?: any) {
    try {
      const existingPatient = await prisma.patient.findFirst({
        where: {
          OR: [
            { mobile: data.mobile },
            ...(data.email ? [{ email: data.email }] : []),
          ],
        },
      });

      if (existingPatient) {
        throw new AppError('Patient with this mobile or email already exists', 400);
      }

      const uhid = await this.generateUHID();

      // Set hospitalId from currentUser for non-SUPER_ADMIN users
      const hospitalId = currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId
        ? currentUser.hospitalId
        : null;

      const patient = await prisma.patient.create({
        data: {
          uhid,
          firstName: data.firstName,
          lastName: data.lastName,
          gender: data.gender as Gender,
          dob: new Date(data.dob),
          mobile: data.mobile,
          email: data.email,
          address: data.address || {},
          bloodGroup: data.bloodGroup,
          emergencyContact: data.emergencyContact || {},
          abhaId: data.abhaId,
          hospitalId,
        },
        include: {
          abhaRecord: true,
        },
      });

      logger.info('Patient created successfully', {
        patientId: patient.id,
        uhid: patient.uhid,
        hospitalId,
      });

      return {
        success: true,
        data: patient,
        message: 'Patient created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create patient', error);
      throw new AppError(
        error.message || 'Failed to create patient',
        error.statusCode || 500
      );
    }
  }

  async getPatientById(id: string, currentUser?: any) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id },
        include: {
          abhaRecord: true,
          appointments: {
            include: {
              doctor: true,
            },
            take: 10,
          },
          encounters: {
            include: {
              doctor: true,
            },
            orderBy: {
              createdAt: 'desc',
            },
            take: 10,
          },
        },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      // Hospital isolation: Non-SUPER_ADMIN users can only access patients from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Patient not found', 404);
        }
      }

      return {
        success: true,
        data: patient,
      };
    } catch (error: any) {
      logger.error('Failed to fetch patient', error);
      throw new AppError(
        error.message || 'Failed to fetch patient',
        error.statusCode || 500
      );
    }
  }

  async getPatientByUHID(uhid: string, currentUser?: any) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { uhid },
        include: {
          abhaRecord: true,
        },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      // Hospital isolation: Non-SUPER_ADMIN users can only access patients from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Patient not found', 404);
        }
      }

      return {
        success: true,
        data: patient,
      };
    } catch (error: any) {
      logger.error('Failed to fetch patient by UHID', error);
      throw new AppError(
        error.message || 'Failed to fetch patient',
        error.statusCode || 500
      );
    }
  }

  async updatePatient(id: string, data: UpdatePatientRequest) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      const updatedPatient = await prisma.patient.update({
        where: { id },
        data: {
          firstName: data.firstName,
          lastName: data.lastName,
          mobile: data.mobile,
          email: data.email,
          address: data.address,
          bloodGroup: data.bloodGroup,
          emergencyContact: data.emergencyContact,
        },
        include: {
          abhaRecord: true,
        },
      });

      logger.info('Patient updated successfully', {
        patientId: id,
      });

      return {
        success: true,
        data: updatedPatient,
        message: 'Patient updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update patient', error);
      throw new AppError(
        error.message || 'Failed to update patient',
        error.statusCode || 500
      );
    }
  }

  async searchPatients(query: SearchPatientQuery, currentUser?: any) {
    try {
      const page = query.page || 1;
      const limit = query.limit || 10;
      const skip = (page - 1) * limit;

      const where: Prisma.PatientWhereInput = {};

      // Filter by hospital for non-super-admin users
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.hospitalId = currentUser.hospitalId;
      }

      if (query.search) {
        where.OR = [
          { firstName: { contains: query.search, mode: 'insensitive' } },
          { lastName: { contains: query.search, mode: 'insensitive' } },
          { uhid: { contains: query.search, mode: 'insensitive' } },
          { mobile: { contains: query.search } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ];
      }

      if (query.gender) {
        where.gender = query.gender as Gender;
      }

      if (query.abhaLinked !== undefined) {
        if (query.abhaLinked) {
          where.abhaId = { not: null };
        } else {
          where.abhaId = null;
        }
      }

      const [patients, total] = await Promise.all([
        prisma.patient.findMany({
          where,
          include: {
            abhaRecord: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          skip,
          take: limit,
        }),
        prisma.patient.count({ where }),
      ]);

      return {
        success: true,
        data: patients,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error: any) {
      logger.error('Failed to search patients', error);
      throw new AppError(
        error.message || 'Failed to search patients',
        error.statusCode || 500
      );
    }
  }

  async deletePatient(id: string) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      await prisma.patient.delete({
        where: { id },
      });

      logger.info('Patient deleted successfully', {
        patientId: id,
      });

      return {
        success: true,
        message: 'Patient deleted successfully',
      };
    } catch (error: any) {
      logger.error('Failed to delete patient', error);
      throw new AppError(
        error.message || 'Failed to delete patient',
        error.statusCode || 500
      );
    }
  }

  async getPatientStats(currentUser?: any) {
    try {
      const hospitalFilter = currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId
        ? { hospitalId: currentUser.hospitalId }
        : {};

      const [total, abhaLinked, maleCount, femaleCount, todayCount] = await Promise.all([
        prisma.patient.count({ where: hospitalFilter }),
        prisma.patient.count({
          where: {
            ...hospitalFilter,
            abhaId: { not: null },
          },
        }),
        prisma.patient.count({
          where: { ...hospitalFilter, gender: Gender.MALE },
        }),
        prisma.patient.count({
          where: { ...hospitalFilter, gender: Gender.FEMALE },
        }),
        prisma.patient.count({
          where: {
            ...hospitalFilter,
            createdAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        }),
      ]);

      return {
        success: true,
        data: {
          total,
          abhaLinked,
          abhaNotLinked: total - abhaLinked,
          male: maleCount,
          female: femaleCount,
          todayRegistrations: todayCount,
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch patient stats', error);
      throw new AppError(
        error.message || 'Failed to fetch patient stats',
        error.statusCode || 500
      );
    }
  }

  private async generateUHID(): Promise<string> {
    const prefix = 'UH';
    const lastPatient = await prisma.patient.findFirst({
      where: {
        uhid: {
          startsWith: prefix,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    let nextNumber = 1;
    if (lastPatient && lastPatient.uhid) {
      const lastNumber = parseInt(lastPatient.uhid.replace(prefix, ''));
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
  }
}

export default new PatientService();
