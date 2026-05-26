import { BundleEntry, FHIRReference, NRCES_PROFILES, urnUUID, generateUUID } from '../coding-tables';
import { buildComposition, SECTION_CODES, makeTextSection, makeRefSection, CompositionSection } from '../resources/composition';
import type { FHIRBundleInput } from '../fhir-builder';

export function buildPrescriptionBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  conditionEntries: BundleEntry[];
  medicationEntries: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  conditionUUIDs: string[];
  medicationUUIDs: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = { reference: urnUUID(input.patientUUID), display: `${input.patient.firstName} ${input.patient.lastName}` };
  const practitionerRef: FHIRReference = { reference: urnUUID(input.practitionerUUID), display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}` };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  if (input.conditionUUIDs.length > 0) {
    sections.push(makeRefSection('Diagnosis', SECTION_CODES.diagnosis,
      input.conditionUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.medicationUUIDs.length > 0) {
    sections.push(makeRefSection('Medications', SECTION_CODES.medications,
      input.medicationUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.encounter.notes) {
    sections.push(makeTextSection('Notes', SECTION_CODES.followUp, input.encounter.notes));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.PrescriptionRecord,
    title: 'Prescription',
    date: new Date().toISOString(),
    patientRef,
    practitionerRef,
    organizationRef,
    encounterRef,
    sections,
  });

  const bundleId = generateUUID();
  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: { lastUpdated: new Date().toISOString() },
    identifier: { system: 'https://ndhm.in/bundle', value: bundleId },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: urnUUID(compositionResult.uuid), resource: compositionResult.resource },
      input.patientEntry,
      input.practitionerEntry,
      input.organizationEntry,
      input.encounterEntry,
      ...input.conditionEntries,
      ...input.medicationEntries,
    ],
  };
}
