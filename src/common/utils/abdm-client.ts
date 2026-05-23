import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { abdmConfig } from '../config/abdm';
import logger from '../config/logger';
import EncryptionService from './encryption';
import prisma from '../config/database';

interface AbdmAuthResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
}

export class AbdmClient {
  private axiosInstance: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiryTime: number = 0;
  private publicCert: string | null = null;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: abdmConfig.baseUrl,
      timeout: abdmConfig.timeout,
      headers: {
        'Content-Type': 'application/json',
        // Required by ABDM gateway on all calls: 'sbx' in sandbox, 'abdm' in production
        'X-CM-ID': abdmConfig.cmId,
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.axiosInstance.interceptors.request.use(
      async (config) => {
        await this.ensureValidToken();
        if (this.accessToken && config.headers) {
          config.headers.Authorization = `Bearer ${this.accessToken}`;
        }
        return config;
      },
      (error) => {
        logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

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
          await this.ensureValidToken();
          return this.axiosInstance.request(error.config);
        }
        
        return Promise.reject(error);
      }
    );
  }

  private async logTransaction(
    config: AxiosRequestConfig,
    response?: AxiosResponse,
    error?: any
  ): Promise<void> {
    try {
      await prisma.abdmTransaction.create({
        data: {
          transactionId: crypto.randomUUID(),
          requestId: config.headers?.['X-Request-Id'] as string,
          apiEndpoint: config.url || '',
          method: config.method?.toUpperCase() || 'GET',
          requestPayload: config.data || {},
          responsePayload: response?.data || null,
          statusCode: response?.status || error?.response?.status || null,
          success: !!response && response.status >= 200 && response.status < 300,
          errorMessage: error?.message || null,
          duration: null,
        },
      });
    } catch (err) {
      logger.error('Failed to log ABDM transaction', err);
    }
  }

  private async ensureValidToken(): Promise<void> {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiryTime > now) {
      return;
    }

    await this.authenticate();
  }

  private async authenticate(): Promise<void> {
    try {
      // Sessions endpoint lives on baseUrl (not gatewayUrl) — e.g. https://dev.abdm.gov.in/gateway/v0.5/sessions
      const response = await axios.post<AbdmAuthResponse>(
        `${abdmConfig.baseUrl}${abdmConfig.endpoints.auth.sessions}`,
        {
          clientId: abdmConfig.clientId,
          clientSecret: abdmConfig.clientSecret,
        }
      );

      this.accessToken = response.data.accessToken;
      this.tokenExpiryTime = Date.now() + response.data.expiresIn * 1000 - 60000;

      logger.info('ABDM authentication successful');
    } catch (error) {
      logger.error('ABDM authentication failed', error);
      throw new Error('Failed to authenticate with ABDM');
    }
  }

  async getPublicCert(): Promise<string> {
    if (this.publicCert) {
      return this.publicCert;
    }

    try {
      const response = await this.axiosInstance.get(abdmConfig.endpoints.auth.cert);
      this.publicCert = response.data;
      
      if (!this.publicCert) {
        throw new Error('Public certificate is empty');
      }
      
      EncryptionService.setPublicKey(this.publicCert);
      
      logger.info('ABDM public certificate fetched successfully');
      return this.publicCert;
    } catch (error) {
      logger.error('Failed to fetch ABDM public certificate', error);
      throw error;
    }
  }

  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axiosInstance.post<T>(url, data, config);
    return response.data;
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axiosInstance.get<T>(url, config);
    return response.data;
  }

  async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axiosInstance.put<T>(url, data, config);
    return response.data;
  }

  async patch<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axiosInstance.patch<T>(url, data, config);
    return response.data;
  }

  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axiosInstance.delete<T>(url, config);
    return response.data;
  }

  // -------------------------------------------------------------------------
  // Bridge management helpers (called once during sandbox setup)
  // -------------------------------------------------------------------------

  async updateBridgeUrl(bridgeUrl: string): Promise<void> {
    // PATCH callback URL — lives on gatewayUrl (confirmed from ABDM email)
    await this.patch(`${abdmConfig.gatewayUrl}${abdmConfig.endpoints.bridge.update}`, {
      url: bridgeUrl,
    });
    logger.info(`ABDM bridge URL registered: ${bridgeUrl}`);
  }

  async addBridgeService(service: {
    id: string;
    name: string;
    type: 'HIP' | 'HIU' | 'HEALTH_LOCKER';
    active: boolean;
    alias?: string[];
    endpoints: { address: string; connectionType: string; use: string }[];
  }): Promise<void> {
    await this.post(`${abdmConfig.gatewayUrl}${abdmConfig.endpoints.bridge.addUpdateServices}`, [service]);
    logger.info(`ABDM bridge service registered: ${service.id} (${service.type})`);
  }

  async getBridgeServices(): Promise<any> {
    return this.get(`${abdmConfig.gatewayUrl}${abdmConfig.endpoints.bridge.getServices}`);
  }

  encryptSensitiveData(data: string): string {
    if (!this.publicCert) {
      throw new Error('Public certificate not available. Call getPublicCert() first.');
    }
    return EncryptionService.encryptWithRSA(data, this.publicCert);
  }
}

export default new AbdmClient();
