import { FHIRResource, FHIRReference, FHIRCodeableConcept, SYSTEM, NRCES_PROFILES, generateUUID, lookupDiagnosis } from '../coding-tables';
import { lookupSnomed } from '../snomed-lookup';

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

    // Enrich with SNOMED-CT coding if a match is found
    const snomedMatch = lookupSnomed(part);
    if (snomedMatch) {
      const enriched: FHIRCodeableConcept = {
        ...code,
        coding: [
          ...(code.coding || []),
          { system: snomedMatch.system, code: snomedMatch.code, display: snomedMatch.display },
        ],
      };
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
        code: enriched,
        subject: patientRef,
        ...(encounterRef && { encounter: encounterRef }),
      };
      return { uuid, resource };
    }

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
