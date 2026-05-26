import { FHIRResource, FHIRReference, SYSTEM, NRCES_PROFILES, generateUUID, lookupDiagnosis } from '../coding-tables';

export function buildConditions(
  diagnosisText: string | null | undefined,
  patientRef: FHIRReference,
  encounterRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  if (!diagnosisText) return [];

  const parts = diagnosisText
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  return parts.map(part => {
    const uuid = generateUUID();
    const code = lookupDiagnosis(part);

    const resource: FHIRResource = {
      resourceType: 'Condition',
      id: uuid,
      meta: { profile: [NRCES_PROFILES.Condition] },
      clinicalStatus: {
        coding: [{ system: SYSTEM.FHIR_CONDITION_CLINICAL, code: 'active', display: 'Active' }],
      },
      verificationStatus: {
        coding: [{ system: SYSTEM.FHIR_CONDITION_VERIFICATION, code: 'confirmed', display: 'Confirmed' }],
      },
      category: [{
        coding: [{ system: SYSTEM.FHIR_CONDITION_CATEGORY, code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }],
      }],
      code,
      subject: patientRef,
      ...(encounterRef && { encounter: encounterRef }),
    };

    return { uuid, resource };
  });
}
