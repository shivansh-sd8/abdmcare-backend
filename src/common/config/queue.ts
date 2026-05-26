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

export interface HealthDataPushJobData {
  transactionId: string;
  requestId: string;
  consentAbdmId: string;
  consentPatientId: string;
  dataPushUrl: string;
  dateRange: { from: string; to: string };
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

export { REDIS_CONNECTION };
