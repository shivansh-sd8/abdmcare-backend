import { BundleEntry, FHIRReference, NRCES_PROFILES, urnUUID, generateUUID, BUNDLE_IDENTIFIER_SYSTEM } from '../coding-tables';
import { buildComposition, SECTION_CODES, makeTextSection, makeRefSection, CompositionSection } from '../resources/composition';
import type { FHIRBundleInput } from '../fhir-builder';

export function buildHealthDocumentBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  observationEntries: BundleEntry[];
  conditionEntries: BundleEntry[];
  medicationEntries: BundleEntry[];
  diagnosticEntries: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  observationUUIDs: string[];
  conditionUUIDs: string[];
  medicationUUIDs: string[];
  diagnosticUUIDs: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = { reference: urnUUID(input.patientUUID), display: `${input.patient.firstName} ${input.patient.lastName}` };
  const practitionerRef: FHIRReference = { reference: urnUUID(input.practitionerUUID), display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}` };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  if (input.encounter.chiefComplaint) {
    sections.push(makeTextSection('Chief Complaint', SECTION_CODES.chiefComplaint, input.encounter.chiefComplaint));
  }

  if (input.encounter.pastMedicalHistory) {
    sections.push(makeTextSection('Medical History', SECTION_CODES.medicalHistory, input.encounter.pastMedicalHistory));
  }

  if (input.encounter.physicalExamination) {
    sections.push(makeTextSection('Physical Examination', SECTION_CODES.physicalExamination, input.encounter.physicalExamination));
  }

  if (input.observationUUIDs.length > 0) {
    sections.push(makeRefSection('Vital Signs', SECTION_CODES.vitalSigns,
      input.observationUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.conditionUUIDs.length > 0) {
    sections.push(makeRefSection('Diagnosis', SECTION_CODES.diagnosis,
      input.conditionUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.medicationUUIDs.length > 0) {
    sections.push(makeRefSection('Medications', SECTION_CODES.medications,
      input.medicationUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.diagnosticUUIDs.length > 0) {
    sections.push(makeRefSection('Investigations', SECTION_CODES.investigations,
      input.diagnosticUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.encounter.followUpDate) {
    const followUp = typeof input.encounter.followUpDate === 'string'
      ? input.encounter.followUpDate
      : input.encounter.followUpDate.toISOString().split('T')[0];
    sections.push(makeTextSection('Follow Up', SECTION_CODES.followUp, `Follow-up scheduled: ${followUp}`));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.HealthDocumentRecord,
    title: 'Health Document',
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
    meta: { lastUpdated: new Date().toISOString(), profile: [NRCES_PROFILES.HealthDocumentRecord] },
    identifier: { system: BUNDLE_IDENTIFIER_SYSTEM, value: bundleId },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: urnUUID(compositionResult.uuid), resource: compositionResult.resource },
      input.patientEntry,
      input.practitionerEntry,
      input.organizationEntry,
      input.encounterEntry,
      ...input.observationEntries,
      ...input.conditionEntries,
      ...input.medicationEntries,
      ...input.diagnosticEntries,
    ],
  };
}
