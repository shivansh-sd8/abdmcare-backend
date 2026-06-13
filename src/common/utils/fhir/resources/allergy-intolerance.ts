import { generateUUID, SYSTEM, FHIRReference, FHIRResource, NRCES_PROFILES } from '../coding-tables';

export function buildAllergyIntolerances(
  allergies: string | null | undefined,
  patientRef: FHIRReference,
  encounterRef: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  if (!allergies || allergies.trim() === '') {
    const uuid = generateUUID();
    return [{
      uuid,
      resource: {
        resourceType: 'AllergyIntolerance',
        id: uuid,
        meta: { profile: [NRCES_PROFILES.AllergyIntolerance] },
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active', display: 'Active' }],
        },
        verificationStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed', display: 'Confirmed' }],
        },
        code: {
          coding: [{ system: SYSTEM.SNOMED, code: '716186003', display: 'No known allergy' }],
          text: 'No known allergies',
        },
        patient: patientRef,
        encounter: encounterRef,
      },
    }];
  }

  const allergyList = allergies.split(',').map(a => a.trim()).filter(Boolean);
  return allergyList.map((allergyText) => {
    const uuid = generateUUID();
    return {
      uuid,
      resource: {
        resourceType: 'AllergyIntolerance',
        id: uuid,
        meta: { profile: [NRCES_PROFILES.AllergyIntolerance] },
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active', display: 'Active' }],
        },
        verificationStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed', display: 'Confirmed' }],
        },
        code: { text: allergyText },
        patient: patientRef,
        encounter: encounterRef,
      },
    };
  });
}
