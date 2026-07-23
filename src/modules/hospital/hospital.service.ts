import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import bcrypt from 'bcryptjs';
import { rethrowServiceError } from '../../common/utils/serviceErrors';
import { istDayRange } from '../../common/utils/dateRange';

// ─────────────────────────────────────────────────────────────────────────────
// Hospital onboarding contract
//
// Per ABDM documentation (https://sandbox.abdm.gov.in docs / "About ABDM
// Sandbox"), ABDM client_id / client_secret / callback URL are issued by NHA
// at the integrator/HMIS level — NOT per facility. They are configured via
// env vars (`ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET`, `ABDM_CALLBACK_URL`) and
// shared across every hospital on this platform. The legacy per-hospital
// `abdmClientId/abdmClientSecret/abdmCallbackUrl` columns remain in the
// schema for backwards compatibility but are no longer accepted as inputs.
//
// HFR Facility ID, HIP ID, HIU ID are per-facility identifiers issued by
// the Health Facility Registry. HPR IDs live on the Doctor row, not here.
//
// The "owner" identity is a single `Primary Hospital Admin` user — created
// in the User table with role=ADMIN and linked via Hospital.primaryAdminId.
// Hospital.email and User.email both hold the same admin email (single
// source of truth). The legacy `ownerName/ownerEmail/ownerPhone` columns on
// Hospital are populated for read-back compatibility but are derived from
// the admin user, never accepted as direct input.
// ─────────────────────────────────────────────────────────────────────────────
interface HospitalOnboardingData {
  // Basic Information
  name: string;
  type: string;

  // Contact Information (hospital-specific; reception/general line)
  // The single `email` is the platform's "primary email" — used as both the
  // hospital's email-of-record AND the initial admin user's login email.
  email: string;
  phone: string;
  alternatePhone?: string;
  website?: string;

  // Address Details
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  country?: string;
  pincode: string;
  landmark?: string;

  // Legal & Registration
  registrationNumber?: string;
  gstNumber?: string;
  panNumber?: string;
  licenseNumber?: string;
  establishedYear?: number;

  // Primary Hospital Admin (REQUIRED on create — owner identity).
  // All six fields must be supplied together; the bootstrap is atomic.
  adminUsername: string;
  adminPassword: string;
  adminFirstName: string;
  adminLastName: string;
  adminPhone: string;

  // Facility Details
  totalBeds?: number;
  icuBeds?: number;
  emergencyBeds?: number;
  operationTheaters?: number;

  // Services & Specialties
  services?: string[];
  specialties?: string[];

  // Subscription Plan
  plan?: 'FREE' | 'BASIC' | 'PROFESSIONAL' | 'ENTERPRISE';

  // Default OPD charge (used when doctor has no individual fee set)
  defaultOpdCharge?: number;

  // ABDM Integration (per-facility identifiers from HFR/NHA)
  hipId?: string;
  hipName?: string;
  hiuId?: string;
  hiuName?: string;
  hfrFacilityId?: string;
  // NOTE: HPR IDs live on Doctor, not Hospital.
  // NOTE: abdmClientId/Secret/CallbackUrl are PLATFORM-level (env vars).
}

interface UpdateHospitalData {
  name?: string;
  type?: any;
  email?: string;
  phone?: string;
  alternatePhone?: string;
  website?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  landmark?: string;
  registrationNumber?: string;
  gstNumber?: string;
  panNumber?: string;
  licenseNumber?: string;
  establishedYear?: number;
  totalBeds?: number;
  icuBeds?: number;
  emergencyBeds?: number;
  operationTheaters?: number;
  services?: string[];
  specialties?: string[];
  plan?: any;
  status?: any;
  isActive?: boolean;
  hipId?: string;
  hipName?: string;
  hiuId?: string;
  hiuName?: string;
  hfrFacilityId?: string;
  abdmEnabled?: boolean;
  abdmAutoShare?: boolean;
  defaultOpdCharge?: number;
  operatingHours?: any;
  defaultSlotDuration?: number;
  breakTimes?: any;
  holidays?: any;
  is24x7?: boolean;

  // Optional admin-side edits (propagate to the linked primary admin user).
  adminFirstName?: string;
  adminLastName?: string;
  adminPhone?: string;
  adminUsername?: string;
  adminPassword?: string;  // Only applied when non-empty (admin reset)
}

export class HospitalService {
  // Onboard a new hospital
  async onboardHospital(data: HospitalOnboardingData) {
    try {
      logger.info('Starting hospital onboarding', { name: data.name, email: data.email });

      // ── Admin bootstrap is REQUIRED and ATOMIC ────────────────────────────
      // Every hospital must have a primary admin user. The owner identity is
      // collapsed into this single admin block (no separate ownerName/Email/
      // Phone inputs) — backend derives owner fields from the admin row.
      const missingAdminFields: string[] = [];
      if (!data.adminUsername?.trim()) missingAdminFields.push('adminUsername');
      if (!data.adminPassword?.trim()) missingAdminFields.push('adminPassword');
      if (!data.adminFirstName?.trim()) missingAdminFields.push('adminFirstName');
      if (!data.adminLastName?.trim()) missingAdminFields.push('adminLastName');
      if (!data.adminPhone?.trim()) missingAdminFields.push('adminPhone');
      if (!data.email?.trim()) missingAdminFields.push('email');
      if (missingAdminFields.length > 0) {
        throw new AppError(
          `Primary admin details are required: missing ${missingAdminFields.join(', ')}`,
          422
        );
      }

      // Duplicate checks — hospital email (also used as admin login email)
      const existingByEmail = await prisma.hospital.findUnique({
        where: { email: data.email },
      });
      if (existingByEmail) {
        throw new AppError('A hospital with this email already exists', 409);
      }
      const existingUserByEmail = await prisma.user.findUnique({
        where: { email: data.email },
      });
      if (existingUserByEmail) {
        throw new AppError('This email is already registered as a user', 409);
      }

      // Duplicate checks — registration number (unique in DB)
      if (data.registrationNumber) {
        const existingByRegNo = await prisma.hospital.findUnique({
          where: { registrationNumber: data.registrationNumber },
        });
        if (existingByRegNo) {
          throw new AppError('A hospital with this registration number already exists', 409);
        }
      }

      // Duplicate checks — admin username
      const existingByUsername = await prisma.user.findUnique({
        where: { username: data.adminUsername },
      });
      if (existingByUsername) {
        throw new AppError('Admin username is already taken', 409);
      }

      // Hospital code is ALWAYS server-generated for consistency. Any value
      // that snuck through from the client is ignored.
      const hospitalCode = this.generateHospitalCode(data.name);

      // Determine plan limits
      const planLimits = this.getPlanLimits(data.plan || 'FREE');

      // Calculate trial end date (14 days)
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 14);

      // Create hospital
      const hospital = await prisma.hospital.create({
        data: {
          // Basic Information
          name: data.name,
          code: hospitalCode,
          type: data.type as any,
          
          // Contact Information
          email: data.email,
          phone: data.phone,
          alternatePhone: data.alternatePhone,
          website: data.website,
          
          // Address Details
          addressLine1: data.addressLine1,
          addressLine2: data.addressLine2,
          city: data.city,
          state: data.state,
          country: data.country || 'India',
          pincode: data.pincode,
          landmark: data.landmark,
          
          // Legal & Registration
          registrationNumber: data.registrationNumber,
          gstNumber: data.gstNumber ? data.gstNumber.toUpperCase() : undefined,
          panNumber: data.panNumber ? data.panNumber.toUpperCase() : undefined,
          licenseNumber: data.licenseNumber,
          establishedYear: data.establishedYear ? parseInt(data.establishedYear.toString()) : null,

          // Owner identity (legacy columns, derived from primary admin so the
          // single source of truth stays on the User row).
          ownerName: `${data.adminFirstName.trim()} ${data.adminLastName.trim()}`.trim(),
          ownerEmail: data.email,
          ownerPhone: data.adminPhone,

          // Facility Details
          totalBeds: data.totalBeds ? parseInt(data.totalBeds.toString()) : 0,
          icuBeds: data.icuBeds ? parseInt(data.icuBeds.toString()) : 0,
          emergencyBeds: data.emergencyBeds ? parseInt(data.emergencyBeds.toString()) : 0,
          operationTheaters: data.operationTheaters ? parseInt(data.operationTheaters.toString()) : 0,

          // Services & Specialties
          services: data.services || [],
          specialties: data.specialties || [],

          // Subscription & Plan
          plan: data.plan || 'FREE',
          status: 'TRIAL',
          trialStartedAt: new Date(),
          trialEndsAt,

          // Plan Limits
          maxUsers: planLimits.maxUsers,
          maxDoctors: planLimits.maxDoctors,
          maxPatients: planLimits.maxPatients,
          maxStorage: planLimits.maxStorage,

          // ABDM Integration (per-facility identifiers from HFR/NHA).
          // Each tenant must have its OWN hipId/hiuId registered with the
          // ABDM bridge — they are the unit of consent + the unit of data
          // fulfillment. Falling back to the platform-default hipId/hiuId
          // (as a single-tenant deployment would) breaks isolation, so the
          // multi-tenant rewrite REQUIRES per-row values.
          hipId: data.hipId || null,
          hipName: data.hipName || null,
          hiuId: data.hiuId || null,
          hiuName: data.hiuName || null,
          hfrFacilityId: data.hfrFacilityId || null,
          // Per ABDM docs, abdmClientId/Secret/CallbackUrl are platform-level
          // (issued by NHA per integrator) — supplied via env, not per-row.
          //
          // abdmEnabled is set to TRUE only after we successfully register
          // the new tenant's hipId/hiuId with the platform's ABDM bridge —
          // see the post-creation auto-register block below. Until then it
          // stays false so the admin dashboard correctly shows "ABDM not
          // wired up yet" instead of giving a false-green status.
          abdmEnabled: false,
          abdmRegisteredAt: null,

          // Default OPD charge
          defaultOpdCharge: data.defaultOpdCharge != null ? data.defaultOpdCharge : null,

          // Onboarding
          onboardingStep: 1,
          onboardingCompleted: false,
        },
      });

      // Create primary admin user (REQUIRED — checked at the top of this fn).
      // The admin's email is the single source of truth for the hospital's
      // primary contact email and login.
      const hashedPassword = await bcrypt.hash(data.adminPassword, 10);

      const adminUser = await prisma.user.create({
        data: {
          username: data.adminUsername.trim(),
          email: data.email,
          password: hashedPassword,
          firstName: data.adminFirstName.trim(),
          lastName: data.adminLastName.trim(),
          phone: data.adminPhone.trim(),
          role: 'ADMIN',
          hospitalId: hospital.id,
          isActive: true,
        },
      });

      // Link the admin row back to the hospital.
      await prisma.hospital.update({
        where: { id: hospital.id },
        data: { primaryAdminId: adminUser.id },
      });

      logger.info('Hospital onboarded successfully', {
        hospitalId: hospital.id,
        hospitalCode: hospital.code,
        adminUserId: adminUser.id,
      });

      // ── Auto-register ABDM bridge services (best-effort, async) ──────────
      // If the admin provided a hipId or hiuId, register them with the
      // platform's bridge so ABDM treats this tenant as a real HIP/HIU.
      // We do this in setImmediate so a slow / failing bridge never blocks
      // the response — the admin can always retry from "Hospital Management
      // → Register with ABDM" if either call fails. abdmEnabled flips to
      // true only when at least one registration succeeds.
      if ((data.hipId || data.hiuId) && process.env.ABDM_CLIENT_ID) {
        const newHospitalId = hospital.id;
        setImmediate(async () => {
          let anyOk = false;
          try {
            const hipServiceModule = await import('../hip/hip.service');
            const hipService = hipServiceModule.default;
            if (data.hipId) {
              try {
                await hipService.registerHipService(newHospitalId);
                anyOk = true;
                logger.info('ABDM bridge: HIP registered for new hospital', {
                  hospitalId: newHospitalId, hipId: data.hipId,
                });
              } catch (e: any) {
                logger.warn('ABDM bridge: HIP registration failed (admin can retry)', {
                  hospitalId: newHospitalId, hipId: data.hipId, error: e?.message,
                });
              }
            }
            if (data.hiuId) {
              try {
                await hipService.registerHiuService(newHospitalId);
                anyOk = true;
                logger.info('ABDM bridge: HIU registered for new hospital', {
                  hospitalId: newHospitalId, hiuId: data.hiuId,
                });
              } catch (e: any) {
                logger.warn('ABDM bridge: HIU registration failed (admin can retry)', {
                  hospitalId: newHospitalId, hiuId: data.hiuId, error: e?.message,
                });
              }
            }
            // registerHipService/registerHiuService each set
            // abdmEnabled=true on success, so this UPDATE only matters if
            // both calls failed — in that case keep abdmEnabled=false.
            if (!anyOk) {
              logger.warn('ABDM bridge: no service registered for new hospital — abdmEnabled stays false', {
                hospitalId: newHospitalId,
              });
            }
          } catch (outerErr: any) {
            logger.warn('ABDM bridge auto-register: unexpected error', {
              hospitalId: newHospitalId, error: outerErr?.message,
            });
          }
        });
      } else if (data.hipId || data.hiuId) {
        logger.info('Skipping ABDM bridge auto-register — ABDM_CLIENT_ID is not configured', {
          hospitalId: hospital.id,
        });
      }

      return {
        success: true,
        data: {
          hospital: {
            id: hospital.id,
            name: hospital.name,
            code: hospital.code,
            email: hospital.email,
            plan: hospital.plan,
            status: hospital.status,
            trialEndsAt: hospital.trialEndsAt,
          },
          admin: {
            id: adminUser.id,
            username: adminUser.username,
            email: adminUser.email,
            role: adminUser.role,
          },
        },
        message: 'Hospital onboarded successfully',
      };
    } catch (error: any) {
      logger.error('Failed to onboard hospital', error);
      rethrowServiceError(error);
    }
  }

  // Get all hospitals (SUPER_ADMIN only)
  async getAllHospitals(query: { page?: number; limit?: number; search?: string; status?: string; plan?: string }) {
    try {
      const page = query.page || 1;
      const limit = query.limit || 20;
      const skip = (page - 1) * limit;

      const where: any = {};

      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { code: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
          { city: { contains: query.search, mode: 'insensitive' } },
        ];
      }

      if (query.status) {
        where.status = query.status;
      }

      if (query.plan) {
        where.plan = query.plan;
      }

      const [hospitals, total] = await Promise.all([
        prisma.hospital.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            _count: {
              select: {
                users: true,
                doctors: true,
                patients: true,
                appointments: true,
              },
            },
          },
        }),
        prisma.hospital.count({ where }),
      ]);

      // Surface the linked primary admin so the management UI can verify
      // (and edit) the hospital's owner identity in one place. We fetch in a
      // single batched query rather than declaring a Prisma relation, to
      // keep the schema migration-free.
      const adminIds = hospitals
        .map((h: any) => h.primaryAdminId)
        .filter((v: string | null | undefined): v is string => !!v);
      const admins = adminIds.length
        ? await prisma.user.findMany({
            where: { id: { in: adminIds } },
            select: {
              id: true,
              username: true,
              email: true,
              firstName: true,
              lastName: true,
              phone: true,
              isActive: true,
            },
          })
        : [];
      const adminById = new Map(admins.map((a) => [a.id, a]));
      for (const h of hospitals as any[]) {
        h.primaryAdmin = h.primaryAdminId ? adminById.get(h.primaryAdminId) || null : null;
      }

      return {
        success: true,
        data: {
          hospitals,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch hospitals', error);
      rethrowServiceError(error);
    }
  }

  // Get hospital by ID
  async getHospitalById(id: string, currentUser?: any) {
    try {
      // Non-SUPER_ADMIN users can only access their own hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId !== id) {
        throw new AppError('You can only access your own hospital details', 403);
      }

      const hospital = await prisma.hospital.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              users: true,
              doctors: true,
              patients: true,
              appointments: true,
              departments: true,
            },
          },
        },
      });

      if (!hospital) {
        throw new AppError('Hospital not found', 404);
      }

      // Attach primary admin user (single-source-of-truth for owner identity).
      const primaryAdmin = hospital.primaryAdminId
        ? await prisma.user.findUnique({
            where: { id: hospital.primaryAdminId },
            select: {
              id: true,
              username: true,
              email: true,
              firstName: true,
              lastName: true,
              phone: true,
              isActive: true,
            },
          })
        : null;
      (hospital as any).primaryAdmin = primaryAdmin;

      return {
        success: true,
        data: hospital,
      };
    } catch (error: any) {
      logger.error('Failed to fetch hospital', error);
      rethrowServiceError(error);
    }
  }

  // Update hospital
  async updateHospital(id: string, data: UpdateHospitalData, currentUser?: any) {
    try {
      const hospital = await prisma.hospital.findUnique({
        where: { id },
      });

      if (!hospital) {
        throw new AppError('Hospital not found', 404);
      }

      // Tenant guard: hospital ADMIN can only update their own hospital row.
      // SUPER_ADMIN can update any hospital. Plan/limits/status are still
      // server-controlled below so ADMIN cannot escalate their own tier.
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (currentUser.hospitalId !== id) {
          throw new AppError('You can only update your own hospital', 403);
        }
        // ADMIN may not change plan/limits/status/active flag from this endpoint.
        delete (data as any).plan;
        delete (data as any).status;
        delete (data as any).isActive;
      }

      // Strip fields that are NEVER settable from the API:
      //  - hospital code (server-generated only)
      //  - legacy ownerName/Email/Phone (derived from primary admin)
      //  - platform-level ABDM creds (env-only per ABDM docs)
      delete (data as any).code;
      delete (data as any).ownerName;
      delete (data as any).ownerEmail;
      delete (data as any).ownerPhone;
      delete (data as any).abdmClientId;
      delete (data as any).abdmClientSecret;
      delete (data as any).abdmCallbackUrl;

      // Pull admin-side edits out of the hospital payload — applied below
      // against the linked primary-admin user row.
      const adminFirstName = (data.adminFirstName ?? '').trim();
      const adminLastName = (data.adminLastName ?? '').trim();
      const adminPhone = (data.adminPhone ?? '').trim();
      const adminUsername = (data.adminUsername ?? '').trim();
      const adminPasswordRaw = data.adminPassword ?? '';
      delete data.adminFirstName;
      delete data.adminLastName;
      delete data.adminPhone;
      delete data.adminUsername;
      delete data.adminPassword;

      // Normalize uppercase identifiers if changed.
      if (data.gstNumber) data.gstNumber = data.gstNumber.toUpperCase();
      if (data.panNumber) data.panNumber = data.panNumber.toUpperCase();

      // Email change must propagate to BOTH hospital.email AND the primary
      // admin user's email (they're the same logical contact).
      const emailChanging = !!(data.email && data.email !== hospital.email);
      if (emailChanging) {
        const dup = await prisma.hospital.findUnique({ where: { email: data.email! } });
        if (dup && dup.id !== id) throw new AppError('Another hospital already uses this email', 409);
        const dupUser = await prisma.user.findUnique({ where: { email: data.email! } });
        if (dupUser && dupUser.id !== hospital.primaryAdminId) {
          throw new AppError('This email is already registered as a user', 409);
        }
      }

      // Check registration number uniqueness if changing
      if (data.registrationNumber && data.registrationNumber !== hospital.registrationNumber) {
        const dup = await prisma.hospital.findUnique({ where: { registrationNumber: data.registrationNumber } });
        if (dup) throw new AppError('Another hospital already uses this registration number', 409);
      }

      // Username uniqueness on admin side
      if (adminUsername && hospital.primaryAdminId) {
        const dupUsername = await prisma.user.findUnique({ where: { username: adminUsername } });
        if (dupUsername && dupUsername.id !== hospital.primaryAdminId) {
          throw new AppError('Admin username is already taken', 409);
        }
      }

      // Persist hospital row first.
      const updatedHospital = await prisma.hospital.update({
        where: { id },
        data: {
          ...data,
          // Keep legacy owner columns aligned with the admin identity.
          ...(emailChanging ? { ownerEmail: data.email } : {}),
          ...(adminPhone ? { ownerPhone: adminPhone } : {}),
          ...(adminFirstName || adminLastName
            ? {
                ownerName: `${adminFirstName || ''} ${adminLastName || ''}`.trim()
                  || hospital.ownerName,
              }
            : {}),
        },
      });

      // Propagate admin edits to the linked user row.
      if (hospital.primaryAdminId) {
        const userUpdate: any = {};
        if (adminFirstName) userUpdate.firstName = adminFirstName;
        if (adminLastName) userUpdate.lastName = adminLastName;
        if (adminPhone) userUpdate.phone = adminPhone;
        if (adminUsername) userUpdate.username = adminUsername;
        if (emailChanging) userUpdate.email = data.email;
        if (adminPasswordRaw && adminPasswordRaw.length > 0) {
          if (adminPasswordRaw.length < 8) {
            throw new AppError('Admin password must be at least 8 characters', 422);
          }
          userUpdate.password = await bcrypt.hash(adminPasswordRaw, 10);
        }
        if (Object.keys(userUpdate).length > 0) {
          await prisma.user.update({ where: { id: hospital.primaryAdminId }, data: userUpdate });
        }
      }

      logger.info('Hospital updated successfully', { hospitalId: id });

      return {
        success: true,
        data: updatedHospital,
        message: 'Hospital updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update hospital', error);
      rethrowServiceError(error);
    }
  }

  // Update hospital plan
  async updateHospitalPlan(id: string, plan: string, billingCycle?: string) {
    try {
      const hospital = await prisma.hospital.findUnique({
        where: { id },
      });

      if (!hospital) {
        throw new AppError('Hospital not found', 404);
      }

      const planLimits = this.getPlanLimits(plan);

      const updateData: any = {
        plan,
        maxUsers: planLimits.maxUsers,
        maxDoctors: planLimits.maxDoctors,
        maxPatients: planLimits.maxPatients,
        maxStorage: planLimits.maxStorage,
      };

      if (billingCycle) {
        updateData.billingCycle = billingCycle;
      }

      // If upgrading from trial/free, set subscription dates
      if (plan !== 'FREE' && hospital.status === 'TRIAL') {
        updateData.status = 'ACTIVE';
        updateData.subscriptionStartedAt = new Date();
        
        const subscriptionEndsAt = new Date();
        if (billingCycle === 'MONTHLY') {
          subscriptionEndsAt.setMonth(subscriptionEndsAt.getMonth() + 1);
        } else if (billingCycle === 'QUARTERLY') {
          subscriptionEndsAt.setMonth(subscriptionEndsAt.getMonth() + 3);
        } else if (billingCycle === 'YEARLY') {
          subscriptionEndsAt.setFullYear(subscriptionEndsAt.getFullYear() + 1);
        }
        updateData.subscriptionEndsAt = subscriptionEndsAt;
        updateData.nextBillingDate = subscriptionEndsAt;
      }

      const updatedHospital = await prisma.hospital.update({
        where: { id },
        data: updateData,
      });

      logger.info('Hospital plan updated', { hospitalId: id, plan });

      return {
        success: true,
        data: updatedHospital,
        message: 'Hospital plan updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update hospital plan', error);
      rethrowServiceError(error);
    }
  }

  // Get hospital statistics
  async getHospitalStats() {
    try {
      const [total, active, trial, suspended, expired, byPlan] = await Promise.all([
        prisma.hospital.count(),
        prisma.hospital.count({ where: { status: 'ACTIVE' } }),
        prisma.hospital.count({ where: { status: 'TRIAL' } }),
        prisma.hospital.count({ where: { status: 'SUSPENDED' } }),
        prisma.hospital.count({ where: { status: 'EXPIRED' } }),
        prisma.hospital.groupBy({
          by: ['plan'],
          _count: true,
        }),
      ]);

      return {
        success: true,
        data: {
          total,
          byStatus: {
            active,
            trial,
            suspended,
            expired,
          },
          byPlan: byPlan.reduce((acc: any, item: any) => {
            acc[item.plan] = item._count;
            return acc;
          }, {}),
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch hospital stats', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Per-hospital performance snapshot for the Hospital Performance page.
   * Aggregates volume + ABDM adoption + clinical activity + revenue across
   * the patient / doctor / appointment / encounter / admission / payment
   * tables, plus a 7-day trend for the most useful series.
   *
   * Auth scoping:
   *   - SUPER_ADMIN: any hospital.
   *   - ADMIN: only their own hospital (403 otherwise).
   */
  async getHospitalPerformance(hospitalId: string, currentUser?: any) {
    try {
      const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });
      if (!hospital) throw new AppError('Hospital not found', 404);

      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (currentUser.hospitalId !== hospitalId) {
          throw new AppError('Access denied', 403);
        }
      }

      // IST-anchored. The user expects the dashboard to switch days at
      // IST midnight regardless of which timezone the Node process is in.
      const startOfToday = istDayRange(0).start;

      const [
        totalPatients, abhaLinkedPatients, todayPatients,
        totalDoctors, hprLinkedDoctors,
        totalAppointments, todayAppointments, completedAppointments,
        totalEncounters, completedEncounters,
        totalAdmissions, activeAdmissions, dischargedAdmissions,
        totalBeds, occupiedBeds,
        revenue30d, paymentCount30d,
      ] = await Promise.all([
        prisma.patient.count({ where: { hospitalId } }),
        prisma.patient.count({ where: { hospitalId, abhaId: { not: null } } }),
        prisma.patient.count({ where: { hospitalId, createdAt: { gte: startOfToday } } }),
        prisma.doctor.count({ where: { hospitalId } }),
        prisma.doctor.count({ where: { hospitalId, hprId: { not: null } } }),
        prisma.appointment.count({ where: { hospitalId } }),
        prisma.appointment.count({ where: { hospitalId, createdAt: { gte: startOfToday } } }),
        prisma.appointment.count({ where: { hospitalId, status: 'COMPLETED' } }),
        prisma.encounter.count({ where: { patient: { hospitalId } } }),
        prisma.encounter.count({ where: { patient: { hospitalId }, status: 'COMPLETED' } }),
        prisma.admission.count({ where: { hospitalId } }),
        prisma.admission.count({
          where: { hospitalId, status: { in: ['ADMITTED', 'DISCHARGE_READY'] } },
        }),
        prisma.admission.count({ where: { hospitalId, status: 'DISCHARGED' } }),
        prisma.bed.count({ where: { ward: { hospitalId } } }),
        prisma.bed.count({ where: { ward: { hospitalId }, status: 'OCCUPIED' } }),
        prisma.payment.aggregate({
          where: {
            hospitalId,
            status: 'PAID',
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          _sum: { amount: true },
        }),
        prisma.payment.count({
          where: {
            hospitalId,
            status: 'PAID',
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        }),
      ]);

      // 7-day trend — patients registered, encounters opened, admissions opened.
      const trend: Array<{
        date: string;
        patients: number;
        encounters: number;
        admissions: number;
      }> = [];
      for (let i = 6; i >= 0; i--) {
        const { start: dayStart, end: dayEnd, label: dateLabel } = istDayRange(i);
        const [pts, enc, adm] = await Promise.all([
          prisma.patient.count({
            where: { hospitalId, createdAt: { gte: dayStart, lte: dayEnd } },
          }),
          prisma.encounter.count({
            where: { patient: { hospitalId }, createdAt: { gte: dayStart, lte: dayEnd } },
          }),
          prisma.admission.count({
            where: { hospitalId, admittedAt: { gte: dayStart, lte: dayEnd } },
          }),
        ]);
        trend.push({ date: dateLabel, patients: pts, encounters: enc, admissions: adm });
      }

      // Doctor specialisation distribution (top 6).
      const specGrouping = await prisma.doctor.groupBy({
        by: ['specialization'],
        where: { hospitalId },
        _count: true,
      });
      const specializations = specGrouping
        .filter((s) => s.specialization)
        .sort((a, b) => (b._count as any) - (a._count as any))
        .slice(0, 6)
        .map((s) => ({ name: s.specialization || 'Unknown', count: s._count as any }));

      const abhaPercent = totalPatients > 0
        ? Math.round((abhaLinkedPatients / totalPatients) * 100)
        : 0;
      const hprPercent = totalDoctors > 0
        ? Math.round((hprLinkedDoctors / totalDoctors) * 100)
        : 0;
      const occupancyPercent = totalBeds > 0
        ? Math.round((occupiedBeds / totalBeds) * 100)
        : 0;

      return {
        success: true,
        data: {
          hospital: {
            id: hospital.id,
            name: hospital.name,
            code: hospital.code,
            type: hospital.type,
            city: (hospital as any).city,
            state: (hospital as any).state,
            phone: hospital.phone,
            email: hospital.email,
            status: hospital.status,
            isActive: hospital.isActive,
            abdmEnabled: (hospital as any).abdmEnabled || false,
            hipId: hospital.hipId,
            hiuId: hospital.hiuId,
            createdAt: hospital.createdAt,
          },
          summary: {
            totalPatients,
            abhaLinkedPatients,
            abhaPercent,
            todayPatients,
            totalDoctors,
            hprLinkedDoctors,
            hprPercent,
            totalAppointments,
            todayAppointments,
            completedAppointments,
            totalEncounters,
            completedEncounters,
            totalAdmissions,
            activeAdmissions,
            dischargedAdmissions,
            totalBeds,
            occupiedBeds,
            occupancyPercent,
            revenue30d: Number((revenue30d as any)?._sum?.amount || 0),
            paymentCount30d,
          },
          trend,
          specializations,
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch hospital performance', error);
      rethrowServiceError(error);
    }
  }

  // Delete hospital (soft delete - mark as inactive)
  async deleteHospital(id: string) {
    try {
      const hospital = await prisma.hospital.findUnique({
        where: { id },
      });

      if (!hospital) {
        throw new AppError('Hospital not found', 404);
      }

      // Soft delete - just mark as inactive
      const deletedHospital = await prisma.hospital.update({
        where: { id },
        data: { 
          isActive: false,
          status: 'SUSPENDED',
        },
      });

      logger.info('Hospital deleted (soft)', { hospitalId: id });

      return {
        success: true,
        data: deletedHospital,
        message: 'Hospital deleted successfully',
      };
    } catch (error: any) {
      logger.error('Failed to delete hospital', error);
      rethrowServiceError(error);
    }
  }

  // Update hospital schedule configuration
  async updateSchedule(
    id: string,
    data: {
      operatingHours?: any;
      defaultSlotDuration?: number;
      breakTimes?: any;
      holidays?: string[];
      is24x7?: boolean;
    },
    currentUser?: any,
  ) {
    const hospital = await prisma.hospital.findUnique({ where: { id } });
    if (!hospital) throw new AppError('Hospital not found', 404);

    // Multi-tenant guard: only SUPER_ADMIN may modify any hospital, ADMIN
    // may modify only their own hospital. Other roles are blocked at the
    // route level by `authorize`, but we re-check here defensively.
    if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      if (!currentUser.hospitalId || currentUser.hospitalId !== id) {
        throw new AppError('Access denied: Cannot modify another hospital\'s schedule', 403);
      }
    }

    if (data.defaultSlotDuration && ![10, 15, 20, 30, 45, 60].includes(data.defaultSlotDuration)) {
      throw new AppError('Slot duration must be 10, 15, 20, 30, 45, or 60 minutes', 400);
    }

    const updateData: any = {};
    if (data.operatingHours !== undefined) updateData.operatingHours = data.operatingHours;
    if (data.defaultSlotDuration !== undefined) updateData.defaultSlotDuration = data.defaultSlotDuration;
    if (data.breakTimes !== undefined) updateData.breakTimes = data.breakTimes;
    if (data.holidays !== undefined) updateData.holidays = data.holidays;
    if (data.is24x7 !== undefined) updateData.is24x7 = data.is24x7;

    const updated = await prisma.hospital.update({ where: { id }, data: updateData });
    logger.info('Hospital schedule updated', { hospitalId: id });
    return { success: true, data: updated, message: 'Schedule updated successfully' };
  }

  // Get hospital schedule configuration
  async getSchedule(id: string, currentUser?: any) {
    const hospital = await prisma.hospital.findUnique({
      where: { id },
      select: {
        id: true, name: true, operatingHours: true, defaultSlotDuration: true,
        breakTimes: true, holidays: true, is24x7: true,
      },
    });
    if (!hospital) throw new AppError('Hospital not found', 404);

    // Multi-tenant guard: non-SUPER_ADMIN can only read their own hospital's
    // schedule. The schedule includes operating hours / holidays / break
    // times that are otherwise treated as internal config.
    if (
      currentUser &&
      currentUser.role !== 'SUPER_ADMIN' &&
      currentUser.hospitalId !== id
    ) {
      throw new AppError('Hospital not found', 404);
    }

    return { success: true, data: hospital };
  }

  // Helper: Generate unique hospital code
  private generateHospitalCode(name: string): string {
    const prefix = name
      .split(' ')
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .substring(0, 3);
    
    const timestamp = Date.now().toString().slice(-6);
    return `${prefix}${timestamp}`;
  }

  // Helper: Get plan limits
  private getPlanLimits(plan: string) {
    const limits: any = {
      FREE: {
        maxUsers: 5,
        maxDoctors: 3,
        maxPatients: 100,
        maxStorage: 1024, // 1 GB
      },
      BASIC: {
        maxUsers: 20,
        maxDoctors: 10,
        maxPatients: 1000,
        maxStorage: 5120, // 5 GB
      },
      PROFESSIONAL: {
        maxUsers: 50,
        maxDoctors: 30,
        maxPatients: 5000,
        maxStorage: 20480, // 20 GB
      },
      ENTERPRISE: {
        maxUsers: 999,
        maxDoctors: 999,
        maxPatients: 999999,
        maxStorage: 102400, // 100 GB
      },
    };

    return limits[plan] || limits.FREE;
  }
}

export default new HospitalService();
