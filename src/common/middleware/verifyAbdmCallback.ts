import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import logger from '../config/logger';
import { abdmConfig } from '../config/abdm';
import redisClient from '../config/redis';

interface JWK {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

interface JWKSCache {
  keys: Map<string, JWK>;
  fetchedAt: number;
}

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLOCK_SKEW_SECONDS = 60;
let jwksCache: JWKSCache | null = null;

async function fetchJWKS(): Promise<Map<string, JWK>> {
  // Use the dedicated public JWKS endpoint (/gateway/v0.5/certs). The HIECM
  // gateway path returns 401, which previously made every callback fail.
  const certsUrl = abdmConfig.certsUrl;
  try {
    const response = await axios.get(certsUrl, { timeout: 10_000 });
    const keys: JWK[] = response.data?.keys || [];
    const keyMap = new Map<string, JWK>();
    for (const key of keys) {
      if (key.kid) keyMap.set(key.kid, key);
    }
    jwksCache = { keys: keyMap, fetchedAt: Date.now() };
    logger.info(`ABDM JWKS fetched: ${keyMap.size} keys cached`);
    return keyMap;
  } catch (err: any) {
    logger.error('Failed to fetch ABDM JWKS', { error: err.message, url: certsUrl });
    throw err;
  }
}

async function getJWK(kid: string): Promise<JWK | undefined> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    const cached = jwksCache.keys.get(kid);
    if (cached) return cached;
  }
  const keys = await fetchJWKS();
  return keys.get(kid);
}

function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padLen);
  return Buffer.from(base64, 'base64');
}

function jwkToPublicKey(jwk: JWK): crypto.KeyObject {
  return crypto.createPublicKey({
    key: { kty: 'RSA', n: jwk.n, e: jwk.e },
    format: 'jwk',
  });
}

function decodeJwtHeader(token: string): { alg: string; kid?: string; typ?: string } {
  const headerPart = token.split('.')[0];
  return JSON.parse(base64UrlDecode(headerPart).toString('utf-8'));
}

function verifyJwt(token: string, publicKey: crypto.KeyObject): any {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf-8'));

  const algMap: Record<string, string> = {
    RS256: 'RSA-SHA256',
    RS384: 'RSA-SHA384',
    RS512: 'RSA-SHA512',
  };
  const algorithm = algMap[header.alg];
  if (!algorithm) throw new Error(`Unsupported algorithm: ${header.alg}`);

  const signatureValid = crypto
    .createVerify(algorithm)
    .update(`${headerB64}.${payloadB64}`)
    .verify(publicKey, base64UrlDecode(signatureB64));

  if (!signatureValid) throw new Error('JWT signature verification failed');

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));

  const now = Date.now() / 1000;

  if (payload.exp && now > payload.exp + CLOCK_SKEW_SECONDS) {
    throw new Error('JWT has expired');
  }

  if (payload.nbf && now < payload.nbf - CLOCK_SKEW_SECONDS) {
    throw new Error('JWT not yet valid (nbf)');
  }

  // Validate issuer — accept known ABDM issuers
  if (payload.iss) {
    const trustedIssuers = [abdmConfig.cmId, 'sbx', 'abdm', 'nha', 'ABDM-Gateway'];
    if (!trustedIssuers.some((ti) => payload.iss.includes(ti))) {
      throw new Error(`JWT issuer not trusted: ${payload.iss}`);
    }
  }

  // Validate audience — accept our HIP or HIU IDs
  if (payload.aud) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const acceptableAuds = [abdmConfig.hip.id, abdmConfig.hiu.id, abdmConfig.cmId].filter(Boolean);
    if (acceptableAuds.length > 0) {
      const hasMatch = auds.some((a: string) => acceptableAuds.includes(a));
      if (!hasMatch) {
        throw new Error(`JWT audience mismatch: ${JSON.stringify(payload.aud)}`);
      }
    }
  }

  return payload;
}

async function checkJtiReplay(jti: string, exp: number): Promise<boolean> {
  try {
    const jtiKey = `abdm-jti:${jti}`;
    const exists = await redisClient.get(jtiKey);
    if (exists) return true;
    const ttl = Math.max(1, Math.ceil(exp - Date.now() / 1000) + CLOCK_SKEW_SECONDS);
    await redisClient.set(jtiKey, '1', { EX: ttl });
    return false;
  } catch {
    // Redis unavailable — skip replay check, allow through
    return false;
  }
}

/**
 * Middleware to verify ABDM gateway JWT on inbound callbacks.
 * Fetches JWKS from ABDM /v3/certs, caches by kid, and verifies the
 * Authorization: Bearer <jwt> header on every callback request.
 *
 * Validates: signature, exp (with 60s skew), nbf, iss, aud, jti replay.
 *
 * In development mode with no ABDM credentials configured, this is
 * permissive (logs a warning but allows the request through) to enable
 * local testing without a live ABDM sandbox.
 */
export function verifyAbdmCallback(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!abdmConfig.clientId && process.env.NODE_ENV !== 'production') {
    logger.warn('ABDM callback verification skipped: no ABDM_CLIENT_ID configured (dev mode)');
    next();
    return;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('ABDM callback missing Authorization header', {
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);

  (async () => {
    try {
      const header = decodeJwtHeader(token);
      if (!header.kid) {
        res.status(401).json({ error: 'JWT missing kid in header' });
        return;
      }

      const jwk = await getJWK(header.kid);
      if (!jwk) {
        logger.warn('ABDM callback JWT kid not found in JWKS', { kid: header.kid });
        res.status(401).json({ error: 'Unknown signing key' });
        return;
      }

      const publicKey = jwkToPublicKey(jwk);
      const payload = verifyJwt(token, publicKey);

      // Replay protection via jti
      if (payload.jti && payload.exp) {
        const isReplay = await checkJtiReplay(payload.jti, payload.exp);
        if (isReplay) {
          logger.warn('ABDM callback JWT replay detected', { jti: payload.jti, path: req.path });
          res.status(401).json({ error: 'JWT replay detected' });
          return;
        }
      }

      (req as any).abdmJwtPayload = payload;
      logger.debug('ABDM callback JWT verified', {
        path: req.path,
        sub: payload.sub,
        iss: payload.iss,
        aud: payload.aud,
      });
      next();
    } catch (err: any) {
      logger.warn('ABDM callback JWT verification failed', {
        path: req.path,
        error: err.message,
      });
      res.status(401).json({ error: 'JWT verification failed', details: err.message });
    }
  })();
}

export default verifyAbdmCallback;
