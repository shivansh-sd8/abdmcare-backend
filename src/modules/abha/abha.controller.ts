import { Request, Response } from 'express';
import { asyncHandler } from '../../common/middleware/errorHandler';
import abhaService from './abha.service';
import abdmClient from '../../common/utils/abdm-client';

// ─────────────────────────────────────────────────────────────────────────────
// Helper — extract X-token from body or header
// ─────────────────────────────────────────────────────────────────────────────
function getXToken(req: Request): string {
  const fromHeader = req.headers['x-token'] as string;
  const fromBody = (req.body as any).xToken;
  const raw = fromHeader || fromBody || '';
  return raw.replace(/^Bearer\s+/i, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────────

export class AbhaController {

  // ── Enrollment: Aadhaar ────────────────────────────────────────────────────

  generateAadhaarOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.generateAadhaarOtp(req.body.aadhaar);
    res.json({ success: true, data });
  });

  resendAadhaarOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.resendAadhaarOtp(req.body.txnId, req.body.aadhaar);
    res.json({ success: true, data });
  });

  enrolByAadhaar = asyncHandler(async (req: Request, res: Response) => {
    const { txnId, otp, mobile } = req.body;
    if (!mobile || mobile.length !== 10) {
      res.status(400).json({ success: false, message: 'A valid 10-digit mobile number is required for ABHA enrollment' });
      return;
    }
    const data = await abhaService.enrolByAadhaar({ txnId, otp, mobile });
    res.json({ success: true, data });
  });

  // ── Mobile verification (post Aadhaar enrol) ───────────────────────────────

  sendMobileVerifyOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.sendMobileVerifyOtp(req.body.txnId, req.body.mobile);
    res.json({ success: true, data });
  });

  verifyMobileOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.verifyMobileOtp(req.body.txnId, req.body.otp);
    res.json({ success: true, data });
  });

  // ── ABHA Address ───────────────────────────────────────────────────────────

  getAbhaAddressSuggestions = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.getAbhaAddressSuggestions(req.body.txnId || req.query.txnId as string);
    res.json({ success: true, data });
  });

  createAbhaAddress = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.createAbhaAddress(req.body.txnId, req.body.abhaAddress);
    res.json({ success: true, data });
  });

  // ── Enrollment: Driving License ────────────────────────────────────────────

  dlSendMobileOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.dlSendMobileOtp(req.body.mobile);
    res.json({ success: true, data });
  });

  dlVerifyMobileOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.dlVerifyMobileOtp(req.body.txnId, req.body.otp);
    res.json({ success: true, data });
  });

  enrolByDrivingLicense = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.enrolByDrivingLicense(req.body);
    res.json({ success: true, data });
  });

  // ── Login / Verification ───────────────────────────────────────────────────

  loginRequestOtp = asyncHandler(async (req: Request, res: Response) => {
    const { scope, loginHint, loginId, otpSystem, txnId } = req.body;
    const data = await abhaService.loginRequestOtp({ scope, loginHint, loginId, otpSystem, txnId });
    res.json({ success: true, data });
  });

  loginVerify = asyncHandler(async (req: Request, res: Response) => {
    const { scope, txnId, otp } = req.body;
    const data = await abhaService.loginVerify({ scope, txnId, otp });
    res.json({ success: true, data });
  });

  loginVerifyPassword = asyncHandler(async (req: Request, res: Response) => {
    const { scope, abhaNumber, password } = req.body;
    const data = await abhaService.loginVerifyPassword({ scope, abhaNumber, password });
    res.json({ success: true, data });
  });

  loginVerifyUser = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.loginVerifyUser(req.body.abhaNumber, req.body.txnId);
    res.json({ success: true, data });
  });

  loginSearch = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.loginSearch(req.body.abhaNumber);
    res.json({ success: true, data });
  });

  // ── Profile (X-token required) ─────────────────────────────────────────────

  getProfile = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.getProfile(getXToken(req));
    res.json({ success: true, data });
  });

  updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const xToken = getXToken(req);
    const { xToken: _omit, ...updates } = req.body;
    const data = await abhaService.updateProfile(xToken, updates);
    res.json({ success: true, data });
  });

  getQrCode = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.getQrCode(getXToken(req));
    res.json({ success: true, data });
  });

  getAbhaCard = asyncHandler(async (req: Request, res: Response) => {
    const cardData = await abhaService.getAbhaCard(getXToken(req));
    if (Buffer.isBuffer(cardData) || typeof cardData === 'string') {
      res.set('Content-Type', 'image/png');
      res.send(cardData);
    } else {
      res.json({ success: true, data: cardData });
    }
  });

  logout = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.logout(getXToken(req));
    res.json({ success: true, data });
  });

  // ── Profile OTP ops ────────────────────────────────────────────────────────

  profileRequestOtp = asyncHandler(async (req: Request, res: Response) => {
    const xToken = getXToken(req);
    const { scope, loginHint, loginId, otpSystem } = req.body;
    const data = await abhaService.profileRequestOtp(xToken, { scope, loginHint, loginId, otpSystem });
    res.json({ success: true, data });
  });

  profileVerifyOtp = asyncHandler(async (req: Request, res: Response) => {
    const xToken = getXToken(req);
    const { scope, txnId, otp } = req.body;
    const data = await abhaService.profileVerifyOtp(xToken, { scope, txnId, otp });
    res.json({ success: true, data });
  });

  // ── Forgot ABHA / Enrolment Number Retrieval ──────────────────────────────

  forgotAbhaRequestOtp = asyncHandler(async (req: Request, res: Response) => {
    const { abhaAddress, authMethod } = req.body;
    const data = await abhaService.forgotAbhaRequestOtp(abhaAddress, authMethod);
    res.json({ success: true, data });
  });

  forgotAbhaVerify = asyncHandler(async (req: Request, res: Response) => {
    const { txnId, otp } = req.body;
    const data = await abhaService.forgotAbhaVerify(txnId, otp);
    res.json({ success: true, data });
  });

  // ── Email Verification ───────────────────────────────────────────────────

  requestEmailVerification = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.requestEmailVerification(getXToken(req));
    res.json({ success: true, data });
  });

  // ── Password Set / Update ────────────────────────────────────────────────

  setAbhaPassword = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.setAbhaPassword(getXToken(req), req.body.password);
    res.json({ success: true, data });
  });

  updateAbhaPassword = asyncHandler(async (req: Request, res: Response) => {
    const { oldPassword, newPassword } = req.body;
    const data = await abhaService.updateAbhaPassword(getXToken(req), oldPassword, newPassword);
    res.json({ success: true, data });
  });

  // ── Re-KYC ──────────────────────────────────────────────────────────────

  requestReKyc = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.requestReKyc(getXToken(req), req.body.authMethod);
    res.json({ success: true, data });
  });

  // ── Refresh Token ────────────────────────────────────────────────────────

  refreshAbhaToken = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.refreshAbhaToken(req.body.refreshToken);
    res.json({ success: true, data });
  });

  // ── Delete ABHA ──────────────────────────────────────────────────────────

  deleteAbhaRequestOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.deleteAbhaRequestOtp(getXToken(req));
    res.json({ success: true, data });
  });

  deleteAbhaConfirm = asyncHandler(async (req: Request, res: Response) => {
    const { txnId, otp } = req.body;
    const data = await abhaService.deleteAbhaConfirm(getXToken(req), txnId, otp);
    res.json({ success: true, data });
  });

  // ── Deactivate / Reactivate ABHA ────────────────────────────────────────

  deactivateAbha = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.deactivateAbha(getXToken(req), req.body.reason);
    res.json({ success: true, data });
  });

  reactivateAbhaRequestOtp = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.reactivateAbhaRequestOtp(req.body.abhaNumber);
    res.json({ success: true, data });
  });

  reactivateAbhaConfirm = asyncHandler(async (req: Request, res: Response) => {
    const { txnId, otp } = req.body;
    const data = await abhaService.reactivateAbhaConfirm(txnId, otp);
    res.json({ success: true, data });
  });

  // ── Find ABHA ──────────────────────────────────────────────────────────────

  findAbhaByMobile = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.findAbhaByMobile(req.body.mobile);
    res.json({ success: true, data });
  });

  // ── PHR / ABHA Address Verification ───────────────────────────────────────

  phrSearch = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.phrSearch(req.body.abhaAddress);
    res.json({ success: true, data });
  });

  phrRequestOtp = asyncHandler(async (req: Request, res: Response) => {
    const { abhaAddress, scope, otpSystem } = req.body;
    const data = await abhaService.phrRequestOtp({ abhaAddress, scope, otpSystem });
    res.json({ success: true, data });
  });

  phrVerifyOtp = asyncHandler(async (req: Request, res: Response) => {
    const { scope, txnId, otp } = req.body;
    const data = await abhaService.phrVerifyOtp({ scope, txnId, otp });
    res.json({ success: true, data });
  });

  phrGetProfile = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.phrGetProfile(getXToken(req));
    res.json({ success: true, data });
  });

  phrGetCard = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.phrGetCard(getXToken(req));
    res.json({ success: true, data });
  });

  // ── Patient linking ────────────────────────────────────────────────────────

  linkToPatient = asyncHandler(async (req: Request, res: Response) => {
    const { abhaNumber, patientId, abhaAddress } = req.body;
    const currentUser = (req as any).user;
    const data = await abhaService.linkToPatient(abhaNumber, patientId, abhaAddress, currentUser);
    res.json({ success: true, data });
  });

  unlinkFromPatient = asyncHandler(async (req: Request, res: Response) => {
    const { abhaNumber, patientId } = req.body;
    const data = await abhaService.unlinkFromPatient(abhaNumber, patientId);
    res.json({ success: true, data });
  });

  getLocalRecord = asyncHandler(async (req: Request, res: Response) => {
    const data = await abhaService.getLocalAbhaRecord(req.params.abhaNumber);
    if (!data) res.status(404).json({ success: false, message: 'ABHA record not found' });
    else res.json({ success: true, data });
  });

  lookupPatient = asyncHandler(async (req: Request, res: Response) => {
    const { identifier } = req.query;
    if (!identifier || typeof identifier !== 'string') {
      res.status(400).json({ success: false, message: 'identifier query param required (ABHA number or address)' });
      return;
    }
    const data = await abhaService.lookupPatientByAbha(identifier);
    res.json({ success: true, data });
  });

  healthCheck = asyncHandler(async (_req: Request, res: Response) => {
    try {
      const token = await abdmClient.ensureValidToken();
      res.json({
        success: true,
        message: 'ABDM gateway connection OK',
        tokenPreview: token ? `${token.substring(0, 10)}...` : null,
      });
    } catch (error: any) {
      res.status(502).json({
        success: false,
        message: 'ABDM gateway authentication failed',
        error: error?.message,
      });
    }
  });
}

export default new AbhaController();
