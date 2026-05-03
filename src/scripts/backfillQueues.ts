/**
 * One-time backfill script: reads all completed encounters that have LabOrders /
 * EncounterPrescriptions but no corresponding Investigation / Prescription rows,
 * and creates them so they appear in the lab queue and pharmacy queue.
 *
 * Run with:
 *   cd backend
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfillQueues.ts
 */

import prisma from '../common/config/database';

async function backfill() {
  console.log('Starting queue backfill…');

  const completedStatuses = ['LAB_PENDING', 'LAB_IN_PROGRESS', 'LAB_COMPLETED',
    'PHARMACY_PENDING', 'PHARMACY_COMPLETED', 'BILLING_PENDING', 'COMPLETED'];

  const encounters = await prisma.encounter.findMany({
    where: { status: { in: completedStatuses as any } },
    include: {
      labOrders:     true,
      prescriptions: true,
      patient:       { select: { hospitalId: true } },
    },
  });

  let labCreated = 0;
  let rxCreated  = 0;

  for (const enc of encounters) {
    // ── Investigations ──────────────────────────────────────────────────────
    if (enc.labOrders.length > 0) {
      const existingCount = await prisma.investigation.count({ where: { encounterId: enc.id } });
      if (existingCount === 0 && enc.patient.hospitalId) {
        await prisma.investigation.createMany({
          data: enc.labOrders.map((lo) => ({
            patientId:   enc.patientId,
            doctorId:    enc.doctorId,
            hospitalId:  enc.patient.hospitalId!,
            encounterId: enc.id,
            testName:    lo.testName,
            testType:    lo.testType || 'LAB',
            priority:    (lo.priority as string) || 'ROUTINE',
            status:      'ORDERED',
          })),
        });
        labCreated += enc.labOrders.length;
        console.log(`  Created ${enc.labOrders.length} investigation(s) for encounter ${enc.id}`);
      }
    }

    // ── Prescriptions ───────────────────────────────────────────────────────
    if (enc.prescriptions.length > 0) {
      const existingRx = await prisma.prescription.count({ where: { encounterId: enc.id } });
      if (existingRx === 0) {
        await prisma.prescription.create({
          data: {
            patientId:   enc.patientId,
            doctorId:    enc.doctorId,
            encounterId: enc.id,
            medications: enc.prescriptions.map((p) => ({
              name:         p.medicineName,
              dosage:       p.dosage,
              frequency:    p.frequency,
              duration:     p.duration,
              instructions: p.instructions || '',
            })),
          },
        });
        rxCreated++;
        console.log(`  Created prescription for encounter ${enc.id} (${enc.prescriptions.length} medicines)`);
      }
    }
  }

  console.log(`\nBackfill complete. Lab investigations created: ${labCreated}, Prescriptions created: ${rxCreated}`);
  await prisma.$disconnect();
}

backfill().catch((err) => { console.error(err); process.exit(1); });
