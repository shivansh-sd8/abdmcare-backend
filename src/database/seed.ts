import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Create Super Admin
  console.log('👤 Creating Super Admin...');
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
      type: 'MULTI_SPECIALTY',
      addressLine1: '123 Healthcare Street',
      addressLine2: 'Medical District',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      pincode: '400001',
      phone: '+91-22-12345678',
      email: 'info@medisync-hospital.com',
      plan: 'PROFESSIONAL',
      status: 'ACTIVE',
      abdmEnabled: true,
      hipId: 'MGH001@hip',
      hiuId: 'MGH001@hiu',
      maxUsers: 50,
      maxDoctors: 30,
      maxPatients: 5000,
      maxStorage: 20480,
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

  // Create Sample Patients
  console.log('\n👥 Creating sample patients...');
  
  const patient1 = await prisma.patient.create({
    data: {
      uhid: 'UH000001',
      firstName: 'Rajesh',
      lastName: 'Kumar',
      gender: 'MALE',
      dob: new Date('1985-05-15'),
      mobile: '+91-9876543211',
      email: 'rajesh.kumar@example.com',
      bloodGroup: 'O+',
      address: {
        line1: '45 MG Road',
        line2: 'Andheri West',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400058',
      },
      emergencyContact: {
        name: 'Priya Kumar',
        relationship: 'Wife',
        mobile: '+91-9876543212',
      },
      hospitalId: hospital.id,
    },
  });

  const patient2 = await prisma.patient.create({
    data: {
      uhid: 'UH000002',
      firstName: 'Priya',
      lastName: 'Sharma',
      gender: 'FEMALE',
      dob: new Date('1990-08-22'),
      mobile: '+91-9876543213',
      email: 'priya.sharma@example.com',
      bloodGroup: 'A+',
      address: {
        line1: '12 Park Street',
        line2: 'Bandra East',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400051',
      },
      emergencyContact: {
        name: 'Amit Sharma',
        relationship: 'Husband',
        mobile: '+91-9876543214',
      },
      hospitalId: hospital.id,
    },
  });

  const patient3 = await prisma.patient.create({
    data: {
      uhid: 'UH000003',
      firstName: 'Mohammed',
      lastName: 'Ali',
      gender: 'MALE',
      dob: new Date('1978-12-10'),
      mobile: '+91-9876543215',
      email: 'mohammed.ali@example.com',
      bloodGroup: 'B+',
      address: {
        line1: '78 Station Road',
        line2: 'Kurla West',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400070',
      },
      emergencyContact: {
        name: 'Fatima Ali',
        relationship: 'Wife',
        mobile: '+91-9876543216',
      },
      hospitalId: hospital.id,
    },
  });

  console.log('✅ Created 3 sample patients');

  // Create Sample Appointments
  console.log('\n📅 Creating sample appointments...');
  
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);

  const dayAfterTomorrow = new Date(now);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
  dayAfterTomorrow.setHours(14, 30, 0, 0);

  // Appointment 1 - SCHEDULED (Ready for check-in)
  await prisma.appointment.create({
    data: {
      appointmentId: `APT-${Date.now()}-001`,
      patientId: patient1.id,
      doctorId: doctor.id,
      hospitalId: hospital.id,
      scheduledAt: tomorrow,
      duration: 30,
      type: 'OPD',
      status: 'SCHEDULED',
      notes: 'Fever and cough for 3 days',
    },
  });

  // Appointment 2 - SCHEDULED
  await prisma.appointment.create({
    data: {
      appointmentId: `APT-${Date.now()}-002`,
      patientId: patient2.id,
      doctorId: doctor.id,
      hospitalId: hospital.id,
      scheduledAt: dayAfterTomorrow,
      duration: 30,
      type: 'OPD',
      status: 'SCHEDULED',
      notes: 'Routine checkup',
    },
  });

  // Appointment 3 - SCHEDULED
  await prisma.appointment.create({
    data: {
      appointmentId: `APT-${Date.now()}-003`,
      patientId: patient3.id,
      doctorId: doctor.id,
      hospitalId: hospital.id,
      scheduledAt: dayAfterTomorrow,
      duration: 30,
      type: 'OPD',
      status: 'SCHEDULED',
      notes: 'Diabetes follow-up',
    },
  });

  console.log('✅ Created 3 sample appointments');
  console.log(`   - Appointment 1: ${patient1.firstName} ${patient1.lastName} - ${tomorrow.toLocaleString()}`);
  console.log(`   - Appointment 2: ${patient2.firstName} ${patient2.lastName} - ${dayAfterTomorrow.toLocaleString()}`);
  console.log(`   - Appointment 3: ${patient3.firstName} ${patient3.lastName} - ${dayAfterTomorrow.toLocaleString()}`);

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
