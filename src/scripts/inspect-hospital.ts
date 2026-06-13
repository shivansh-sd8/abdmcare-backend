/**
 * Diagnostic — dump everything we care about for a hospital row, plus the
 * linked primary admin user and the most recent consents for any patient
 * registered there. Intended for one-shot ops use:
 *
 *   npx tsx src/scripts/inspect-hospital.ts "Abha Hospital"
 *
 * Read-only; safe to run on prod.
 */
import prisma from '../common/config/database';

const ABDM_FIELDS = [
  'hipId', 'hipName',
  'hiuId', 'hiuName',
  'hfrFacilityId',
  'abdmEnabled', 'abdmRegisteredAt',
  'abdmClientId', 'abdmClientSecret', 'abdmCallbackUrl',
] as const;

const CORE_FIELDS = [
  'id', 'name', 'code', 'email', 'phone',
  'addressLine1', 'city', 'state', 'pincode',
  'isActive', 'isVerified', 'status', 'plan',
  'onboardingCompleted', 'onboardingStep',
  'primaryAdminId',
  'ownerName', 'ownerEmail', 'ownerPhone',
  'createdAt', 'updatedAt',
] as const;

async function main() {
  const nameOrCode = process.argv[2] || 'Abha Hospital';

  const hospital = await prisma.hospital.findFirst({
    where: {
      OR: [
        { name: { equals: nameOrCode, mode: 'insensitive' } },
        { code: { equals: nameOrCode, mode: 'insensitive' } },
      ],
    },
  });

  if (!hospital) {
    console.log(`✗ no hospital found matching "${nameOrCode}"`);
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`HOSPITAL: ${hospital.name}  (${hospital.code})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('Core fields:');
  for (const k of CORE_FIELDS) {
    const v = (hospital as any)[k];
    console.log(`  ${k.padEnd(22)} ${v ?? '(null)'}`);
  }

  console.log('\nABDM identifiers:');
  for (const k of ABDM_FIELDS) {
    const v = (hospital as any)[k];
    console.log(`  ${k.padEnd(22)} ${v ?? '(null)'}`);
  }

  console.log('\nEnv-level ABDM (platform shared):');
  console.log(`  ABDM_HIP_ID            ${process.env.HIP_ID || process.env.ABDM_HIP_ID || '(unset)'}`);
  console.log(`  ABDM_HIU_ID            ${process.env.HIU_ID || process.env.ABDM_HIU_ID || '(unset)'}`);
  console.log(`  ABDM_CALLBACK_URL      ${process.env.ABDM_CALLBACK_URL || '(unset)'}`);
  console.log(`  ABDM_CLIENT_ID         ${process.env.ABDM_CLIENT_ID || '(unset)'}`);

  // Primary admin
  if (hospital.primaryAdminId) {
    const admin = await prisma.user.findUnique({
      where: { id: hospital.primaryAdminId },
      select: {
        id: true, username: true, email: true,
        firstName: true, lastName: true, phone: true,
        role: true, isActive: true, createdAt: true,
      },
    });
    console.log('\nPrimary admin:');
    if (admin) {
      console.log(`  id:        ${admin.id}`);
      console.log(`  username:  ${admin.username}`);
      console.log(`  email:     ${admin.email}`);
      console.log(`  name:      ${admin.firstName} ${admin.lastName}`);
      console.log(`  phone:     ${admin.phone}`);
      console.log(`  role:      ${admin.role}`);
      console.log(`  isActive:  ${admin.isActive}`);
    } else {
      console.log('  ✗ primaryAdminId set but no user row found (orphan)');
    }
  } else {
    console.log('\n✗ Primary admin: NOT LINKED (primaryAdminId is null)');
  }

  // Consents this hospital requested as HIU
  const consents = await prisma.consent.findMany({
    where: { requesterHospitalId: hospital.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      consentId: true,
      abdmConsentId: true,
      status: true,
      createdAt: true,
      grantedAt: true,
      expiresAt: true,
      hiTypes: true,
      artefactBody: true,
      artefactFetchedAt: true,
    },
  });
  console.log(`\nConsents requested by this hospital: ${consents.length}`);
  for (const c of consents) {
    const cc = (c as any).artefactBody?.careContexts;
    console.log(`  • ${c.id.slice(0, 8)}... status=${c.status} grantedAt=${c.grantedAt?.toISOString() || '-'}`);
    console.log(`      abdmConsentId: ${c.abdmConsentId || '(none)'}`);
    console.log(`      hiTypes:       ${(c.hiTypes as string[] | null)?.join(',') || '(none)'}`);
    console.log(`      artefactBody:  ${c.artefactBody ? 'present' : 'MISSING'}  (fetched ${c.artefactFetchedAt?.toISOString() || '-'})`);
    console.log(`      careContexts:  ${Array.isArray(cc) ? cc.length : '0 / not present'}`);
  }

  // Consent keypair lookups (HIU side — what the data push needs)
  // Use raw SQL so we don't crash on pre-migration databases that don't yet
  // have the requestId / transactionId columns.
  const abdmConsentIds = consents.map(c => c.abdmConsentId).filter(Boolean) as string[];
  if (abdmConsentIds.length > 0) {
    try {
      const keypairs = await prisma.$queryRawUnsafe<any[]>(
        `SELECT "consentId", "requestId", "transactionId", "createdAt"
           FROM consent_key_pairs
           WHERE "consentId" = ANY($1::text[])`,
        abdmConsentIds,
      );
      console.log(`\nIn-flight HIU keypairs: ${keypairs.length}`);
      for (const k of keypairs) {
        console.log(`  • consentId=${k.consentId}`);
        console.log(`      requestId:     ${k.requestId || '(missing — pre-fix consent)'}`);
        console.log(`      transactionId: ${k.transactionId || '(missing — on-request callback never landed)'}`);
      }
    } catch (e: any) {
      // Pre-migration schema (no requestId/transactionId columns yet).
      const msg = e?.meta?.column || e?.message || String(e);
      console.log(`\n⚠ Keypair table is pre-migration: ${msg}`);
      console.log('  → run `npx prisma migrate deploy` to apply 20260613155000_consent_keypair_request_transaction_ids');
      const legacy = await prisma.$queryRawUnsafe<any[]>(
        `SELECT "consentId", "createdAt" FROM consent_key_pairs WHERE "consentId" = ANY($1::text[])`,
        abdmConsentIds,
      );
      console.log(`  Legacy keypairs found: ${legacy.length}`);
      for (const k of legacy) {
        console.log(`    • consentId=${k.consentId}  createdAt=${k.createdAt}`);
      }
    }
  } else {
    console.log('\nNo abdmConsentId on any consent yet — skipping keypair check');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FAILED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
