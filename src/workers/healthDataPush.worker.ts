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

  try {
    const consent = await prisma.consent.findFirst({
      where: { abdmConsentId: consentAbdmId },
      include: { patient: { include: { abhaRecord: true } } },
    });

    if (!consent) {
      throw new Error(`Consent not found: ${consentAbdmId}`);
    }

    const hospital = await prisma.hospital.findFirst({
      where: { id: consent.patient.hospitalId || undefined },
    });

    // Load care contexts with their linked encounters via the correct relation
    const careContextsWithEnc = await prisma.careContext.findMany({
      where: { patientId: consentPatientId },
      include: {
        encounter: {
          include: {
            doctor: true,
            prescriptions: true,
            labOrders: true,
            emrRecords: true,
            ipdAdmission: true,
          },
        },
      },
    });

    // Filter encounters within consent dateRange
    const fromDate = dateRange?.from ? new Date(dateRange.from) : null;
    const toDate = dateRange?.to ? new Date(dateRange.to) : null;

    const validContexts = careContextsWithEnc.filter((cc) => {
      if (!cc.encounter) return false;
      const encDate = cc.encounter.visitDate || cc.encounter.createdAt;
      if (fromDate && encDate < fromDate) return false;
      if (toDate && encDate > toDate) return false;
      return true;
    });

    if (validContexts.length === 0) {
      logger.warn('Worker: No encounters found in consent date range', { transactionId, from: dateRange?.from, to: dateRange?.to });
    }

    // Load vitals and investigations separately (they link via encounterId string, not a Prisma relation)
    const encounterIds = validContexts.map((cc) => cc.encounter!.id);
    const [allVitals, allInvestigations] = await Promise.all([
      encounterIds.length > 0
        ? prisma.vitals.findMany({ where: { encounterId: { in: encounterIds } } })
        : Promise.resolve([]),
      encounterIds.length > 0
        ? prisma.investigation.findMany({ where: { encounterId: { in: encounterIds } } })
        : Promise.resolve([]),
    ]);

    const vitalsByEnc = new Map<string, any[]>();
    for (const v of allVitals) {
      if (!v.encounterId) continue;
      const list = vitalsByEnc.get(v.encounterId) || [];
      list.push(v);
      vitalsByEnc.set(v.encounterId, list);
    }
    const investigationsByEnc = new Map<string, any[]>();
    for (const inv of allInvestigations) {
      if (!inv.encounterId) continue;
      const list = investigationsByEnc.get(inv.encounterId) || [];
      list.push(inv);
      investigationsByEnc.set(inv.encounterId, list);
    }

    const { buildFHIRBundle } = await import('../common/utils/fhir/fhir-builder');

    // Build one FHIR bundle + entry per care context
    const entries: Array<{ content: string; media: string; checksum: string; careContextReference: string }> = [];

    for (const cc of validContexts) {
      const enc = cc.encounter!;
      try {
        const fhirBundle = buildFHIRBundle({
          patient: consent.patient,
          doctor: enc.doctor,
          hospital,
          encounter: enc as any,
          vitals: vitalsByEnc.get(enc.id) || [],
          encounterPrescriptions: enc.prescriptions || [],
          investigations: investigationsByEnc.get(enc.id) || [],
        });

        const dataString = JSON.stringify(fhirBundle);
        const encryptResult = EncryptionService.encryptWithECDH(
          dataString,
          keyMaterial.dhPublicKey.keyValue,
          keyMaterial.nonce,
        );
        const checksum = crypto.createHash('md5').update(encryptResult.encryptedData).digest('hex');

        entries.push({
          content: encryptResult.encryptedData,
          media: 'application/fhir+json',
          checksum,
          careContextReference: cc.careContextId,
        });
      } catch (buildErr: any) {
        logger.warn('Worker: Failed to build FHIR bundle for encounter, using fallback', {
          encounterId: enc.id,
          error: buildErr.message,
        });
        const fallback = buildBasicFHIRBundle([enc]);
        const dataString = JSON.stringify(fallback);
        const encryptResult = EncryptionService.encryptWithECDH(
          dataString,
          keyMaterial.dhPublicKey.keyValue,
          keyMaterial.nonce,
        );
        const checksum = crypto.createHash('md5').update(encryptResult.encryptedData).digest('hex');
        entries.push({
          content: encryptResult.encryptedData,
          media: 'application/fhir+json',
          checksum,
          careContextReference: cc.careContextId,
        });
      }
    }

    // If no entries were built (e.g. no encounters in range), push an empty collection
    if (entries.length === 0) {
      const emptyBundle = buildBasicFHIRBundle([]);
      const dataString = JSON.stringify(emptyBundle);
      const encryptResult = EncryptionService.encryptWithECDH(
        dataString,
        keyMaterial.dhPublicKey.keyValue,
        keyMaterial.nonce,
      );
      const checksum = crypto.createHash('md5').update(encryptResult.encryptedData).digest('hex');
      entries.push({
        content: encryptResult.encryptedData,
        media: 'application/fhir+json',
        checksum,
        careContextReference: careContextsWithEnc[0]?.careContextId || '',
      });
    }

    // Generate key material for this push session
    const sessionEncrypt = EncryptionService.encryptWithECDH(
      '{}',
      keyMaterial.dhPublicKey.keyValue,
      keyMaterial.nonce,
    );

    await abdmClient.post(dataPushUrl, {
      pageNumber: 0,
      pageCount: 1,
      transactionId,
      entries,
      keyMaterial: sessionEncrypt.keyMaterial,
    });

    // Notify ABDM: data delivered
    await abdmClient.post(abdmConfig.endpoints.hip.dataFlowNotify, {
      notification: {
        consentId: consentAbdmId,
        transactionId,
        doneAt: new Date().toISOString(),
        notifier: { type: 'HIP', id: abdmConfig.hip.id },
        statusNotification: { sessionStatus: 'TRANSFERRED', hipId: abdmConfig.hip.id },
      },
    });

    logger.info('Worker: Health data push completed', { transactionId, entriesCount: entries.length });
  } catch (error: any) {
    logger.error('Worker: Health data push failed', { transactionId, error: error.message });

    // Notify ABDM: push failed
    try {
      await abdmClient.post(abdmConfig.endpoints.hip.dataFlowNotify, {
        notification: {
          consentId: consentAbdmId,
          transactionId,
          doneAt: new Date().toISOString(),
          notifier: { type: 'HIP', id: abdmConfig.hip.id },
          statusNotification: { sessionStatus: 'FAILED', hipId: abdmConfig.hip.id },
        },
      });
    } catch (notifyErr: any) {
      logger.error('Worker: Failed to send FAILED notification to ABDM', { error: notifyErr.message });
    }

    throw error;
  }
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
