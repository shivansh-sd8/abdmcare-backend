/**
 * Minimal seed — creates ONLY the platform Super Admin.
 *
 *   npm run seed:superadmin
 *
 * No hospital, departments, doctors, staff, wards, beds or pharmacy stock are
 * created. Use this after a `prisma migrate reset --skip-seed` when you want a
 * clean DB with just a login to bootstrap everything else from the UI.
 *
 *   superadmin@abhaayushman.com / Admin@123
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const hash = (pwd: string) => bcrypt.hash(pwd, 10);

async function main() {
  console.log('🌱  AbhaAyushman seed — Super Admin only\n');

  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@abhaayushman.com' },
    update: {
      password: await hash('Admin@123'),
      role: 'SUPER_ADMIN',
      hospitalId: null,
      isActive: true,
    },
    create: {
      email: 'superadmin@abhaayushman.com',
      username: 'superadmin',
      password: await hash('Admin@123'),
      firstName: 'AbhaAyushman',
      lastName: 'Super Admin',
      phone: '+91-9000000000',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });

  console.log('✅ Super Admin created');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Email    : ${superAdmin.email}`);
  console.log('  Password : Admin@123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
