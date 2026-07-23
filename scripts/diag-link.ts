/**
 * Diagnostic: inspect patient ABHA identity, care-context link status, and the
 * last ABDM API calls related to linking (generate-token / link/carecontext).
 * Run: npx ts-node scripts/diag-link.ts
 */
import prisma from '../src/common/config/database';

async function main() {
  console.log('\n===== PATIENTS WITH ABHA =====');
  const patients = await prisma.patient.findMany({
    where: { OR: [{ abhaNumber: { not: null } }, { abhaAddress: { not: null } }, { abhaId: { not: null } }] },
    include: { abhaRecord: true, careContexts: true, encounters: { select: { id: true, visitDate: true, type: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  if (!patients.length) console.log('  (none — no patient has any ABHA identifier!)');

  for (const p of patients) {
    console.log(`\n• ${p.firstName} ${p.lastName}  [${p.uhid}]  id=${p.id}`);
    console.log(`    abhaId=${p.abhaId}  abhaNumber=${p.abhaNumber}  abhaAddress=${p.abhaAddress}`);
    console.log(`    abhaRecord: number=${p.abhaRecord?.abhaNumber}  address=${p.abhaRecord?.abhaAddress}`);
    console.log(`    encounters: ${p.encounters.length}  | careContexts: ${p.careContexts.length}`);
    for (const cc of p.careContexts) {
      console.log(`      - cc ${cc.careContextId} | status=${cc.linkStatus} | token=${cc.linkToken ? 'YES' : 'no'} | "${cc.display}"`);
    }
  }

  console.log('\n===== LAST 15 ABDM TRANSACTIONS (linking/consent related) =====');
  const txns = await prisma.abdmTransaction.findMany({
    orderBy: { timestamp: 'desc' },
    take: 40,
  });
  const relevant = txns.filter(t =>
    /generate-token|carecontext|link|consent|token/i.test(t.apiEndpoint || '')
  ).slice(0, 15);

  if (!relevant.length) console.log('  (no linking/consent calls logged yet)');

  for (const t of relevant) {
    console.log(`\n[${t.timestamp.toISOString()}] ${t.method} ${t.apiEndpoint}`);
    console.log(`   status=${t.statusCode} success=${t.success} err=${t.errorMessage || '-'}`);
    const req = JSON.stringify(t.requestPayload)?.slice(0, 400);
    const resp = JSON.stringify(t.responsePayload)?.slice(0, 600);
    console.log(`   REQ : ${req}`);
    console.log(`   RESP: ${resp}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
