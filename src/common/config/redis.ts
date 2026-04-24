import { createClient } from 'redis';
import logger from './logger';

const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  password: process.env.REDIS_PASSWORD || undefined,
});

// Suppress error logs since Redis is optional
redisClient.on('error', () => {
  // Silently ignore Redis connection errors
});

redisClient.on('connect', () => {
  logger.info('Redis Client Connected');
});

export const connectRedis = async (): Promise<void> => {
  try {
    await redisClient.connect();
  } catch (error) {
    logger.warn('Failed to connect to Redis', error);
    if (process.env.NODE_ENV === 'production') {
      logger.warn('Redis is optional in production. App will continue without caching.');
    } else {
      throw error;
    }
  }
};

export default redisClient;
