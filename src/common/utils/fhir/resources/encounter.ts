import { FHIRResource, FHIRReference, SYSTEM, NRCES_PROFILES, generateUUID } from '../coding-tables';

interface EncounterInput {
  id: string;
  type: 'OPD' | 'IPD' | 'EMERGENCY' | 'TELECONSULTATION';
  status: string;
  chiefComplaint: string;
  visitDate: Date;
  createdAt: Date;
  dischargeType?: string | null;
}

function mapEncounterClass(type: string): { system: string; code: string; display: string } {
  switch (type) {
    case 'IPD':
      return { system: SYSTEM.FHIR_V3_ACT_CODE, code: 'IMP', display: 'inpatient encounter' };
    case 'EMERGENCY':
      return { system: SYSTEM.FHIR_V3_ACT_CODE, code: 'EMER', display: 'emergency' };
    default:
      return { system: SYSTEM.FHIR_V3_ACT_CODE, code: 'AMB', display: 'ambulatory' };
  }
}

function mapStatus(status: string): string {
  if (['COMPLETED', 'BILLING_PENDING', 'PHARMACY_COMPLETED'].includes(status)) return 'finished';
  if (status === 'CANCELLED') return 'cancelled';
  if (['SCHEDULED', 'CONFIRMED'].includes(status)) return 'planned';
  return 'in-progress';
}

const DISCHARGE_DISPOSITION_MAP: Record<string, { code: string; display: string }> = {
  home: { code: 'home', display: 'Discharged to home' },
  normal: { code: 'home', display: 'Discharged to home' },
  lama: { code: 'aadvice', display: 'Left against medical advice' },
  absconded: { code: 'aadvice', display: 'Left against medical advice' },
  referred: { code: 'other-hcf', display: 'Discharged to another healthcare facility' },
  transfer: { code: 'other-hcf', display: 'Discharged to another healthcare facility' },
  expired: { code: 'exp', display: 'Expired' },
  death: { code: 'exp', display: 'Expired' },
};

function mapDischargeDisposition(dischargeType: string): { coding: Array<{ system: string; code: string; display: string }> } | null {
  const key = dischargeType.trim().toLowerCase();
  const mapped = DISCHARGE_DISPOSITION_MAP[key];
  if (mapped) {
    return {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/discharge-disposition', code: mapped.code, display: mapped.display }],
    };
  }
  return null;
}

export function buildEncounter(
  encounter: EncounterInput,
  patientRef: FHIRReference,
  practitionerRef: FHIRReference,
): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();

  const resource: FHIRResource = {
    resourceType: 'Encounter',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Encounter] },
    status: mapStatus(encounter.status),
    class: mapEncounterClass(encounter.type),
    subject: patientRef,
    participant: [{
      individual: practitionerRef,
    }],
    period: {
      start: encounter.visitDate.toISOString(),
    },
    reasonCode: [{
      text: encounter.chiefComplaint,
    }],
    ...(encounter.type === 'IPD' && encounter.dischargeType && (() => {
      const disposition = mapDischargeDisposition(encounter.dischargeType);
      return disposition ? { hospitalization: { dischargeDisposition: disposition } } : {};
    })()),
  };

  return { uuid, resource };
}
