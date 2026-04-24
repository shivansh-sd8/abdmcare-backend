import app from './app';
import { config } from './common/config/index';
import logger from './common/config/logger';
import prisma from './common/config/database';
import { connectRedis } from './common/config/redis';
import EncryptionService from './common/utils/encryption';
import { initializeDatabase } from './common/config/database-init';

const PORT = config.app.port;

const startServer = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');

    await initializeDatabase();

    EncryptionService.loadRSAKeys();
    logger.info('RSA keys loaded');

    const server = app.listen(PORT, () => {
      logger.info(`🚀 ${config.app.name} v${config.app.version} started`);
      logger.info(`📡 Server running on port ${PORT}`);
      logger.info(`🌍 Environment: ${config.app.env}`);
      logger.info(`📊 Health check: http://localhost:${PORT}/health`);
    });

    await connectRedis();

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
