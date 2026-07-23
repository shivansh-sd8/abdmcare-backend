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

// ABHA OTP limiter — guards `/abha/login/request-otp` and similar endpoints.
// We keep this separate from the general API limiter because OTP requests
// are the part of ABDM most prone to runaway loops and abuse, but the prior
// 3-per-30-min cap was too tight for real testing — receptionists hit it on
// the second resend during a single linking session. We're still well below
// ABDM's gateway-side per-mobile ceiling, so this is the front-line guard
// only; the gateway remains the authoritative rate-limit.
export const abhaOtpLimiter = createLimiter(15 * 60 * 1000, 20);

export const loginLimiter = createLimiter(15 * 60 * 1000, 50);

export const apiLimiter = createLimiter(15 * 60 * 1000, 100);
