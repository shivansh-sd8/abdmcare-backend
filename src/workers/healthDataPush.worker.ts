import { Job } from 'bullmq';
import prisma from '../common/config/database';
import logger from '../common/config/logger';
import { abdmConfig } from '../common/config/abdm';
import { AbdmClient } from '../common/utils/abdm-client';
import EncryptionService from '../common/utils/encryption';
import crypto from 'crypto';
import { HealthDataPushJobData, createHealthDataPushWorker } from '../common/config/queue';

const abdmClient = new AbdmClient();

async function processHealthDataPush(job: Job<HealthDataPushJobData>): Promise<void> {
  const { transactionId, consentAbdmId, consentPatientId, dataPushUrl, dateRange, keyMaterial } = job.data;

  logger.info('Worker: Processing health data push', { transactionId, jobId: job.id });

  const careContexts = await prisma.careContext.findMany({ where: { patientId: consentPatientId } });
  const careContextIds = careContexts.map((cc) => cc.careContextId);
  const encounters = await prisma.encounter.findMany({
    where: { id: { in: careContextIds }, patientId: consentPatientId },
    include: { doctor: true, emrRecords: true },
  });

  const consent = await prisma.consent.findFirst({
    where: { abdmConsentId: consentAbdmId },
    include: { patient: { include: { abhaRecord: true } } },
  });

  if (!consent) {
    throw new Error(`Consent not found: ${consentAbdmId}`);
  }

  // Build FHIR bundle (will use NRCeS builder when available, fallback to basic)
  let fhirBundle: any;
  try {
    const { buildFHIRBundle } = await import('../common/utils/fhir/fhir-builder');
    const hospital = await prisma.hospital.findFirst({ where: { id: consent.patient.hospitalId || undefined } });
    // Build bundle for each encounter — use first as primary
    const enc = encounters[0];
    if (enc) {
      fhirBundle = buildFHIRBundle({
        encounter: enc,
        patient: consent.patient,
        hospital,
        dateRange,
      } as any);
    } else {
      fhirBundle = buildBasicFHIRBundle(encounters);
    }
  } catch {
    fhirBundle = buildBasicFHIRBundle(encounters);
  }

  const dataString = JSON.stringify(fhirBundle);
  const encryptResult = EncryptionService.encryptWithECDH(
    dataString,
    keyMaterial.dhPublicKey.keyValue,
    keyMaterial.nonce,
  );
  const checksum = crypto.createHash('md5').update(encryptResult.encryptedData).digest('hex');

  await abdmClient.post(dataPushUrl, {
    pageNumber: 0,
    pageCount: 1,
    transactionId,
    entries: [{
      content: encryptResult.encryptedData,
      media: 'application/fhir+json',
      checksum,
      careContextReference: careContexts[0]?.careContextId || '',
    }],
    keyMaterial: encryptResult.keyMaterial,
  });

  // Notify ABDM that data has been delivered
  await abdmClient.post(abdmConfig.endpoints.hip.dataFlowNotify, {
    notification: {
      consentId: consentAbdmId,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: 'HIP', id: abdmConfig.hip.id },
      statusNotification: { sessionStatus: 'TRANSFERRED', hipId: abdmConfig.hip.id },
    },
  });

  logger.info('Worker: Health data push completed', { transactionId });
}

function buildBasicFHIRBundle(encounters: any[]): any {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: encounters.map((enc) => ({
      resource: {
        resourceType: 'Encounter',
        id: enc.id,
        status: 'finished',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
        period: { start: enc.createdAt?.toISOString(), end: enc.updatedAt?.toISOString() },
      },
    })),
  };
}

export function startHealthDataPushWorker(): void {
  createHealthDataPushWorker(processHealthDataPush);
  logger.info('Health data push worker started');
}
