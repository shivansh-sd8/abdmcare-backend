import bcrypt from 'bcryptjs';
import prisma from '../../common/config/database';
import { generateToken, generateRefreshToken } from '../../common/middleware/auth';
import { AppError } from '../../common/middleware/errorHandler';

interface RegisterData {
  email: string;
  password: string;
  username: string;
  firstName: string;
  lastName: string;
  role?: 'SUPER_ADMIN' | 'ADMIN' | 'DOCTOR' | 'NURSE' | 'RECEPTIONIST' | 'LAB_TECHNICIAN' | 'PHARMACIST';
  hospitalId?: string;
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
      },
      token,
      refreshToken,
    };
  }

  async superAdminSignup(data: RegisterData, secretKey: string) {
    // Validate secret key
    const SUPER_ADMIN_SECRET = process.env.SUPER_ADMIN_SECRET_KEY || 'medisync-super-secret-2026';
    
    if (secretKey !== SUPER_ADMIN_SECRET) {
      throw new AppError('Invalid secret key', 403);
    }

    // Check if any super admin already exists
    const existingSuperAdmin = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' },
    });

    if (existingSuperAdmin) {
      throw new AppError('Super Admin already exists. Contact existing Super Admin for access.', 409);
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new AppError('Email already registered', 409);
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        password: hashedPassword,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        role: 'SUPER_ADMIN',
        hospitalId: null,
      },
    });

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      hospitalId: undefined,
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

    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new AppError('User already exists', 409);
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        password: hashedPassword,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        role: data.role || 'RECEPTIONIST',
        hospitalId,
      },
    });

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

  async refreshToken(_refreshToken: string) {
    const token = generateToken({
      id: 'temp',
      email: 'temp@example.com',
      role: 'RECEPTIONIST',
    });

    return { token };
  }

  async getAllUsers(currentUser: any) {
    const where: any = {};
    
    // ADMIN can only see users from their hospital
    if (currentUser.role === 'ADMIN' && currentUser.hospitalId) {
      where.hospitalId = currentUser.hospitalId;
    }
    // SUPER_ADMIN sees all users

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

    const user = await prisma.user.update({
      where: { id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        role: data.role,
        hospitalId: data.hospitalId,
      },
      select: {
        id: true,
        username: true,
        email: true,
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
}
