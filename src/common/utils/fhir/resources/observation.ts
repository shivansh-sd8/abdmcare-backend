import {
  FHIRResource, FHIRReference, SYSTEM, NRCES_PROFILES,
  VITAL_LOINC, VITAL_UNITS, generateUUID,
} from '../coding-tables';

interface VitalsInput {
  id: string;
  temperature?: number | null;
  bloodPressureSystolic?: number | null;
  bloodPressureDiastolic?: number | null;
  heartRate?: number | null;
  respiratoryRate?: number | null;
  oxygenSaturation?: number | null;
  weight?: number | null;
  height?: number | null;
  bmi?: number | null;
  recordedAt: Date;
}

function buildSingleObservation(
  vitalKey: string,
  value: number,
  recordedAt: Date,
  patientRef: FHIRReference,
  encounterRef?: FHIRReference,
): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();
  const loinc = VITAL_LOINC[vitalKey];
  const unit = VITAL_UNITS[vitalKey];

  const resource: FHIRResource = {
    resourceType: 'Observation',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Observation] },
    status: 'final',
    category: [{
      coding: [{
        system: SYSTEM.FHIR_OBSERVATION_CATEGORY,
        code: 'vital-signs',
        display: 'Vital Signs',
      }],
    }],
    code: {
      coding: [{ system: loinc.system, code: loinc.code, display: loinc.display }],
      text: loinc.display,
    },
    subject: patientRef,
    ...(encounterRef && { encounter: encounterRef }),
    effectiveDateTime: recordedAt.toISOString(),
    valueQuantity: {
      value,
      unit: unit.unit,
      system: unit.system,
      code: unit.code,
    },
  };

  return { uuid, resource };
}

const VITAL_FIELDS = [
  'bloodPressureSystolic',
  'bloodPressureDiastolic',
  'heartRate',
  'temperature',
  'oxygenSaturation',
  'respiratoryRate',
  'weight',
  'height',
  'bmi',
] as const;

export function buildObservations(
  vitals: VitalsInput,
  patientRef: FHIRReference,
  encounterRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  const results: Array<{ uuid: string; resource: FHIRResource }> = [];

  for (const field of VITAL_FIELDS) {
    const val = vitals[field];
    if (val != null) {
      results.push(buildSingleObservation(field, val, vitals.recordedAt, patientRef, encounterRef));
    }
  }

  return results;
}
