import {
  FHIRResource, FHIRReference, SYSTEM, NRCES_PROFILES,
  generateUUID,
} from '../coding-tables';

export interface ImmunizationInput {
  id: string;
  vaccineName: string;
  vaccineCode?: string | null;
  manufacturer?: string | null;
  lotNumber?: string | null;
  expiryDate?: Date | null;
  doseNumber?: number | null;
  totalDoses?: number | null;
  site?: string | null;
  route?: string | null;
  doseQuantity?: number | null;
  doseUnit?: string | null;
  administeredAt: Date;
  reason?: string | null;
  notes?: string | null;
}

/**
 * Build a single Immunization FHIR resource per NRCeS profile
 * `https://nrces.in/ndhm/fhir/r4/StructureDefinition/Immunization`.
 *
 * The vaccine `code` is optional but strongly preferred — when present, must
 * carry a SNOMED-CT code. Falls back to `text` when only a free-text vaccine
 * name is captured.
 */
export function buildImmunization(
  input: ImmunizationInput,
  patientRef: FHIRReference,
  practitionerRef?: FHIRReference,
  encounterRef?: FHIRReference,
): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();

  const resource: FHIRResource = {
    resourceType: 'Immunization',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Immunization] },
    status: 'completed',
    vaccineCode: {
      ...(input.vaccineCode
        ? { coding: [{ system: SYSTEM.SNOMED, code: input.vaccineCode, display: input.vaccineName }] }
        : {}),
      text: input.vaccineName,
    },
    patient: patientRef,
    occurrenceDateTime: input.administeredAt.toISOString(),
    primarySource: true,
    ...(encounterRef ? { encounter: encounterRef } : {}),
    ...(input.lotNumber ? { lotNumber: input.lotNumber } : {}),
    ...(input.expiryDate ? { expirationDate: input.expiryDate.toISOString().split('T')[0] } : {}),
    ...(input.manufacturer
      ? { manufacturer: { display: input.manufacturer } }
      : {}),
    ...(input.site
      ? {
          site: { text: input.site },
        }
      : {}),
    ...(input.route
      ? {
          route: { text: input.route },
        }
      : {}),
    ...(input.doseQuantity != null
      ? {
          doseQuantity: {
            value: input.doseQuantity,
            unit: input.doseUnit || 'mL',
            system: 'http://unitsofmeasure.org',
            code: input.doseUnit || 'mL',
          },
        }
      : {}),
    ...(practitionerRef
      ? {
          performer: [{
            actor: practitionerRef,
          }],
        }
      : {}),
    ...(input.reason
      ? {
          reasonCode: [{ text: input.reason }],
        }
      : {}),
    ...(input.notes
      ? {
          note: [{ text: input.notes }],
        }
      : {}),
    ...(input.doseNumber != null || input.totalDoses != null
      ? {
          protocolApplied: [{
            ...(input.doseNumber != null ? { doseNumberPositiveInt: input.doseNumber } : {}),
            ...(input.totalDoses != null ? { seriesDosesPositiveInt: input.totalDoses } : {}),
          }],
        }
      : {}),
  };

  return { uuid, resource };
}

export function buildImmunizations(
  records: ImmunizationInput[],
  patientRef: FHIRReference,
  practitionerRef?: FHIRReference,
  encounterRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  if (!records?.length) return [];
  return records.map(r => buildImmunization(r, patientRef, practitionerRef, encounterRef));
}
