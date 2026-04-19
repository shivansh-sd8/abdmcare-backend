import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import EncryptionService from '../../common/utils/encryption';

interface DiscoverRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  patient: {
    id: string;
    verifiedIdentifiers?: Array<{
      type: string;
      value: string;
    }>;
    name?: string;
    gender?: string;
    yearOfBirth?: string;
  };
}

interface LinkInitRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  patient: {
    referenceNumber: string;
    display: string;
  };
  careContexts: Array<{
    referenceNumber: string;
    display: string;
  }>;
}

interface HealthInformationRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  hiRequest: {
    consent: {
      id: string;
    };
    dateRange: {
      from: string;
      to: string;
    };
    dataPushUrl: string;
    keyMaterial: {
      cryptoAlg: string;
      curve: string;
      dhPublicKey: {
        expiry: string;
        parameters: string;
        keyValue: string;
      };
      nonce: string;
    };
  };
}

export class HipService {
  // M2.1 - Care Context Discovery
  async discoverCareContexts(request: DiscoverRequest) {
    try {
      logger.info('HIP: Discovering care contexts', { requestId: request.requestId });

      const patientIdentifier = request.patient.verifiedIdentifiers?.find(
        (id) => id.type === 'MOBILE' || id.type === 'ABHA_NUMBER'
      );

      if (!patientIdentifier) {
        return {
          requestId: request.requestId,
          timestamp: new Date().toISOString(),
          transactionId: request.transactionId,
          error: {
            code: 1000,
            message: 'No verified identifier provided',
          },
          resp: {
            requestId: request.requestId,
          },
        };
      }

      let patient;
      if (patientIdentifier.type === 'MOBILE') {
        patient = await prisma.patient.findFirst({
          where: { mobile: patientIdentifier.value },
          include: {
            encounters: {
              orderBy: { createdAt: 'desc' },
              take: 10,
            },
            abhaRecord: true,
          },
        });
      } else if (patientIdentifier.type === 'ABHA_NUMBER') {
        patient = await prisma.patient.findFirst({
          where: {
            abhaRecord: {
              abhaNumber: patientIdentifier.value,
            },
          },
          include: {
            encounters: {
              orderBy: { createdAt: 'desc' },
              take: 10,
            },
            abhaRecord: true,
          },
        });
      }

      if (!patient) {
        return {
          requestId: request.requestId,
          timestamp: new Date().toISOString(),
          transactionId: request.transactionId,
          error: {
            code: 1001,
            message: 'Patient not found',
          },
          resp: {
            requestId: request.requestId,
          },
        };
      }

      const careContexts = patient.encounters.map((encounter) => ({
        referenceNumber: encounter.id,
        display: `${encounter.type} - ${new Date(encounter.createdAt).toLocaleDateString()}`,
      }));

      const response = {
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        transactionId: request.transactionId,
        patient: {
          referenceNumber: patient.id,
          display: `${patient.firstName} ${patient.lastName}`,
          careContexts: careContexts,
          matchedBy: [patientIdentifier.type],
        },
        resp: {
          requestId: request.requestId,
        },
      };

      await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, response);

      logger.info('HIP: Care contexts discovered successfully', {
        requestId: request.requestId,
        patientId: patient.id,
        careContextCount: careContexts.length,
      });

      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to discover care contexts', error);
      throw new AppError(
        error.message || 'Failed to discover care contexts',
        error.statusCode || 500
      );
    }
  }

  // M2.2 - Link Care Contexts
  async linkCareContexts(request: LinkInitRequest) {
    try {
      logger.info('HIP: Linking care contexts', { requestId: request.requestId });

      const patient = await prisma.patient.findUnique({
        where: { id: request.patient.referenceNumber },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      const careContexts = await prisma.careContext.findMany({
        where: { patientId: patient.id },
      });
      const careContextIds = careContexts.map((cc) => cc.careContextId);
      const encounters = await prisma.encounter.findMany({
        where: {
          id: { in: careContextIds },
          patientId: patient.id,
        },
      });

      if (encounters.length !== careContextIds.length) {
        throw new AppError('Some care contexts not found', 404);
      }

      for (const encounter of encounters) {
        await prisma.careContext.create({
          data: {
            careContextId: `CC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            encounterId: encounter.id,
            patientId: patient.id,
            display: `${encounter.type} - ${new Date(encounter.createdAt).toLocaleDateString()}`,
            hipId: abdmConfig.hip.id,
          },
        });
      }

      const response = {
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        transactionId: request.transactionId,
        patient: {
          referenceNumber: patient.id,
          display: `${patient.firstName} ${patient.lastName}`,
          careContexts: request.careContexts,
        },
        resp: {
          requestId: request.requestId,
        },
      };

      await abdmClient.post(abdmConfig.endpoints.hip.onLink, response);

      logger.info('HIP: Care contexts linked successfully', {
        requestId: request.requestId,
        patientId: patient.id,
        careContextCount: careContextIds.length,
      });

      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to link care contexts', error);
      throw new AppError(
        error.message || 'Failed to link care contexts',
        error.statusCode || 500
      );
    }
  }

  // M2.3 - Health Information Request
  async handleHealthInformationRequest(request: HealthInformationRequest) {
    try {
      logger.info('Health information request received', {
        transactionId: request.transactionId,
      });

      const consent = await prisma.consent.findUnique({
        where: { consentId: request.hiRequest.consent.id },
        include: {
          patient: true,
        },
      });

      if (!consent) {
        throw new AppError('Consent not found', 404);
      }

      if (consent.status !== 'GRANTED') {
        throw new AppError('Consent not granted', 403);
      }

      const careContexts = await prisma.careContext.findMany({
        where: { patientId: consent.patientId },
      });
      const careContextIds = careContexts.map((cc) => cc.careContextId);
      const encounters = await prisma.encounter.findMany({
        where: {
          id: { in: careContextIds },
          patientId: consent.patientId,
        },
        include: {
          doctor: true,
          emrRecords: true,
        },
      });

      const fhirBundle = await this.generateFHIRBundle(consent, request.hiRequest.dateRange, encounters);

      const encryptedData = await this.encryptHealthData(
        fhirBundle,
        request.hiRequest.keyMaterial
      );

      await abdmClient.post(request.hiRequest.dataPushUrl, {
        pageNumber: 1,
        pageCount: 1,
        transactionId: request.transactionId,
        entries: [
          {
            content: encryptedData.content,
            media: 'application/fhir+json',
            checksum: encryptedData.checksum,
            careContextReference: careContexts[0]?.id,
          },
        ],
        keyMaterial: request.hiRequest.keyMaterial,
      });

      logger.info('HIP: Health information sent successfully', {
        requestId: request.requestId,
        consentId: consent.consentId,
      });

      return {
        success: true,
        message: 'Health information sent successfully',
      };
    } catch (error: any) {
      logger.error('HIP: Failed to process health information request', error);
      throw new AppError(
        error.message || 'Failed to process health information request',
        error.statusCode || 500
      );
    }
  }

  // Generate FHIR Bundle
  private async generateFHIRBundle(consent: any, _dateRange: { from: string; to: string }, encounters: any[]) {
    const bundle: any = {
      resourceType: 'Bundle',
      id: `bundle-${consent.id}`,
      type: 'collection',
      timestamp: new Date().toISOString(),
      entry: [],
    };

    for (const encounter of encounters) {
      bundle.entry.push({
        fullUrl: `Encounter/${encounter.id}`,
        resource: {
          resourceType: 'Encounter',
          id: encounter.id,
          status: 'finished',
          class: {
            system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            code: 'AMB',
            display: 'ambulatory',
          },
          subject: {
            reference: `Patient/${consent.patient.id}`,
            display: `${consent.patient.firstName} ${consent.patient.lastName}`,
          },
          participant: [
            {
              individual: {
                reference: `Practitioner/${encounter.doctor.id}`,
                display: `Dr. ${encounter.doctor.firstName} ${encounter.doctor.lastName}`,
              },
            },
          ],
          period: {
            start: encounter.createdAt.toISOString(),
            end: encounter.createdAt.toISOString(),
          },
        },
      });

      for (const emr of encounter.emrRecords) {
        if (emr.type === 'PRESCRIPTION') {
          bundle.entry.push({
            fullUrl: `MedicationRequest/${emr.id}`,
            resource: {
              resourceType: 'MedicationRequest',
              id: emr.id,
              status: 'active',
              intent: 'order',
              subject: {
                reference: `Patient/${consent.patient.id}`,
              },
              encounter: {
                reference: `Encounter/${encounter.id}`,
              },
              authoredOn: emr.createdAt.toISOString(),
            },
          });
        } else if (emr.type === 'LAB_REPORT') {
          bundle.entry.push({
            fullUrl: `DiagnosticReport/${emr.id}`,
            resource: {
              resourceType: 'DiagnosticReport',
              id: emr.id,
              status: 'final',
              code: {
                text: 'Laboratory Report',
              },
              subject: {
                reference: `Patient/${consent.patient.id}`,
              },
              encounter: {
                reference: `Encounter/${encounter.id}`,
              },
              effectiveDateTime: emr.createdAt.toISOString(),
            },
          });
        }
      }
    }

    return bundle;
  }

  // Encrypt health data for transmission
  private async encryptHealthData(data: any, _keyMaterial: any) {
    const dataString = JSON.stringify(data);
    const encrypted = EncryptionService.encryptWithAES(dataString);
    const checksum = 'SHA256_CHECKSUM'; // Placeholder for actual checksum

    return {
      content: encrypted,
      checksum: checksum,
    };
  }

  // Add new care contexts
  async addCareContexts(patientId: string, careContexts: Array<{ encounterId: string; display: string }>) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: { abhaRecord: true },
      });

      if (!patient || !patient.abhaRecord) {
        throw new AppError('Patient or ABHA record not found', 404);
      }

      const createdContexts = [];
      for (const context of careContexts) {
        const careContext = await prisma.careContext.create({
          data: {
            careContextId: `CC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            encounterId: context.encounterId,
            patientId: patient.id,
            display: context.display,
            hipId: abdmConfig.hip.id,
          },
        });
        createdContexts.push(careContext);
      }

      await abdmClient.post(abdmConfig.endpoints.hip.notify, {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        notification: {
          patient: {
            id: patient.abhaRecord.abhaNumber,
          },
          careContexts: createdContexts.map((cc) => ({
            referenceNumber: cc.id,
            display: cc.display,
          })),
        },
      });

      logger.info('HIP: Care contexts added and notified', {
        patientId: patient.id,
        count: createdContexts.length,
      });

      return {
        success: true,
        data: createdContexts,
        message: 'Care contexts added successfully',
      };
    } catch (error: any) {
      logger.error('HIP: Failed to add care contexts', error);
      throw new AppError(
        error.message || 'Failed to add care contexts',
        error.statusCode || 500
      );
    }
  }
}

export default new HipService();
