import {
  BundleEntry,
  FHIRReference,
  NRCES_PROFILES,
  COMPOSITION_TYPE,
  urnUUID,
  generateUUID,
  BUNDLE_IDENTIFIER_SYSTEM,
} from '../coding-tables';
import {
  buildComposition,
  SECTION_CODES,
  makeRefSection,
  makeTextSection,
  CompositionSection,
} from '../resources/composition';
import { invoicesNarrative } from './narrative-helpers';
import type { FHIRBundleInput } from '../fhir-builder';

/**
 * NRCeS InvoiceRecord (M2 Health Record Formats).
 * https://nrces.in/ndhm/fhir/r4/StructureDefinition/InvoiceRecord
 *
 * Composition.type — custom code "INVOICEREC" / display "Invoice record" under
 * the ABDM record-types code system (no SNOMED concept exists for an invoice
 * "document"; receivers identify the bundle by `meta.profile`).
 *
 * Required content: at least one FHIR Invoice resource referenced from the
 * "Invoice" section. We render one Invoice per Payment row — IPD discharge
 * settlements + every OPD partial-payment row each show up as their own
 * line item.
 */
export function buildInvoiceRecordBundle(input: FHIRBundleInput & {
  patientEntry: BundleEntry;
  practitionerEntry: BundleEntry;
  organizationEntry: BundleEntry;
  encounterEntry: BundleEntry;
  invoiceEntries: BundleEntry[];
  patientUUID: string;
  practitionerUUID: string;
  organizationUUID: string;
  encounterUUID: string;
  invoiceUUIDs: string[];
}): { resourceType: string; id: string; meta: any; identifier: any; type: string; timestamp: string; entry: BundleEntry[] } {
  const patientRef: FHIRReference = {
    reference: urnUUID(input.patientUUID),
    display: `${input.patient.firstName} ${input.patient.lastName}`,
  };
  const practitionerRef: FHIRReference = {
    reference: urnUUID(input.practitionerUUID),
    display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}`,
  };
  const organizationRef: FHIRReference = { reference: urnUUID(input.organizationUUID) };
  const encounterRef: FHIRReference = { reference: urnUUID(input.encounterUUID) };

  const sections: CompositionSection[] = [];

  if (input.invoiceUUIDs.length > 0) {
    sections.push(makeRefSection(
      'Invoice',
      SECTION_CODES.invoice,
      input.invoiceUUIDs.map((u) => ({ uuid: u })),
      invoicesNarrative(input),
    ));
  } else {
    // Defensive — InvoiceRecord MUST carry at least one section. This path is
    // only reached when the worker mis-routes an empty payments list to this
    // profile, which we already guard against, but the placeholder keeps the
    // bundle FHIR-valid for the receiver.
    sections.push(makeTextSection(
      'Invoice',
      SECTION_CODES.invoice,
      'No billing records available for this care context.',
    ));
  }

  const compositionResult = buildComposition({
    profileUrl: NRCES_PROFILES.InvoiceRecord,
    title: 'Invoice Record',
    date: new Date().toISOString(),
    patientRef,
    practitionerRef,
    organizationRef,
    encounterRef,
    sections,
    typeCoding: COMPOSITION_TYPE.InvoiceRecord,
  });

  const bundleId = generateUUID();
  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: { lastUpdated: new Date().toISOString(), profile: [NRCES_PROFILES.InvoiceRecord] },
    identifier: { system: BUNDLE_IDENTIFIER_SYSTEM, value: bundleId },
    type: 'document',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: urnUUID(compositionResult.uuid), resource: compositionResult.resource },
      input.patientEntry,
      input.practitionerEntry,
      input.organizationEntry,
      input.encounterEntry,
      ...input.invoiceEntries,
    ],
  };
}
