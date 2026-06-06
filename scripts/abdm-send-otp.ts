/**
 * Send ABHA enrollment OTP for an Aadhaar number.
 *
 * Pipeline:
 *   1. POST /api/hiecm/gateway/v3/sessions             → fresh access token
 *   2. GET  /abha/api/v3/profile/public/certificate    → RSA-OAEP public key
 *   3. RSA/ECB/OAEPWithSHA-1AndMGF1Padding (base64)    → encrypt Aadhaar
 *   4. POST /abha/api/v3/enrollment/request/otp        → returns { txnId, message }
 *
 * Usage:
 *   npx ts-node scripts/abdm-send-otp.ts 298064642893
 *   npm run abdm:send-otp -- 298064642893
 *
 * NOTE: Step 2 + 4 hit `abhasbx.abdm.gov.in`, which is currently blocked by ABDM's
 * CloudFront WAF for the DigitalOcean Bangalore IP. Run this from your local Mac
 * until ABDM whitelists the production IP.
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import abdmClient from '../src/common/utils/abdm-client';
import { abdmConfig } from '../src/common/config/abdm';

const AADHAAR = (process.argv[2] || '').replace(/\s|-/g, '');

if (!/^\d{12}$/.test(AADHAAR)) {
  console.error('❌ Provide a 12-digit Aadhaar number as argv[2]');
  console.error('   Example: npx ts-node scripts/abdm-send-otp.ts 298064642893');
  process.exit(1);
}

const masked = `${AADHAAR.slice(0, 4)}-XXXX-${AADHAAR.slice(-4)}`;

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(` ABHA Enrollment — Send Aadhaar OTP for ${masked}`);
  console.log('══════════════════════════════════════════════════════\n');

  console.log('Step 1 — Obtaining V3 access token…');
  await abdmClient.ensureValidToken();
  console.log('  ✅ Token obtained\n');

  console.log('Step 2 — Fetching RSA-OAEP public key from ABHA…');
  await abdmClient.getPublicKey();
  console.log('  ✅ Public key cached\n');

  console.log('Step 3 — Encrypting Aadhaar (RSA/ECB/OAEPWithSHA-1AndMGF1Padding)…');
  const encAadhaar = await abdmClient.encrypt(AADHAAR);
  console.log(`  ✅ Ciphertext length: ${encAadhaar.length} chars (base64)\n`);

  console.log(`Step 4 — POST ${abdmConfig.abhaUrl}${abdmConfig.endpoints.enrollment.requestOtp}`);
  const res = await abdmClient.abhaPost<any>(abdmConfig.endpoints.enrollment.requestOtp, {
    txnId: '',
    scope: ['abha-enrol'],
    loginHint: 'aadhaar',
    loginId: encAadhaar,
    otpSystem: 'aadhaar',
  });

  console.log('\n══════════════════════════════════════════════════════');
  console.log(' ABDM Response');
  console.log('══════════════════════════════════════════════════════');
  console.log(JSON.stringify(res, null, 2));
  console.log('══════════════════════════════════════════════════════\n');

  if (res?.txnId) {
    console.log('✅ OTP sent. Save the txnId below for the verify step:\n');
    console.log(`   TXN_ID=${res.txnId}`);
    console.log(`   ${res.message || ''}\n`);
    console.log('Next step (after OTP arrives on the mobile linked to Aadhaar):');
    console.log('   POST /abha/api/v3/enrollment/enrol/byAadhaar');
    console.log('   { txnId, authData: { authMethods: ["otp"], otp: { txnId, otpValue: encrypted, timeStamp, mobile } } }\n');
  } else {
    console.log('⚠️  No txnId in response — check the body above.\n');
  }
}

main().catch((err) => {
  console.error('\n❌ Failed:', err?.statusCode || err?.response?.status || '', err?.message || err);
  const detail = err?.response?.data ?? err?.body ?? null;
  if (detail) console.error('   Body:', typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500));
  if (JSON.stringify(detail || '').toLowerCase().includes('cloudfront') || err?.statusCode === 503) {
    console.error('\n💡 abhasbx.abdm.gov.in is blocked from this IP by ABDM CloudFront WAF.');
    console.error('   Run this script from your local Mac (or via a whitelisted host).');
  }
  process.exitCode = 1;
});
