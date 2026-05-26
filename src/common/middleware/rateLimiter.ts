import rateLimit from 'express-rate-limit';

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
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
