/**
 * Pure-Node ABDM M1 Send-OTP probe — no ts-node, no TypeScript build needed.
 *
 * Pipeline (all V3):
 *   1. POST  https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions   → access token
 *   2. GET   https://abhasbx.abdm.gov.in/abha/api/v3/profile/public/certificate → RSA pubkey
 *   3. RSA-OAEP-SHA1 + MGF1 encrypt Aadhaar (base64)
 *   4. POST  https://abhasbx.abdm.gov.in/abha/api/v3/enrollment/request/otp → { txnId }
 *
 * Reads ABDM_CLIENT_ID and ABDM_CLIENT_SECRET from ./.env or process env.
 *
 * Usage:
 *   node scripts/abdm-send-otp.js 298064642893
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const { randomUUID } = require('crypto');

// ── Load .env if present ──────────────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch (_) { /* ignore */ }

const CLIENT_ID = process.env.ABDM_CLIENT_ID;
const CLIENT_SECRET = process.env.ABDM_CLIENT_SECRET;
const GATEWAY_URL = process.env.ABDM_GATEWAY_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway/v3';
const ABHA_URL = process.env.ABDM_ABHA_URL || 'https://abhasbx.abdm.gov.in/abha/api';

const AADHAAR = (process.argv[2] || '').replace(/[\s-]/g, '');
if (!/^\d{12}$/.test(AADHAAR)) {
  console.error('❌ Provide a 12-digit Aadhaar as argv[2]');
  console.error('   Example: node scripts/abdm-send-otp.js 298064642893');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ ABDM_CLIENT_ID / ABDM_CLIENT_SECRET not found in env or .env');
  process.exit(1);
}

const mask = `${AADHAAR.slice(0, 4)}-XXXX-${AADHAAR.slice(-4)}`;

// ── HTTPS request helper (no axios) ───────────────────────────────────────────
// Force IPv4 unless explicitly disabled — DO Bangalore IPv6 may not be whitelisted
// even when its IPv4 is. Set FORCE_IPV4=0 to disable.
const FORCE_IPV4 = process.env.FORCE_IPV4 !== '0';

function request({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: 443,
      headers: { ...headers, 'Content-Length': body ? Buffer.byteLength(body) : 0 },
      ...(FORCE_IPV4 ? { family: 4 } : {}),
    };
    let remote = '';
    const req = https.request(opts, (res) => {
      try { remote = `${res.socket.remoteAddress}:${res.socket.remotePort}`; } catch (_) {}
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* HTML or non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json, remote });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function uuid() { return randomUUID(); }
function ts() { return new Date().toISOString().replace(/Z$/, '000Z').replace('.000000Z', '.000Z'); }

// ── RSA-OAEP-SHA1+MGF1 encrypt (ABDM-standard padding) ────────────────────────
function rsaEncrypt(plaintext, pemBase64) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${pemBase64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  const key = crypto.createPublicKey(pem);
  const enc = crypto.publicEncrypt({
    key,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha1',
  }, Buffer.from(plaintext, 'utf8'));
  return enc.toString('base64');
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(` ABHA Enrollment — Send Aadhaar OTP for ${mask}`);
  console.log(' (pure-node probe, no ts-node required, IPv4-forced)');
  console.log('══════════════════════════════════════════════════════\n');

  // Step 1
  console.log('Step 1 — POST /api/hiecm/gateway/v3/sessions');
  const sess = await request({
    method: 'POST',
    url: `${GATEWAY_URL}/sessions`,
    headers: {
      'Content-Type': 'application/json',
      'REQUEST-ID': uuid(),
      'TIMESTAMP': ts(),
      'X-CM-ID': 'sbx',
    },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      grantType: 'client_credentials',
    }),
  });
  console.log(`  Status: ${sess.status}   server: ${sess.headers.server}   remote: ${sess.remote}`);
  if (sess.status !== 200 || !sess.json?.accessToken) {
    console.error('  ❌ Session failed.\n  Body:', sess.raw.slice(0, 400));
    process.exit(2);
  }
  const token = sess.json.accessToken;
  console.log(`  ✅ Token (len=${token.length})\n`);

  // Step 2
  console.log('Step 2 — GET  /abha/api/v3/profile/public/certificate');
  const cert = await request({
    method: 'GET',
    url: `${ABHA_URL}/v3/profile/public/certificate`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'REQUEST-ID': uuid(),
      'TIMESTAMP': ts(),
    },
  });
  console.log(`  Status: ${cert.status}   server: ${cert.headers.server}   remote: ${cert.remote}   x-cache: ${cert.headers['x-cache'] || '-'}`);
  if (cert.status !== 200 || !cert.json?.publicKey) {
    console.error('\n  ❌ Public-key fetch failed.\n  Body (first 400 chars):');
    console.error('  ' + cert.raw.slice(0, 400).replace(/\n/g, '\n  '));
    if (cert.raw.toLowerCase().includes('cloudfront')) {
      console.error('\n  💡 abhasbx.abdm.gov.in is blocked by ABDM CloudFront WAF for this source IP.');
      console.error('     This is the same block our ticket references. Capture this output for ABDM.');
    }
    process.exit(3);
  }
  console.log('  ✅ RSA public key cached\n');

  // Step 3
  console.log('Step 3 — RSA/ECB/OAEPWithSHA-1AndMGF1Padding encrypt Aadhaar');
  const encAadhaar = rsaEncrypt(AADHAAR, cert.json.publicKey);
  console.log(`  ✅ Ciphertext: ${encAadhaar.length} chars (base64)\n`);

  // Step 4
  console.log('Step 4 — POST /abha/api/v3/enrollment/request/otp');
  const otp = await request({
    method: 'POST',
    url: `${ABHA_URL}/v3/enrollment/request/otp`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'REQUEST-ID': uuid(),
      'TIMESTAMP': ts(),
    },
    body: JSON.stringify({
      txnId: '',
      scope: ['abha-enrol'],
      loginHint: 'aadhaar',
      loginId: encAadhaar,
      otpSystem: 'aadhaar',
    }),
  });
  console.log(`  Status: ${otp.status}   server: ${otp.headers.server}   remote: ${otp.remote}`);
  if (otp.status !== 200) {
    console.error('\n  ❌ Send-OTP failed.\n  Body (first 400 chars):');
    console.error('  ' + otp.raw.slice(0, 400).replace(/\n/g, '\n  '));
    if (otp.raw.toLowerCase().includes('cloudfront')) {
      console.error('\n  💡 CloudFront WAF block on abhasbx.abdm.gov.in. Capture for ABDM ticket.');
    }
    process.exit(4);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(' ABDM Response');
  console.log('══════════════════════════════════════════════════════');
  console.log(JSON.stringify(otp.json, null, 2));
  console.log('══════════════════════════════════════════════════════\n');
  if (otp.json?.txnId) {
    console.log(`✅ OTP sent.   txnId = ${otp.json.txnId}`);
    console.log(`   ${otp.json.message || ''}\n`);
  }
})().catch((err) => {
  console.error('\n❌ Unhandled error:', err?.message || err);
  process.exit(99);
});
