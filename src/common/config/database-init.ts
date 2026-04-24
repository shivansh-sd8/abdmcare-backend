import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import logger from './logger';

const prisma = new PrismaClient();

export async function initializeDatabase(): Promise<void> {
  try {
    logger.info('Initializing database...');

    // Run migrations to create tables
    logger.info('Running database migrations...');
    try {
      await prisma.$executeRawUnsafe(`SELECT 1`);
      logger.info('Database connection verified');
    } catch (error) {
      logger.error('Database connection failed:', error);
      throw error;
    }

    // Check if data already exists
    let userCount = 0;
    try {
      userCount = await prisma.user.count();
    } catch (error: any) {
      if (error.code === 'P2021') {
        logger.info('Database tables not found. Tables will be created during migration.');
        userCount = 0;
      } else {
        throw error;
      }
    }
    
    if (userCount === 0) {
      logger.info('No existing data found. Running seed...');
      await seedDatabase();
    } else {
      logger.info(`Database already contains ${userCount} users. Skipping seed.`);
    }
  } catch (error) {
    logger.error('Database initialization error:', error);
    throw error;
  }
}

async function seedDatabase(): Promise<void> {
  try {
    logger.info('🌱 Seeding database...');

    // Create Super Admin
    const hashedPassword = await bcrypt.hash('Admin@123', 10);
    
    const superAdmin = await prisma.user.upsert({
      where: { email: 'superadmin@medisync.com' },
      update: {},
      create: {
        email: 'superadmin@medisync.com',
        password: hashedPassword,
        username: 'superadmin',
        firstName: 'Super',
        lastName: 'Admin',
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });

    logger.info('✅ Super Admin created:', {
      email: superAdmin.email,
      username: superAdmin.username,
      role: superAdmin.role,
    });

    // Create a sample hospital
    const hospital = await prisma.hospital.upsert({
      where: { code: 'MGH001' },
      update: {},
      create: {
        name: 'MediSync General Hospital',
        code: 'MGH001',
        address: '123 Healthcare Street',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        phone: '+91-22-12345678',
        email: 'info@medisync-hospital.com',
        plan: 'PROFESSIONAL',
        status: 'ACTIVE',
        abdmEnabled: true,
        hipId: 'MGH001@hip',
        hiuId: 'MGH001@hiu',
        maxUsers: 50,
        maxPatients: 1000,
      },
    });

    logger.info('✅ Sample Hospital created:', {
      name: hospital.name,
      code: hospital.code,
    });

    // Create Hospital Admin
    const adminPassword = await bcrypt.hash('Admin@123', 10);
    
    const hospitalAdmin = await prisma.user.create({
      data: {
        email: 'admin@medisync-hospital.com',
        password: adminPassword,
        username: 'hospitaladmin',
        firstName: 'Hospital',
        lastName: 'Admin',
        role: 'ADMIN',
        hospitalId: hospital.id,
        isActive: true,
      },
    });

    logger.info('✅ Hospital Admin created:', {
      email: hospitalAdmin.email,
      username: hospitalAdmin.username,
      role: hospitalAdmin.role,
      hospital: hospital.name,
    });

    // Create a Receptionist
    const receptionistPassword = await bcrypt.hash('Recep@123', 10);
    
    const receptionist = await prisma.user.create({
      data: {
        email: 'receptionist@medisync-hospital.com',
        password: receptionistPassword,
        username: 'receptionist',
        firstName: 'Front',
        lastName: 'Desk',
        role: 'RECEPTIONIST',
        hospitalId: hospital.id,
        isActive: true,
      },
    });

    logger.info('✅ Receptionist created:', {
      email: receptionist.email,
      username: receptionist.username,
      role: receptionist.role,
    });

    // Create a Facility
    const facility = await prisma.facility.create({
      data: {
        name: 'MediSync General Hospital',
        type: 'HOSPITAL',
        address: {
          line1: '123 Healthcare Street',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400001',
        },
        contact: {
          phone: '+91-22-12345678',
          email: 'info@medisync-hospital.com',
        },
      },
    });

    logger.info('✅ Facility created:', {
      name: facility.name,
      type: facility.type,
    });

    // Create a Department
    const department = await prisma.department.create({
      data: {
        name: 'General Medicine',
        code: 'GM001',
        description: 'General Medicine Department',
        hospitalId: hospital.id,
        facilityId: facility.id,
      },
    });

    logger.info('✅ Department created:', {
      name: department.name,
      code: department.code,
    });

    // Create a Doctor
    const doctorPassword = await bcrypt.hash('Doctor@123', 10);
    
    await prisma.user.create({
      data: {
        email: 'doctor@medisync-hospital.com',
        password: doctorPassword,
        username: 'drsmith',
        firstName: 'John',
        lastName: 'Smith',
        role: 'DOCTOR',
        hospitalId: hospital.id,
        isActive: true,
      },
    });

    const doctor = await prisma.doctor.create({
      data: {
        firstName: 'John',
        lastName: 'Smith',
        specialization: 'General Medicine',
        qualification: 'MBBS, MD',
        registrationNo: 'MCI12345',
        mobile: '+91-9876543210',
        email: 'doctor@medisync-hospital.com',
        hospitalId: hospital.id,
        departmentId: department.id,
      },
    });

    logger.info('✅ Doctor created:', {
      name: `Dr. ${doctor.firstName} ${doctor.lastName}`,
      specialization: doctor.specialization,
    });

    logger.info('\n🎉 Database seeded successfully!\n');
    logger.info('📋 Login Credentials:');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('SUPER ADMIN:');
    logger.info('  Email: superadmin@medisync.com');
    logger.info('  Password: Admin@123');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('HOSPITAL ADMIN:');
    logger.info('  Email: admin@medisync-hospital.com');
    logger.info('  Password: Admin@123');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('RECEPTIONIST:');
    logger.info('  Email: receptionist@medisync-hospital.com');
    logger.info('  Password: Recep@123');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('DOCTOR:');
    logger.info('  Email: doctor@medisync-hospital.com');
    logger.info('  Password: Doctor@123');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    logger.error('Error seeding database:', error);
    throw error;
  }
}
