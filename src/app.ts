import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { config } from './common/config/index';
import { swaggerSpec } from './common/config/swagger';
import { errorHandler, notFoundHandler } from './common/middleware/errorHandler';
import { generalLimiter } from './common/middleware/rateLimiter';
import { requestIdMiddleware } from './common/middleware/requestId';
import logger from './common/config/logger';

const app: Application = express();

// Trust the first proxy (Nginx) so express-rate-limit reads real client IP from X-Forwarded-For
app.set('trust proxy', 1);

app.use(helmet());

// CORS Configuration
let corsOrigin: string | string[] | boolean;

if (process.env.CORS_ORIGIN) {
  // Use CORS_ORIGIN from environment (comma-separated list)
  corsOrigin = process.env.CORS_ORIGIN.split(',').map(origin => origin.trim());
} else if (process.env.CORS_ORIGINS) {
  // Fallback to CORS_ORIGINS for backward compatibility
  corsOrigin = process.env.CORS_ORIGINS.split(',').map(origin => origin.trim());
} else if (config.app.env === 'production') {
  // Production: Restrict to specific origins (should be set via env vars)
  corsOrigin = false; // Deny all origins if not configured
  logger.warn('⚠️  CORS_ORIGIN not set in production! All origins will be blocked.');
} else {
  // Development: Allow all origins
  corsOrigin = true;
}

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-token', 'REQUEST-ID', 'TIMESTAMP'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400, // 24 hours
  })
);

app.use(compression());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

if (config.app.env === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(
    morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim()),
      },
    })
  );
}

app.use(requestIdMiddleware);
app.use(generalLimiter);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.app.env,
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: config.app.name,
    version: config.app.version,
    message: 'ABDM Care API is running',
  });
});

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'MediSync ABDM API Docs',
}));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

import routes from './routes';
app.use('/api/v1', routes);

// ── ABDM V3 callbacks (ABDM gateway calls these — no /api/v1 prefix) ─────
import hipCallbackRoutes from './modules/hip/hip.routes';
import hiuCallbackRoutes from './modules/hiu/hiu.routes';
import {
  consentV3Routes,
  hiuConsentV3Routes,
  hiuConsentsOnFetchRoutes,
  linkV3Routes,
  linksV3Routes,
  patientsV3Routes,
  hipTokenV3Routes,
} from './modules/abdm-callbacks/v3-callbacks.routes';

// Structured inbound callback logging for all ABDM /api/v3 routes
app.use('/api/v3', (req, _res, next) => {
  logger.info('[ABDM-INBOUND]', {
    method: req.method,
    path: req.originalUrl,
    requestId: req.headers['request-id'] || req.headers['x-request-id'] || (req as any).requestId,
    timestamp: req.headers['timestamp'],
    bodyKeys: req.body ? Object.keys(req.body) : [],
    ip: req.ip,
  });
  next();
});

// ── Specific ABDM callback sub-paths FIRST ──────────────────────────────────
// These callback routers each carry their own verifyAbdmCallback (ABDM JWT)
// and MUST be matched before the generic /api/v3/hip and /api/v3/hiu routers
// below, which apply router-level `authenticate` to every unmatched sub-path
// (an ABDM callback has no app JWT, so reaching them yields a 401 and the
// notification is silently dropped).
app.use('/api/v3/hip/token', hipTokenV3Routes);
// HIU-side consent callbacks → /api/v3/hiu/consent/request/{on-init,on-status,on-notify}
app.use('/api/v3/hiu/consent/request', hiuConsentV3Routes);
// HIU-side consent ARTEFACT delivery → /api/v3/hiu/consents/on-fetch
// (M3 spec ndhm-hiu /v0.5/consents/on-fetch — async response to /consent/v3/fetch).
// MUST be mounted before /api/v3/hiu (which applies authenticate middleware).
app.use('/api/v3/hiu/consents', hiuConsentsOnFetchRoutes);
// HIP-side consent notification → /api/v3/consent/request/hip/notify
app.use('/api/v3/consent/request', consentV3Routes);
app.use('/api/v3/link', linkV3Routes);
// CM deep-linking ack → /api/v3/links/context/on-notify (note plural "links")
app.use('/api/v3/links', linksV3Routes);
// Patient lifecycle (sms/on-notify, status/notify) → /api/v3/patients/...
app.use('/api/v3/patients', patientsV3Routes);

// ── Generic role routers (internal authenticated APIs + a few callbacks) ────
app.use('/api/v3/hip', hipCallbackRoutes);
app.use('/api/v3/hiu', hiuCallbackRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
