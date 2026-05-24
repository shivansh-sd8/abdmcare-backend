import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import crypto from 'crypto';
import { abdmConfig } from '../config/abdm';
import logger from '../config/logger';
import prisma from '../config/database';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AbdmV3SessionResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  tokenType: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ABDM Client  (V3)
// ─────────────────────────────────────────────────────────────────────────────

export class AbdmClient {
  private axiosInstance: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiryTime: number = 0;
  private publicKey: string | null = null;   // RSA public key from ABHA cert API

  constructor() {
    this.axiosInstance = axios.create({
      timeout: abdmConfig.timeout,
      headers: { 'Content-Type': 'application/json' },
    });
    this.setupInterceptors();
  }

  // ── Interceptors ────────────────────────────────────────────────────────────

  private setupInterceptors(): void {
    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.logTransaction(response.config, response);
        return response;
      },
      async (error) => {
        this.logTransaction(error.config, error.response, error);
        if (error.response?.status === 401) {
          this.accessToken = null;
          this.tokenExpiryTime = 0;
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
          duration: null,
        },
      });
    } catch (err: any) {
      logger.error('Failed to log ABDM transaction', { message: err?.message });
    }
  }

  // ── Auth: V3 Session Token ──────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    try {
      const response = await axios.post<AbdmV3SessionResponse>(
        `https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions`,
        {
          clientId: abdmConfig.clientId,
          clientSecret: abdmConfig.clientSecret,
          grantType: 'client_credentials',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: abdmConfig.timeout,
        }
      );
      this.accessToken = response.data.accessToken;
      this.tokenExpiryTime = Date.now() + response.data.expiresIn * 1000 - 60_000;
      logger.info('ABDM V3 authentication successful');
    } catch (error: any) {
      logger.error('ABDM V3 authentication failed', { message: error?.message, status: error?.response?.status, data: error?.response?.data });
      throw new Error('Failed to authenticate with ABDM gateway');
    }
  }

  async ensureValidToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiryTime) {
      await this.authenticate();
    }
    return this.accessToken!;
  }

  // ── RSA public key + OAEP encryption ────────────────────────────────────────

  async getPublicKey(): Promise<string> {
    if (this.publicKey) return this.publicKey;
    try {
      const token = await this.ensureValidToken();
      const response = await axios.get<{ publicKey: string; encryptionAlgorithm: string }>(
        `${abdmConfig.abhaUrl}${abdmConfig.endpoints.profile.publicCertificate}`,
        { headers: this.abhaHeaders(token) }
      );
      const raw = response.data.publicKey;
      // Wrap in PEM if not already
      this.publicKey = raw.includes('BEGIN') ? raw :
        `-----BEGIN PUBLIC KEY-----\n${raw.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
      logger.info('ABDM V3 public key fetched');
      return this.publicKey;
    } catch (error: any) {
      logger.error('Failed to fetch ABDM public key', { message: error?.message, status: error?.response?.status });
      throw error;
    }
  }

  /**
   * Encrypt any sensitive value (Aadhaar, OTP, mobile, etc.) using
   * RSA/ECB/OAEPWithSHA-1AndMGF1Padding — required by ABDM V3.
   */
  async encrypt(plaintext: string): Promise<string> {
    const key = await this.getPublicKey();
    const encrypted = crypto.publicEncrypt(
      {
        key,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1',
      },
      Buffer.from(plaintext, 'utf8')
    );
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

  /** Headers for gateway calls (dev.abdm.gov.in) */
  gatewayHeaders(token: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'REQUEST-ID': crypto.randomUUID(),
      'TIMESTAMP': new Date().toISOString(),
      'Authorization': `Bearer ${token}`,
      'X-CM-ID': abdmConfig.cmId,
    };
  }

  // ── Generic HTTP helpers for ABHA server ────────────────────────────────────

  async abhaPost<T = any>(path: string, data?: any, xToken?: string): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.post<T>(
      `${abdmConfig.abhaUrl}${path}`,
      data,
      { headers: this.abhaHeaders(token, xToken) }
    );
    return response.data;
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

  // ── Generic helpers for legacy M2/M3 services (absolute URLs) ───────────

  async post<T = any>(url: string, data?: any): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.post<T>(url, data, {
      headers: this.gatewayHeaders(token),
    });
    return response.data;
  }

  async get<T = any>(url: string): Promise<T> {
    const token = await this.ensureValidToken();
    const response = await this.axiosInstance.get<T>(url, {
      headers: this.gatewayHeaders(token),
    });
    return response.data;
  }
}

export default new AbdmClient();
