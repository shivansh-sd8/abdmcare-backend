import { BundleEntry, FHIRReference, urnUUID } from './coding-tables';
import { buildPatient } from './resources/patient';
import { buildPractitioner } from './resources/practitioner';
import { buildOrganization } from './resources/organization';
import { buildEncounter } from './resources/encounter';
import { buildObservations } from './resources/observation';
import { buildConditions } from './resources/condition';
import { buildMedicationRequests } from './resources/medication-request';
import { buildDiagnosticReports } from './resources/diagnostic-report';
import { buildAllergyIntolerances } from './resources/allergy-intolerance';
import { buildImmunizations, ImmunizationInput } from './resources/immunization';
import { buildOPConsultBundle } from './profiles/op-consult-record';
import { buildDischargeSummaryBundle } from './profiles/discharge-summary-record';
import { buildPrescriptionBundle } from './profiles/prescription-record';
import { buildDiagnosticReportBundle } from './profiles/diagnostic-report-record';
import { buildHealthDocumentBundle } from './profiles/health-document-record';
import { buildImmunizationRecordBundle } from './profiles/immunization-record';
import { buildWellnessRecordBundle } from './profiles/wellness-record';
import { buildInvoiceRecordBundle } from './profiles/invoice-record';
import { buildInvoices, InvoiceInput } from './resources/invoice';
import { buildDocumentReferences, documentEntriesFrom, DocumentInput } from './resources/document-reference';

// ─── Input types matching Prisma models ──────────────────────────────────────

export interface FHIRBundleInput {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    gender: 'MALE' | 'FEMALE' | 'OTHER';
    dob?: Date | null;
    mobile: string;
    email?: string | null;
    address?: any;
    abhaNumber?: string | null;
    abhaAddress?: string | null;
    abhaRecord?: { abhaNumber: string; abhaAddress?: string | null } | null;
  };
  doctor: {
    id: string;
    firstName: string;
    lastName: string;
    specialization: string;
    qualification: string;
    registrationNo: string;
    hprId?: string | null;
    mobile: string;
    email: string;
  };
  hospital?: {
    id: string;
    name: string;
    phone: string;
    email: string;
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    pincode: string;
    hipId?: string | null;
    registrationNumber?: string | null;
  } | null;
  encounter: {
    id: string;
    type: 'OPD' | 'IPD' | 'EMERGENCY' | 'TELECONSULTATION';
    status: string;
    chiefComplaint: string;
    historyOfPresentIllness?: string | null;
    pastMedicalHistory?: string | null;
    physicalExamination?: string | null;
    diagnosis?: string | null;
    finalDiagnosis?: string | null;
    provisionalDiagnosis?: string | null;
    notes?: string | null;
    allergies?: string | null;
    followUpDate?: Date | null;
    visitDate: Date;
    createdAt: Date;
    admissionId?: string | null;
  };
  vitals?: Array<{
    id: string;
    temperature?: number | null;
    bloodPressureSystolic?: number | null;
    bloodPressureDiastolic?: number | null;
    heartRate?: number | null;
    respiratoryRate?: number | null;
    oxygenSaturation?: number | null;
    weight?: number | null;
    height?: number | null;
    bmi?: number | null;
    recordedAt: Date;
  }>;
  prescriptions?: Array<{
    id: string;
    medications?: any;
    diagnosis?: string | null;
    issuedAt: Date;
  }>;
  encounterPrescriptions?: Array<{
    id: string;
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string | null;
  }>;
  investigations?: Array<{
    id: string;
    testName: string;
    testType: string;
    status: string;
    results?: any;
    notes?: string | null;
    orderedAt: Date;
    reportedAt?: Date | null;
  }>;
  /** Vaccination doses administered. Drives the ImmunizationRecord profile. */
  immunizations?: ImmunizationInput[];
  /**
   * Payments collected for the encounter. Drives the InvoiceRecord profile.
   * Also surfaced in narratives of clinical bundles when payments exist
   * alongside other clinical data (so HIUs can show "you also paid ₹X" next
   * to the encounter), but only the dedicated InvoiceRecord profile renders
   * them as FHIR Invoice resources.
   */
  payments?: InvoiceInput[];
  /**
   * Uploaded, unstructured artefacts (scanned reports, prescription PDFs,
   * discharge summaries). Rendered as FHIR DocumentReference resources and
   * drive the HealthDocumentRecord profile when an encounter has no structured
   * clinical content of its own.
   */
  documents?: DocumentInput[];
  /** Force a specific profile instead of auto-detecting from encounter type */
  profileOverride?: ProfileName;
}

// ─── Profile selection ───────────────────────────────────────────────────────

export type ProfileName =
  | 'OPConsultRecord'
  | 'DischargeSummaryRecord'
  | 'PrescriptionRecord'
  | 'DiagnosticReportRecord'
  | 'HealthDocumentRecord'
  | 'ImmunizationRecord'
  | 'WellnessRecord'
  | 'InvoiceRecord';

/**
 * Pick the right NRCeS FHIR profile for an encounter. Mirrors
 * `deriveHiType()` in `modules/hip/discovery-helpers.ts` so the profile we
 * BUILD on data push matches the hiType we ADVERTISED on link/discover. Any
 * divergence between the two leads to consumers (PHR apps, HIUs) refusing
 * the bundle because it doesn't match the consented hiType.
 *
 * Priority order (must match `deriveHiType`):
 *   1. Immunization-only (dose + no diagnosis + no investigation) →
 *      ImmunizationRecord
 *   2. IPD with admission                                          →
 *      DischargeSummaryRecord
 *   3. Investigation-only (no diagnosis + no prescription)         →
 *      DiagnosticReportRecord
 *   4. Prescription-only (no diagnosis + no investigation)         →
 *      PrescriptionRecord
 *   5. Payment-only (no clinical data of any kind)                 →
 *      InvoiceRecord
 *   6. Anything else (incl. OPD/TELE/EMERGENCY with diagnosis)     →
 *      OPConsultRecord
 */
function selectProfile(input: FHIRBundleInput): ProfileName {
  if (input.profileOverride) return input.profileOverride;

  const enc = input.encounter;

  const hasImmunizations = (input.immunizations?.length || 0) > 0;
  const hasInvestigations = (input.investigations?.length || 0) > 0;
  const hasPrescriptions =
    (input.prescriptions?.length || 0) > 0 ||
    (input.encounterPrescriptions?.length || 0) > 0;
  const hasDiagnosis = !!(
    enc.finalDiagnosis ||
    enc.diagnosis ||
    enc.provisionalDiagnosis
  );
  const hasPayments = (input.payments?.length || 0) > 0;
  const hasDocuments = (input.documents?.length || 0) > 0;

  if (hasImmunizations && !hasDiagnosis && !hasInvestigations) {
    return 'ImmunizationRecord';
  }

  if (enc.type === 'IPD' && enc.admissionId) {
    return 'DischargeSummaryRecord';
  }

  // Unstructured-only encounter: an uploaded document with no structured
  // clinical content of its own is shared as a HealthDocumentRecord.
  if (hasDocuments && !hasDiagnosis && !hasInvestigations && !hasPrescriptions && !hasImmunizations && !hasPayments) {
    return 'HealthDocumentRecord';
  }

  if (hasInvestigations && !hasDiagnosis && !hasPrescriptions) {
    return 'DiagnosticReportRecord';
  }

  if (hasPrescriptions && !hasDiagnosis && !hasInvestigations) {
    return 'PrescriptionRecord';
  }

  if (hasPayments && !hasDiagnosis && !hasInvestigations && !hasPrescriptions && !hasImmunizations) {
    return 'InvoiceRecord';
  }

  // Default — covers OPD, TELECONSULTATION, EMERGENCY, and any encounter
  // with a diagnosis.
  return 'OPConsultRecord';
}

// ─── Main builder ────────────────────────────────────────────────────────────

export function generateFHIRBundle(input: FHIRBundleInput) {
  // Build core resources
  const patientResult = buildPatient(input.patient);
  const practitionerResult = buildPractitioner(input.doctor);

  const defaultOrg = {
    id: 'default-org',
    name: 'Healthcare Facility',
    phone: '',
    email: '',
    addressLine1: '',
    city: '',
    state: '',
    pincode: '',
  };
  const organizationResult = buildOrganization(input.hospital || defaultOrg);

  const patientRef: FHIRReference = {
    reference: urnUUID(patientResult.uuid),
    display: `${input.patient.firstName} ${input.patient.lastName}`,
  };
  const practitionerRef: FHIRReference = {
    reference: urnUUID(practitionerResult.uuid),
    display: `Dr. ${input.doctor.firstName} ${input.doctor.lastName}`,
  };

  const encounterResult = buildEncounter(input.encounter, patientRef, practitionerRef);
  const encounterRef: FHIRReference = { reference: urnUUID(encounterResult.uuid) };

  // Build clinical resources
  // ──────────────────────────────────────────────────────────────────────
  // We keep VITAL observations and LAB-ANALYTE observations in separate
  // lists. Both end up in the bundle's `entry[]` so every resource has a
  // fullUrl, but only the vitals UUIDs are fed to the "Vital Signs"
  // Composition section. Lab analytes are reachable via
  // `DiagnosticReport.result[]` and don't need a section reference of
  // their own — folding them into the Vital Signs section is what made
  // the ABHA app render Hb/RBC/Haematocrit under "Vital Signs".
  // ──────────────────────────────────────────────────────────────────────
  const vitalObservations: Array<{ uuid: string; resource: any }> = [];
  if (input.vitals) {
    for (const v of input.vitals) {
      vitalObservations.push(...buildObservations(v, patientRef, encounterRef));
    }
  }

  const diagnosisText = input.encounter.finalDiagnosis || input.encounter.diagnosis || input.encounter.provisionalDiagnosis;
  const conditionResults = buildConditions(diagnosisText, patientRef, encounterRef);

  const medicationResults = buildMedicationRequests(
    input.prescriptions || [],
    input.encounterPrescriptions || [],
    input.encounter.visitDate,
    patientRef,
    practitionerRef,
    encounterRef,
  );

  const diagnosticResult = buildDiagnosticReports(
    input.investigations || [],
    patientRef,
    practitionerRef,
    encounterRef,
  );

  // Lab-analyte Observations + auxiliary Specimen resources from the lab
  // results live alongside the DiagnosticReport but are NOT advertised in
  // the Vital Signs Composition section.
  const labAuxiliaryResources = diagnosticResult.observations;
  // All Observation/Specimen entries that need a fullUrl in the bundle.
  const allObservations = [...vitalObservations, ...labAuxiliaryResources];

  const allergyResults = buildAllergyIntolerances(
    input.encounter.allergies,
    patientRef,
    encounterRef,
  );

  const immunizationResults = buildImmunizations(
    input.immunizations || [],
    patientRef,
    practitionerRef,
    encounterRef,
  );

  const invoiceResults = buildInvoices(
    input.payments || [],
    patientRef,
    { reference: urnUUID(organizationResult.uuid) },
  );

  const documentResults = buildDocumentReferences(
    input.documents || [],
    patientRef,
    practitionerRef,
  );

  // Prepare bundle entries
  const patientEntry: BundleEntry = { fullUrl: urnUUID(patientResult.uuid), resource: patientResult.resource };
  const practitionerEntry: BundleEntry = { fullUrl: urnUUID(practitionerResult.uuid), resource: practitionerResult.resource };
  const organizationEntry: BundleEntry = { fullUrl: urnUUID(organizationResult.uuid), resource: organizationResult.resource };
  const encounterEntry: BundleEntry = { fullUrl: urnUUID(encounterResult.uuid), resource: encounterResult.resource };

  const observationEntries: BundleEntry[] = allObservations.map(o => ({ fullUrl: urnUUID(o.uuid), resource: o.resource }));
  const conditionEntries: BundleEntry[] = conditionResults.map(c => ({ fullUrl: urnUUID(c.uuid), resource: c.resource }));
  const medicationEntries: BundleEntry[] = medicationResults.map(m => ({ fullUrl: urnUUID(m.uuid), resource: m.resource }));
  const diagnosticEntries: BundleEntry[] = diagnosticResult.reports.map(d => ({ fullUrl: urnUUID(d.uuid), resource: d.resource }));
  const allergyEntries: BundleEntry[] = allergyResults.map(a => ({ fullUrl: urnUUID(a.uuid), resource: a.resource }));
  const immunizationEntries: BundleEntry[] = immunizationResults.map(i => ({ fullUrl: urnUUID(i.uuid), resource: i.resource }));
  const invoiceEntries: BundleEntry[] = invoiceResults.map(i => ({ fullUrl: urnUUID(i.uuid), resource: i.resource }));
  const documentEntries: BundleEntry[] = documentEntriesFrom(documentResults);

  const commonPayload = {
    ...input,
    patientEntry,
    practitionerEntry,
    organizationEntry,
    encounterEntry,
    observationEntries,
    conditionEntries,
    medicationEntries,
    diagnosticEntries,
    allergyEntries,
    immunizationEntries,
    invoiceEntries,
    documentEntries,
    patientUUID: patientResult.uuid,
    practitionerUUID: practitionerResult.uuid,
    organizationUUID: organizationResult.uuid,
    encounterUUID: encounterResult.uuid,
    // `observationUUIDs` is the list referenced by the "Vital Signs"
    // Composition section and MUST contain only true vital observations.
    // Lab analytes are reachable via DiagnosticReport.result; surfacing
    // them as a section reference makes PHR apps display them under
    // Vital Signs (we hit this exact bug — Hb/RBC under "Vital Signs").
    observationUUIDs: vitalObservations.map(o => o.uuid),
    conditionUUIDs: conditionResults.map(c => c.uuid),
    medicationUUIDs: medicationResults.map(m => m.uuid),
    diagnosticUUIDs: diagnosticResult.reports.map(d => d.uuid),
    allergyUUIDs: allergyResults.map(a => a.uuid),
    immunizationUUIDs: immunizationResults.map(i => i.uuid),
    invoiceUUIDs: invoiceResults.map(i => i.uuid),
    documentUUIDs: documentResults.map(d => d.uuid),
  };

  const profile = selectProfile(input);

  switch (profile) {
    case 'OPConsultRecord':
      return buildOPConsultBundle(commonPayload);
    case 'DischargeSummaryRecord':
      return buildDischargeSummaryBundle(commonPayload);
    case 'PrescriptionRecord':
      return buildPrescriptionBundle(commonPayload);
    case 'DiagnosticReportRecord':
      return buildDiagnosticReportBundle(commonPayload);
    case 'HealthDocumentRecord':
      return buildHealthDocumentBundle(commonPayload);
    case 'ImmunizationRecord':
      return buildImmunizationRecordBundle(commonPayload);
    case 'WellnessRecord':
      return buildWellnessRecordBundle(commonPayload);
    case 'InvoiceRecord':
      return buildInvoiceRecordBundle(commonPayload);
  }
}

export { generateFHIRBundle as buildFHIRBundle };
