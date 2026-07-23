/**
 * ABDM V3 Sandbox Setup Script — one-shot, idempotent.
 *
 * Performs:
 *   1. /sessions   → fresh token
 *   2. /certs      → cache public key
 *   3. PATCH /bridge/url      → point ABDM at our callback URL
 *   4. POST  MutipleHRPAddUpdateServices (HIP)
 *   5. POST  MutipleHRPAddUpdateServices (HIU)
 *   6. GET   /bridge-service/serviceId/:id   → verify
 *   7. HEAD/GET  $ABDM_CALLBACK_URL/health   → verify public reachability
 *   8. UPDATE hospitals SET hipId, hiuId, abdmEnabled=true, abdmRegisteredAt=NOW()
 *
 * Steps 3-5 are idempotent: "already associated" responses from ABDM are
 * treated as success (HFR auto-registers services under your bridge).
 *
 * Usage:
 *   npx ts-node scripts/abdm-sandbox-setup.ts                # uses .env values
 *   HOSPITAL_NAME="Shivansh Test Facility" npx ts-node scripts/abdm-sandbox-setup.ts
 *   HOSPITAL_ID=<uuid> npx ts-node scripts/abdm-sandbox-setup.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import axios from 'axios';
import abdmClient from '../src/common/utils/abdm-client';
import { abdmConfig } from '../src/common/config/abdm';
import prisma from '../src/common/config/database';

// ─────────────────────────────────────────────────────────────────────────────

function validateEnv(): void {
  const required = [
    'ABDM_CLIENT_ID', 'ABDM_CLIENT_SECRET',
    'ABDM_CALLBACK_URL', 'HIP_ID', 'HIP_NAME',
    'HIU_ID', 'HIU_NAME',
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

type StepStatus = 'OK' | 'NOOP' | 'WARN' | 'FAILED';
const results: Array<{ step: string; status: StepStatus; detail?: string }> = [];

function record(step: string, status: StepStatus, detail?: string) {
  results.push({ step, status, detail });
  const icon = status === 'OK' ? '✅' : status === 'NOOP' ? '➖' : status === 'WARN' ? '⚠️ ' : '❌';
  const tail = detail ? ` — ${detail}` : '';
  console.log(`  ${icon} ${status}${tail}`);
}

function isAlreadyAssociated(err: any): boolean {
  const data = JSON.stringify(err?.response?.data || '');
  return data.includes('already associated');
}

async function findTargetHospital() {
  const where: any = {};
  if (process.env.HOSPITAL_ID) where.id = process.env.HOSPITAL_ID;
  else if (process.env.HOSPITAL_NAME) where.name = process.env.HOSPITAL_NAME;
  else where.hipId = process.env.HIP_ID!;
  const hospital = await prisma.hospital.findFirst({ where });
  return hospital;
}

async function checkCallbackReachable(callbackUrl: string) {
  try {
    const r = await axios.get(`${callbackUrl}/health`, { timeout: 8000 });
    return { ok: r.status === 200, status: r.status, body: r.data };
  } catch (err: any) {
    return { ok: false, status: err?.response?.status || 0, body: err?.message };
  }
}

async function runSetup(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' ABDM V3 Sandbox Setup — one-shot, idempotent');
  console.log('══════════════════════════════════════════════════════\n');

  validateEnv();

  const callbackUrl = process.env.ABDM_CALLBACK_URL!;
  const clientId = process.env.ABDM_CLIENT_ID!;
  const hipId = process.env.HIP_ID!;
  const hipName = process.env.HIP_NAME!;
  const hiuId = process.env.HIU_ID!;
  const hiuName = process.env.HIU_NAME!;

  console.log('Config:');
  console.log(`  Gateway   : ${abdmConfig.gatewayUrl}`);
  console.log(`  Callback  : ${callbackUrl}`);
  console.log(`  Bridge ID : ${clientId}`);
  console.log(`  HIP ID    : ${hipId}  (${hipName})`);
  console.log(`  HIU ID    : ${hiuId}  (${hiuName})\n`);

  // ── Step 1: Authenticate ──────────────────────────────────────────────────
  console.log('Step 1 — Obtaining V3 session token…');
  try {
    await abdmClient.ensureValidToken();
    record('sessions', 'OK');
  } catch (err: any) {
    record('sessions', 'FAILED', err?.message);
    throw err;
  }

  // ── Step 2: Fetch public key ──────────────────────────────────────────────
  console.log('\nStep 2 — Fetching ABHA V3 public key…');
  try {
    await abdmClient.getPublicKey();
    record('public-key', 'OK');
  } catch (err: any) {
    record('public-key', 'WARN', err?.message);
  }

  // ── Step 3: Update bridge URL ─────────────────────────────────────────────
  console.log(`\nStep 3 — PATCH bridge URL → ${callbackUrl}`);
  try {
    await abdmClient.updateBridgeUrl(callbackUrl);
    record('updateBridgeUrl', 'OK');
  } catch (err: any) {
    record('updateBridgeUrl', 'WARN', JSON.stringify(err?.response?.data || err?.message).slice(0, 200));
  }

  // ── Step 4: Register HIP service ─────────────────────────────────────────
  console.log(`\nStep 4 — Register HIP service (${hipId})`);
  try {
    await abdmClient.addBridgeHipService({ facilityId: hipId, facilityName: hipName, bridgeId: clientId, hipName, active: true });
    record('addBridgeHipService', 'OK');
  } catch (err: any) {
    if (isAlreadyAssociated(err)) record('addBridgeHipService', 'NOOP', 'already associated (HFR auto-registered)');
    else record('addBridgeHipService', 'WARN', JSON.stringify(err?.response?.data || err?.message).slice(0, 200));
  }

  // ── Step 5: Register HIU service ─────────────────────────────────────────
  console.log(`\nStep 5 — Register HIU service (${hiuId})`);
  try {
    await abdmClient.addBridgeHiuService({ facilityId: hiuId, facilityName: hiuName, bridgeId: clientId, hiuName, active: true });
    record('addBridgeHiuService', 'OK');
  } catch (err: any) {
    if (isAlreadyAssociated(err)) record('addBridgeHiuService', 'NOOP', 'already associated (HFR auto-registered)');
    else record('addBridgeHiuService', 'WARN', JSON.stringify(err?.response?.data || err?.message).slice(0, 200));
  }

  // ── Step 6: Verify bridge services ───────────────────────────────────────
  console.log(`\nStep 6 — Verify registration for ${hipId}`);
  let bridgeOk = false;
  try {
    const data: any = await abdmClient.getBridgeServiceById(hipId);
    // /bridge-service/serviceId/:id returns: { isHip: bool, isHiu: bool, active: bool, ... }
    // /bridge-services (plural) returns:    { services: [{ types: ["HIP","HIU"] }] }
    const hasHip = data?.isHip === true || /"HIP"/.test(JSON.stringify(data));
    const hasHiu = data?.isHiu === true || /"HIU"/.test(JSON.stringify(data));
    const active = data?.active !== false;
    bridgeOk = hasHip && hasHiu && active;
    record(
      'bridge-service GET',
      bridgeOk ? 'OK' : 'WARN',
      `hasHIP=${hasHip} hasHIU=${hasHiu} active=${active}`,
    );
    console.log('\n  Snapshot:');
    console.log(JSON.stringify(data, null, 2).split('\n').map(l => '    ' + l).join('\n'));
  } catch (err: any) {
    record('bridge-service GET', 'WARN', err?.message);
  }

  // ── Step 7: Public callback reachability ─────────────────────────────────
  console.log(`\nStep 7 — Public callback reachability — ${callbackUrl}/health`);
  const reach = await checkCallbackReachable(callbackUrl);
  if (reach.ok) record('callback /health', 'OK', `HTTP ${reach.status}`);
  else record('callback /health', 'WARN', `HTTP ${reach.status} — ABDM callbacks won't arrive until this is reachable`);

  // ── Step 8: Update Hospital row ──────────────────────────────────────────
  console.log(`\nStep 8 — Update Hospital DB row`);
  try {
    const hospital = await findTargetHospital();
    if (!hospital) {
      record('hospital update', 'WARN', 'no matching hospital row found (set HOSPITAL_ID/HOSPITAL_NAME env, or seed the row)');
    } else {
      const updated = await prisma.hospital.update({
        where: { id: hospital.id },
        data: {
          hipId,
          hiuId,
          abdmEnabled: bridgeOk,
          abdmRegisteredAt: bridgeOk ? new Date() : hospital.abdmRegisteredAt,
        },
      });
      record('hospital update', 'OK', `${updated.name} → hipId=${updated.hipId}, hiuId=${updated.hiuId}, abdmEnabled=${updated.abdmEnabled}`);
    }
  } catch (err: any) {
    record('hospital update', 'FAILED', err?.message);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' Summary');
  console.log('══════════════════════════════════════════════════════');
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : r.status === 'NOOP' ? '➖' : r.status === 'WARN' ? '⚠️ ' : '❌';
    console.log(` ${icon} ${r.step.padEnd(28)} ${r.status}${r.detail ? '  — ' + r.detail : ''}`);
  }
  const failed = results.filter(r => r.status === 'FAILED').length;
  console.log('══════════════════════════════════════════════════════');
  console.log(failed === 0 ? ' ✅ Bridge configured. Ready for M2 / M3 testing.' : ` ❌ ${failed} step(s) failed.`);
  console.log('══════════════════════════════════════════════════════\n');
}

runSetup()
  .catch((err) => {
    console.error('\n❌ Setup failed:', err?.response?.data || err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
