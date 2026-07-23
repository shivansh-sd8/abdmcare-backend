import { BundleEntry, FHIRReference, NRCES_PROFILES, urnUUID, generateUUID, COMPOSITION_TYPE, BUNDLE_IDENTIFIER_SYSTEM } from '../coding-tables';
import { buildComposition, SECTION_CODES, makeRefSection, makeTextSection, CompositionSection } from '../resources/composition';
import { allergiesNarrative, immunizationsNarrative } from './narrative-helpers';
import type { FHIRBundleInput } from '../fhir-builder';

/**
 * NRCeS ImmunizationRecord (M2 Health Record Formats).
 * https://nrces.in/ndhm/fhir/r4/StructureDefinition/ImmunizationRecord
 *
 * Composition.type SNOMED 41000179103 ("Immunization record").
 * Required sections: Immunization (≥ 1).
 * Optional sections: ImmunizationRecommendation, AllergyIntolerance,
 *                     DocumentReference.
 */
export function buildImmunizationRecordBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  immunizationEntries: BundleEntry[];
  allergyEntries: BundleEntry[];
  documentEntries?: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  immunizationUUIDs: string[];
  allergyUUIDs: string[];
  documentUUIDs?: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = { reference: urnUUID(input.patientUUID), display: `${input.patient.firstName} ${input.patient.lastName}` };
  const practitionerRef: FHIRReference = { reference: urnUUID(input.practitionerUUID), display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}` };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  // Required: Immunization (one or more) — empty array is invalid for this
  // profile. The fhir-builder is responsible for ensuring there's at least one
  // immunization before invoking this profile.
  if (input.immunizationUUIDs.length > 0) {
    sections.push(makeRefSection(
      'Immunizations',
      SECTION_CODES.immunization,
      input.immunizationUUIDs.map(u => ({ uuid: u })),
      immunizationsNarrative(input),
    ));
  } else {
    // Defensive: render a textual "no doses recorded" so the bundle still
    // validates as a Composition.
    sections.push(makeTextSection(
      'Immunizations',
      SECTION_CODES.immunization,
      'No immunization doses recorded for this encounter.',
    ));
  }

  // Optional: known allergies (informs immunization safety).
  if (input.allergyUUIDs.length > 0) {
    sections.push(makeRefSection(
      'Allergies',
      SECTION_CODES.allergies,
      input.allergyUUIDs.map(u => ({ uuid: u })),
      allergiesNarrative(input.encounter),
    ));
  }

  // Optional: any source documents (uploaded vaccine cards, ICMR certificates).
  if (input.documentUUIDs?.length) {
    sections.push(makeRefSection(
      'Document Reference',
      SECTION_CODES.documentReference,
      input.documentUUIDs.map(u => ({ uuid: u })),
    ));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.ImmunizationRecord,
    title: 'Immunization Record',
    date: new Date().toISOString(),
    patientRef,
    practitionerRef,
    organizationRef,
    encounterRef,
    sections,
    typeCoding: COMPOSITION_TYPE.ImmunizationRecord,
  });

  const bundleId = generateUUID();
  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: { lastUpdated: new Date().toISOString(), profile: [NRCES_PROFILES.ImmunizationRecord] },
    identifier: { system: BUNDLE_IDENTIFIER_SYSTEM, value: bundleId },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: urnUUID(compositionResult.uuid), resource: compositionResult.resource },
      input.patientEntry,
      input.practitionerEntry,
      input.organizationEntry,
      input.encounterEntry,
      ...input.immunizationEntries,
      ...input.allergyEntries,
      ...(input.documentEntries || []),
    ],
  };
}
