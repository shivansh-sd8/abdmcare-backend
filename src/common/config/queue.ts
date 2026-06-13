import { Queue, Worker, Job } from 'bullmq';
import logger from './logger';

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

export const healthDataPushQueue = new Queue('health-data-push', {
  connection: REDIS_CONNECTION,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Consent expiry sweeper queue (Phase 3 — M3 lifecycle automation)
// A repeatable job runs every CONSENT_EXPIRY_INTERVAL_MS milliseconds (default
// 15 min). The processor flips GRANTED → EXPIRED on stale consents and runs the
// HIU cascade-delete via consent-compliance.purgeConsentData. Uses its own queue
// so its retry/backoff settings don't disturb the data-push queue.
// ─────────────────────────────────────────────────────────────────────────────

export const consentExpiryQueue = new Queue('consent-expiry', {
  connection: REDIS_CONNECTION,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 200,
    attempts: 1,
  },
});

export interface ConsentExpiryJobData {
  triggeredAt: string;
  source: 'cron' | 'manual';
}

export interface HealthDataPushJobData {
  transactionId: string;
  requestId: string;
  consentAbdmId: string;
  consentPatientId: string;
  dataPushUrl: string;
  dateRange: { from: string; to: string };
  /**
   * Permitted hiTypes from the consent artefact. The worker filters care
   * contexts to those whose derived hiType is in this list so we never push
   * records the user did not consent to. ABDM hiType strings only (e.g.
   * 'OPConsultation', 'Prescription', 'DischargeSummary'). Empty/undefined
   * means "no restriction" (legacy consents that pre-dated the hiTypes
   * column).
   */
  hiTypes?: string[];
  keyMaterial: {
    cryptoAlg: string;
    curve: string;
    dhPublicKey: { expiry: string; parameters: string; keyValue: string };
    nonce: string;
  };
}

export function createHealthDataPushWorker(
  processor: (job: Job<HealthDataPushJobData>) => Promise<void>,
): Worker {
  const worker = new Worker('health-data-push', processor, {
    connection: REDIS_CONNECTION,
    concurrency: 2,
  });

  worker.on('completed', (job) => {
    logger.info('Health data push job completed', { jobId: job.id, transactionId: job.data.transactionId });
  });

  worker.on('failed', (job, err) => {
    logger.error('Health data push job failed', {
      jobId: job?.id,
      transactionId: job?.data?.transactionId,
      error: err.message,
      attemptsMade: job?.attemptsMade,
    });
  });

  return worker;
}

export function createConsentExpiryWorker(
  processor: (job: Job<ConsentExpiryJobData>) => Promise<void>,
): Worker {
  const worker = new Worker('consent-expiry', processor, {
    connection: REDIS_CONNECTION,
    concurrency: 1,
  });

  worker.on('completed', (job) => {
    logger.info('Consent expiry sweep completed', { jobId: job.id, source: job.data.source });
  });

  worker.on('failed', (job, err) => {
    logger.error('Consent expiry sweep failed', {
      jobId: job?.id,
      error: err.message,
    });
  });

  return worker;
}

export { REDIS_CONNECTION };
