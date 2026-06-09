import { Job } from 'bullmq';
import prisma from '../common/config/database';
import logger from '../common/config/logger';
import {
  consentExpiryQueue,
  ConsentExpiryJobData,
  createConsentExpiryWorker,
} from '../common/config/queue';
import { purgeConsentData } from '../modules/hiu/consent-compliance';

// ─────────────────────────────────────────────────────────────────────────────
// Consent expiry sweeper (M3 lifecycle automation)
//
// Runs every 15 min (configurable via CONSENT_EXPIRY_INTERVAL_MS). Each pass:
//   1. Finds Consent rows where status='GRANTED' and expiresAt < now()
//   2. Flips them to EXPIRED + stamps purgedAt-cascade via purgeConsentData
//      (which deletes ExternalHealthRecord rows + ConsentKeyPair).
//   3. Also re-runs purgeConsentData for any REVOKED/DENIED consent that has
//      not yet been purged — recovers from a missed purge in the on-notify
//      callback (e.g. transient DB error).
//
// This is a repeatable BullMQ job (using `repeat`) — the queue itself stores
// the schedule, so a restart does not duplicate jobs.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const REPEATABLE_JOB_NAME = 'consent-expiry-sweep';

export async function processConsentExpiry(_job: Job<ConsentExpiryJobData>): Promise<void> {
  const startedAt = new Date();
  let expired = 0;
  let recoveredPurges = 0;
  let totalRecordsDeleted = 0;
  let totalKeyPairsDeleted = 0;
  const errors: string[] = [];

  try {
    // 1. EXPIRE the consents whose grant window has elapsed.
    const stale = await prisma.consent.findMany({
      where: {
        status: 'GRANTED',
        expiresAt: { lt: startedAt, not: null },
      },
      select: { id: true, consentId: true, expiresAt: true },
      take: 500,
    });

    for (const c of stale) {
      try {
        await prisma.consent.update({
          where: { id: c.id },
          data: { status: 'EXPIRED' },
        });
        expired += 1;
        const result = await purgeConsentData(c.id);
        totalRecordsDeleted += result.externalRecordsDeleted;
        totalKeyPairsDeleted += result.keyPairsDeleted;
      } catch (err: any) {
        errors.push(`expire ${c.consentId}: ${err.message}`);
      }
    }

    // 2. RECOVER missed purges — REVOKED/DENIED rows where purgedAt is still
    //    null. This catches the rare case where the cascade-delete in the
    //    on-notify callback was interrupted (server crash, DB blip).
    const missed = await prisma.consent.findMany({
      where: {
        status: { in: ['REVOKED', 'DENIED', 'EXPIRED'] },
        purgedAt: null,
      },
      select: { id: true, consentId: true, status: true },
      take: 500,
    });

    for (const c of missed) {
      try {
        const result = await purgeConsentData(c.id);
        if (!result.alreadyPurged) {
          recoveredPurges += 1;
          totalRecordsDeleted += result.externalRecordsDeleted;
          totalKeyPairsDeleted += result.keyPairsDeleted;
        }
      } catch (err: any) {
        errors.push(`recover ${c.consentId}: ${err.message}`);
      }
    }

    // 3. Audit trail (best-effort).
    try {
      await prisma.auditLog.create({
        data: {
          action: 'CONSENT_SWEEP',
          module: 'HIU',
          userType: 'SYSTEM',
          resourceType: 'CONSENT',
          status: errors.length ? 'PARTIAL' : 'SUCCESS',
          requestData: {
            startedAt: startedAt.toISOString(),
            expired,
            recoveredPurges,
            totalRecordsDeleted,
            totalKeyPairsDeleted,
            errorsCount: errors.length,
          } as any,
          ...(errors.length ? { errorMessage: errors.slice(0, 5).join(' | ') } : {}),
        },
      });
    } catch (auditErr: any) {
      logger.warn('Consent sweep: audit write failed', { message: auditErr?.message });
    }

    logger.info('Consent expiry sweep complete', {
      expired,
      recoveredPurges,
      totalRecordsDeleted,
      totalKeyPairsDeleted,
      durationMs: Date.now() - startedAt.getTime(),
      errors: errors.length,
    });
  } catch (err: any) {
    logger.error('Consent expiry sweep crashed', { error: err?.message });
    throw err;
  }
}

/**
 * Register / start the worker AND ensure the repeatable job is scheduled.
 * Called once at server boot. Idempotent — BullMQ stores repeatable jobs
 * under a deterministic key, so calling this on every boot does not create
 * duplicates.
 */
export async function startConsentExpirySweeper(): Promise<void> {
  createConsentExpiryWorker(processConsentExpiry);

  const intervalMs = parseInt(
    process.env.CONSENT_EXPIRY_INTERVAL_MS || String(DEFAULT_INTERVAL_MS),
    10,
  );

  // BullMQ v5 repeat options use `every` (ms). Use a stable jobId to dedupe
  // across restarts. Removing first guarantees the schedule is always the
  // current `intervalMs` — not whatever was scheduled at the previous boot.
  try {
    const repeatables = await consentExpiryQueue.getRepeatableJobs();
    for (const r of repeatables) {
      if (r.name === REPEATABLE_JOB_NAME) {
        await consentExpiryQueue.removeRepeatableByKey(r.key);
      }
    }
  } catch (err: any) {
    logger.warn('Consent sweeper: failed to clear old repeatable jobs', { message: err?.message });
  }

  await consentExpiryQueue.add(
    REPEATABLE_JOB_NAME,
    { triggeredAt: new Date().toISOString(), source: 'cron' },
    { repeat: { every: intervalMs } },
  );

  logger.info('Consent expiry sweeper scheduled', { intervalMs });
}

/**
 * Manually trigger the sweeper (useful for tests, admin endpoints).
 */
export async function triggerConsentExpirySweep(): Promise<void> {
  await consentExpiryQueue.add(
    `${REPEATABLE_JOB_NAME}-manual`,
    { triggeredAt: new Date().toISOString(), source: 'manual' },
  );
}
