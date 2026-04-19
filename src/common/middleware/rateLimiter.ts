import rateLimit from 'express-rate-limit';
import { config } from '../config/index';

export const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

export const createLimiter = (windowMs: number, max: number) => {
  return rateLimit({
    windowMs,
    max,
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
  });
};

export const abhaOtpLimiter = createLimiter(30 * 60 * 1000, 3);

export const loginLimiter = createLimiter(15 * 60 * 1000, 5);

export const apiLimiter = createLimiter(15 * 60 * 1000, 100);
