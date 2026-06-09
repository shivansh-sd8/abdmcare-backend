import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}

import app from './app';
import { config } from './common/config/index';
import logger from './common/config/logger';
import prisma from './common/config/database';
import { connectRedis } from './common/config/redis';
import EncryptionService from './common/utils/encryption';

const INSECURE_DEFAULTS = ['your-secret-key', 'your-refresh-secret', ''];

if (config.app.env === 'production') {
  if (INSECURE_DEFAULTS.includes(config.jwt.secret)) {
    console.error('FATAL: JWT_SECRET is unset or using the default value. Refusing to start in production.');
    process.exit(1);
  }
  if (INSECURE_DEFAULTS.includes(config.jwt.refreshSecret)) {
    console.error('FATAL: JWT_REFRESH_SECRET is unset or using the default value. Refusing to start in production.');
    process.exit(1);
  }
}

const PORT = config.app.port;

const startServer = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');

    EncryptionService.loadRSAKeys();
    logger.info('RSA keys loaded');

    if (config.app.env === 'development') {
      const ecdhOk = EncryptionService.verifyECDHRoundTrip();
      logger.info(`ECDH self-test: ${ecdhOk ? 'PASSED' : 'FAILED'}`);
    }

    const server = app.listen(PORT, () => {
      logger.info(`🚀 ${config.app.name} v${config.app.version} started`);
      logger.info(`📡 Server running on port ${PORT}`);
      logger.info(`🌍 Environment: ${config.app.env}`);
      logger.info(`📊 Health check: http://localhost:${PORT}/health`);
    });

    await connectRedis();

    try {
      const { startHealthDataPushWorker } = await import('./workers/healthDataPush.worker');
      startHealthDataPushWorker();
      const { startConsentExpirySweeper } = await import('./workers/consentExpiry.worker');
      await startConsentExpirySweeper();
      logger.info('BullMQ workers started');
    } catch (err: any) {
      logger.warn('BullMQ workers could not start (Redis may be unavailable)', { error: err.message });
    }

    const gracefulShutdown = async (signal: string): Promise<void> => {
      logger.info(`${signal} received. Starting graceful shutdown...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        await prisma.$disconnect();
        logger.info('Database disconnected');

        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled Rejection', reason);
    });

    process.on('uncaughtException', (error: Error) => {
      logger.error('Uncaught Exception', error);
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
};

startServer();
