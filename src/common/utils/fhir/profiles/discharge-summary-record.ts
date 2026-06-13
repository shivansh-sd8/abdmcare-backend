import { BundleEntry, FHIRReference, NRCES_PROFILES, urnUUID, generateUUID } from '../coding-tables';
import { buildComposition, SECTION_CODES, makeTextSection, makeRefSection, CompositionSection } from '../resources/composition';
import {
  vitalsNarrative,
  diagnosisNarrative,
  allergiesNarrative,
  medicationsNarrative,
  investigationsNarrative,
} from './narrative-helpers';
import type { FHIRBundleInput } from '../fhir-builder';

export function buildDischargeSummaryBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  observationEntries: BundleEntry[];
  conditionEntries: BundleEntry[];
  medicationEntries: BundleEntry[];
  diagnosticEntries: BundleEntry[];
  allergyEntries: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  observationUUIDs: string[];
  conditionUUIDs: string[];
  medicationUUIDs: string[];
  diagnosticUUIDs: string[];
  allergyUUIDs: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = { reference: urnUUID(input.patientUUID), display: `${input.patient.firstName} ${input.patient.lastName}` };
  const practitionerRef: FHIRReference = { reference: urnUUID(input.practitionerUUID), display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}` };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  if (input.encounter.chiefComplaint) {
    sections.push(makeTextSection('Chief Complaint', SECTION_CODES.chiefComplaint, input.encounter.chiefComplaint));
  }

  if (input.encounter.historyOfPresentIllness || input.encounter.pastMedicalHistory) {
    const historyText = [input.encounter.historyOfPresentIllness, input.encounter.pastMedicalHistory].filter(Boolean).join('\n\n');
    sections.push(makeTextSection('Medical History', SECTION_CODES.medicalHistory, historyText));
  }

  if (input.encounter.notes) {
    sections.push(makeTextSection('Hospital Course', SECTION_CODES.hospitalCourse, input.encounter.notes));
  }

  if (input.encounter.physicalExamination) {
    sections.push(makeTextSection('Physical Examination', SECTION_CODES.physicalExamination, input.encounter.physicalExamination));
  }

  if (input.allergyUUIDs.length > 0) {
    sections.push(makeRefSection('Allergies', SECTION_CODES.allergies,
      input.allergyUUIDs.map(u => ({ uuid: u })), allergiesNarrative(input.encounter)));
  }

  if (input.observationUUIDs.length > 0) {
    sections.push(makeRefSection('Vital Signs', SECTION_CODES.vitalSigns,
      input.observationUUIDs.map(u => ({ uuid: u })), vitalsNarrative(input.vitals)));
  }

  if (input.conditionUUIDs.length > 0) {
    sections.push(makeRefSection('Discharge Diagnosis', SECTION_CODES.dischargeDiagnosis,
      input.conditionUUIDs.map(u => ({ uuid: u })), diagnosisNarrative(input.encounter)));
  }

  if (input.medicationUUIDs.length > 0) {
    sections.push(makeRefSection('Discharge Medications', SECTION_CODES.dischargeMedications,
      input.medicationUUIDs.map(u => ({ uuid: u })), medicationsNarrative(input)));
  }

  if (input.diagnosticUUIDs.length > 0) {
    sections.push(makeRefSection('Investigations', SECTION_CODES.investigations,
      input.diagnosticUUIDs.map(u => ({ uuid: u })), investigationsNarrative(input)));
  }

  if (input.encounter.followUpDate) {
    const followUp = typeof input.encounter.followUpDate === 'string'
      ? input.encounter.followUpDate
      : input.encounter.followUpDate.toISOString().split('T')[0];
    sections.push(makeTextSection('Follow Up Instructions', SECTION_CODES.followUp, `Follow-up scheduled: ${followUp}`));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.DischargeSummaryRecord,
    title: 'Discharge Summary',
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
    meta: { lastUpdated: new Date().toISOString(), profile: [NRCES_PROFILES.DischargeSummaryRecord] },
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
      ...input.conditionEntries,
      ...input.medicationEntries,
      ...input.diagnosticEntries,
      ...input.allergyEntries,
    ],
  };
}
