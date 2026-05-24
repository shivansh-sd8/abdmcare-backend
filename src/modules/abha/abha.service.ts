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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const E = abdmConfig.endpoints;

function toAppError(error: any, fallback: string, fallbackStatus = 500): never {
  const respData = error?.response?.data;
  let msg = fallback;
  if (respData) {
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
  }
  const status = error?.response?.status || fallbackStatus;
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
   * Resend Aadhaar OTP — same endpoint, pass existing txnId
   */
  async resendAadhaarOtp(txnId: string, aadhaar: string) {
    try {
      const encAadhaar = await abdmClient.encrypt(aadhaar);
      const res = await abdmClient.abhaPost(E.enrollment.requestOtp, {
        txnId,
        scope: ['abha-enrol'],
        loginHint: 'aadhaar',
        loginId: encAadhaar,
        otpSystem: 'aadhaar',
      });
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

  async linkToPatient(abhaNumber: string, patientId: string, abhaAddress?: string) {
    try {
      const patient = await prisma.patient.findUnique({ where: { id: patientId } });
      if (!patient) throw new AppError('Patient not found', 404);

      const normalized = abhaNumber.replace(/-/g, '');
      await prisma.$transaction([
        prisma.patient.update({
          where: { id: patientId },
          data: { abhaId: normalized, abhaNumber: normalized, ...(abhaAddress && { abhaAddress }) },
        }),
        prisma.abhaRecord.upsert({
          where: { abhaNumber: normalized },
          create: { abhaNumber: normalized, abhaAddress: abhaAddress || null, patientId, kycStatus: 'PENDING' },
          update: { patientId, ...(abhaAddress && { abhaAddress }) },
        }),
      ]);
      return { message: 'ABHA linked to patient successfully' };
    } catch (error: any) {
      logger.error('linkToPatient failed', error);
      throw new AppError(error.message || 'Failed to link ABHA', error.statusCode || 500);
    }
  }

  async unlinkFromPatient(abhaNumber: string, patientId: string) {
    try {
      const normalized = abhaNumber.replace(/-/g, '');
      await prisma.$transaction([
        prisma.patient.update({
          where: { id: patientId },
          data: { abhaId: null, abhaNumber: null, abhaAddress: null },
        }),
        prisma.abhaRecord.update({
          where: { abhaNumber: normalized },
          data: { patientId: null },
        }),
      ]);
      return { message: 'ABHA unlinked successfully' };
    } catch (error: any) {
      logger.error('unlinkFromPatient failed', error);
      throw new AppError(error.message || 'Failed to unlink ABHA', error.statusCode || 500);
    }
  }

  async getLocalAbhaRecord(abhaNumber: string) {
    const normalized = abhaNumber.replace(/-/g, '');
    return prisma.abhaRecord.findUnique({ where: { abhaNumber: normalized } });
  }

  // ===========================================================================
  // SECTION 11 — NEW vs RETURNING PATIENT LOOKUP
  // ===========================================================================

  async lookupPatientByAbha(identifier: string) {
    const normalized = identifier.replace(/-/g, '').replace(/@.*$/, '');
    const isMobile = /^\d{10}$/.test(identifier.trim());

    const conditions: any[] = [
      { abhaNumber: normalized },
      { abhaId: normalized },
      { abhaAddress: identifier },
      { abhaRecord: { abhaNumber: normalized } },
      { abhaRecord: { abhaAddress: identifier } },
    ];
    if (isMobile) {
      conditions.push({ mobile: identifier.trim() });
    }

    const patient = await prisma.patient.findFirst({
      where: { OR: conditions },
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
