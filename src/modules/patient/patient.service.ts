import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { Prisma, Gender } from '@prisma/client';
import { rethrowServiceError } from '../../common/utils/serviceErrors';

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
  maritalStatus?: string;
  occupation?: string;
  allergies?: string[];
  medicalHistory?: any;
  abhaId?: string;
  // ABDM identity — abhaNumber (14-digit) and abhaAddress (name@sbx) are needed
  // for M2 linking and M3 consent. abhaAddress in particular is required by
  // ABDM consent (consent.patient.id) and link/carecontext.
  abhaNumber?: string;
  abhaAddress?: string;
}

interface UpdatePatientRequest {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  gender?: string;
  dob?: string;
  mobile?: string;
  email?: string;
  address?: any;
  bloodGroup?: string;
  emergencyContact?: any;
  maritalStatus?: string;
  occupation?: string;
  allergies?: string[];
  medicalHistory?: any;
  abhaId?: string;
  abhaNumber?: string;
  abhaAddress?: string;
}

interface SearchPatientQuery {
  search?: string;
  abhaLinked?: boolean;
  gender?: string;
  page?: number;
  limit?: number;
  hospitalId?: string;
}

export class PatientService {
  async createPatient(data: CreatePatientRequest, currentUser?: any) {
    try {
      // Determine the hospital scope for this registration.
      // SUPER_ADMIN with no hospitalId in body operates globally (hospitalId = null).
      const hospitalId = currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId
        ? currentUser.hospitalId
        : null;

      // Duplicate check is scoped PER HOSPITAL.
      // ABHA / mobile are national identifiers and the same person legitimately
      // exists at multiple hospitals — each as a separate Patient row. We only
      // block re-registering the same person at the SAME hospital.
      const existingPatient = await prisma.patient.findFirst({
        where: {
          hospitalId,
          OR: [
            { mobile: data.mobile },
            ...(data.email ? [{ email: data.email }] : []),
            ...(data.abhaId ? [{ abhaId: data.abhaId }] : []),
          ],
        },
      });

      if (existingPatient) {
        if (data.abhaId && existingPatient.abhaId === data.abhaId) {
          throw new AppError('A patient with this ABHA ID is already registered at this hospital', 400);
        }
        throw new AppError('A patient with this mobile or email is already registered at this hospital', 400);
      }

      const uhid = await this.generateUHID();

      const normalizedAbhaNumber = data.abhaNumber ? data.abhaNumber.replace(/-/g, '') : undefined;

      const patient = await prisma.patient.create({
        data: {
          uhid,
          firstName: data.firstName,
          middleName: data.middleName,
          lastName: data.lastName,
          gender: data.gender as Gender,
          dob: new Date(data.dob),
          mobile: data.mobile,
          email: data.email,
          address: data.address || {},
          bloodGroup: data.bloodGroup,
          emergencyContact: data.emergencyContact || {},
          maritalStatus: data.maritalStatus || null,
          occupation: data.occupation || null,
          allergies: Array.isArray(data.allergies) ? data.allergies : [],
          medicalHistory: data.medicalHistory ?? undefined,
          abhaId: data.abhaId,
          abhaNumber: normalizedAbhaNumber,
          abhaAddress: data.abhaAddress || undefined,
          hospitalId,
        },
        include: {
          abhaRecord: true,
        },
      });

      // If the registrar entered an ABHA number / address but no AbhaRecord was
      // attached, create a minimal AbhaRecord row so downstream HIP / consent
      // flows can find it (they look up Patient.abhaRecord, not the legacy
      // scalar fields). This keeps "I typed in my ABHA at the desk" working
      // for ABDM linking and care-context push without a full re-verify.
      // Note: AbhaRecord requires a non-null abhaNumber (unique). If only an
      // address was provided we skip — KYC must be completed before linking.
      if (normalizedAbhaNumber && !patient.abhaRecord) {
        try {
          // Don't conflict with an existing global record for the same ABHA.
          const existing = await prisma.abhaRecord.findUnique({
            where: { abhaNumber: normalizedAbhaNumber },
          });
          if (!existing) {
            const created = await prisma.abhaRecord.create({
              data: {
                patientId: patient.id,
                abhaNumber: normalizedAbhaNumber,
                abhaAddress: data.abhaAddress || null,
              },
            });
            (patient as any).abhaRecord = created;
          } else if (!existing.patientId) {
            // Re-attach an orphan ABHA record to this patient
            const updated = await prisma.abhaRecord.update({
              where: { abhaNumber: normalizedAbhaNumber },
              data: { patientId: patient.id, abhaAddress: data.abhaAddress || existing.abhaAddress },
            });
            (patient as any).abhaRecord = updated;
          }
        } catch (e: any) {
          logger.warn('AbhaRecord auto-create failed (non-fatal)', { message: e?.message });
        }
      }

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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
    }
  }

  async updatePatient(id: string, data: UpdatePatientRequest, currentUser?: any) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Patient belongs to a different hospital', 403);
        }
      }

      const updateData: any = {};
      if (data.firstName !== undefined)        updateData.firstName = data.firstName;
      if (data.middleName !== undefined)       updateData.middleName = data.middleName || null;
      if (data.lastName !== undefined)         updateData.lastName = data.lastName;
      if (data.gender !== undefined)           updateData.gender = data.gender;
      if (data.dob !== undefined)              updateData.dob = new Date(data.dob);
      if (data.mobile !== undefined)           updateData.mobile = data.mobile;
      if (data.email !== undefined)            updateData.email = data.email || null;
      if (data.bloodGroup !== undefined)       updateData.bloodGroup = data.bloodGroup || null;
      if (data.address !== undefined)          updateData.address = data.address;
      if (data.emergencyContact !== undefined) updateData.emergencyContact = data.emergencyContact;
      if (data.maritalStatus !== undefined)    updateData.maritalStatus = data.maritalStatus || null;
      if (data.occupation !== undefined)       updateData.occupation = data.occupation || null;
      if (data.allergies !== undefined)        updateData.allergies = Array.isArray(data.allergies) ? data.allergies : [];
      if (data.medicalHistory !== undefined)   updateData.medicalHistory = data.medicalHistory;
      // Allow editing ABHA identity so patients registered before the address
      // was captured can be fixed (abhaAddress is required for ABDM linking).
      if (data.abhaId !== undefined)           updateData.abhaId = data.abhaId ? data.abhaId.replace(/-/g, '') : null;
      if (data.abhaNumber !== undefined)       updateData.abhaNumber = data.abhaNumber ? data.abhaNumber.replace(/-/g, '') : null;
      if (data.abhaAddress !== undefined)      updateData.abhaAddress = data.abhaAddress || null;

      const updatedPatient = await prisma.patient.update({
        where: { id },
        data: updateData,
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
      rethrowServiceError(error);
    }
  }

  async searchPatients(query: SearchPatientQuery, currentUser?: any) {
    try {
      const page = query.page || 1;
      const limit = query.limit || 10;
      const skip = (page - 1) * limit;

      const where: Prisma.PatientWhereInput = {};

      // Tenant isolation:
      //   SUPER_ADMIN: cross-hospital (no filter, optionally narrow with query.hospitalId).
      //   Anyone else: must be scoped to their hospital. If their JWT has no
      //   hospitalId we fail closed (return zero results) rather than leaking.
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          return {
            success: true,
            data: [],
            pagination: { total: 0, page, limit, totalPages: 0 },
          };
        }
        where.hospitalId = currentUser.hospitalId;
      } else if (query.hospitalId) {
        where.hospitalId = query.hospitalId;
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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
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
