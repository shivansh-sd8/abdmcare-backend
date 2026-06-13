import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import crypto from 'crypto';
import https from 'https';
import dns from 'dns';
import { abdmConfig } from '../config/abdm';
import logger from '../config/logger';
import prisma from '../config/database';

// ─────────────────────────────────────────────────────────────────────────────
// IPv4-only HTTPS agent for ABDM calls.
//
// Why: ABDM's CloudFront distribution for abhasbx.abdm.gov.in has a per-edge
// WAF rule that blocks the Bangalore (`BLR50-P4`) POP for our DO IP. Forcing
// IPv4 with `family: 4` causes Node's DNS resolver to land on a different
// CloudFront edge (`99.86.182.x`, US/EU POP) which is not blocked.
//
// We also bump the global DNS result order so that any code path that doesn't
// use this agent still prefers IPv4 first.
// ─────────────────────────────────────────────────────────────────────────────
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* node < 17 */ }

const ipv4HttpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 30_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AbdmV3SessionResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  tokenType: string;
}

/**
 * Per-hospital ABDM context. When provided (typically resolved from
 * `Hospital` row by `resolveHospitalAbdmContext()`), every gateway call
 * uses these values instead of the global env-level ABDM_* config.
 *
 * Any field not provided falls back to the env global so single-tenant
 * deployments and partial migrations keep working.
 */
export interface HospitalAbdmContext {
  hospitalId?: string;
  clientId?: string | null;
  clientSecret?: string | null;
  hipId?: string | null;
  hiuId?: string | null;
  hipName?: string | null;
  hiuName?: string | null;
  cmId?: string | null;
}

/**
 * Load the per-hospital ABDM credentials row from the DB and shape it as a
 * `HospitalAbdmContext`. Returns `null` if no `hospitalId` is given.
 *
 * Use this in route handlers / services to make ABDM calls scoped to the
 * caller's hospital. Pass the result to `abdmClient.post(url, body, headers, ctx)`.
 */
export async function resolveHospitalAbdmContext(
  hospitalId?: string | null
): Promise<HospitalAbdmContext | null> {
  if (!hospitalId) return null;
  const hospital = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    select: {
      id: true,
      hipId: true, hipName: true,
      hiuId: true, hiuName: true,
      abdmClientId: true, abdmClientSecret: true,
      name: true,
    },
  });
  if (!hospital) return null;
  return {
    hospitalId: hospital.id,
    clientId: hospital.abdmClientId,
    clientSecret: hospital.abdmClientSecret,
    hipId: hospital.hipId,
    hiuId: hospital.hiuId,
    hipName: hospital.hipName || hospital.name,
    hiuName: hospital.hiuName || hospital.name,
  };
}

/**
 * Strict variant — load the hospital and assert it has a usable HIP ID.
 *
 * Use this everywhere we make an outbound HIP call (link/carecontext,
 * generate-token, link/context/notify, on-discover, on-request, data push).
 * If the hospital row is missing or has no hipId, throw — silently falling
 * back to the env-level ABDM_HIP_ID would assign cross-tenant data to the
 * platform default tenant and break per-facility isolation.
 *
 * Throws AppError(422, ...) so the route layer surfaces a helpful message
 * instead of the generic 500 a `null.hipId` access would produce.
 */
export async function resolveHipTenant(hospitalId: string): Promise<HospitalAbdmContext & { hipId: string; hipName: string }> {
  if (!hospitalId) {
    const { AppError } = await import('../middleware/errorHandler');
    throw new AppError('Cannot make HIP call without a hospital context', 500);
  }
  const ctx = await resolveHospitalAbdmContext(hospitalId);
  if (!ctx) {
    const { AppError } = await import('../middleware/errorHandler');
    throw new AppError(`Hospital ${hospitalId} not found`, 404);
  }
  if (!ctx.hipId) {
    const { AppError } = await import('../middleware/errorHandler');
    throw new AppError(
      'Hospital has no HIP ID configured. Register the facility in HFR and onboard it with a hipId before performing HIP operations.',
      422,
    );
  }
  return { ...ctx, hipId: ctx.hipId, hipName: ctx.hipName || 'Healthcare Facility' };
}

/** HIU-side mirror of `resolveHipTenant`. */
export async function resolveHiuTenant(hospitalId: string): Promise<HospitalAbdmContext & { hiuId: string; hiuName: string }> {
  if (!hospitalId) {
    const { AppError } = await import('../middleware/errorHandler');
    throw new AppError('Cannot make HIU call without a hospital context', 500);
  }
  const ctx = await resolveHospitalAbdmContext(hospitalId);
  if (!ctx) {
    const { AppError } = await import('../middleware/errorHandler');
    throw new AppError(`Hospital ${hospitalId} not found`, 404);
  }
  if (!ctx.hiuId) {
    const { AppError } = await import('../middleware/errorHandler');
    throw new AppError(
      'Hospital has no HIU ID configured. Register the facility in HFR and onboard it with a hiuId before performing HIU operations.',
      422,
    );
  }
  return { ...ctx, hiuId: ctx.hiuId, hiuName: ctx.hiuName || 'Healthcare Facility' };
}

/**
 * Reverse lookup — given an inbound `metaData.hipId` / `X-HIP-ID` from an
 * ABDM callback, return the hospital tenant whose row owns that HIP ID.
 *
 * Returns `null` (not throw) when no tenant matches; the route layer then
 * decides whether to fall back to platform default or reject the callback
 * outright. Per-facility multi-tenant deployments should reject; legacy
 * single-tenant deployments should accept under the seeded hospital.
 */
export async function findHipTenant(hipIdHeader: string | null | undefined): Promise<(HospitalAbdmContext & { hipId: string; hipName: string }) | null> {
  if (!hipIdHeader) return null;
  const hospital = await prisma.hospital.findFirst({
    where: {
      // hipId is the canonical match. hfrFacilityId is the same value at
      // facilities that registered both fields under one HFR id (common case).
      OR: [{ hipId: hipIdHeader }, { hfrFacilityId: hipIdHeader }],
    },
    select: {
      id: true,
      hipId: true, hipName: true,
      hiuId: true, hiuName: true,
      abdmClientId: true, abdmClientSecret: true,
      name: true,
    },
  });
  if (!hospital || !hospital.hipId) return null;
  return {
    hospitalId: hospital.id,
    clientId: hospital.abdmClientId,
    clientSecret: hospital.abdmClientSecret,
    hipId: hospital.hipId,
    hiuId: hospital.hiuId,
    hipName: hospital.hipName || hospital.name,
    hiuName: hospital.hiuName || hospital.name,
  };
}

/** HIU-side mirror of `findHipTenant`. */
export async function findHiuTenant(hiuIdHeader: string | null | undefined): Promise<(HospitalAbdmContext & { hiuId: string; hiuName: string }) | null> {
  if (!hiuIdHeader) return null;
  const hospital = await prisma.hospital.findFirst({
    where: { hiuId: hiuIdHeader },
    select: {
      id: true,
      hipId: true, hipName: true,
      hiuId: true, hiuName: true,
      abdmClientId: true, abdmClientSecret: true,
      name: true,
    },
  });
  if (!hospital || !hospital.hiuId) return null;
  return {
    hospitalId: hospital.id,
    clientId: hospital.abdmClientId,
    clientSecret: hospital.abdmClientSecret,
    hipId: hospital.hipId,
    hiuId: hospital.hiuId,
    hipName: hospital.hipName || hospital.name,
    hiuName: hospital.hiuName || hospital.name,
  };
}

// ABDM has deprecated v0.5. Using v3 only — confirmed in writing by ABDM support
// (06/04/2026 & 06/05/2026 sandbox tickets). v0.5 calls from non-whitelisted
// origin servers are now blocked at CloudFront with HTML 403 responses.
const SESSION_ENDPOINTS = [
  `${process.env.ABDM_SESSIONS_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions'}`,
];

// ─────────────────────────────────────────────────────────────────────────────
// ABDM Client  (V3)
// ─────────────────────────────────────────────────────────────────────────────

export class AbdmClient {
  private axiosInstance: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiryTime: number = 0;
  private publicKey: string | null = null;

  constructor() {
    this.axiosInstance = axios.create({
      timeout: abdmConfig.timeout,
      headers: { 'Content-Type': 'application/json' },
      httpsAgent: ipv4HttpsAgent, // Force IPv4 to bypass per-edge CloudFront WAF on abhasbx
    });
    this.setupInterceptors();
  }

  // ── Interceptors ────────────────────────────────────────────────────────────

  private setupInterceptors(): void {
    this.axiosInstance.interceptors.request.use((config) => {
      (config as any)._startTime = Date.now();
      return config;
    });

    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.logTransaction(response.config, response);
        return response;
      },
      async (error) => {
        this.logTransaction(error.config, error.response, error);
        const retried = (error.config as any)?._retried;
        if (error.response?.status === 401 && !retried) {
          logger.warn('[ABDM-INTERCEPTOR] Got 401, re-authenticating (one retry)...');
          this.accessToken = null;
          this.tokenExpiryTime = 0;
          error.config._retried = true;
          await this.authenticate();
          return this.axiosInstance.request(error.config);
        }
        return Promise.reject(error);
      }
    );
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  private async logTransaction(
    config: AxiosRequestConfig,
    response?: AxiosResponse,
    error?: any
  ): Promise<void> {
    try {
      let requestPayload = {};
      try { requestPayload = typeof config.data === 'string' ? JSON.parse(config.data) : config.data || {}; } catch { requestPayload = {}; }

      const startTime = (config as any)?._startTime;
      const duration = startTime ? Date.now() - startTime : null;

      await prisma.abdmTransaction.create({
        data: {
          transactionId: crypto.randomUUID(),
          requestId: (config.headers?.['REQUEST-ID'] as string) || null,
          apiEndpoint: config.url || '',
          method: config.method?.toUpperCase() || 'GET',
          requestPayload,
          responsePayload: response?.data || null,
          statusCode: response?.status ?? error?.response?.status ?? null,
          success: !!response && response.status >= 200 && response.status < 300,
          errorMessage: error?.message || null,
          duration,
        },
      });
    } catch (err: any) {
      logger.error('Failed to log ABDM transaction', { message: err?.message });
    }
  }

  // ── Auth: V3 Session Token ───────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    const payload = {
      clientId: abdmConfig.clientId,
      clientSecret: abdmConfig.clientSecret,
      grantType: 'client_credentials',
    };

    logger.info('[ABDM-AUTH] Starting authentication', {
      clientId: abdmConfig.clientId || '(EMPTY)',
      hasSecret: !!abdmConfig.clientSecret,
      endpoints: SESSION_ENDPOINTS,
    });

    for (const endpoint of SESSION_ENDPOINTS) {
      try {
        logger.info(`[ABDM-AUTH] Trying endpoint: ${endpoint}`);
        const response = await axios.post<AbdmV3SessionResponse>(
          endpoint,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'REQUEST-ID': crypto.randomUUID(),
              'TIMESTAMP': new Date().toISOString(),
              'X-CM-ID': abdmConfig.cmId || 'sbx',
            },
            timeout: abdmConfig.timeout,
            httpsAgent: ipv4HttpsAgent,
          }
        );
        // ABDM sandbox sometimes returns HTTP 200 with an error body instead of 4xx
        if ((response.data as any).error || !(response.data as any).accessToken) {
          const errMsg = (response.data as any).error?.message
            || (response.data as any).error?.code
            || 'No accessToken in response';
          logger.error(`[ABDM-AUTH] Got HTTP 200 but no token from ${endpoint}`, { body: JSON.stringify(response.data).substring(0, 200) });
          throw new Error(`ABDM auth error: ${errMsg}`);
        }

        this.accessToken = response.data.accessToken;
        this.tokenExpiryTime = Date.now() + (response.data.expiresIn || 1800) * 1000 - 60_000;
        logger.info(`[ABDM-AUTH] SUCCESS via ${endpoint}`, {
          tokenPreview: this.accessToken?.substring(0, 20) + '...',
          expiresIn: response.data.expiresIn,
        });
        return;
      } catch (error: any) {
        logger.error(`[ABDM-AUTH] FAILED on ${endpoint}`, {
          status: error?.response?.status,
          statusText: error?.response?.statusText,
          data: JSON.stringify(error?.response?.data)?.substring(0, 500),
          message: error?.message,
          code: error?.code,
        });
      }
    }

    logger.error('[ABDM-AUTH] ALL endpoints failed', {
      clientId: abdmConfig.clientId || '(EMPTY)',
    });
    throw new Error('Failed to authenticate with ABDM gateway');
  }

  async ensureValidToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiryTime) {
      logger.info('[ABDM-TOKEN] Token expired or missing, re-authenticating...');
      await this.authenticate();
    }
    return this.accessToken!;
  }

  // ── RSA public key + OAEP encryption ────────────────────────────────────────

  async getPublicKey(): Promise<string> {
    if (this.publicKey) {
      logger.info('[ABDM-KEY] Using cached public key');
      return this.publicKey;
    }
    const certUrl = `${abdmConfig.abhaUrl}${abdmConfig.endpoints.profile.publicCertificate}`;
    logger.info(`[ABDM-KEY] Fetching public key from ${certUrl}`);
    try {
      const token = await this.ensureValidToken();
      const response = await axios.get<{ publicKey: string; encryptionAlgorithm: string }>(
        certUrl,
        { headers: this.abhaHeaders(token), httpsAgent: ipv4HttpsAgent }
      );
      const raw = response.data.publicKey;
      this.publicKey = raw.includes('BEGIN') ? raw :
        `-----BEGIN PUBLIC KEY-----\n${raw.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
      logger.info('[ABDM-KEY] Public key fetched successfully');
      return this.publicKey;
    } catch (error: any) {
      logger.error('[ABDM-KEY] Failed to fetch public key', {
        url: certUrl,
        status: error?.response?.status,
        data: JSON.stringify(error?.response?.data)?.substring(0, 300),
        message: error?.message,
        code: error?.code,
      });
      throw error;
    }
  }

  /**
   * Encrypt any sensitive value (Aadhaar, OTP, mobile, etc.) using
   * RSA/ECB/OAEPWithSHA-1AndMGF1Padding — required by ABDM V3.
   */
  async encrypt(plaintext: string): Promise<string> {
    logger.info('[ABDM-ENCRYPT] Encrypting value', { length: plaintext.length });
    const key = await this.getPublicKey();
    const encrypted = crypto.publicEncrypt(
      {
        key,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1',
      },
      Buffer.from(plaintext, 'utf8')
    );
    logger.info('[ABDM-ENCRYPT] Encryption successful');
    return encrypted.toString('base64');
  }

  // ── V3 required headers ─────────────────────────────────────────────────────

  /** Headers for ABHA server calls (abhasbx.abdm.gov.in) */
  abhaHeaders(token: string, xToken?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'REQUEST-ID': crypto.randomUUID(),
      'TIMESTAMP': new Date().toISOString(),
      'Authorization': `Bearer ${token}`,
    };
    if (xToken) h['X-token'] = `Bearer ${xToken}`;
    return h;
  }

  /** Headers for gateway calls (dev.abdm.gov.in).
   * `extra` lets callers add ABDM routing headers required by specific V3
   * endpoints, e.g. X-HIP-ID (generate-token / link/carecontext),
   * X-LINK-TOKEN (link/carecontext) or X-HIU-ID.
   *
   * If `tenant` is provided, its `cmId` overrides the env-level CM-ID. The
   * caller is responsible for stamping any HIP/HIU headers in `extra` (or
   * letting `post()` / `get()` auto-detect them from the URL).
   */
  gatewayHeaders(
    token: string,
    extra?: Record<string, string>,
    tenant?: HospitalAbdmContext | null,
  ): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'REQUEST-ID': crypto.randomUUID(),
      'TIMESTAMP': new Date().toISOString(),
      'Authorization': `Bearer ${token}`,
      'X-CM-ID': (tenant?.cmId || abdmConfig.cmId) as string,
      ...(extra || {}),
    };
  }

  // ── Generic HTTP helpers for ABHA server ────────────────────────────────────

  async abhaPost<T = any>(path: string, data?: any, xToken?: string): Promise<T> {
    const fullUrl = `${abdmConfig.abhaUrl}${path}`;
    logger.info(`[ABDM-API] POST ${fullUrl}`, { bodyKeys: data ? Object.keys(data) : [] });
    const token = await this.ensureValidToken();
    try {
      const response = await this.axiosInstance.post<T>(
        fullUrl,
        data,
        { headers: this.abhaHeaders(token, xToken) }
      );
      logger.info(`[ABDM-API] POST ${path} => ${response.status} OK`);
      return response.data;
    } catch (error: any) {
      logger.error(`[ABDM-API] POST ${path} FAILED`, {
        status: error?.response?.status,
        data: JSON.stringify(error?.response?.data)?.substring(0, 500),
        message: error?.message,
      });
      throw error;
    }
  }

  async abhaGet<T = any>(path: string, xToken?: string, params?: Record<string, string>, responseType?: 'json' | 'arraybuffer'): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.get<T>(
      `${abdmConfig.abhaUrl}${path}`,
      { headers: this.abhaHeaders(token, xToken), params, responseType: responseType || 'json' }
    );
    return response.data;
  }

  async abhaPatch<T = any>(path: string, data?: any, xToken?: string): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.patch<T>(
      `${abdmConfig.abhaUrl}${path}`,
      data,
      { headers: this.abhaHeaders(token, xToken) }
    );
    return response.data;
  }

  // ── Generic HTTP helpers for PHR server ─────────────────────────────────────

  async phrPost<T = any>(path: string, data?: any, xToken?: string): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.post<T>(
      `${abdmConfig.phrUrl}${path}`,
      data,
      { headers: this.abhaHeaders(token, xToken) }
    );
    return response.data;
  }

  async phrGet<T = any>(path: string, xToken?: string): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.get<T>(
      `${abdmConfig.phrUrl}${path}`,
      { headers: this.abhaHeaders(token, xToken) }
    );
    return response.data;
  }

  // ── Generic HTTP helpers for gateway ────────────────────────────────────────

  async gatewayPost<T = any>(path: string, data?: any): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.post<T>(
      `${abdmConfig.gatewayUrl}${path}`,
      data,
      { headers: this.gatewayHeaders(token) }
    );
    return response.data;
  }

  async gatewayGet<T = any>(path: string): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.get<T>(
      `${abdmConfig.gatewayUrl}${path}`,
      { headers: this.gatewayHeaders(token) }
    );
    return response.data;
  }

  async gatewayPatch<T = any>(path: string, data?: any): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.patch<T>(
      `${abdmConfig.gatewayUrl}${path}`,
      data,
      { headers: this.gatewayHeaders(token) }
    );
    return response.data;
  }

  // ── Bridge management (V3) ───────────────────────────────────────────────────

  async updateBridgeUrl(url: string): Promise<void> {
    await this.gatewayPatch(abdmConfig.endpoints.bridge.updateUrl, { url });
    logger.info(`ABDM V3 bridge URL set: ${url}`);
  }

  async getBridgeServices(): Promise<any> {
    return this.gatewayGet(abdmConfig.endpoints.bridge.getServices);
  }

  async getBridgeServiceById(serviceId: string): Promise<any> {
    return this.gatewayGet(`${abdmConfig.endpoints.bridge.getServiceById}/${serviceId}`);
  }

  async addBridgeHipService(params: {
    facilityId: string;
    facilityName: string;
    bridgeId: string;
    hipName: string;
    active?: boolean;
  }): Promise<void> {
    const token = await this.ensureValidToken();
    await this.axiosInstance.post(
      `${abdmConfig.facilityUrl}${abdmConfig.endpoints.facility.addUpdateServices}`,
      {
        facilityId: params.facilityId,
        facilityName: params.facilityName,
        HRP: [{
          bridgeId: params.bridgeId,
          hipName: params.hipName,
          type: 'HIP',
          active: params.active ?? true,
        }],
      },
      { headers: this.gatewayHeaders(token) }
    );
    logger.info(`ABDM V3 HIP service registered: ${params.facilityId}`);
  }

  async addBridgeHiuService(params: {
    facilityId: string;
    facilityName: string;
    bridgeId: string;
    hiuName: string;
    active?: boolean;
  }): Promise<void> {
    const token = await this.ensureValidToken();
    await this.axiosInstance.post(
      `${abdmConfig.facilityUrl}${abdmConfig.endpoints.facility.addUpdateServices}`,
      {
        facilityId: params.facilityId,
        facilityName: params.facilityName,
        HRP: [{
          bridgeId: params.bridgeId,
          hipName: params.hiuName,
          type: 'HIU',
          active: params.active ?? true,
        }],
      },
      { headers: this.gatewayHeaders(token) }
    );
    logger.info(`ABDM V3 HIU service registered: ${params.facilityId}`);
  }

  // ── Generic helpers for legacy M2/M3 services (absolute URLs) ───────────

  /**
   * Generic gateway POST. ABDM's istio/envoy edge requires X-HIU-ID on every
   * HIU-facing endpoint and X-HIP-ID on every HIP-facing endpoint. We auto-
   * detect from the URL path so callers don't have to remember; explicit
   * extraHeaders still win on conflict.
   */
  async post<T = any>(
    url: string,
    data?: any,
    extraHeaders?: Record<string, string>,
    tenant?: HospitalAbdmContext | null,
  ): Promise<T> {
    const token = await this.ensureValidToken();
    const role = this.detectGatewayRole(url);
    const merged: Record<string, string> = {};
    const hipId = tenant?.hipId || abdmConfig.hip.id;
    const hiuId = tenant?.hiuId || abdmConfig.hiu.id;
    if (role === 'HIU' && hiuId) merged['X-HIU-ID'] = hiuId;
    if (role === 'HIP' && hipId) merged['X-HIP-ID'] = hipId;
    Object.assign(merged, extraHeaders || {});
    const response = await this.axiosInstance.post<T>(url, data, {
      headers: this.gatewayHeaders(token, merged, tenant),
    });
    return response.data;
  }

  async get<T = any>(url: string, tenant?: HospitalAbdmContext | null): Promise<T> {
    const token = await this.ensureValidToken();
    const role = this.detectGatewayRole(url);
    const extra: Record<string, string> = {};
    const hipId = tenant?.hipId || abdmConfig.hip.id;
    const hiuId = tenant?.hiuId || abdmConfig.hiu.id;
    if (role === 'HIU' && hiuId) extra['X-HIU-ID'] = hiuId;
    if (role === 'HIP' && hipId) extra['X-HIP-ID'] = hipId;
    const response = await this.axiosInstance.get<T>(url, {
      headers: this.gatewayHeaders(token, extra, tenant),
    });
    return response.data;
  }

  /**
   * Determine whether a gateway URL is HIU-facing or HIP-facing.
   * Matches both V3 (/api/hiecm/...) and legacy (/v0.5/...) paths.
   * Returns null for endpoints that don't need a role header (e.g. consent
   * init, sessions, bridge).
   */
  private detectGatewayRole(url: string): 'HIU' | 'HIP' | null {
    const u = url.toLowerCase();

    // ── HIU-facing endpoints (X-HIU-ID required by gateway envoy) ────────
    // NOTE: /api/hiecm/data-flow/v3/health-information/notify is shared
    // between HIP and HIU; per spec it only requires X-CM-ID, so we do NOT
    // auto-stamp a role header on that path. Callers can pass extraHeaders
    // explicitly if they want to.
    if (
      u.includes('/data-flow/v3/health-information/request') ||
      u.includes('/consent/v3/fetch') ||
      u.includes('/consent/v3/request/status') ||
      u.includes('/consent/v3/request/init') ||
      u.includes('/consent/v3/request/hiu/') ||
      u.includes('/api-hiu/')
    ) {
      return 'HIU';
    }

    // ── HIP-facing endpoints ─────────────────────────────────────────────
    if (
      u.includes('/hip/v3/') ||
      u.includes('/data-flow/v3/health-information/hip/') ||
      u.includes('/consent/v3/request/hip/') ||
      u.includes('/care-context/v3/discover') ||
      u.includes('/care-context/v3/on-discover') ||
      u.includes('/care-context/v3/link') ||
      u.includes('/care-context/v3/on-link') ||
      u.includes('/patients/v3/status/on-notify') ||
      u.includes('/api/hiecm/v3/token/generate-token') ||
      u.includes('/api/hiecm/sms/notify')
    ) {
      return 'HIP';
    }

    return null;
  }
}

export default new AbdmClient();
