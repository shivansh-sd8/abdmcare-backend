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
import { buildOPConsultBundle } from './profiles/op-consult-record';
import { buildDischargeSummaryBundle } from './profiles/discharge-summary-record';
import { buildPrescriptionBundle } from './profiles/prescription-record';
import { buildDiagnosticReportBundle } from './profiles/diagnostic-report-record';
import { buildHealthDocumentBundle } from './profiles/health-document-record';

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
  /** Force a specific profile instead of auto-detecting from encounter type */
  profileOverride?: 'OPConsultRecord' | 'DischargeSummaryRecord' | 'PrescriptionRecord' | 'DiagnosticReportRecord' | 'HealthDocumentRecord';
}

// ─── Profile selection ───────────────────────────────────────────────────────

type ProfileName = 'OPConsultRecord' | 'DischargeSummaryRecord' | 'PrescriptionRecord' | 'DiagnosticReportRecord' | 'HealthDocumentRecord';

function selectProfile(input: FHIRBundleInput): ProfileName {
  if (input.profileOverride) return input.profileOverride;

  const enc = input.encounter;

  if (enc.type === 'IPD' && enc.admissionId) {
    return 'DischargeSummaryRecord';
  }

  if (enc.type === 'OPD' || enc.type === 'TELECONSULTATION') {
    return 'OPConsultRecord';
  }

  if (enc.type === 'EMERGENCY') {
    return 'OPConsultRecord';
  }

  return 'HealthDocumentRecord';
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
  const allObservations: Array<{ uuid: string; resource: any }> = [];
  if (input.vitals) {
    for (const v of input.vitals) {
      allObservations.push(...buildObservations(v, patientRef, encounterRef));
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

  // Merge lab/analyte observations from diagnostic reports into allObservations
  allObservations.push(...diagnosticResult.observations);

  const allergyResults = buildAllergyIntolerances(
    input.encounter.allergies,
    patientRef,
    encounterRef,
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
    patientUUID: patientResult.uuid,
    practitionerUUID: practitionerResult.uuid,
    organizationUUID: organizationResult.uuid,
    encounterUUID: encounterResult.uuid,
    observationUUIDs: allObservations.map(o => o.uuid),
    conditionUUIDs: conditionResults.map(c => c.uuid),
    medicationUUIDs: medicationResults.map(m => m.uuid),
    diagnosticUUIDs: diagnosticResult.reports.map(d => d.uuid),
    allergyUUIDs: allergyResults.map(a => a.uuid),
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
  }
}

export { generateFHIRBundle as buildFHIRBundle };
