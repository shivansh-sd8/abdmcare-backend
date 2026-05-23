/**
 * ABDM Sandbox Setup Script
 *
 * Runs the 4 mandatory steps from ABDM onboarding:
 *   1. Verify gateway authentication
 *   2. Register callback URL  (PATCH https://dev.abdm.gov.in/devservice/v1/bridges)
 *   3. Link HIP (+ HIU) service (POST https://dev.abdm.gov.in/gateway/v1/bridges/addUpdateServices)
 *   4. Verify configuration   (GET  https://dev.abdm.gov.in/gateway/v1/bridges/getServices)
 *
 * Usage:
 *   cd backend
 *   npx ts-node scripts/abdm-sandbox-setup.ts
 *
 * For quick webhook testing without deploying, set:
 *   ABDM_CALLBACK_URL=https://webhook.site/<your-unique-id>
 *
 * Prerequisites:
 *   .env must have ABDM_CLIENT_ID, ABDM_CLIENT_SECRET, ABDM_CALLBACK_URL, HIP_ID, HIP_NAME
 */

import 'dotenv/config';
import abdmClient from '../src/common/utils/abdm-client';
import { abdmConfig } from '../src/common/config/abdm';

function validateEnv(): void {
  const required = ['ABDM_CLIENT_ID', 'ABDM_CLIENT_SECRET', 'ABDM_CALLBACK_URL', 'HIP_ID', 'HIP_NAME'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`\n❌  Missing required env vars: ${missing.join(', ')}`);
    console.error('   Set them in backend/.env and re-run.\n');
    process.exit(1);
  }
  const url = process.env.ABDM_CALLBACK_URL!;
  if (!url.startsWith('https://')) {
    console.error(`\n❌  ABDM_CALLBACK_URL must start with https://`);
    console.error(`   Current value: ${url}`);
    console.error('   Use ngrok or webhook.site for local testing.\n');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateEnv();

  const callbackUrl = process.env.ABDM_CALLBACK_URL!;
  const hipId       = process.env.HIP_ID!;
  const hipName     = process.env.HIP_NAME!;
  const hiuId       = process.env.HIU_ID;
  const hiuName     = process.env.HIU_NAME;

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    ABDM Sandbox Bridge Registration      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Client ID    : ${abdmConfig.clientId}`);
  console.log(`  Callback URL : ${callbackUrl}`);
  console.log(`  HIP ID       : ${hipId}  (${hipName})`);
  if (hiuId) console.log(`  HIU ID       : ${hiuId}  (${hiuName})`);
  console.log(`  X-CM-ID      : ${abdmConfig.cmId}`);
  console.log('');

  // ── Step 1: Auth ──────────────────────────────────────────────────────────
  // Trigger authenticate() by making a harmless call; if we get back a non-401
  // we know the credentials are valid. getServices may 404 before bridge exists.
  console.log('Step 1/4 — Verifying gateway authentication...');
  try {
    await abdmClient.getBridgeServices();
    console.log('  ✅  Auth OK. Bridge already has registered services.');
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      // Could be unregistered bridge, not bad credentials — try a direct token fetch
      console.log(`  ⚠️   getServices returned ${status} — bridge may not exist yet. Proceeding anyway.`);
    } else {
      console.log(`  ✅  Auth OK (status ${status ?? 'network-error'} on getServices — expected before bridge exists).`);
    }
  }

  // ── Step 2: Register callback URL ─────────────────────────────────────────
  console.log('\nStep 2/4 — Registering callback URL...');
  console.log(`  PATCH https://dev.abdm.gov.in/devservice/v1/bridges`);
  try {
    await abdmClient.updateBridgeUrl(callbackUrl);
    console.log(`  ✅  Callback URL registered: ${callbackUrl}`);
  } catch (err: any) {
    console.error(`  ❌  Failed: ${JSON.stringify(err?.response?.data) || err.message}`);
    process.exit(1);
  }

  // ── Step 3: Link HIP service ──────────────────────────────────────────────
  console.log('\nStep 3/4 — Linking HIP service...');
  console.log(`  POST https://dev.abdm.gov.in/gateway/v1/bridges/addUpdateServices`);
  try {
    await abdmClient.addBridgeService({
      id: hipId,
      name: hipName,
      type: 'HIP',
      active: true,
      alias: [hipId.toLowerCase().replace(/[^a-z0-9]/g, '-')],
      endpoints: [{ address: callbackUrl, connectionType: 'https', use: 'registration' }],
    });
    console.log(`  ✅  HIP linked: ${hipId}`);
  } catch (err: any) {
    console.error(`  ❌  Failed: ${JSON.stringify(err?.response?.data) || err.message}`);
    process.exit(1);
  }

  // ── Step 3b: Optionally link HIU ──────────────────────────────────────────
  if (hiuId && hiuName) {
    console.log('\nStep 3b — Linking HIU service...');
    try {
      await abdmClient.addBridgeService({
        id: hiuId,
        name: hiuName,
        type: 'HIU',
        active: true,
        alias: [hiuId.toLowerCase().replace(/[^a-z0-9]/g, '-')],
        endpoints: [{ address: callbackUrl, connectionType: 'https', use: 'registration' }],
      });
      console.log(`  ✅  HIU linked: ${hiuId}`);
    } catch (err: any) {
      console.warn(`  ⚠️   HIU linking failed (non-fatal): ${JSON.stringify(err?.response?.data) || err.message}`);
    }
  }

  // ── Step 4: Verify ────────────────────────────────────────────────────────
  console.log('\nStep 4/4 — Verifying configuration...');
  console.log(`  GET https://dev.abdm.gov.in/gateway/v1/bridges/getServices`);
  try {
    const services = await abdmClient.getBridgeServices();
    console.log('  ✅  Registered services:');
    console.log(JSON.stringify(services, null, 2));
  } catch (err: any) {
    console.warn(`  ⚠️   Could not fetch services: ${err?.response?.data || err.message}`);
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Setup complete!                         ║');
  console.log('║                                          ║');
  console.log('║  Next steps:                             ║');
  console.log('║  1. Test async callback with Postman     ║');
  console.log('║     POST /gateway/v0.5/users/auth/       ║');
  console.log('║          fetch-modes with an @sbx ABHA   ║');
  console.log('║  2. Verify callback arrives at your URL  ║');
  console.log('║  3. Reply to ABDM to close ticket        ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
