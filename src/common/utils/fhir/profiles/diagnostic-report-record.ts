import { BundleEntry, FHIRReference, NRCES_PROFILES, urnUUID, generateUUID } from '../coding-tables';
import { buildComposition, SECTION_CODES, makeRefSection, CompositionSection } from '../resources/composition';
import type { FHIRBundleInput } from '../fhir-builder';

export function buildDiagnosticReportBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  diagnosticEntries: BundleEntry[];
  observationEntries: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  diagnosticUUIDs: string[];
  observationUUIDs: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = { reference: urnUUID(input.patientUUID), display: `${input.patient.firstName} ${input.patient.lastName}` };
  const practitionerRef: FHIRReference = { reference: urnUUID(input.practitionerUUID), display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}` };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  if (input.diagnosticUUIDs.length > 0) {
    sections.push(makeRefSection('Diagnostic Reports', SECTION_CODES.investigations,
      input.diagnosticUUIDs.map(u => ({ uuid: u }))));
  }

  if (input.observationUUIDs.length > 0) {
    sections.push(makeRefSection('Observations', SECTION_CODES.vitalSigns,
      input.observationUUIDs.map(u => ({ uuid: u }))));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.DiagnosticReportRecord,
    title: 'Diagnostic Report',
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
    meta: { lastUpdated: new Date().toISOString(), profile: [NRCES_PROFILES.DiagnosticReportRecord] },
    identifier: { system: 'https://www.ndhm.gov.in/bundle', value: bundleId },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: urnUUID(compositionResult.uuid), resource: compositionResult.resource },
      input.patientEntry,
      input.practitionerEntry,
      input.organizationEntry,
      input.encounterEntry,
      ...input.diagnosticEntries,
      ...input.observationEntries,
    ],
  };
}
