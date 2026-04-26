import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import bcrypt from 'bcryptjs';

interface HospitalOnboardingData {
  // Basic Information
  name: string;
  type: string;
  
  // Contact Information
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
  
  // Admin/Owner Details (optional for SUPER_ADMIN creation)
  ownerName?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  adminUsername?: string;
  adminPassword?: string;
  adminFirstName?: string;
  adminLastName?: string;
  
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
  ownerName?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  totalBeds?: number;
  icuBeds?: number;
  emergencyBeds?: number;
  operationTheaters?: number;
  services?: string[];
  specialties?: string[];
  plan?: any;
  status?: any;
  isActive?: boolean;
}

export class HospitalService {
  // Onboard a new hospital
  async onboardHospital(data: HospitalOnboardingData) {
    try {
      logger.info('Starting hospital onboarding', { name: data.name, email: data.email });

      // Check if hospital email already exists
      const existingHospital = await prisma.hospital.findUnique({
        where: { email: data.email },
      });

      if (existingHospital) {
        throw new AppError('Hospital with this email already exists', 400);
      }

      // Check if admin email already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: data.ownerEmail },
      });

      if (existingUser) {
        throw new AppError('Admin email already registered', 400);
      }

      // Generate unique hospital code
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
          gstNumber: data.gstNumber,
          panNumber: data.panNumber,
          licenseNumber: data.licenseNumber,
          establishedYear: data.establishedYear ? parseInt(data.establishedYear.toString()) : null,
          
          // Admin/Owner Details
          ownerName: data.ownerName,
          ownerEmail: data.ownerEmail,
          ownerPhone: data.ownerPhone,
          
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
          
          // Onboarding
          onboardingStep: 1,
          onboardingCompleted: false,
        },
      });

      // Create primary admin user only if admin details are provided
      let adminUser = null;
      if (data.adminUsername && data.adminPassword && data.adminFirstName && data.adminLastName) {
        const hashedPassword = await bcrypt.hash(data.adminPassword, 10);

        adminUser = await prisma.user.create({
          data: {
            username: data.adminUsername,
            email: data.ownerEmail || data.email,
            password: hashedPassword,
            firstName: data.adminFirstName,
            lastName: data.adminLastName,
            role: 'ADMIN',
            hospitalId: hospital.id,
            isActive: true,
          },
        });

        // Update hospital with primary admin ID
        await prisma.hospital.update({
          where: { id: hospital.id },
          data: { primaryAdminId: adminUser.id },
        });
      }

      logger.info('Hospital onboarded successfully', {
        hospitalId: hospital.id,
        hospitalCode: hospital.code,
        adminUserId: adminUser?.id,
      });

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
          admin: adminUser ? {
            id: adminUser.id,
            username: adminUser.username,
            email: adminUser.email,
            role: adminUser.role,
          } : null,
        },
        message: 'Hospital onboarded successfully',
      };
    } catch (error: any) {
      logger.error('Failed to onboard hospital', error);
      throw new AppError(
        error.message || 'Failed to onboard hospital',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to fetch hospitals',
        error.statusCode || 500
      );
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

      return {
        success: true,
        data: hospital,
      };
    } catch (error: any) {
      logger.error('Failed to fetch hospital', error);
      throw new AppError(
        error.message || 'Failed to fetch hospital',
        error.statusCode || 500
      );
    }
  }

  // Update hospital
  async updateHospital(id: string, data: UpdateHospitalData) {
    try {
      const hospital = await prisma.hospital.findUnique({
        where: { id },
      });

      if (!hospital) {
        throw new AppError('Hospital not found', 404);
      }

      const updatedHospital = await prisma.hospital.update({
        where: { id },
        data,
      });

      logger.info('Hospital updated successfully', { hospitalId: id });

      return {
        success: true,
        data: updatedHospital,
        message: 'Hospital updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update hospital', error);
      throw new AppError(
        error.message || 'Failed to update hospital',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to update hospital plan',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to fetch hospital stats',
        error.statusCode || 500
      );
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
      throw new AppError(
        error.message || 'Failed to delete hospital',
        error.statusCode || 500
      );
    }
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
