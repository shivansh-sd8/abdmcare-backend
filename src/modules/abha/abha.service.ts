/**
 * ABDM V3 ABHA Service
 * Implements all M1 mandatory flows based on official Postman collection (18-08-2025)
 *
 * Enrollment flows:
 *   - Aadhaar OTP  (mandatory)
 *   - Driving License (optional)
 *   - Biometrics (optional — hardware PID required, not handled here)
 *
 * Verification flows:
 *   - Login via ABHA number (Aadhaar OTP / ABDM OTP / password)
 *   - Login via mobile OTP
 *   - Login via Aadhaar OTP
 *   - ABHA Address verification (PHR/web flow)
 *   - Find ABHA via mobile
 *
 * Profile:
 *   - Get, update, QR code, ABHA card, logout
 *   - Update mobile / email
 *   - Delete / Deactivate / Reactivate
 */

import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import prisma from '../../common/config/database';
import { rethrowServiceError } from '../../common/utils/serviceErrors';
import { getEffectiveHospitalId } from '../../common/utils/scope';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const E = abdmConfig.endpoints;

function toAppError(error: any, fallback: string, fallbackStatus = 500): never {
  if (error?.message?.includes('Failed to authenticate with ABDM gateway')) {
    logger.error('ABDM gateway authentication failed — check ABDM_CLIENT_ID and ABDM_CLIENT_SECRET', { endpoint: error?.config?.url });
    throw new AppError('ABDM gateway authentication failed. Please verify your sandbox credentials (ABDM_CLIENT_ID / ABDM_CLIENT_SECRET) are valid and not expired.', 502);
  }
  const respData = error?.response?.data;
  const status = error?.response?.status || fallbackStatus;
  let msg = fallback;

  // CloudFront/WAF block returns HTML — detect and give a clean message
  if (typeof respData === 'string' && respData.includes('cloudfront')) {
    msg = 'ABDM gateway is temporarily unreachable (blocked by CloudFront). Please try again later.';
    logger.error(fallback, { message: msg, status, endpoint: error?.config?.url });
    throw new AppError(msg, 503);
  }

  if (respData && typeof respData === 'object') {
    if (respData.error?.message) msg = respData.error.message;
    else if (respData.message) msg = respData.message;
    else if (respData.details) msg = respData.details;
    else {
      const fieldErrors = Object.entries(respData)
        .filter(([k]) => k !== 'timestamp')
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      if (fieldErrors) msg = fieldErrors;
    }
  } else if (typeof respData === 'string' && respData.includes('<HTML')) {
    msg = `ABDM gateway returned an error page (HTTP ${status}). The service may be temporarily unavailable.`;
  }

  logger.error(fallback, { message: msg, status, endpoint: error?.config?.url });
  throw new AppError(msg, status);
}

// ─────────────────────────────────────────────────────────────────────────────
// ABHA Service V3
// ─────────────────────────────────────────────────────────────────────────────

export class AbhaService {

  // ===========================================================================
  // SECTION 1 — ENROLLMENT VIA AADHAAR OTP
  // ===========================================================================

  /**
   * Step 1: Send Aadhaar OTP
   * POST /v3/enrollment/request/otp
   */
  async generateAadhaarOtp(aadhaar: string) {
    try {
      const encAadhaar = await abdmClient.encrypt(aadhaar);
      const res = await abdmClient.abhaPost(E.enrollment.requestOtp, {
        txnId: '',
        scope: ['abha-enrol'],
        loginHint: 'aadhaar',
        loginId: encAadhaar,
        otpSystem: 'aadhaar',
      });
      logger.info('Aadhaar OTP sent', { txnId: res.txnId });
      return { txnId: res.txnId, message: res.message || 'OTP sent to Aadhaar-linked mobile' };
    } catch (e) { toAppError(e, 'Failed to generate Aadhaar OTP'); }
  }

  /**
   * Resend Aadhaar OTP.
   *
   * ABDM's enrollment/request/otp has NO dedicated resend operation: the txnId
   * it returns is single-use, so re-posting the previous txnId is rejected with
   * "txnId: Invalid Transaction Id" (verified in prod logs). A resend is simply
   * a fresh OTP request — send an EMPTY txnId exactly like the initial send.
   * ABDM issues a NEW txnId which the caller must use for the subsequent enrol
   * step (returned below).
   *
   * The previous txnId is accepted by the route for API compatibility but is
   * intentionally not forwarded to ABDM.
   */
  async resendAadhaarOtp(_txnId: string, aadhaar: string) {
    try {
      const encAadhaar = await abdmClient.encrypt(aadhaar);
      const res = await abdmClient.abhaPost(E.enrollment.requestOtp, {
        txnId: '',
        scope: ['abha-enrol'],
        loginHint: 'aadhaar',
        loginId: encAadhaar,
        otpSystem: 'aadhaar',
      });
      logger.info('Aadhaar OTP resent', { txnId: res.txnId });
      return { txnId: res.txnId, message: res.message || 'OTP resent' };
    } catch (e) { toAppError(e, 'Failed to resend Aadhaar OTP'); }
  }

  /**
   * Step 2: Enrol ABHA — verifies OTP and creates ABHA
   * POST /v3/enrollment/enrol/byAadhaar
   */
  async enrolByAadhaar(params: {
    txnId: string;
    otp: string;
    mobile: string;
  }) {
    try {
      const encOtp = await abdmClient.encrypt(params.otp);
      const res = await abdmClient.abhaPost(E.enrollment.enrolByAadhaar, {
        authData: {
          authMethods: ['otp'],
          otp: {
            txnId: params.txnId,
            otpValue: encOtp,
            mobile: params.mobile,
          },
        },
        consent: { code: 'abha-enrollment', version: '1.4' },
      });

      // Persist to DB if new ABHA
      if (res.ABHAProfile?.ABHANumber) {
        const abhaNumber = res.ABHAProfile.ABHANumber.replace(/-/g, '');
        await prisma.abhaRecord.upsert({
          where: { abhaNumber: abhaNumber },
          create: {
            abhaNumber: abhaNumber,
            abhaAddress: res.ABHAProfile.phrAddress?.[0] || null,
            aadhaarLinked: true,
            mobileLinked: !!params.mobile,
            kycStatus: 'VERIFIED',
            profileData: {
              ...res.ABHAProfile,
              token: res.tokens?.token,
              refreshToken: res.tokens?.refreshToken,
            },
          },
          update: {
            abhaAddress: res.ABHAProfile.phrAddress?.[0] || undefined,
            kycStatus: 'VERIFIED',
            profileData: {
              ...res.ABHAProfile,
              token: res.tokens?.token,
              refreshToken: res.tokens?.refreshToken,
            },
          },
        });
      }

      logger.info('ABHA enrolled via Aadhaar', { abhaNumber: res.ABHAProfile?.ABHANumber });
      return {
        txnId: res.txnId,
        isNew: res.isNew,
        tokens: res.tokens,
        profile: res.ABHAProfile,
        // If mobile differs from Aadhaar-linked, mobile verify is required next
        requiresMobileVerify: res.ABHAProfile?.mobile === null,
      };
    } catch (e) { toAppError(e, 'Failed to enrol ABHA via Aadhaar'); }
  }

  // ===========================================================================
  // SECTION 2 — MOBILE VERIFICATION (after Aadhaar enrolment with different mobile)
  // ===========================================================================

  /**
   * Send OTP to new mobile (not Aadhaar-linked)
   * POST /v3/enrollment/request/otp  scope: ["abha-enrol","mobile-verify"]
   */
  async sendMobileVerifyOtp(txnId: string, mobile: string) {
    try {
      const encMobile = await abdmClient.encrypt(mobile);
      const res = await abdmClient.abhaPost(E.enrollment.requestOtp, {
        txnId,
        scope: ['abha-enrol', 'mobile-verify'],
        loginHint: 'mobile',
        loginId: encMobile,
        otpSystem: 'abdm',
      });
      return { txnId: res.txnId, message: res.message || 'OTP sent to mobile' };
    } catch (e) { toAppError(e, 'Failed to send mobile verify OTP'); }
  }

  /**
   * Verify mobile OTP
   * POST /v3/enrollment/auth/byAbdm
   */
  async verifyMobileOtp(txnId: string, otp: string) {
    try {
      const encOtp = await abdmClient.encrypt(otp);
      const res = await abdmClient.abhaPost(E.enrollment.authByAbdm, {
        scope: ['abha-enrol', 'mobile-verify'],
        authData: {
          authMethods: ['otp'],
          otp: {
            timeStamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
            txnId,
            otpValue: encOtp,
          },
        },
      });
      return { txnId: res.txnId, authResult: res.authResult, message: res.message };
    } catch (e) { toAppError(e, 'Failed to verify mobile OTP'); }
  }

  // ===========================================================================
  // SECTION 3 — ABHA ADDRESS (after enrolment)
  // ===========================================================================

  /**
   * Get suggested ABHA addresses
   * GET /v3/enrollment/enrol/suggestion  (txnId sent as query param)
   */
  async getAbhaAddressSuggestions(txnId: string) {
    try {
      const token = await abdmClient.ensureValidToken();
      const axios = (await import('axios')).default;
      const res = await axios.get(
        `${abdmConfig.abhaUrl}${E.enrollment.suggestion}`,
        {
          headers: {
            ...abdmClient.abhaHeaders(token),
            'Transaction_Id': txnId,
          },
        }
      );
      return res.data.abhaAddressList || [];
    } catch (e) { toAppError(e, 'Failed to get ABHA address suggestions'); }
  }

  /**
   * Create custom ABHA address
   * POST /v3/enrollment/enrol/abha-address
   */
  async createAbhaAddress(txnId: string, abhaAddress: string) {
    try {
      const res = await abdmClient.abhaPost(E.enrollment.abhaAddress, {
        txnId,
        abhaAddress,
        preferred: 1,
      });
      return {
        txnId: res.txnId,
        abhaNumber: res.healthIdNumber,
        preferredAbhaAddress: res.preferredAbhaAddress,
      };
    } catch (e) { toAppError(e, 'Failed to create ABHA address'); }
  }

  // ===========================================================================
  // SECTION 4 — ENROLLMENT VIA DRIVING LICENSE
  // ===========================================================================

  /**
   * Step 1: Send OTP to mobile for DL flow
   */
  async dlSendMobileOtp(mobile: string) {
    try {
      const encMobile = await abdmClient.encrypt(mobile);
      const res = await abdmClient.abhaPost(E.enrollment.requestOtp, {
        scope: ['abha-enrol', 'mobile-verify', 'dl-flow'],
        loginHint: 'mobile',
        loginId: encMobile,
        otpSystem: 'abdm',
      });
      return { txnId: res.txnId, message: res.message || 'OTP sent' };
    } catch (e) { toAppError(e, 'Failed to send OTP for DL enrolment'); }
  }

  /**
   * Step 2: Verify mobile OTP for DL flow
   */
  async dlVerifyMobileOtp(txnId: string, otp: string) {
    try {
      const encOtp = await abdmClient.encrypt(otp);
      const res = await abdmClient.abhaPost(E.enrollment.authByAbdm, {
        scope: ['abha-enrol', 'mobile-verify', 'dl-flow'],
        authData: {
          authMethods: ['otp'],
          otp: {
            timeStamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
            txnId,
            otpValue: encOtp,
          },
        },
      });
      return { txnId: res.txnId, authResult: res.authResult };
    } catch (e) { toAppError(e, 'Failed to verify mobile OTP for DL'); }
  }

  /**
   * Step 3: Submit DL document
   * POST /v3/enrollment/enrol/byDocument
   */
  async enrolByDrivingLicense(params: {
    txnId: string;
    dlNumber: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    dob: string;
    gender: string;
    state?: string;
    district?: string;
    pinCode?: string;
  }) {
    try {
      const res = await abdmClient.abhaPost(E.enrollment.enrolByDocument, {
        txnId: params.txnId,
        documentType: 'DRIVING_LICENCE',
        documentId: params.dlNumber,
        firstName: params.firstName,
        middleName: params.middleName || '',
        lastName: params.lastName,
        dob: params.dob,
        gender: params.gender,
        ...(params.state && { stateCode: params.state }),
        ...(params.district && { districtCode: params.district }),
        ...(params.pinCode && { pinCode: params.pinCode }),
      });
      return { txnId: res.txnId, enrollmentNumber: res.enrollmentNumber, profile: res };
    } catch (e) { toAppError(e, 'Failed to enrol via Driving License'); }
  }

  // ===========================================================================
  // SECTION 5 — LOGIN / ABHA VERIFICATION
  // ===========================================================================

  /**
   * Send OTP for login — generic, used for all verification flows
   * POST /v3/profile/login/request/otp
   *
   * loginHint: 'abha-number' | 'mobile' | 'aadhaar'
   * otpSystem: 'aadhaar' | 'abdm'
   * scope examples:
   *   ['abha-login','aadhaar-verify']  — login via ABHA + Aadhaar OTP
   *   ['abha-login','mobile-verify']   — login via ABHA/mobile + ABDM OTP
   *   ['abha-login','search-abha','mobile-verify'] — find ABHA by mobile
   */
  async loginRequestOtp(params: {
    scope: string[];
    loginHint: string;
    loginId: string;          // plain text — will be encrypted
    otpSystem: 'aadhaar' | 'abdm';
    txnId?: string;           // required for search-then-verify (mobile index flow)
  }) {
    try {
      const encId = await abdmClient.encrypt(params.loginId);
      const payload: Record<string, any> = {
        scope: params.scope,
        loginHint: params.loginHint,
        loginId: encId,
        otpSystem: params.otpSystem,
      };
      if (params.txnId) payload.txnId = params.txnId;
      const res = await abdmClient.abhaPost(E.profile.loginRequestOtp, payload);
      return { txnId: res.txnId, message: res.message };
    } catch (e) { toAppError(e, 'Failed to send login OTP'); }
  }

  /**
   * Verify login OTP — returns X-token (user session token)
   * POST /v3/profile/login/verify
   */
  async loginVerify(params: {
    scope: string[];
    txnId: string;
    otp: string;
  }) {
    try {
      const encOtp = await abdmClient.encrypt(params.otp);
      const res = await abdmClient.abhaPost(E.profile.loginVerify, {
        scope: params.scope,
        authData: {
          authMethods: ['otp'],
          otp: { txnId: params.txnId, otpValue: encOtp },
        },
      });
      return {
        txnId: res.txnId,
        authResult: res.authResult,
        token: res.token,
        refreshToken: res.refreshToken,
        accounts: res.accounts || [],
        message: res.message,
      };
    } catch (e) { toAppError(e, 'Failed to verify login OTP'); }
  }

  /**
   * Verify password login
   * POST /v3/profile/login/verify
   */
  async loginVerifyPassword(params: {
    scope: string[];
    abhaNumber: string;
    password: string;
  }) {
    try {
      const encPass = await abdmClient.encrypt(params.password);
      const res = await abdmClient.abhaPost(E.profile.loginVerify, {
        scope: params.scope,
        authData: {
          authMethods: ['password'],
          password: { ABHANumber: params.abhaNumber, password: encPass },
        },
      });
      return { token: res.token, refreshToken: res.refreshToken, accounts: res.accounts };
    } catch (e) { toAppError(e, 'Failed to verify password'); }
  }

  /**
   * After mobile OTP login — select which ABHA to use
   * POST /v3/profile/login/verify/user
   */
  async loginVerifyUser(abhaNumber: string, txnId: string) {
    try {
      const res = await abdmClient.abhaPost(E.profile.loginVerifyUser, { ABHANumber: abhaNumber, txnId });
      return { token: res.token, refreshToken: res.refreshToken };
    } catch (e) { toAppError(e, 'Failed to select ABHA user'); }
  }

  /**
   * Search ABHA by number (returns available auth methods)
   * POST /v3/profile/login/search
   */
  async loginSearch(abhaNumber: string) {
    try {
      const res = await abdmClient.abhaPost(E.profile.loginSearch, { ABHANumber: abhaNumber });
      return res;
    } catch (e) { toAppError(e, 'Failed to search ABHA'); }
  }

  // ===========================================================================
  // SECTION 6 — PROFILE (requires X-token)
  // ===========================================================================

  async getProfile(xToken: string) {
    try {
      return await abdmClient.abhaGet(E.profile.account, xToken);
    } catch (e) { toAppError(e, 'Failed to get ABHA profile'); }
  }

  async updateProfile(xToken: string, updates: {
    profilePhoto?: string;
    abhaNumber?: string;
    mobile?: string;
    accountStatus?: string;
    dob?: string;
    name?: string;
    gender?: string;
  }) {
    try {
      return await abdmClient.abhaPatch(E.profile.account, updates, xToken);
    } catch (e) { toAppError(e, 'Failed to update ABHA profile'); }
  }

  async getQrCode(xToken: string) {
    try {
      return await abdmClient.abhaGet(E.profile.qrCode, xToken);
    } catch (e) { toAppError(e, 'Failed to get QR code'); }
  }

  async getAbhaCard(xToken: string) {
    try {
      return await abdmClient.abhaGet(E.profile.abhaCard, xToken, undefined, 'arraybuffer');
    } catch (e) { toAppError(e, 'Failed to download ABHA card'); }
  }

  async logout(xToken: string) {
    try {
      await abdmClient.abhaGet(E.profile.logout, xToken);
      return { message: 'Logged out successfully' };
    } catch (e) { toAppError(e, 'Failed to logout'); }
  }

  // ===========================================================================
  // SECTION 7 — PROFILE OTP OPERATIONS (update mobile/email, delete, deactivate)
  // ===========================================================================

  /**
   * Request OTP for profile operations (update mobile, email, delete, deactivate, re-kyc)
   * POST /v3/profile/account/request/otp
   */
  async profileRequestOtp(xToken: string, params: {
    scope: string[];
    loginHint: string;
    loginId: string;   // plain text
    otpSystem: 'aadhaar' | 'abdm';
  }) {
    try {
      const encId = await abdmClient.encrypt(params.loginId);
      const res = await abdmClient.abhaPost(E.profile.requestOtp, {
        scope: params.scope,
        loginHint: params.loginHint,
        loginId: encId,
        otpSystem: params.otpSystem,
      }, xToken);
      return { txnId: res.txnId, message: res.message };
    } catch (e) { toAppError(e, 'Failed to request profile OTP'); }
  }

  /**
   * Verify profile OTP (used for update mobile/email, delete, deactivate, re-kyc, change password)
   * POST /v3/profile/account/verify
   */
  async profileVerifyOtp(xToken: string, params: {
    scope: string[];
    txnId: string;
    otp: string;
  }) {
    try {
      const encOtp = await abdmClient.encrypt(params.otp);
      const res = await abdmClient.abhaPost(E.profile.verify, {
        scope: params.scope,
        authData: {
          authMethods: ['otp'],
          otp: { txnId: params.txnId, otpValue: encOtp },
        },
      }, xToken);
      return { txnId: res.txnId, authResult: res.authResult, message: res.message };
    } catch (e) { toAppError(e, 'Failed to verify profile OTP'); }
  }

  // ===========================================================================
  // SECTION 8 — FIND ABHA (search by mobile)
  // ===========================================================================

  async findAbhaByMobile(mobile: string) {
    try {
      const encMobile = await abdmClient.encrypt(mobile);
      const res = await abdmClient.abhaPost(E.profile.abhaSearch, {
        scope: ['search-abha'],
        mobile: encMobile,
      });
      return res;
    } catch (e) { toAppError(e, 'Failed to find ABHA by mobile'); }
  }

  // ===========================================================================
  // SECTION 9 — ABHA ADDRESS VERIFICATION (PHR/Scan & Share)
  // ===========================================================================

  /**
   * Search auth methods for an ABHA address
   * POST /v3/phr/web/login/abha/search
   */
  async phrSearch(abhaAddress: string) {
    try {
      return await abdmClient.phrPost(abdmConfig.endpoints.phr.search, { abhaAddress });
    } catch (e) { toAppError(e, 'Failed to search ABHA address'); }
  }

  /**
   * Request OTP for ABHA address verification
   * POST /v3/phr/web/login/abha/request/otp
   * scope: ['abha-address-login','mobile-verify'] | ['abha-address-login','aadhaar-verify']
   */
  async phrRequestOtp(params: {
    abhaAddress: string;
    scope: string[];
    otpSystem: 'aadhaar' | 'abdm';
  }) {
    try {
      const encAddress = await abdmClient.encrypt(params.abhaAddress);
      const res = await abdmClient.phrPost(abdmConfig.endpoints.phr.requestOtp, {
        scope: params.scope,
        loginHint: 'abha-address',
        loginId: encAddress,
        otpSystem: params.otpSystem,
      });
      return { txnId: res.txnId, message: res.message };
    } catch (e) { toAppError(e, 'Failed to request ABHA address OTP'); }
  }

  /**
   * Verify ABHA address OTP — returns X-token
   * POST /v3/phr/web/login/abha/verify
   */
  async phrVerifyOtp(params: {
    scope: string[];
    txnId: string;
    otp: string;
  }) {
    try {
      const encOtp = await abdmClient.encrypt(params.otp);
      const res = await abdmClient.phrPost(abdmConfig.endpoints.phr.verify, {
        scope: params.scope,
        authData: {
          authMethods: ['otp'],
          otp: { txnId: params.txnId, otpValue: encOtp },
        },
      });
      return {
        message: res.message,
        authResult: res.authResult,
        tokens: res.tokens,
        users: res.users,
      };
    } catch (e) { toAppError(e, 'Failed to verify ABHA address OTP'); }
  }

  /**
   * Get PHR profile (after ABHA address verification)
   * GET /v3/phr/web/login/profile/abha-profile
   */
  async phrGetProfile(xToken: string) {
    try {
      return await abdmClient.phrGet(abdmConfig.endpoints.phr.profile, xToken);
    } catch (e) { toAppError(e, 'Failed to get PHR profile'); }
  }

  async phrGetCard(xToken: string) {
    try {
      return await abdmClient.phrGet(abdmConfig.endpoints.phr.phrCard, xToken);
    } catch (e) { toAppError(e, 'Failed to get PHR card'); }
  }

  // ===========================================================================
  // SECTION 10 — PATIENT LINKING (local DB)
  // ===========================================================================

  async linkToPatient(abhaNumber: string, patientId: string, abhaAddress?: string, currentUser?: any) {
    try {
      const patient = await prisma.patient.findUnique({ where: { id: patientId } });
      if (!patient) throw new AppError('Patient not found', 404);

      // Multi-tenant guard: non-SUPER_ADMIN may only link ABHA to patients
      // in their own hospital. Note we explicitly require patient.hospitalId
      // to be set — refusing to operate on rogue null-tenancy rows — and
      // we don't bypass when the JWT happens to have no hospitalId.
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
        if (patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: patient belongs to a different hospital', 403);
        }
      }

      const normalized = abhaNumber.replace(/-/g, '');
      // AbhaRecord is a global per-ABHA cache; patientId pointer is informational
      // (the same ABHA may be linked to multiple Patient rows across hospitals).
      // The authoritative per-hospital linkage lives on Patient.abhaNumber.
      // To avoid blowing up the other hospital's AbhaRecord.patientId pointer,
      // only set patientId on initial create.
      await prisma.$transaction([
        prisma.patient.update({
          where: { id: patientId },
          data: { abhaId: normalized, abhaNumber: normalized, ...(abhaAddress && { abhaAddress }) },
        }),
        prisma.abhaRecord.upsert({
          where: { abhaNumber: normalized },
          create: { abhaNumber: normalized, abhaAddress: abhaAddress || null, patientId, kycStatus: 'PENDING' },
          update: { ...(abhaAddress && { abhaAddress }) }, // do NOT clobber existing patientId
        }),
      ]);
      return { message: 'ABHA linked to patient successfully' };
    } catch (error: any) {
      logger.error('linkToPatient failed', error);
      rethrowServiceError(error);
    }
  }

  async unlinkFromPatient(abhaNumber: string, patientId: string, currentUser?: any) {
    try {
      // Multi-tenant guard: a receptionist at hospital A must not be able
      // to clear another hospital's patient ABHA fields. Block unless
      // SUPER_ADMIN or same hospital.
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { id: true, hospitalId: true },
      });
      if (!patient) throw new AppError('Patient not found', 404);
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (!currentUser.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
        if (patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: patient belongs to a different hospital', 403);
        }
      }

      const normalized = abhaNumber.replace(/-/g, '');
      // Only clear the AbhaRecord.patientId back-pointer if it currently
      // points to *this* patient — the same ABHA may be linked to multiple
      // Patient rows across hospitals and we shouldn't blow away another
      // hospital's pointer just because we're unlinking ours.
      await prisma.$transaction([
        prisma.patient.update({
          where: { id: patientId },
          data: { abhaId: null, abhaNumber: null, abhaAddress: null },
        }),
        prisma.abhaRecord.updateMany({
          where: { abhaNumber: normalized, patientId },
          data: { patientId: null },
        }),
      ]);
      return { message: 'ABHA unlinked successfully' };
    } catch (error: any) {
      logger.error('unlinkFromPatient failed', error);
      rethrowServiceError(error);
    }
  }

  async getLocalAbhaRecord(abhaNumber: string, currentUser?: any) {
    const normalized = abhaNumber.replace(/-/g, '');
    const record = await prisma.abhaRecord.findUnique({
      where: { abhaNumber: normalized },
    });
    if (!record) return null;

    // Multi-tenant guard: AbhaRecord is a global cache, but it carries a
    // patientId pointing at one Patient row (which itself is hospital-bound).
    // For non-SUPER_ADMIN, only return the record if the linked patient is
    // in the caller's hospital — otherwise we'd reveal that some other
    // hospital has registered this ABHA.
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
      if (!record.patientId) return record;
      const linked = await prisma.patient.findUnique({
        where: { id: record.patientId },
        select: { hospitalId: true },
      });
      if (linked && linked.hospitalId !== currentUser.hospitalId) {
        return null;
      }
    }
    return record;
  }

  // ===========================================================================
  // SECTION 11 — FORGOT ABHA / RETRIEVAL OF ENROLMENT NUMBER
  // ===========================================================================

  /**
   * Request OTP for forgot ABHA flow
   * Uses login OTP endpoint with scope for forgot flow
   */
  async forgotAbhaRequestOtp(abhaAddress: string, authMethod: string) {
    try {
      const encAddress = await abdmClient.encrypt(abhaAddress);
      const otpSystem = authMethod === 'aadhaar' ? 'aadhaar' : 'abdm';
      const res = await abdmClient.abhaPost(E.profile.loginRequestOtp, {
        scope: ['abha-login', 'forgot-abha'],
        loginHint: 'abha-address',
        loginId: encAddress,
        otpSystem,
      });
      return { txnId: res.txnId, message: res.message || 'OTP sent for ABHA retrieval' };
    } catch (e) { toAppError(e, 'Failed to request OTP for forgot ABHA'); }
  }

  /**
   * Verify OTP and retrieve enrolment number
   */
  async forgotAbhaVerify(txnId: string, otp: string) {
    try {
      const encOtp = await abdmClient.encrypt(otp);
      const res = await abdmClient.abhaPost(E.profile.loginVerify, {
        scope: ['abha-login', 'forgot-abha'],
        authData: {
          authMethods: ['otp'],
          otp: { txnId, otpValue: encOtp },
        },
      });
      return {
        txnId: res.txnId,
        ABHANumber: res.ABHANumber,
        enrolmentNumber: res.enrolmentNumber || res.ABHANumber,
        accounts: res.accounts || [],
        message: res.message,
      };
    } catch (e) { toAppError(e, 'Failed to verify OTP for forgot ABHA'); }
  }

  // ===========================================================================
  // SECTION 12 — EMAIL VERIFICATION
  // ===========================================================================

  /**
   * Request email verification link
   * POST /v3/profile/account/request/emailVerificationLink
   */
  async requestEmailVerification(xToken: string) {
    try {
      const res = await abdmClient.abhaPost(E.profile.requestEmailVerification, {}, xToken);
      return { message: res.message || 'Email verification link sent', txnId: res.txnId };
    } catch (e) { toAppError(e, 'Failed to request email verification'); }
  }

  // ===========================================================================
  // SECTION 13 — PASSWORD SET / UPDATE
  // ===========================================================================

  /**
   * Set ABHA password (first time)
   * POST /v3/profile/account/verify with scope PASSWORD_SET
   */
  async setAbhaPassword(xToken: string, password: string) {
    try {
      const encPassword = await abdmClient.encrypt(password);
      const res = await abdmClient.abhaPost(E.profile.verify, {
        scope: ['password-set'],
        authData: {
          authMethods: ['password'],
          password: { passwordValue: encPassword },
        },
      }, xToken);
      return { message: res.message || 'Password set successfully', authResult: res.authResult };
    } catch (e) { toAppError(e, 'Failed to set ABHA password'); }
  }

  /**
   * Update ABHA password
   * POST /v3/profile/account/verify with old + new password
   */
  async updateAbhaPassword(xToken: string, oldPassword: string, newPassword: string) {
    try {
      const encOldPassword = await abdmClient.encrypt(oldPassword);
      const encNewPassword = await abdmClient.encrypt(newPassword);
      const res = await abdmClient.abhaPost(E.profile.verify, {
        scope: ['password-update'],
        authData: {
          authMethods: ['password'],
          password: {
            oldPasswordValue: encOldPassword,
            newPasswordValue: encNewPassword,
          },
        },
      }, xToken);
      return { message: res.message || 'Password updated successfully', authResult: res.authResult };
    } catch (e) { toAppError(e, 'Failed to update ABHA password'); }
  }

  // ===========================================================================
  // SECTION 14 — RE-KYC
  // ===========================================================================

  /**
   * Initiate re-KYC via profile OTP
   * Sends OTP to the linked Aadhaar or mobile for re-verification
   */
  async requestReKyc(xToken: string, authMethod: string) {
    try {
      const otpSystem = authMethod === 'aadhaar' ? 'aadhaar' : 'abdm';
      const loginHint = authMethod === 'aadhaar' ? 'aadhaar' : 'mobile';
      const res = await abdmClient.abhaPost(E.profile.requestOtp, {
        scope: ['re-kyc'],
        loginHint,
        loginId: '',
        otpSystem,
      }, xToken);
      return { txnId: res.txnId, message: res.message || 'OTP sent for Re-KYC' };
    } catch (e) { toAppError(e, 'Failed to initiate Re-KYC'); }
  }

  // ===========================================================================
  // SECTION 15 — ABHA REFRESH TOKEN
  // ===========================================================================

  /**
   * Refresh ABHA session token
   * POST /v3/profile/account/request/token
   */
  async refreshAbhaToken(refreshToken: string) {
    try {
      const res = await abdmClient.abhaPost(E.profile.refreshToken, {
        refreshToken,
      });
      return {
        token: res.token,
        refreshToken: res.refreshToken,
        expiresIn: res.expiresIn,
      };
    } catch (e) { toAppError(e, 'Failed to refresh ABHA token'); }
  }

  // ===========================================================================
  // SECTION 16 — DELETE ABHA
  // ===========================================================================

  /**
   * Request OTP for ABHA account deletion
   */
  async deleteAbhaRequestOtp(xToken: string) {
    try {
      const res = await abdmClient.abhaPost(E.profile.requestOtp, {
        scope: ['profile-delete'],
        loginHint: 'aadhaar',
        loginId: '',
        otpSystem: 'aadhaar',
      }, xToken);
      return { txnId: res.txnId, message: res.message || 'OTP sent for account deletion' };
    } catch (e) { toAppError(e, 'Failed to request OTP for ABHA deletion'); }
  }

  /**
   * Confirm ABHA deletion after OTP verification
   */
  async deleteAbhaConfirm(xToken: string, txnId: string, otp: string) {
    try {
      const encOtp = await abdmClient.encrypt(otp);
      const res = await abdmClient.abhaPost(E.profile.verify, {
        scope: ['profile-delete'],
        authData: {
          authMethods: ['otp'],
          otp: { txnId, otpValue: encOtp },
        },
      }, xToken);
      return { message: res.message || 'ABHA account deleted successfully', authResult: res.authResult };
    } catch (e) { toAppError(e, 'Failed to confirm ABHA deletion'); }
  }

  // ===========================================================================
  // SECTION 17 — DEACTIVATE / REACTIVATE ABHA
  // ===========================================================================

  /**
   * Deactivate ABHA account
   * Requires valid X-token; account is suspended
   */
  async deactivateAbha(xToken: string, reason?: string) {
    try {
      const res = await abdmClient.abhaPost(E.profile.verify, {
        scope: ['profile-deactivate'],
        authData: {
          authMethods: ['otp'],
          ...(reason && { reason }),
        },
      }, xToken);
      return { message: res.message || 'ABHA account deactivated', authResult: res.authResult };
    } catch (e) { toAppError(e, 'Failed to deactivate ABHA'); }
  }

  /**
   * Request OTP for reactivation (uses login flow since account is inactive)
   */
  async reactivateAbhaRequestOtp(abhaNumber: string) {
    try {
      const encAbha = await abdmClient.encrypt(abhaNumber);
      const res = await abdmClient.abhaPost(E.profile.loginRequestOtp, {
        scope: ['abha-login', 'profile-reactivate'],
        loginHint: 'abha-number',
        loginId: encAbha,
        otpSystem: 'aadhaar',
      });
      return { txnId: res.txnId, message: res.message || 'OTP sent for reactivation' };
    } catch (e) { toAppError(e, 'Failed to request OTP for reactivation'); }
  }

  /**
   * Confirm reactivation after OTP verification
   */
  async reactivateAbhaConfirm(txnId: string, otp: string) {
    try {
      const encOtp = await abdmClient.encrypt(otp);
      const res = await abdmClient.abhaPost(E.profile.loginVerify, {
        scope: ['abha-login', 'profile-reactivate'],
        authData: {
          authMethods: ['otp'],
          otp: { txnId, otpValue: encOtp },
        },
      });
      return {
        token: res.token,
        refreshToken: res.refreshToken,
        message: res.message || 'ABHA account reactivated',
      };
    } catch (e) { toAppError(e, 'Failed to confirm ABHA reactivation'); }
  }

  // ===========================================================================
  // SECTION 18 — NEW vs RETURNING PATIENT LOOKUP
  // ===========================================================================

  async lookupPatientByAbha(identifier: string, currentUser?: any) {
    const normalized = identifier.replace(/-/g, '').replace(/@.*$/, '');
    const isMobile = /^\d{10}$/.test(identifier.trim());

    const orConditions: any[] = [
      { abhaNumber: normalized },
      { abhaId: normalized },
      { abhaAddress: identifier },
      { abhaRecord: { abhaNumber: normalized } },
      { abhaRecord: { abhaAddress: identifier } },
    ];
    if (isMobile) {
      orConditions.push({ mobile: identifier.trim() });
    }

    // Multi-tenancy: scope to caller's hospital unless they're an unscoped
    // SUPER_ADMIN. Without this, a receptionist at one facility could discover
    // patients registered at another — a privacy leak.
    const where: any = { OR: orConditions };
    const effectiveHospitalId = getEffectiveHospitalId(currentUser);
    if (effectiveHospitalId) {
      where.hospitalId = effectiveHospitalId;
    }

    const patient = await prisma.patient.findFirst({
      where,
      include: {
        abhaRecord: true,
        encounters: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { doctor: true },
        },
      },
    });

    if (!patient) {
      return { isReturning: false, patient: null };
    }

    return {
      isReturning: true,
      patient: {
        id: patient.id,
        uhid: patient.uhid,
        firstName: patient.firstName,
        lastName: patient.lastName,
        gender: patient.gender,
        dob: patient.dob,
        mobile: patient.mobile,
        abhaNumber: patient.abhaNumber,
        abhaAddress: patient.abhaAddress,
        lastVisit: patient.encounters[0]?.createdAt || null,
        visitCount: patient.encounters.length,
        recentEncounters: patient.encounters.map(e => ({
          id: e.id,
          type: e.type,
          date: e.createdAt,
          doctor: e.doctor ? `Dr. ${e.doctor.firstName} ${e.doctor.lastName}` : null,
        })),
      },
    };
  }
}

export default new AbhaService();
