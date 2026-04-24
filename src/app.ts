import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './common/config/index';
import { errorHandler, notFoundHandler } from './common/middleware/errorHandler';
import { generalLimiter } from './common/middleware/rateLimiter';
import logger from './common/config/logger';

const app: Application = express();

app.use(helmet());

let corsOrigin: string | string[] | boolean = '*';

if (config.app.env === 'development') {
  corsOrigin = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001,http://localhost:5173').split(',');
} else if (process.env.CORS_ORIGIN) {
  corsOrigin = process.env.CORS_ORIGIN.split(',');
} else {
  corsOrigin = true;
}

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
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

import routes from './routes';
app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
