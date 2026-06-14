/**
 * One-time cleanup for `external_health_records` polluted by the pre-fix HIU
 * ingestion bug.
 *
 * Two classes of bad rows accumulated before the consent-disambiguation +
 * dedup fixes landed:
 *   1. MIS-TAGGED rows — persisted under the HIP-side bookkeeping consent, so
 *      they carry hospitalId = NULL (and/or the wrong patientId). These are
 *      invisible to every hospital user already (the read query requires a
 *      matching hospitalId), so they are pure dead weight.
 *   2. DUPLICATES — every "Pull from ABDM" click re-`create()`d a row for the
 *      same care context (no dedup existed), inflating the per-consent count
 *      (the "2 / 5 / 8" the UI showed).
 *
 * This script removes (1) and collapses (2). It is SAFE to run because this
 * table holds ONLY ABDM-fetched data — anything deleted can be re-pulled from a
 * still-granted consent via the patient profile's "Pull from ABDM".
 *
 * Usage:
 *   npx ts-node scripts/cleanup-external-records.ts                 # dry-run (report only)
 *   npx ts-node scripts/cleanup-external-records.ts --apply         # perform deletions
 *   npx ts-node scripts/cleanup-external-records.ts --patient=<id>  # scope to one patient
 *   npx ts-node scripts/cleanup-external-records.ts --apply --patient=<id>
 */
import prisma from '../src/common/config/database';

const APPLY = process.argv.includes('--apply');
const patientArg = process.argv.find((a) => a.startsWith('--patient='));
const PATIENT_ID = patientArg ? patientArg.split('=')[1] : undefined;

function header(label: string) {
  console.log(`\n===== ${label} =====`);
}

async function main() {
  console.log(
    `\nMode: ${APPLY ? 'APPLY (rows WILL be deleted)' : 'DRY-RUN (no changes)'}` +
      (PATIENT_ID ? `  |  scoped to patientId=${PATIENT_ID}` : '  |  ALL patients'),
  );

  const baseWhere = PATIENT_ID ? { patientId: PATIENT_ID } : {};

  const total = await prisma.externalHealthRecord.count({ where: baseWhere });
  header('CURRENT STATE');
  console.log(`  external_health_records in scope: ${total}`);

  // ── (1) Mis-tagged rows: hospitalId IS NULL ──────────────────────────────
  const misTagged = await prisma.externalHealthRecord.findMany({
    where: { ...baseWhere, hospitalId: null },
    select: { id: true, consentId: true, patientId: true, recordType: true, receivedAt: true },
  });
  header('MIS-TAGGED (hospitalId = NULL) — invisible to hospital users');
  console.log(`  count: ${misTagged.length}`);
  for (const r of misTagged.slice(0, 20)) {
    console.log(`    - ${r.id} | consent=${r.consentId} | patient=${r.patientId} | ${r.recordType}`);
  }
  if (misTagged.length > 20) console.log(`    … and ${misTagged.length - 20} more`);

  // ── (2) Duplicates among the REMAINING (correctly-tagged) rows ───────────
  // Group key: prefer (consentId, careContextReference); fall back to
  // (consentId, patientId, recordType, recordDate) for legacy rows where
  // careContextReference is null. Keep the newest receivedAt per group.
  const misTaggedIds = new Set(misTagged.map((r) => r.id));
  const remaining = await prisma.externalHealthRecord.findMany({
    where: baseWhere,
    select: {
      id: true,
      consentId: true,
      patientId: true,
      careContextReference: true,
      recordType: true,
      recordDate: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: 'desc' },
  });

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const r of remaining) {
    if (misTaggedIds.has(r.id)) continue; // handled by (1)
    const key = r.careContextReference
      ? `${r.consentId}::ctx::${r.careContextReference}`
      : `${r.consentId}::leg::${r.patientId}::${r.recordType}::${
          r.recordDate ? r.recordDate.toISOString() : 'null'
        }`;
    if (seen.has(key)) {
      duplicateIds.push(r.id); // older row (we sorted desc, so first seen is newest)
    } else {
      seen.add(key);
    }
  }

  header('DUPLICATES (older copies of the same care context) — to be collapsed');
  console.log(`  count: ${duplicateIds.length}`);

  const toDelete = [...misTaggedIds, ...duplicateIds];
  header('SUMMARY');
  console.log(`  mis-tagged to delete : ${misTaggedIds.size}`);
  console.log(`  duplicates to delete : ${duplicateIds.length}`);
  console.log(`  TOTAL to delete      : ${toDelete.length}`);
  console.log(`  rows kept            : ${total - toDelete.length}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to delete the rows above.\n');
    return;
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete.\n');
    return;
  }

  const result = await prisma.externalHealthRecord.deleteMany({
    where: { id: { in: toDelete } },
  });
  console.log(`\nDeleted ${result.count} row(s). Re-pull from the patient profile to repopulate cleanly.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
