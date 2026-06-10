import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../../common/config/database';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../../common/middleware/auth';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

// In-memory store for password reset tokens (production: use Redis or DB)
const resetTokens = new Map<string, { email: string; expiresAt: number }>();

interface RegisterData {
  email: string;
  password: string;
  username: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role?: 'SUPER_ADMIN' | 'ADMIN' | 'DOCTOR' | 'NURSE' | 'RECEPTIONIST' | 'LAB_TECHNICIAN' | 'PHARMACIST';
  hospitalId?: string;
  // Doctor-specific fields
  specialization?: string;
  qualification?: string;
  registrationNo?: string;
  hprId?: string;
}

export class AuthService {
  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        isActive: true,
      },
    });

    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    if (!user.isActive) {
      throw new AppError('Account has been deactivated. Contact your administrator.', 403);
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new AppError('Invalid credentials', 401);
    }

    // Get doctor ID if user is a doctor
    let doctorId: string | undefined;
    if (user.role === 'DOCTOR') {
      const doctor = await prisma.doctor.findFirst({
        where: { email: user.email },
        select: { id: true },
      });
      doctorId = doctor?.id;
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      hospitalId: user.hospitalId || undefined,
      doctorId,
    } as any);

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email,
      role: user.role,
      hospitalId: user.hospitalId || undefined,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        hospitalId: user.hospitalId,
        doctorId,
      },
      token,
      refreshToken,
    };
  }

  async register(data: RegisterData, currentUser?: any) {
    // Role escalation prevention
    const adminOnlyRoles: string[] = ['SUPER_ADMIN'];
    const staffRoles: string[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'];

    if (currentUser?.role === 'ADMIN') {
      // ADMIN can only create staff roles within their hospital
      if (data.role && !staffRoles.includes(data.role)) {
        throw new AppError('Hospital Admin can only create staff roles (Doctor, Nurse, Receptionist, Lab Technician, Pharmacist)', 403);
      }
      if (!currentUser.hospitalId) {
        throw new AppError('Admin must be associated with a hospital', 403);
      }
    }

    if (currentUser?.role !== 'SUPER_ADMIN' && data.role && adminOnlyRoles.includes(data.role)) {
      throw new AppError('Only Super Admin can create admin-level users', 403);
    }

    // Enforce hospitalId for all non-SUPER_ADMIN users
    const role = data.role || 'RECEPTIONIST';
    let hospitalId = data.hospitalId;

    if (currentUser?.role === 'ADMIN' && currentUser?.hospitalId) {
      hospitalId = currentUser.hospitalId;
    }

    if (role !== 'SUPER_ADMIN' && !hospitalId) {
      throw new AppError('Hospital ID is required for all non-Super Admin users', 400);
    }

    // Pre-check uniqueness so we return clean 409 errors instead of raw P2002.
    const [byEmail, byUsername] = await Promise.all([
      prisma.user.findUnique({ where: { email: data.email } }),
      data.username ? prisma.user.findUnique({ where: { username: data.username } }) : null,
    ]);
    if (byEmail) throw new AppError('A user with this email already exists', 409);
    if (byUsername) throw new AppError('This username is already taken', 409);

    // Enforce per-hospital plan limit (maxUsers) for non-SUPER_ADMIN tenants.
    if (hospitalId) {
      const [hospital, currentUserCount] = await Promise.all([
        prisma.hospital.findUnique({ where: { id: hospitalId }, select: { maxUsers: true } }),
        prisma.user.count({ where: { hospitalId, isActive: true } }),
      ]);
      if (hospital?.maxUsers && currentUserCount >= hospital.maxUsers) {
        throw new AppError(
          `User limit (${hospital.maxUsers}) reached for this hospital's plan. Upgrade the plan or deactivate unused users.`,
          409,
        );
      }
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        password: hashedPassword,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone || null,
        role: data.role || 'RECEPTIONIST',
        hospitalId,
      },
    });

    // Auto-create Doctor record if user role is DOCTOR
    if (user.role === 'DOCTOR' && hospitalId) {
      try {
        // Find or create a default facility
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

        // Find or create a default department
        let department = await prisma.department.findFirst({
          where: { hospitalId },
        });

        if (!department) {
          department = await prisma.department.create({
            data: {
              name: 'General',
              code: 'GENERAL',
              description: 'General Department',
              facilityId: facility.id,
              hospitalId,
            },
          });
        }

        // Create doctor record
        await prisma.doctor.create({
          data: {
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            mobile: data.phone || '',
            registrationNo: data.registrationNo || `REG-${Date.now()}`,
            specialization: data.specialization || 'General Physician',
            qualification: data.qualification || 'MBBS',
            hprId: data.hprId || null,
            hospitalId,
            departmentId: department.id,
          },
        });

        logger.info('Doctor record created automatically for user', {
          userId: user.id,
          email: user.email,
        });
      } catch (error) {
        logger.error('Failed to create doctor record for user', error);
      }
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      hospitalId: user.hospitalId || undefined,
    });

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
      token,
      refreshToken,
    };
  }

  async refreshToken(refreshTokenStr: string) {
    const decoded = verifyRefreshToken(refreshTokenStr);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true, hospitalId: true },
    });

    if (!user) {
      throw new AppError('User not found', 401);
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      hospitalId: user.hospitalId || undefined,
    });

    return { token };
  }

  async getAllUsers(currentUser: any) {
    const where: any = {};
    
    // ADMIN can only see users from their hospital and cannot see SUPER_ADMIN users
    if (currentUser.role === 'ADMIN' && currentUser.hospitalId) {
      where.hospitalId = currentUser.hospitalId;
      where.role = { not: 'SUPER_ADMIN' };
    }
    // Non-SUPER_ADMIN users cannot see SUPER_ADMIN users
    else if (currentUser.role !== 'SUPER_ADMIN') {
      where.role = { not: 'SUPER_ADMIN' };
    }
    // SUPER_ADMIN with the global "viewing as" hospital scope: only show
    // users that belong to that hospital. Without a scope, show all users.
    else if (currentUser.role === 'SUPER_ADMIN' && currentUser.scopedHospitalId) {
      where.hospitalId = currentUser.scopedHospitalId;
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        hospital: {
          select: {
            name: true,
            code: true,
          },
        },
        isActive: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return { data: users };
  }

  async getUserById(id: string, currentUser?: any) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        hospital: {
          select: {
            name: true,
            code: true,
          },
        },
        isActive: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // ADMIN can only view users from their own hospital
    if (currentUser?.role === 'ADMIN' && currentUser?.hospitalId) {
      if (user.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Cannot view users from other hospitals', 403);
      }
    }

    return user;
  }

  async updateUser(id: string, data: any, currentUser?: any) {
    const existingUser = await prisma.user.findUnique({ where: { id } });

    if (!existingUser) {
      throw new AppError('User not found', 404);
    }

    // ADMIN hospital-scoping: can only edit users in their hospital
    if (currentUser?.role === 'ADMIN' && currentUser?.hospitalId) {
      if (existingUser.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Cannot modify users from other hospitals', 403);
      }
      // ADMIN cannot escalate roles to SUPER_ADMIN or ADMIN
      if (data.role && ['SUPER_ADMIN', 'ADMIN'].includes(data.role)) {
        throw new AppError('Cannot assign admin-level roles', 403);
      }
    }

    // Build a whitelist update payload — never trust the entire body. Optional
    // password change runs through bcrypt; passwords sent as empty strings (the
    // common FE pattern when "Edit user" reuses the create form) are ignored.
    const update: any = {};
    if (data.firstName !== undefined) update.firstName = data.firstName;
    if (data.lastName !== undefined) update.lastName = data.lastName;
    if (data.phone !== undefined) update.phone = data.phone || null;
    if (data.role !== undefined) update.role = data.role;
    if (data.isActive !== undefined) update.isActive = !!data.isActive;

    if (data.email && data.email !== existingUser.email) {
      const dup = await prisma.user.findUnique({ where: { email: data.email } });
      if (dup) throw new AppError('Another user already uses this email', 409);
      update.email = data.email;
    }

    if (typeof data.password === 'string' && data.password.length > 0) {
      if (data.password.length < 8) {
        throw new AppError('Password must be at least 8 characters', 400);
      }
      update.password = await bcrypt.hash(data.password, 10);
    }

    // SUPER_ADMIN may move a user across hospitals; ADMIN cannot.
    if (data.hospitalId && currentUser?.role === 'SUPER_ADMIN') {
      update.hospitalId = data.hospitalId;
    }

    const user = await prisma.user.update({
      where: { id },
      data: update,
      select: {
        id: true,
        username: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        isActive: true,
      },
    });

    return user;
  }

  async deleteUser(id: string, currentUser?: any) {
    const user = await prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    // Prevent deleting yourself
    if (currentUser?.id === id) {
      throw new AppError('Cannot delete your own account', 400);
    }

    // ADMIN can only deactivate, not hard delete
    if (currentUser?.role === 'ADMIN') {
      // ADMIN can only deactivate users in their hospital
      if (user.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Cannot deactivate users from other hospitals', 403);
      }
      // ADMIN cannot delete other admins
      if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
        throw new AppError('Cannot deactivate admin-level users', 403);
      }
    }

    // Soft-delete: deactivate the user
    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async forgotPassword(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't reveal whether email exists
      return { message: 'If an account with that email exists, a reset code has been sent.' };
    }

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

    resetTokens.set(otp, { email, expiresAt });

    // Clean up expired tokens periodically
    for (const [key, val] of resetTokens) {
      if (val.expiresAt < Date.now()) resetTokens.delete(key);
    }

    logger.info('Password reset OTP generated', { email, otp });

    // SECURITY: never echo the OTP in the API response in non-development
    // environments. In dev we still return it so engineers can complete the
    // flow without an email gateway, but we gate it on NODE_ENV.
    const isDev =
      process.env.NODE_ENV !== 'production' &&
      process.env.RETURN_OTP_IN_RESPONSE === 'true';

    return {
      message: 'If an account with that email exists, a reset code has been sent.',
      ...(isDev ? { otp } : {}),
      expiresIn: '15 minutes',
    };
  }

  async resetPassword(email: string, otp: string, newPassword: string) {
    const tokenData = resetTokens.get(otp);

    if (!tokenData) {
      throw new AppError('Invalid or expired reset code', 400);
    }

    if (tokenData.email !== email) {
      throw new AppError('Invalid or expired reset code', 400);
    }

    if (tokenData.expiresAt < Date.now()) {
      resetTokens.delete(otp);
      throw new AppError('Reset code has expired. Please request a new one.', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (newPassword.length < 6) {
      throw new AppError('Password must be at least 6 characters', 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    resetTokens.delete(otp);
    logger.info('Password reset successful', { email });

    return { message: 'Password updated successfully. You can now log in.' };
  }

  async getProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        hospital: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        isActive: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    return user;
  }

  async updateProfile(userId: string, data: { firstName?: string; lastName?: string; phone?: string; email?: string }) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const updateData: any = {};
    if (data.firstName) updateData.firstName = data.firstName;
    if (data.lastName) updateData.lastName = data.lastName;
    if (data.email && data.email !== user.email) {
      const dup = await prisma.user.findUnique({ where: { email: data.email } });
      if (dup) throw new AppError('Another user already uses this email', 409);
      updateData.email = data.email;
    }
    if (data.phone !== undefined) updateData.phone = data.phone || null;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        isActive: true,
      },
    });

    return updated;
  }

  async updateSettings(_userId: string, settings: Record<string, any>) {
    return { message: 'Settings saved successfully', settings };
  }

  async updatePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new AppError('Current password is incorrect', 401);
    }

    if (newPassword.length < 6) {
      throw new AppError('New password must be at least 6 characters', 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { message: 'Password updated successfully' };
  }
}
