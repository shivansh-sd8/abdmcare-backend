import { Job } from 'bullmq';
import prisma from '../common/config/database';
import logger from '../common/config/logger';
import { abdmConfig } from '../common/config/abdm';
import { AbdmClient } from '../common/utils/abdm-client';
import EncryptionService from '../common/utils/encryption';
import crypto from 'crypto';
import { HealthDataPushJobData, createHealthDataPushWorker } from '../common/config/queue';
import { deriveHiType, hiTypeToProfile, AbdmHiType } from '../modules/hip/discovery-helpers';

const abdmClient = new AbdmClient();

async function processHealthDataPush(job: Job<HealthDataPushJobData>): Promise<void> {
  const { transactionId, consentAbdmId, consentPatientId, dataPushUrl, dateRange, hiTypes, keyMaterial } = job.data;

  logger.info('Worker: Processing health data push', {
    transactionId,
    jobId: job.id,
    dataPushUrl,
    consentAbdmId,
    hiTypes,
    dateRange,
  });

  // Track the care-context references involved so a FAILED notification can
  // still carry a valid `statusResponses` array (required by ABDM, else 400).
  let careContextRefs: string[] = [];

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

    const dateValidContexts = careContextsWithEnc.filter((cc) => {
      if (!cc.encounter) return false;
      const encDate = cc.encounter.visitDate || cc.encounter.createdAt;
      if (fromDate && encDate < fromDate) return false;
      if (toDate && encDate > toDate) return false;
      return true;
    });

    if (dateValidContexts.length === 0) {
      logger.warn('Worker: No encounters found in consent date range', { transactionId, from: dateRange?.from, to: dateRange?.to });
    }

    // Load vitals, investigations and immunizations separately (they link via
    // encounterId string, not a Prisma relation).
    const dateValidEncIds = dateValidContexts.map((cc) => cc.encounter!.id);
    const [allVitals, allInvestigations, allImmunizations] = await Promise.all([
      dateValidEncIds.length > 0
        ? prisma.vitals.findMany({ where: { encounterId: { in: dateValidEncIds } } })
        : Promise.resolve([]),
      dateValidEncIds.length > 0
        ? prisma.investigation.findMany({ where: { encounterId: { in: dateValidEncIds } } })
        : Promise.resolve([]),
      dateValidEncIds.length > 0
        ? prisma.immunization.findMany({ where: { encounterId: { in: dateValidEncIds } } })
        : Promise.resolve([]),
    ]);

    // Per-care-context hiType derivation (same algorithm as discovery/link).
    // The hiType drives both the consent-scope filter AND the FHIR profile
    // chosen by the bundle builder.
    const ccWithHiType = dateValidContexts.map((cc) => {
      const enc = cc.encounter!;
      const ccHiType = deriveHiType({
        type: enc.type as any,
        admissionId: enc.admissionId,
        hasImmunization: allImmunizations.some((im) => im.encounterId === enc.id),
        hasInvestigation: allInvestigations.some((inv) => inv.encounterId === enc.id),
        hasPrescription:
          (enc.prescriptions?.length || 0) > 0 ||
          (enc as any).labOrders?.length > 0,
        hasDiagnosis: !!(enc.finalDiagnosis || enc.diagnosis || enc.provisionalDiagnosis),
      });
      return { cc, hiType: ccHiType };
    });

    // Apply consent.hiTypes filter — drop care contexts whose derived type
    // is not in the consented scope. Empty/undefined hiTypes means "no
    // restriction" (legacy consents that pre-dated the column).
    const allowedHiTypes = (hiTypes && hiTypes.length > 0) ? new Set(hiTypes) : null;
    const validContexts = (allowedHiTypes
      ? ccWithHiType.filter(({ hiType }) => allowedHiTypes.has(hiType))
      : ccWithHiType
    );

    careContextRefs = (validContexts.length > 0
      ? validContexts.map((v) => v.cc)
      : careContextsWithEnc
    ).map((cc) => cc.careContextId).filter(Boolean);

    if (allowedHiTypes && validContexts.length < ccWithHiType.length) {
      logger.info('Worker: Filtered care contexts to consented hiTypes', {
        transactionId,
        consentedHiTypes: Array.from(allowedHiTypes),
        beforeFilter: ccWithHiType.length,
        afterFilter: validContexts.length,
        droppedHiTypes: ccWithHiType
          .filter(({ hiType }) => !allowedHiTypes.has(hiType))
          .map(({ hiType }) => hiType),
      });
    }


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
    const immunizationsByEnc = new Map<string, any[]>();
    for (const im of allImmunizations) {
      if (!im.encounterId) continue;
      const list = immunizationsByEnc.get(im.encounterId) || [];
      list.push(im);
      immunizationsByEnc.set(im.encounterId, list);
    }

    const { buildFHIRBundle } = await import('../common/utils/fhir/fhir-builder');

    // Establish ONE ECDH session for the whole transfer. Every entry MUST be
    // encrypted with this single session key so the HIU can decrypt them all
    // using the one keyMaterial.dhPublicKey we publish in the push payload.
    //
    // ABDM/Fidelius spec: BouncyCastle "curve25519" Weierstrass form.
    // Public keys are 65-byte uncompressed points (`04 || X(32) || Y(32)`).
    // The session key is HKDF-SHA256(sharedSecret.x, salt = first 20 bytes of
    // (senderNonce ⊕ requesterNonce)) and the AES-GCM IV is the LAST 12 bytes
    // of the same XOR — i.e. fully deterministic from the nonces, NO IV
    // prefix is sent on the wire. See `EncryptionService` for details.
    try {
      const peerB64 = keyMaterial.dhPublicKey?.keyValue;
      const peerBytes = peerB64 ? EncryptionService.decodePeerKeyForDiagnostics(peerB64) : Buffer.alloc(0);
      const head = peerBytes.subarray(0, Math.min(8, peerBytes.length)).toString('hex');
      logger.info('Worker: HIU keyMaterial received', {
        transactionId,
        cryptoAlg: keyMaterial.cryptoAlg,
        curveLabel: keyMaterial.curve,
        keyValueLength: peerB64?.length || 0,
        keyBytesLength: peerBytes.length,
        keyHead: head,
        firstByte: peerBytes[0]?.toString(16),
        nonceLength: keyMaterial.nonce ? Buffer.from(keyMaterial.nonce, 'base64').length : 0,
      });
    } catch {
      // diagnostic only
    }

    const ownKeyPair = EncryptionService.generateECDHKeyPair();

    let session: { sessionKey: Buffer; iv: Buffer };
    try {
      session = EncryptionService.deriveSession(
        ownKeyPair.privateKey,
        keyMaterial.dhPublicKey.keyValue,
        ownKeyPair.nonce,
        keyMaterial.nonce,
      );
    } catch (e: any) {
      logger.error('Worker: ECDH derive failed', {
        transactionId,
        error: e?.message,
        keyValuePrefix: keyMaterial.dhPublicKey?.keyValue?.slice(0, 16),
      });
      throw e;
    }

    const sessionKeyMaterial = {
      cryptoAlg: 'ECDH',
      curve: 'Curve25519',
      dhPublicKey: {
        expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        parameters: 'Curve25519/32byte random key',
        keyValue: ownKeyPair.publicKey,
      },
      nonce: ownKeyPair.nonce,
    };

    const makeEntry = (dataString: string, careContextReference: string) => {
      const content = EncryptionService.encryptWithSessionKey(dataString, session.sessionKey, session.iv);
      return {
        content,
        media: 'application/fhir+json',
        checksum: crypto.createHash('md5').update(content).digest('hex'),
        careContextReference,
      };
    };

    // Build one FHIR bundle + entry per care context. The profile is forced
    // to the per-cc hiType so the BUNDLE we push matches the hiType we
    // ADVERTISED on link/discover. NRCeS profiles (OPConsultRecord,
    // DischargeSummaryRecord, PrescriptionRecord, DiagnosticReportRecord,
    // ImmunizationRecord, WellnessRecord, HealthDocumentRecord) are accepted
    // by ABDM-certified PHR apps; sending a mismatched profile causes the
    // PHR app to silently drop the entry.
    const entries: Array<{ content: string; media: string; checksum: string; careContextReference: string; hiType: AbdmHiType }> = [];

    for (const { cc, hiType } of validContexts) {
      const enc = cc.encounter!;
      const profileOverride = hiTypeToProfile(hiType);
      try {
        const fhirBundle = buildFHIRBundle({
          patient: consent.patient,
          doctor: enc.doctor,
          hospital,
          encounter: enc as any,
          vitals: vitalsByEnc.get(enc.id) || [],
          encounterPrescriptions: enc.prescriptions || [],
          investigations: investigationsByEnc.get(enc.id) || [],
          immunizations: (immunizationsByEnc.get(enc.id) || []).map((im: any) => ({
            id: im.id,
            vaccineName: im.vaccineName,
            vaccineCode: im.vaccineCode,
            manufacturer: im.manufacturer,
            lotNumber: im.lotNumber,
            expiryDate: im.expiryDate,
            doseNumber: im.doseNumber,
            totalDoses: im.totalDoses,
            site: im.site,
            route: im.route,
            doseQuantity: im.doseQuantity != null ? Number(im.doseQuantity) : null,
            doseUnit: im.doseUnit,
            administeredAt: im.administeredAt,
            reason: im.reason,
            notes: im.notes,
          })),
          profileOverride,
        });
        entries.push({ ...makeEntry(JSON.stringify(fhirBundle), cc.careContextId), hiType });
      } catch (buildErr: any) {
        logger.warn('Worker: Failed to build FHIR bundle for encounter, using fallback', {
          encounterId: enc.id,
          error: buildErr.message,
        });
        const fallback = buildBasicFHIRBundle([enc]);
        entries.push({ ...makeEntry(JSON.stringify(fallback), cc.careContextId), hiType });
      }
    }

    // If no entries were built (e.g. no encounters in range OR all dropped
    // by the consent-hiType filter), do NOT push a synthetic empty bundle —
    // ABDM treats that as "data delivered" which misleads the user. Instead
    // skip the push entirely and notify FAILED with reason "no records".
    if (entries.length === 0) {
      logger.info('Worker: No care contexts match consent scope, marking transfer as FAILED with no-data', {
        transactionId,
        dateRange,
        consentedHiTypes: hiTypes,
      });
      throw new Error('No care contexts match the consent scope (date range + hiTypes)');
    }

    logger.info('Worker: Built FHIR bundles per consented hiType', {
      transactionId,
      bundleCount: entries.length,
      hiTypeBreakdown: entries.reduce((acc, e) => {
        acc[e.hiType] = (acc[e.hiType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    // ABDM data push supports pagination (pageNumber is 0-indexed, pageCount is
    // the total number of pages). Split entries into bounded pages so large
    // record sets are delivered in chunks instead of one oversized POST. The
    // HIU side retains the keypair until the last page (pageNumber >= pageCount-1).
    const PAGE_SIZE = 10;
    const pages: (typeof entries)[] = [];
    for (let i = 0; i < entries.length; i += PAGE_SIZE) {
      pages.push(entries.slice(i, i + PAGE_SIZE));
    }
    if (pages.length === 0) pages.push([]);
    const pageCount = pages.length;

    for (let pageNumber = 0; pageNumber < pageCount; pageNumber++) {
      // Wire schema (ABDM "Transferring Health Data" OpenAPI, op
      // `callingDataPushUrl` at /api-hiu/data/notification):
      //   { transactionId, pageNumber, pageCount, entries[], keyMaterial }
      //
      // entry shape: { content, media, checksum, careContextReference }
      //
      // STRICT — we deliberately do NOT include any extension fields
      // (consentId, requestId, …): several HIUs run a JSON-schema validator
      // that rejects unknown keys with a generic 400, which is exactly the
      // failure mode we hit before this strip.
      const wireEntries = pages[pageNumber].map(({ content, media, checksum, careContextReference }) => ({
        content,
        media,
        checksum,
        careContextReference,
      }));
      const pushBody = {
        transactionId,
        pageNumber,
        pageCount,
        entries: wireEntries,
        keyMaterial: sessionKeyMaterial,
      };
      try {
        await abdmClient.post(dataPushUrl, pushBody);
        logger.info('Worker: pushed data page', {
          transactionId,
          pageNumber,
          pageCount,
          entries: pages[pageNumber].length,
        });
      } catch (pushErr: any) {
        // Surface the HIU's actual error body so we can diagnose 4xx without
        // re-running. Axios attaches the parsed body on `response.data` —
        // strip large encrypted blobs from the failed-payload echo so we
        // don't dump megabytes per attempt.
        const respStatus = pushErr?.response?.status;
        const respBody = pushErr?.response?.data;
        const respHeaders = pushErr?.response?.headers;
        const compactedBody = (typeof respBody === 'object' && respBody)
          ? JSON.stringify(respBody).slice(0, 800)
          : String(respBody).slice(0, 800);
        logger.error('Worker: data push HTTP error', {
          transactionId,
          pageNumber,
          dataPushUrl,
          status: respStatus,
          responseBody: compactedBody,
          contentType: respHeaders?.['content-type'],
          payloadKeys: Object.keys(pushBody),
          firstEntryKeys: wireEntries[0] ? Object.keys(wireEntries[0]) : [],
          keyMaterialCurve: sessionKeyMaterial.curve,
          keyMaterialParams: sessionKeyMaterial.dhPublicKey.parameters,
        });
        throw pushErr;
      }
    }

    // Per-care-context delivery status for the data-flow notification.
    const statusResponses = entries.map((e) => ({
      careContextReference: e.careContextReference,
      hiStatus: 'DELIVERED',
      description: 'Transferred',
    }));

    // Notify ABDM: data delivered
    await abdmClient.post(abdmConfig.endpoints.hip.dataFlowNotify, {
      notification: {
        consentId: consentAbdmId,
        transactionId,
        doneAt: new Date().toISOString(),
        notifier: { type: 'HIP', id: abdmConfig.hip.id },
        statusNotification: { sessionStatus: 'TRANSFERRED', hipId: abdmConfig.hip.id, statusResponses },
      },
    });

    logger.info('Worker: Health data push completed', { transactionId, entriesCount: entries.length, pageCount });
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
          statusNotification: {
            sessionStatus: 'FAILED',
            hipId: abdmConfig.hip.id,
            // ABDM requires a non-empty statusResponses array even on failure.
            statusResponses: (careContextRefs.length > 0 ? careContextRefs : ['']).map((ref) => ({
              careContextReference: ref,
              hiStatus: 'FAILED',
              description: 'Transfer failed',
            })),
          },
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
