/**
 * ABDM seed script (NEW — does not touch the old seed.ts).
 *
 * Creates a minimal, ABDM-ready dataset:
 *   - 1 Super Admin
 *   - 1 Hospital wired with the real sandbox HIP/HIU id (IN2910002104)
 *   - 1 Facility + 2 Departments
 *   - 2 Doctors (each with a linked DOCTOR user account)
 *   - 1 each of the remaining staff roles: ADMIN, NURSE, RECEPTIONIST,
 *     LAB_TECHNICIAN, PHARMACIST
 *
 * Run:  npx ts-node src/database/seed-abdm.ts
 *       (or)  npm run seed:abdm
 */
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Real ABDM sandbox identifiers (must match backend .env HIP_ID / HIU_ID).
const HIP_ID = 'IN2910002104';
const HIU_ID = 'IN2910002104';

const hash = (pwd: string) => bcrypt.hash(pwd, 10);

async function main() {
  console.log('🌱 Seeding ABDM dataset...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── 1. Super Admin (no hospital scope) ──────────────────────────────────────
  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@medisync.com' },
    update: { password: await hash('Admin@123'), role: 'SUPER_ADMIN', isActive: true },
    create: {
      email: 'superadmin@medisync.com',
      username: 'superadmin',
      password: await hash('Admin@123'),
      firstName: 'Super',
      lastName: 'Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });
  console.log('✅ Super Admin:', superAdmin.email);

  // ── 2. Hospital (real HIP/HIU id, ABDM enabled) ─────────────────────────────
  const hospital = await prisma.hospital.upsert({
    where: { code: 'STF001' },
    update: { hipId: HIP_ID, hiuId: HIU_ID, abdmEnabled: true },
    create: {
      name: 'Shivansh Test Facility',
      code: 'STF001',
      type: 'MULTI_SPECIALTY',
      email: 'info@shivansh-test-facility.com',
      phone: '+91-22-40001234',
      addressLine1: '1 Health Avenue',
      addressLine2: 'Medical District',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      pincode: '400001',
      plan: 'PROFESSIONAL',
      status: 'ACTIVE',
      // ABDM
      hipId: HIP_ID,
      hiuId: HIU_ID,
      abdmEnabled: true,
      // limits
      maxUsers: 50,
      maxDoctors: 30,
      maxPatients: 5000,
      maxStorage: 20480,
      isActive: true,
      isVerified: true,
      onboardingCompleted: true,
    },
  });
  console.log('✅ Hospital:', hospital.name, `(HIP/HIU=${HIP_ID})`);

  // ── 3. Facility + Departments (Doctor requires a department) ────────────────
  const facility = await prisma.facility.create({
    data: {
      name: hospital.name,
      type: 'HOSPITAL',
      address: { line1: '1 Health Avenue', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      contact: { phone: '+91-22-40001234', email: hospital.email },
    },
  });

  const generalMedicine = await prisma.department.upsert({
    where: { hospitalId_code: { hospitalId: hospital.id, code: 'GM001' } },
    update: {},
    create: {
      name: 'General Medicine',
      code: 'GM001',
      description: 'General Medicine Department',
      hospitalId: hospital.id,
      facilityId: facility.id,
    },
  });

  const cardiology = await prisma.department.upsert({
    where: { hospitalId_code: { hospitalId: hospital.id, code: 'CARD001' } },
    update: {},
    create: {
      name: 'Cardiology',
      code: 'CARD001',
      description: 'Cardiology Department',
      hospitalId: hospital.id,
      facilityId: facility.id,
    },
  });
  console.log('✅ Facility + Departments: General Medicine, Cardiology');

  // ── 4. Two Doctors (each with a linked DOCTOR user account) ─────────────────
  const doctorSeeds = [
    {
      firstName: 'Aarav', lastName: 'Mehta', specialization: 'General Medicine',
      qualification: 'MBBS, MD', registrationNo: 'MCI-STF-0001', mobile: '+91-9810000001',
      email: 'aarav.mehta@shivansh-test-facility.com', username: 'dr.aarav',
      departmentId: generalMedicine.id,
    },
    {
      firstName: 'Isha', lastName: 'Verma', specialization: 'Cardiology',
      qualification: 'MBBS, DM (Cardiology)', registrationNo: 'MCI-STF-0002', mobile: '+91-9810000002',
      email: 'isha.verma@shivansh-test-facility.com', username: 'dr.isha',
      departmentId: cardiology.id,
    },
  ];

  for (const d of doctorSeeds) {
    const docUser = await prisma.user.upsert({
      where: { email: d.email },
      update: { password: await hash('Doctor@123'), role: 'DOCTOR', hospitalId: hospital.id, isActive: true },
      create: {
        email: d.email,
        username: d.username,
        password: await hash('Doctor@123'),
        firstName: d.firstName,
        lastName: d.lastName,
        role: 'DOCTOR',
        hospitalId: hospital.id,
        departmentId: d.departmentId,
        isActive: true,
      },
    });

    await prisma.doctor.upsert({
      where: { registrationNo: d.registrationNo },
      update: { hospitalId: hospital.id, departmentId: d.departmentId, userId: docUser.id },
      create: {
        firstName: d.firstName,
        lastName: d.lastName,
        specialization: d.specialization,
        qualification: d.qualification,
        registrationNo: d.registrationNo,
        mobile: d.mobile,
        email: d.email,
        consultationFee: 500,
        hospitalId: hospital.id,
        departmentId: d.departmentId,
        userId: docUser.id,
      },
    });
    console.log(`✅ Doctor: Dr. ${d.firstName} ${d.lastName} (${d.specialization})`);
  }

  // ── 5. Other staff with proper roles ────────────────────────────────────────
  const staffSeeds: Array<{
    email: string; username: string; firstName: string; lastName: string;
    role: UserRole; password: string;
  }> = [
    { email: 'admin@shivansh-test-facility.com',        username: 'hospitaladmin', firstName: 'Hospital',  lastName: 'Admin',   role: 'ADMIN',          password: 'Admin@123' },
    { email: 'nurse@shivansh-test-facility.com',         username: 'nurse',         firstName: 'Nisha',     lastName: 'Rao',     role: 'NURSE',          password: 'Nurse@123' },
    { email: 'receptionist@shivansh-test-facility.com',  username: 'receptionist',  firstName: 'Front',     lastName: 'Desk',    role: 'RECEPTIONIST',   password: 'Recep@123' },
    { email: 'lab@shivansh-test-facility.com',           username: 'labtech',       firstName: 'Lab',       lastName: 'Tech',    role: 'LAB_TECHNICIAN', password: 'Lab@123' },
    { email: 'pharmacist@shivansh-test-facility.com',    username: 'pharmacist',    firstName: 'Pharma',    lastName: 'Cist',    role: 'PHARMACIST',     password: 'Pharma@123' },
  ];

  for (const s of staffSeeds) {
    await prisma.user.upsert({
      where: { email: s.email },
      update: { password: await hash(s.password), role: s.role, hospitalId: hospital.id, isActive: true },
      create: {
        email: s.email,
        username: s.username,
        password: await hash(s.password),
        firstName: s.firstName,
        lastName: s.lastName,
        role: s.role,
        hospitalId: hospital.id,
        isActive: true,
      },
    });
    console.log(`✅ Staff: ${s.role} — ${s.email}`);
  }

  // ── 6. Wards + Beds (IPD workflow) ──────────────────────────────────────────
  const wardSeeds: Array<{
    name: string; type: string; floor: string; dailyCharges: number;
    beds: number; bedPrefix: string;
    bedType?: string; hasOxygen?: boolean; hasVentilator?: boolean; hasMonitor?: boolean; hasSuction?: boolean;
  }> = [
    { name: 'General Ward', type: 'GENERAL', floor: '1', dailyCharges: 1500, beds: 6, bedPrefix: 'GW' },
    { name: 'ICU',          type: 'ICU',     floor: '2', dailyCharges: 5000, beds: 4, bedPrefix: 'ICU',
      bedType: 'ICU', hasOxygen: true, hasVentilator: true, hasMonitor: true, hasSuction: true },
    { name: 'Private Ward', type: 'PRIVATE', floor: '3', dailyCharges: 3000, beds: 4, bedPrefix: 'PVT' },
  ];

  for (const w of wardSeeds) {
    let ward = await prisma.ward.findFirst({ where: { hospitalId: hospital.id, name: w.name } });
    if (!ward) {
      ward = await prisma.ward.create({
        data: {
          name: w.name,
          type: w.type as any,
          floor: w.floor,
          dailyCharges: w.dailyCharges,
          totalBeds: w.beds,
          hospitalId: hospital.id,
        },
      });
    } else {
      ward = await prisma.ward.update({
        where: { id: ward.id },
        data: { type: w.type as any, floor: w.floor, dailyCharges: w.dailyCharges, totalBeds: w.beds },
      });
    }

    for (let i = 1; i <= w.beds; i++) {
      const bedNumber = `${w.bedPrefix}-${String(i).padStart(2, '0')}`;
      await prisma.bed.upsert({
        where: { wardId_bedNumber: { wardId: ward.id, bedNumber } },
        update: {},
        create: {
          bedNumber,
          wardId: ward.id,
          status: 'AVAILABLE',
          bedType: (w.bedType || 'STANDARD') as any,
          hasOxygen: !!w.hasOxygen,
          hasVentilator: !!w.hasVentilator,
          hasMonitor: !!w.hasMonitor,
          hasSuction: !!w.hasSuction,
        },
      });
    }
    console.log(`✅ Ward: ${w.name} (${w.type}) — ${w.beds} beds`);
  }

  // ── 7. Pharmacy: Medicines + stock batches (OPD/IPD dispensing) ─────────────
  const medicineSeeds: Array<{
    name: string; generic: string; category: string; strength: string;
    mrp: number; selling: number; cost: number; qty: number;
  }> = [
    { name: 'Paracetamol 500mg', generic: 'Paracetamol', category: 'TABLET',  strength: '500mg', mrp: 2,   selling: 1.8, cost: 1.0, qty: 1000 },
    { name: 'Amoxicillin 500mg',  generic: 'Amoxicillin', category: 'CAPSULE', strength: '500mg', mrp: 8,   selling: 7.0, cost: 4.5, qty: 500 },
    { name: 'Azithromycin 500mg', generic: 'Azithromycin',category: 'TABLET',  strength: '500mg', mrp: 30,  selling: 27,  cost: 18,  qty: 300 },
    { name: 'Pantoprazole 40mg',  generic: 'Pantoprazole',category: 'TABLET',  strength: '40mg',  mrp: 12,  selling: 10,  cost: 6,   qty: 400 },
    { name: 'ORS Powder',         generic: 'ORS',         category: 'POWDER',  strength: '21.8g', mrp: 22,  selling: 20,  cost: 12,  qty: 200 },
  ];

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 2);

  for (const m of medicineSeeds) {
    const medicine = await prisma.medicine.upsert({
      where: { name_hospitalId: { name: m.name, hospitalId: hospital.id } },
      update: {},
      create: {
        name: m.name,
        genericName: m.generic,
        category: m.category as any,
        strength: m.strength,
        unit: 'pcs',
        mrp: m.mrp,
        sellingPrice: m.selling,
        gstPercent: 12,
        reorderLevel: 50,
        hospitalId: hospital.id,
      },
    });

    const batchNumber = 'BATCH-2026-001';
    await prisma.inventoryBatch.upsert({
      where: { medicineId_batchNumber_hospitalId: { medicineId: medicine.id, batchNumber, hospitalId: hospital.id } },
      update: {},
      create: {
        medicineId: medicine.id,
        hospitalId: hospital.id,
        batchNumber,
        expiryDate: expiry,
        quantityReceived: m.qty,
        quantityAvailable: m.qty,
        costPrice: m.cost,
        sellingPrice: m.selling,
        mrp: m.mrp,
      },
    });
  }
  console.log(`✅ Pharmacy: ${medicineSeeds.length} medicines with stock batches`);

  // ── Credentials summary ─────────────────────────────────────────────────────
  console.log('\n🎉 ABDM seed complete!\n');
  console.log('📋 Login Credentials');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const creds: Array<[string, string, string]> = [
    ['SUPER_ADMIN',    'superadmin@medisync.com',                      'Admin@123'],
    ['ADMIN',          'admin@shivansh-test-facility.com',             'Admin@123'],
    ['DOCTOR',         'aarav.mehta@shivansh-test-facility.com',       'Doctor@123'],
    ['DOCTOR',         'isha.verma@shivansh-test-facility.com',        'Doctor@123'],
    ['NURSE',          'nurse@shivansh-test-facility.com',             'Nurse@123'],
    ['RECEPTIONIST',   'receptionist@shivansh-test-facility.com',      'Recep@123'],
    ['LAB_TECHNICIAN', 'lab@shivansh-test-facility.com',               'Lab@123'],
    ['PHARMACIST',     'pharmacist@shivansh-test-facility.com',        'Pharma@123'],
  ];
  for (const [role, email, pwd] of creds) {
    console.log(`  ${role.padEnd(14)} ${email.padEnd(46)} ${pwd}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Hospital: ${hospital.name}  |  HIP/HIU: ${HIP_ID}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => {
    console.error('❌ ABDM seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
