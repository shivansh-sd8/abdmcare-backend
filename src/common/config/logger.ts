import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const logDir = process.env.LOG_DIR || 'logs';
const logLevel = process.env.LOG_LEVEL || 'info';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Keys whose values are huge/circular Node internals (typically from a raw axios
// error accidentally logged as metadata). Dropping them keeps logs readable and,
// crucially, prevents the bearer token inside axios `config`/`request` from
// leaking into plaintext logs.
const NOISY_KEYS = new Set([
  'config', 'request', 'socket', 'agent', 'httpsAgent', 'httpAgent',
  'sockets', 'freeSockets', '_sessionCache', 'secureContext', '_httpMessage',
  '_redirectable', '_currentRequest', 'res', 'req',
]);
// Header/field names that must never be written to logs.
const SECRET_KEYS = new Set(['authorization', 'x-token', 'x-link-token', 'cookie', 'password', 'clientsecret', 'client_secret']);

// Circular-safe + redacting stringify. Logging an object with a circular
// reference (e.g. an axios error carrying its ClientRequest/IncomingMessage)
// would otherwise make JSON.stringify THROW inside the printf template, and that
// exception bubbles up and 500s the in-flight request (observed on
// /care-context/discover). We replace circular refs with "[Circular]", drop
// noisy Node internals, and redact secrets — keeping logging safe and useful
// (e.g. an axios error's `response.data` survives while its token does not).
const safeStringify = (obj: unknown): string => {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, value) => {
      if (SECRET_KEYS.has(key.toLowerCase())) return '[redacted]';
      if (NOISY_KEYS.has(key)) return '[omitted]';
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return '[unserializable metadata]';
  }
};

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${safeStringify(meta)}`;
    }
    return msg;
  })
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: consoleFormat,
  })
];

if (process.env.NODE_ENV !== 'production') {
  try {
    transports.push(
      new DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxFiles: '30d',
        maxSize: '20m',
      }),
      new DailyRotateFile({
        filename: path.join(logDir, 'combined-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: '30d',
        maxSize: '20m',
      })
    );
  } catch (error) {
    console.warn('Failed to initialize file logging, using console only:', error);
  }
}

const logger = winston.createLogger({
  level: logLevel,
  format: logFormat,
  defaultMeta: { service: 'medisync-abdm' },
  transports,
});

export default logger;
