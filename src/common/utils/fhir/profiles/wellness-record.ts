import { BundleEntry, FHIRReference, NRCES_PROFILES, urnUUID, generateUUID, COMPOSITION_TYPE } from '../coding-tables';
import { buildComposition, SECTION_CODES, makeRefSection, makeTextSection, CompositionSection } from '../resources/composition';
import type { FHIRBundleInput } from '../fhir-builder';

/**
 * NRCeS WellnessRecord (M2 Health Record Formats).
 * https://nrces.in/ndhm/fhir/r4/StructureDefinition/WellnessRecord
 *
 * Composition.type "WELLNESSREC" (no SNOMED concept; ABDM uses a free-text
 * code "Wellness record" under a custom CodeSystem).
 * Required sections: at least one of:
 *   - Vital Signs
 *   - Body Measurement
 *   - Physical Activity
 *   - General Assessment
 *   - Lifestyle
 *   - Other Observations
 *   - Women Health
 * Optional: DocumentReference.
 *
 * Vital signs (BP, HR, SpO2, RR, temp) and body measurements (height/weight/BMI)
 * are both Observations carried in `observationEntries`. The profile splits them
 * into the appropriate sections by walking the input `vitals` object.
 */
export function buildWellnessRecordBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  observationEntries: BundleEntry[];
  documentEntries?: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  observationUUIDs: string[];
  documentUUIDs?: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = { reference: urnUUID(input.patientUUID), display: `${input.patient.firstName} ${input.patient.lastName}` };
  const practitionerRef: FHIRReference = { reference: urnUUID(input.practitionerUUID), display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}` };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  // Bucket observation UUIDs by code so each lands in the right wellness section.
  // The fhir-builder hands us already-built Observation entries; we need to
  // peek at the LOINC code on each entry's resource.code.coding[0].code.
  const VITAL_SIGN_LOINCS = new Set([
    '8480-6', '8462-4', '8867-4', '8310-5', '2708-6', '9279-1',
  ]); // BP-sys, BP-dia, HR, temp, SpO2, RR
  const BODY_MEAS_LOINCS = new Set(['8302-2', '29463-7', '39156-5']); // height, weight, BMI

  const vitalSignUUIDs: string[] = [];
  const bodyMeasUUIDs: string[] = [];
  const otherUUIDs: string[] = [];

  for (const entry of input.observationEntries) {
    const code = entry.resource?.code?.coding?.[0]?.code;
    const uuid = entry.resource?.id;
    if (!uuid) continue;
    if (code && VITAL_SIGN_LOINCS.has(code)) vitalSignUUIDs.push(uuid);
    else if (code && BODY_MEAS_LOINCS.has(code)) bodyMeasUUIDs.push(uuid);
    else otherUUIDs.push(uuid);
  }

  if (vitalSignUUIDs.length > 0) {
    sections.push(makeRefSection(
      'Vital Signs',
      SECTION_CODES.vitalSigns,
      vitalSignUUIDs.map(u => ({ uuid: u })),
    ));
  }

  if (bodyMeasUUIDs.length > 0) {
    sections.push(makeRefSection(
      'Body Measurement',
      SECTION_CODES.bodyMeasurement,
      bodyMeasUUIDs.map(u => ({ uuid: u })),
    ));
  }

  if (otherUUIDs.length > 0) {
    sections.push(makeRefSection(
      'Other Observations',
      SECTION_CODES.otherObservations,
      otherUUIDs.map(u => ({ uuid: u })),
    ));
  }

  // Lifestyle / general assessment: pulled from the encounter's free-text
  // history if present. Wellness records frequently capture these as text.
  if (input.encounter.pastMedicalHistory) {
    sections.push(makeTextSection(
      'Lifestyle',
      SECTION_CODES.lifestyle,
      input.encounter.pastMedicalHistory,
    ));
  }

  if (input.encounter.physicalExamination) {
    sections.push(makeTextSection(
      'General Assessment',
      SECTION_CODES.generalAssessment,
      input.encounter.physicalExamination,
    ));
  }

  if (input.documentUUIDs?.length) {
    sections.push(makeRefSection(
      'Document Reference',
      SECTION_CODES.documentReference,
      input.documentUUIDs.map(u => ({ uuid: u })),
    ));
  }

  // Defensive: WellnessRecord MUST have at least one section. If the encounter
  // has nothing observed at all, render a textual placeholder.
  if (sections.length === 0) {
    sections.push(makeTextSection(
      'Other Observations',
      SECTION_CODES.otherObservations,
      'No observations recorded for this wellness encounter.',
    ));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.WellnessRecord,
    title: 'Wellness Record',
    date: new Date().toISOString(),
    patientRef,
    practitionerRef,
    organizationRef,
    encounterRef,
    sections,
    typeCoding: COMPOSITION_TYPE.WellnessRecord,
  });

  const bundleId = generateUUID();
  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: { lastUpdated: new Date().toISOString(), profile: [NRCES_PROFILES.WellnessRecord] },
    identifier: { system: 'https://www.ndhm.gov.in/bundle', value: bundleId },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: urnUUID(compositionResult.uuid), resource: compositionResult.resource },
      input.patientEntry,
      input.practitionerEntry,
      input.organizationEntry,
      input.encounterEntry,
      ...input.observationEntries,
      ...(input.documentEntries || []),
    ],
  };
}
