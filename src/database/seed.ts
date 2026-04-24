import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

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

  console.log('✅ Super Admin created:', {
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

  console.log('✅ Sample Hospital created:', {
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

  console.log('✅ Hospital Admin created:', {
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

  console.log('✅ Receptionist created:', {
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

  console.log('✅ Facility created:', {
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

  console.log('✅ Department created:', {
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

  console.log('✅ Doctor created:', {
    name: `Dr. ${doctor.firstName} ${doctor.lastName}`,
    specialization: doctor.specialization,
  });

  console.log('\n🎉 Database seeded successfully!\n');
  console.log('📋 Login Credentials:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SUPER ADMIN:');
  console.log('  Email: superadmin@medisync.com');
  console.log('  Password: Admin@123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('HOSPITAL ADMIN:');
  console.log('  Email: admin@medisync-hospital.com');
  console.log('  Password: Admin@123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('RECEPTIONIST:');
  console.log('  Email: receptionist@medisync-hospital.com');
  console.log('  Password: Recep@123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('DOCTOR:');
  console.log('  Email: doctor@medisync-hospital.com');
  console.log('  Password: Doctor@123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
