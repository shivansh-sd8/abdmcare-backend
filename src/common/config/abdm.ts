export const abdmConfig = {
  baseUrl: process.env.ABDM_BASE_URL || 'https://dev.abdm.gov.in',
  // Gateway base — all HIP/HIU/consent async APIs live here
  gatewayUrl: process.env.ABDM_GATEWAY_URL || 'https://dev.abdm.gov.in/gateway',
  // DevService base — sandbox-only bridge registration lives here
  devServiceUrl: process.env.ABDM_DEVSERVICE_URL || 'https://dev.abdm.gov.in/devservice',
  clientId: process.env.ABDM_CLIENT_ID || '',
  clientSecret: process.env.ABDM_CLIENT_SECRET || '',
  callbackUrl: process.env.ABDM_CALLBACK_URL || '',
  // X-CM-ID header: 'sbx' for sandbox, 'abdm' for production
  cmId: process.env.ABDM_CM_ID || 'sbx',

  hip: {
    id: process.env.HIP_ID || '',
    name: process.env.HIP_NAME || '',
  },

  hiu: {
    id: process.env.HIU_ID || '',
    name: process.env.HIU_NAME || '',
  },

  endpoints: {
    auth: {
      cert: '/v2/auth/cert',
      // Correct ABDM gateway session endpoint
      sessions: '/gateway/v0.5/sessions',
    },
    bridge: {
      // PATCH bridge URL — uses gatewayUrl (https://dev.abdm.gov.in/gateway/v1/bridges)
      update: '/v1/bridges',
      // POST add/update HIP/HIU service
      addUpdateServices: '/v1/bridges/addUpdateServices',
      // GET check registered services
      getServices: '/v1/bridges/getServices',
    },
    // ABHA M1 APIs (v2)
    abha: {
      generateAadhaarOtp: '/v2/registration/aadhaar/generateOtp',
      verifyAadhaarOtp: '/v2/registration/aadhaar/verifyOTP',
      resendAadhaarOtp: '/v2/registration/aadhaar/resendAadhaarOtp',
      createHealthId: '/v2/registration/aadhaar/createHealthIdWithPreVerified',
      generateMobileOtp: '/v2/registration/mobile/generateOtp',
      verifyMobileOtp: '/v2/registration/mobile/verifyOtp',
      
      // Profile APIs
      profile: '/v2/account/profile',
      updateProfile: '/v2/account/profile',
      qrCode: '/v2/account/qrCode',
      card: '/v2/account/getPngCard',
      
      // Search & Retrieve
      searchByHealthId: '/v2/search/searchByHealthId',
      searchByMobile: '/v2/search/existsByMobile',
      authInit: '/v2/auth/init',
      authConfirm: '/v2/auth/confirm',
    },
    // HIP APIs (M2)
    hip: {
      discover: '/v0.5/care-contexts/discover',
      link: '/v0.5/links/link/init',
      onDiscover: '/v0.5/care-contexts/on-discover',
      onLink: '/v0.5/links/link/on-init',
      healthInformation: '/v0.5/health-information/hip/request',
      onRequest: '/v0.5/health-information/hip/on-request',
      notify: '/v0.5/links/link/add-contexts',
    },
    // HIU APIs (M3)
    hiu: {
      discover: '/v0.5/care-contexts/discover',
      link: '/v0.5/links/link/init',
      consentRequest: '/v0.5/consent-requests/init',
      healthInformationRequest: '/v0.5/health-information/cm/request',
      onDiscover: '/v0.5/care-contexts/on-discover',
      onInit: '/v0.5/consent-requests/on-init',
      onStatus: '/v0.5/consent-requests/on-status',
      onFetch: '/v0.5/consents/hip/on-notify',
    },
    // Consent Management
    consent: {
      init: '/v0.5/consent-requests/init',
      status: '/v0.5/consent-requests/status',
      fetch: '/v0.5/consents/fetch',
      notify: '/v0.5/consents/hip/notify',
      onNotify: '/v0.5/consents/hip/on-notify',
    },
  },
  
  timeout: 30000,
  retryAttempts: 3,
  retryDelay: 1000,
};

export default abdmConfig;
