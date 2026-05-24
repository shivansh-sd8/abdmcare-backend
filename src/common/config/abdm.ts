// ─────────────────────────────────────────────────────────────────────────────
// ABDM V3 Configuration — M1 + M2 + M3
// All URLs confirmed from official Postman Collections (M1: 18-08-2025, M2/M3: 16-02-2026)
// ─────────────────────────────────────────────────────────────────────────────

const GATEWAY_BASE = process.env.ABDM_GATEWAY_BASE || 'https://dev.abdm.gov.in';

export const abdmConfig = {
  // ── Base URLs ──────────────────────────────────────────────────────────────
  gatewayUrl: process.env.ABDM_GATEWAY_URL || `${GATEWAY_BASE}/api/hiecm/gateway/v3`,
  abhaUrl: process.env.ABDM_ABHA_URL || 'https://abhasbx.abdm.gov.in/abha/api',
  phrUrl: process.env.ABDM_PHR_URL || 'https://abhasbx.abdm.gov.in/abha/api/v3/phr/web',
  facilityUrl: process.env.ABDM_FACILITY_URL || 'https://apihspsbx.abdm.gov.in/v4/int',

  // ── Client credentials ─────────────────────────────────────────────────────
  clientId: process.env.ABDM_CLIENT_ID || '',
  clientSecret: process.env.ABDM_CLIENT_SECRET || '',
  callbackUrl: process.env.ABDM_CALLBACK_URL || '',
  cmId: process.env.ABDM_CM_ID || 'sbx',

  hip: {
    id: process.env.HIP_ID || '',
    name: process.env.HIP_NAME || '',
  },
  hiu: {
    id: process.env.HIU_ID || '',
    name: process.env.HIU_NAME || '',
  },

  // ── Endpoints ─────────────────────────────────────────────────────────────

  endpoints: {
    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  GATEWAY (relative to gatewayUrl)                                    │
    // └─────────────────────────────────────────────────────────────────────┘
    auth: {
      sessions: '/sessions',
      cert: '/certs',
      openidConfig: '/.well-known/openid-configuration',
    },

    bridge: {
      updateUrl: '/bridge/url',
      getServices: '/bridge-services',
      getServiceById: '/bridge-service/serviceId',
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  FACILITY (relative to facilityUrl)                                  │
    // └─────────────────────────────────────────────────────────────────────┘
    facility: {
      addUpdateServices: '/v1/bridges/MutipleHRPAddUpdateServices',
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  M1 — ABHA ENROLLMENT (relative to abhaUrl)                          │
    // └─────────────────────────────────────────────────────────────────────┘
    enrollment: {
      requestOtp: '/v3/enrollment/request/otp',
      enrolByAadhaar: '/v3/enrollment/enrol/byAadhaar',
      enrolByDocument: '/v3/enrollment/enrol/byDocument',
      authByAbdm: '/v3/enrollment/auth/byAbdm',
      suggestion: '/v3/enrollment/enrol/suggestion',
      abhaAddress: '/v3/enrollment/enrol/abha-address',
      children: '/v3/enrollment/profile/children',
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  M1 — ABHA PROFILE / LOGIN (relative to abhaUrl)                     │
    // └─────────────────────────────────────────────────────────────────────┘
    profile: {
      publicCertificate: '/v3/profile/public/certificate',
      loginRequestOtp: '/v3/profile/login/request/otp',
      loginVerify: '/v3/profile/login/verify',
      loginVerifyUser: '/v3/profile/login/verify/user',
      loginSearch: '/v3/profile/login/search',
      account: '/v3/profile/account',
      qrCode: '/v3/profile/account/qrCode',
      abhaCard: '/v3/profile/account/abha-card',
      requestOtp: '/v3/profile/account/request/otp',
      verify: '/v3/profile/account/verify',
      requestEmailVerification: '/v3/profile/account/request/emailVerificationLink',
      logout: '/v3/profile/account/request/logout',
      refreshToken: '/v3/profile/account/request/token',
      abhaSearch: '/v3/profile/account/abha/search',
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  M1 — PHR / ABHA Address Verification (relative to phrUrl)           │
    // └─────────────────────────────────────────────────────────────────────┘
    phr: {
      search: '/login/abha/search',
      requestOtp: '/login/abha/request/otp',
      verify: '/login/abha/verify',
      profile: '/login/profile/abha-profile',
      phrCard: '/login/profile/abha/phr-card',
      qrCode: '/login/profile/abha/qr-code',
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  M1 — SCAN & SHARE                                                   │
    // └─────────────────────────────────────────────────────────────────────┘
    scanAndShare: {
      profileShare: '/api/v3/hip/patient/share',
      onShare: '/patient-share/v3/on-share',
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  M2 — HIP LINKING & DATA TRANSFER (absolute URLs — GATEWAY_BASE)     │
    // └─────────────────────────────────────────────────────────────────────┘
    hip: {
      // HIP Initiated Linking
      generateToken: `${GATEWAY_BASE}/api/hiecm/v3/token/generate-token`,
      linkCareContext: `${GATEWAY_BASE}/api/hiecm/hip/v3/link/carecontext`,
      linkContextNotify: `${GATEWAY_BASE}/api/hiecm/hip/v3/link/context/notify`,
      smsNotify: `${GATEWAY_BASE}/api/hiecm/hip/v3/link/patient/links/sms/notify2`,

      // User Initiated Linking (HIP sends these back to gateway)
      onDiscover: `${GATEWAY_BASE}/api/hiecm/user-initiated-linking/v3/patient/care-context/on-discover`,
      onLinkInit: `${GATEWAY_BASE}/api/hiecm/user-initiated-linking/v3/link/care-context/on-init`,
      onLinkConfirm: `${GATEWAY_BASE}/api/hiecm/user-initiated-linking/v3/link/care-context/on-confirm`,

      // Data Transfer (HIP side)
      consentOnNotify: `${GATEWAY_BASE}/api/hiecm/consent/v3/request/hip/on-notify`,
      healthInfoOnRequest: `${GATEWAY_BASE}/api/hiecm/data-flow/v3/health-information/hip/on-request`,
      dataFlowNotify: `${GATEWAY_BASE}/api/hiecm/data-flow/v3/health-information/notify`,
    },

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │  M3 — HIU CONSENT & DATA REQUEST (absolute URLs — GATEWAY_BASE)      │
    // └─────────────────────────────────────────────────────────────────────┘
    hiu: {
      consentInit: `${GATEWAY_BASE}/api/hiecm/consent/v3/request/init`,
      consentStatus: `${GATEWAY_BASE}/api/hiecm/consent/v3/request/status`,
      consentOnNotify: `${GATEWAY_BASE}/api/hiecm/consent/v3/request/hiu/on-notify`,
      consentFetch: `${GATEWAY_BASE}/api/hiecm/consent/v3/fetch`,
      healthInfoRequest: `${GATEWAY_BASE}/api/hiecm/data-flow/v3/health-information/request`,
      dataFlowNotify: `${GATEWAY_BASE}/api/hiecm/data-flow/v3/health-information/notify`,
      dataPushUrl: `${GATEWAY_BASE}/api-hiu/data/notification`,
    },

    // Keep legacy keys for any remaining old references (aliases)
    consent: {
      init: `${GATEWAY_BASE}/api/hiecm/consent/v3/request/init`,
      fetch: `${GATEWAY_BASE}/api/hiecm/consent/v3/fetch`,
      notify: `${GATEWAY_BASE}/api/hiecm/consent/v3/request/hiu/on-notify`,
    },
  },

  timeout: 30000,
};

export default abdmConfig;
