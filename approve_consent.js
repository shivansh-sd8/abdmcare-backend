require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

async function run() {
  console.log('Getting gateway token...');
  const gwRes = await axios.post('https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions', {
    clientId: process.env.ABDM_CLIENT_ID, clientSecret: process.env.ABDM_CLIENT_SECRET, grantType: 'client_credentials',
  }, { headers: { 'Content-Type': 'application/json', 'REQUEST-ID': crypto.randomUUID(), 'TIMESTAMP': new Date().toISOString(), 'X-CM-ID': 'sbx' } });
  const gwToken = gwRes.data.accessToken;

  const certRes = await axios.get('https://abhasbx.abdm.gov.in/abha/api/v3/profile/public/certificate', {
    headers: { 'Authorization': 'Bearer ' + gwToken, 'REQUEST-ID': crypto.randomUUID(), 'TIMESTAMP': new Date().toISOString() }
  });
  const rawKey = certRes.data.publicKey;
  const pubKey = rawKey.includes('BEGIN') ? rawKey : '-----BEGIN PUBLIC KEY-----\n' + rawKey.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----';
  const encrypt = (val) => crypto.publicEncrypt({ key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(val)).toString('base64');

  // Send OTP
  console.log('Sending OTP to 9119818961...');
  const otpRes = await axios.post('https://abhasbx.abdm.gov.in/abha/api/v3/profile/login/request/otp', {
    scope: ['abha-login', 'mobile-verify'], loginHint: 'mobile', loginId: encrypt('9119818961'), otpSystem: 'abdm'
  }, { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + gwToken, 'REQUEST-ID': crypto.randomUUID(), 'TIMESTAMP': new Date().toISOString() } });
  const txnId = otpRes.data.txnId;
  console.log('OTP sent! txnId:', txnId);

  const otp = await ask('Enter OTP received on 9119818961: ');

  // Verify OTP
  const verRes = await axios.post('https://abhasbx.abdm.gov.in/abha/api/v3/profile/login/verify', {
    scope: ['abha-login', 'mobile-verify'],
    authData: { authMethods: ['otp'], otp: { timeStamp: new Date().toISOString(), txnId, otpValue: encrypt(otp.trim()) } }
  }, { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + gwToken, 'REQUEST-ID': crypto.randomUUID(), 'TIMESTAMP': new Date().toISOString() } });
  const tToken = verRes.data.token;
  console.log('OTP verified! Getting final token...');

  // Get final X-token
  const userRes = await axios.post('https://abhasbx.abdm.gov.in/abha/api/v3/profile/login/verify/user',
    { ABHANumber: '91-4376-3363-3759' },
    { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + gwToken, 'T-Token': 'Bearer ' + tToken, 'REQUEST-ID': crypto.randomUUID(), 'TIMESTAMP': new Date().toISOString() } }
  );
  const xToken = userRes.headers['x-token'] || userRes.data?.token || userRes.data?.tokens?.token;
  console.log('Final X-Token obtained:', xToken ? '✓ Got it' : '✗ Not found');
  console.log('Response:', JSON.stringify(userRes.data, null, 2));
  console.log('Headers:', JSON.stringify(userRes.headers));

  rl.close();
}
run().catch(e => { console.log('ERROR:', e.response?.status, JSON.stringify(e.response?.data, null, 2)); rl.close(); });
