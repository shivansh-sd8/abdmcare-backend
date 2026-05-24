/**
 * ABDM V3 Sandbox Setup Script
 * Registers bridge URL and HIP service with the ABDM gateway.
 *
 * V3 bridge PATCH endpoint: https://dev.abdm.gov.in/api/hiecm/gateway/v3/bridge/url
 * V3 bridge-services GET:   https://dev.abdm.gov.in/api/hiecm/gateway/v3/bridge-services
 * HIP service registration: https://facilitysbx.abdm.gov.in/v1/bridges/MutipleHRPAddUpdateServices
 *
 * Usage: npx ts-node scripts/abdm-sandbox-setup.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import abdmClient from '../src/common/utils/abdm-client';
import { abdmConfig } from '../src/common/config/abdm';
import logger from '../src/common/config/logger';

// ─────────────────────────────────────────────────────────────────────────────

function validateEnv(): void {
  const required = [
    'ABDM_CLIENT_ID', 'ABDM_CLIENT_SECRET',
    'ABDM_CALLBACK_URL', 'HIP_ID', 'HIP_NAME',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    process.exit(1);
  }
  if (!process.env.ABDM_CALLBACK_URL!.startsWith('https://')) {
    console.error('❌ ABDM_CALLBACK_URL must start with https://');
    process.exit(1);
  }
}

async function runSetup(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' ABDM V3 Sandbox Setup');
  console.log('══════════════════════════════════════════════════════\n');

  validateEnv();

  const callbackUrl = process.env.ABDM_CALLBACK_URL!;
  const clientId = process.env.ABDM_CLIENT_ID!;
  const hipId = process.env.HIP_ID!;
  const hipName = process.env.HIP_NAME!;

  console.log('Config:');
  console.log(`  Gateway   : ${abdmConfig.gatewayUrl}`);
  console.log(`  Callback  : ${callbackUrl}`);
  console.log(`  Client ID : ${clientId}`);
  console.log(`  HIP ID    : ${hipId}\n`);

  // ── Step 1: Authenticate ──────────────────────────────────────────────────
  console.log('Step 1 — Obtaining V3 session token…');
  const token = await abdmClient.ensureValidToken();
  console.log('  ✅ Token obtained\n');

  // ── Step 2: Fetch public key (verifies cert endpoint works) ───────────────
  console.log('Step 2 — Fetching ABHA V3 public key…');
  await abdmClient.getPublicKey();
  console.log('  ✅ Public key ready\n');

  // ── Step 3: Update bridge URL ─────────────────────────────────────────────
  console.log(`Step 3 — Updating bridge URL to ${callbackUrl}…`);
  console.log(`  PATCH ${abdmConfig.gatewayUrl}${abdmConfig.endpoints.bridge.updateUrl}`);
  try {
    await abdmClient.updateBridgeUrl(callbackUrl);
    console.log('  ✅ Bridge URL updated\n');
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = JSON.stringify(err?.response?.data || err?.message);
    console.warn(`  ⚠️  Bridge URL update returned ${status}: ${msg}`);
    console.warn('     This may be a pending ABDM-side API subscription. Continue anyway.\n');
  }

  // ── Step 4: Register HIP service ─────────────────────────────────────────
  console.log(`Step 4 — Registering HIP service (${hipId})…`);
  console.log(`  POST ${abdmConfig.facilityUrl}${abdmConfig.endpoints.facility.addUpdateServices}`);
  try {
    await abdmClient.addBridgeHipService({
      facilityId: hipId,
      facilityName: hipName,
      bridgeId: clientId,
      hipName,
      active: true,
    });
    console.log('  ✅ HIP service registered\n');
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = JSON.stringify(err?.response?.data || err?.message);
    console.warn(`  ⚠️  HIP registration returned ${status}: ${msg}`);
    console.warn('     Use the ABDM sandbox portal to manually register if this fails.\n');
  }

  // ── Step 5: Verify bridge services ───────────────────────────────────────
  console.log('Step 5 — Verifying registered bridge services…');
  console.log(`  GET ${abdmConfig.gatewayUrl}${abdmConfig.endpoints.bridge.getServices}`);
  try {
    const services = await abdmClient.getBridgeServices();
    console.log('  ✅ Bridge services:');
    console.log(JSON.stringify(services, null, 2));
  } catch (err: any) {
    const status = err?.response?.status;
    console.warn(`  ⚠️  Could not fetch bridge services (${status}). This is expected before full activation.`);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(' Setup complete');
  console.log(' Next: test enrollment APIs with a real sandbox Aadhaar');
  console.log('══════════════════════════════════════════════════════\n');
}

runSetup().catch((err) => {
  console.error('\n❌ Setup failed:', err?.response?.data || err?.message || err);
  process.exit(1);
});
