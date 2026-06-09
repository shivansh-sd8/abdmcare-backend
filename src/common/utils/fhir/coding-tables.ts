import crypto from 'crypto';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface CodingEntry {
  code: string;
  system: string;
  display: string;
}

export interface FHIRCoding {
  system: string;
  code: string;
  display: string;
}

export interface FHIRCodeableConcept {
  coding?: FHIRCoding[];
  text?: string;
}

export interface FHIRReference {
  reference: string;
  display?: string;
}

export interface FHIRResource {
  resourceType: string;
  id: string;
  meta?: { profile?: string[]; lastUpdated?: string };
  [key: string]: any;
}

export interface BundleEntry {
  fullUrl: string;
  resource: FHIRResource;
}

// ─── System URLs ─────────────────────────────────────────────────────────────

export const SYSTEM = {
  LOINC: 'http://loinc.org',
  SNOMED: 'http://snomed.info/sct',
  ICD10: 'http://hl7.org/fhir/sid/icd-10',
  FHIR_OBSERVATION_CATEGORY: 'http://terminology.hl7.org/CodeSystem/observation-category',
  FHIR_V3_ACT_CODE: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  FHIR_CONDITION_CATEGORY: 'http://terminology.hl7.org/CodeSystem/condition-category',
  FHIR_CONDITION_CLINICAL: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  FHIR_CONDITION_VERIFICATION: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  FHIR_IDENTIFIER_TYPE: 'http://terminology.hl7.org/CodeSystem/v2-0203',
  FHIR_DOC_TYPE: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  FHIR_COMPOSITION_STATUS: 'http://hl7.org/fhir/composition-status',
  NRCES_BASE: 'https://nrces.in/ndhm/fhir/r4/StructureDefinition',
} as const;

// ─── NRCeS Profile URLs ─────────────────────────────────────────────────────

export const NRCES_PROFILES = {
  Patient: `${SYSTEM.NRCES_BASE}/Patient`,
  Practitioner: `${SYSTEM.NRCES_BASE}/Practitioner`,
  Organization: `${SYSTEM.NRCES_BASE}/Organization`,
  Encounter: `${SYSTEM.NRCES_BASE}/Encounter`,
  Observation: `${SYSTEM.NRCES_BASE}/Observation`,
  Condition: `${SYSTEM.NRCES_BASE}/Condition`,
  MedicationRequest: `${SYSTEM.NRCES_BASE}/MedicationRequest`,
  DiagnosticReport: `${SYSTEM.NRCES_BASE}/DiagnosticReport`,
  Composition: `${SYSTEM.NRCES_BASE}/Composition`,
  Immunization: `${SYSTEM.NRCES_BASE}/Immunization`,
  OPConsultRecord: `${SYSTEM.NRCES_BASE}/OPConsultRecord`,
  DischargeSummaryRecord: `${SYSTEM.NRCES_BASE}/DischargeSummaryRecord`,
  PrescriptionRecord: `${SYSTEM.NRCES_BASE}/PrescriptionRecord`,
  DiagnosticReportRecord: `${SYSTEM.NRCES_BASE}/DiagnosticReportRecord`,
  HealthDocumentRecord: `${SYSTEM.NRCES_BASE}/HealthDocumentRecord`,
  ImmunizationRecord: `${SYSTEM.NRCES_BASE}/ImmunizationRecord`,
  WellnessRecord: `${SYSTEM.NRCES_BASE}/WellnessRecord`,
} as const;

// ─── M2 Composition.type codes (per ABDM Health Record Formats) ────────────
// Each ABDM record type carries a specific Composition.type coding so the CM /
// HIU can identify the bundle without parsing entries.
export const COMPOSITION_TYPE = {
  OPConsultRecord: {
    code: '371530004',
    display: 'Clinical consultation report',
    system: SYSTEM.SNOMED,
  },
  DischargeSummaryRecord: {
    code: '373942005',
    display: 'Discharge summary',
    system: SYSTEM.SNOMED,
  },
  PrescriptionRecord: {
    code: '440545006',
    display: 'Prescription record',
    system: SYSTEM.SNOMED,
  },
  DiagnosticReportRecord: {
    code: '721981007',
    display: 'Diagnostic studies report',
    system: SYSTEM.SNOMED,
  },
  HealthDocumentRecord: {
    code: '419891008',
    display: 'Record artifact',
    system: SYSTEM.SNOMED,
  },
  ImmunizationRecord: {
    code: '41000179103',
    display: 'Immunization record',
    system: SYSTEM.SNOMED,
  },
  WellnessRecord: {
    // No SNOMED for "wellness record"; ABDM allows free-text Composition.type
    // when the snomed concept is not available.
    code: 'WELLNESSREC',
    display: 'Wellness record',
    system: 'http://nrces.in/CodeSystem/abdm-record-types',
  },
} as const;

// ─── LOINC codes for Vitals ──────────────────────────────────────────────────

export const VITAL_LOINC: Record<string, CodingEntry> = {
  bloodPressureSystolic: { code: '8480-6', system: SYSTEM.LOINC, display: 'Systolic blood pressure' },
  bloodPressureDiastolic: { code: '8462-4', system: SYSTEM.LOINC, display: 'Diastolic blood pressure' },
  heartRate: { code: '8867-4', system: SYSTEM.LOINC, display: 'Heart rate' },
  temperature: { code: '8310-5', system: SYSTEM.LOINC, display: 'Body temperature' },
  oxygenSaturation: { code: '2708-6', system: SYSTEM.LOINC, display: 'Oxygen saturation in Arterial blood' },
  respiratoryRate: { code: '9279-1', system: SYSTEM.LOINC, display: 'Respiratory rate' },
  bmi: { code: '39156-5', system: SYSTEM.LOINC, display: 'Body mass index' },
  height: { code: '8302-2', system: SYSTEM.LOINC, display: 'Body height' },
  weight: { code: '29463-7', system: SYSTEM.LOINC, display: 'Body weight' },
  bloodGlucose: { code: '2339-0', system: SYSTEM.LOINC, display: 'Glucose [Mass/volume] in Blood' },
};

export const VITAL_UNITS: Record<string, { unit: string; code: string; system: string }> = {
  bloodPressureSystolic: { unit: 'mmHg', code: 'mm[Hg]', system: 'http://unitsofmeasure.org' },
  bloodPressureDiastolic: { unit: 'mmHg', code: 'mm[Hg]', system: 'http://unitsofmeasure.org' },
  heartRate: { unit: 'beats/min', code: '/min', system: 'http://unitsofmeasure.org' },
  temperature: { unit: '°C', code: 'Cel', system: 'http://unitsofmeasure.org' },
  oxygenSaturation: { unit: '%', code: '%', system: 'http://unitsofmeasure.org' },
  respiratoryRate: { unit: 'breaths/min', code: '/min', system: 'http://unitsofmeasure.org' },
  bmi: { unit: 'kg/m2', code: 'kg/m2', system: 'http://unitsofmeasure.org' },
  height: { unit: 'cm', code: 'cm', system: 'http://unitsofmeasure.org' },
  weight: { unit: 'kg', code: 'kg', system: 'http://unitsofmeasure.org' },
  bloodGlucose: { unit: 'mg/dL', code: 'mg/dL', system: 'http://unitsofmeasure.org' },
};

// ─── ICD-10 diagnoses ────────────────────────────────────────────────────────

const ICD10_TABLE: CodingEntry[] = [
  { code: 'I10', system: SYSTEM.ICD10, display: 'Essential (primary) hypertension' },
  { code: 'I11.9', system: SYSTEM.ICD10, display: 'Hypertensive heart disease without heart failure' },
  { code: 'E11.9', system: SYSTEM.ICD10, display: 'Type 2 diabetes mellitus without complications' },
  { code: 'E10.9', system: SYSTEM.ICD10, display: 'Type 1 diabetes mellitus without complications' },
  { code: 'E11.65', system: SYSTEM.ICD10, display: 'Type 2 diabetes mellitus with hyperglycemia' },
  { code: 'R50.9', system: SYSTEM.ICD10, display: 'Fever, unspecified' },
  { code: 'J06.9', system: SYSTEM.ICD10, display: 'Acute upper respiratory infection, unspecified' },
  { code: 'N39.0', system: SYSTEM.ICD10, display: 'Urinary tract infection, site not specified' },
  { code: 'J18.9', system: SYSTEM.ICD10, display: 'Pneumonia, unspecified organism' },
  { code: 'J18.1', system: SYSTEM.ICD10, display: 'Lobar pneumonia, unspecified organism' },
  { code: 'J45.909', system: SYSTEM.ICD10, display: 'Unspecified asthma, uncomplicated' },
  { code: 'J44.1', system: SYSTEM.ICD10, display: 'Chronic obstructive pulmonary disease with acute exacerbation' },
  { code: 'J44.9', system: SYSTEM.ICD10, display: 'Chronic obstructive pulmonary disease, unspecified' },
  { code: 'K29.70', system: SYSTEM.ICD10, display: 'Gastritis, unspecified, without bleeding' },
  { code: 'K21.0', system: SYSTEM.ICD10, display: 'Gastro-esophageal reflux disease with esophagitis' },
  { code: 'D64.9', system: SYSTEM.ICD10, display: 'Anemia, unspecified' },
  { code: 'D50.9', system: SYSTEM.ICD10, display: 'Iron deficiency anemia, unspecified' },
  { code: 'A90', system: SYSTEM.ICD10, display: 'Dengue fever [classical dengue]' },
  { code: 'A91', system: SYSTEM.ICD10, display: 'Dengue hemorrhagic fever' },
  { code: 'B54', system: SYSTEM.ICD10, display: 'Unspecified malaria' },
  { code: 'B50.9', system: SYSTEM.ICD10, display: 'Plasmodium falciparum malaria, unspecified' },
  { code: 'A01.0', system: SYSTEM.ICD10, display: 'Typhoid fever' },
  { code: 'U07.1', system: SYSTEM.ICD10, display: 'COVID-19' },
  { code: 'G43.909', system: SYSTEM.ICD10, display: 'Migraine, unspecified, not intractable' },
  { code: 'G43.009', system: SYSTEM.ICD10, display: 'Migraine without aura, not intractable' },
  { code: 'M54.5', system: SYSTEM.ICD10, display: 'Low back pain' },
  { code: 'M79.3', system: SYSTEM.ICD10, display: 'Panniculitis, unspecified' },
  { code: 'K59.00', system: SYSTEM.ICD10, display: 'Constipation, unspecified' },
  { code: 'A09', system: SYSTEM.ICD10, display: 'Infectious gastroenteritis and colitis, unspecified' },
  { code: 'K30', system: SYSTEM.ICD10, display: 'Functional dyspepsia' },
  { code: 'J00', system: SYSTEM.ICD10, display: 'Acute nasopharyngitis [common cold]' },
  { code: 'J02.9', system: SYSTEM.ICD10, display: 'Acute pharyngitis, unspecified' },
  { code: 'J03.90', system: SYSTEM.ICD10, display: 'Acute tonsillitis, unspecified' },
  { code: 'J20.9', system: SYSTEM.ICD10, display: 'Acute bronchitis, unspecified' },
  { code: 'L30.9', system: SYSTEM.ICD10, display: 'Dermatitis, unspecified' },
  { code: 'H10.9', system: SYSTEM.ICD10, display: 'Unspecified conjunctivitis' },
  { code: 'H66.90', system: SYSTEM.ICD10, display: 'Otitis media, unspecified' },
  { code: 'E03.9', system: SYSTEM.ICD10, display: 'Hypothyroidism, unspecified' },
  { code: 'E05.90', system: SYSTEM.ICD10, display: 'Thyrotoxicosis, unspecified' },
  { code: 'I25.10', system: SYSTEM.ICD10, display: 'Atherosclerotic heart disease of native coronary artery' },
  { code: 'N18.9', system: SYSTEM.ICD10, display: 'Chronic kidney disease, unspecified' },
  { code: 'K76.0', system: SYSTEM.ICD10, display: 'Fatty (change of) liver, not elsewhere classified' },
  { code: 'E78.5', system: SYSTEM.ICD10, display: 'Hyperlipidemia, unspecified' },
  { code: 'J30.1', system: SYSTEM.ICD10, display: 'Allergic rhinitis due to pollen' },
  { code: 'B01.9', system: SYSTEM.ICD10, display: 'Varicella without complication' },
  { code: 'R51', system: SYSTEM.ICD10, display: 'Headache' },
  { code: 'R10.9', system: SYSTEM.ICD10, display: 'Unspecified abdominal pain' },
  { code: 'R05', system: SYSTEM.ICD10, display: 'Cough' },
  { code: 'R11.0', system: SYSTEM.ICD10, display: 'Nausea' },
  { code: 'R42', system: SYSTEM.ICD10, display: 'Dizziness and giddiness' },
];

// Keyword → entry index map for fuzzy matching
const ICD10_KEYWORDS: Array<{ keywords: string[]; entry: CodingEntry }> = [
  { keywords: ['hypertension', 'high blood pressure', 'htn', 'bp high'], entry: ICD10_TABLE[0] },
  { keywords: ['diabetes', 'type 2 diabetes', 'dm2', 'dm', 'type 2 dm', 't2dm', 'sugar'], entry: ICD10_TABLE[2] },
  { keywords: ['type 1 diabetes', 'dm1', 't1dm', 'iddm'], entry: ICD10_TABLE[3] },
  { keywords: ['fever', 'pyrexia', 'febrile'], entry: ICD10_TABLE[5] },
  { keywords: ['urti', 'upper respiratory', 'upper respiratory infection', 'cold and cough'], entry: ICD10_TABLE[6] },
  { keywords: ['uti', 'urinary tract infection', 'urinary infection'], entry: ICD10_TABLE[7] },
  { keywords: ['pneumonia', 'lung infection'], entry: ICD10_TABLE[8] },
  { keywords: ['asthma', 'bronchial asthma', 'wheezing'], entry: ICD10_TABLE[10] },
  { keywords: ['copd', 'chronic obstructive', 'chronic bronchitis', 'emphysema'], entry: ICD10_TABLE[12] },
  { keywords: ['gastritis', 'stomach inflammation'], entry: ICD10_TABLE[13] },
  { keywords: ['gerd', 'acid reflux', 'reflux'], entry: ICD10_TABLE[14] },
  { keywords: ['anemia', 'anaemia', 'low hb', 'low hemoglobin'], entry: ICD10_TABLE[15] },
  { keywords: ['iron deficiency', 'ida'], entry: ICD10_TABLE[16] },
  { keywords: ['dengue'], entry: ICD10_TABLE[17] },
  { keywords: ['malaria'], entry: ICD10_TABLE[19] },
  { keywords: ['typhoid', 'enteric fever'], entry: ICD10_TABLE[21] },
  { keywords: ['covid', 'covid-19', 'coronavirus', 'sars-cov-2'], entry: ICD10_TABLE[22] },
  { keywords: ['migraine'], entry: ICD10_TABLE[23] },
  { keywords: ['low back pain', 'backache', 'lumbago', 'back pain'], entry: ICD10_TABLE[25] },
  { keywords: ['constipation'], entry: ICD10_TABLE[27] },
  { keywords: ['gastroenteritis', 'diarrhea', 'diarrhoea', 'loose motion', 'loose stools'], entry: ICD10_TABLE[28] },
  { keywords: ['dyspepsia', 'indigestion'], entry: ICD10_TABLE[29] },
  { keywords: ['common cold', 'nasopharyngitis', 'cold'], entry: ICD10_TABLE[30] },
  { keywords: ['pharyngitis', 'sore throat', 'throat pain', 'throat infection'], entry: ICD10_TABLE[31] },
  { keywords: ['tonsillitis', 'tonsils'], entry: ICD10_TABLE[32] },
  { keywords: ['bronchitis'], entry: ICD10_TABLE[33] },
  { keywords: ['dermatitis', 'eczema', 'skin rash', 'rash'], entry: ICD10_TABLE[34] },
  { keywords: ['conjunctivitis', 'pink eye', 'eye infection'], entry: ICD10_TABLE[35] },
  { keywords: ['otitis media', 'ear infection', 'ear pain'], entry: ICD10_TABLE[36] },
  { keywords: ['hypothyroid', 'hypothyroidism', 'low thyroid'], entry: ICD10_TABLE[37] },
  { keywords: ['hyperthyroid', 'hyperthyroidism', 'thyrotoxicosis', 'overactive thyroid'], entry: ICD10_TABLE[38] },
  { keywords: ['coronary artery disease', 'cad', 'ihd', 'ischemic heart', 'heart disease'], entry: ICD10_TABLE[39] },
  { keywords: ['ckd', 'chronic kidney', 'renal failure', 'kidney disease'], entry: ICD10_TABLE[40] },
  { keywords: ['fatty liver', 'nafld', 'liver disease'], entry: ICD10_TABLE[41] },
  { keywords: ['hyperlipidemia', 'dyslipidemia', 'high cholesterol', 'cholesterol'], entry: ICD10_TABLE[42] },
  { keywords: ['allergic rhinitis', 'hay fever', 'nasal allergy'], entry: ICD10_TABLE[43] },
  { keywords: ['chickenpox', 'varicella'], entry: ICD10_TABLE[44] },
  { keywords: ['headache', 'head pain', 'cephalgia'], entry: ICD10_TABLE[45] },
  { keywords: ['abdominal pain', 'stomach pain', 'stomach ache', 'abdomen pain'], entry: ICD10_TABLE[46] },
  { keywords: ['cough'], entry: ICD10_TABLE[47] },
  { keywords: ['nausea', 'vomiting'], entry: ICD10_TABLE[48] },
  { keywords: ['dizziness', 'vertigo', 'giddiness'], entry: ICD10_TABLE[49] },
];

// ─── LOINC codes for Lab Tests ───────────────────────────────────────────────

const LAB_LOINC_TABLE: CodingEntry[] = [
  { code: '58410-2', system: SYSTEM.LOINC, display: 'Complete blood count (CBC) panel' },
  { code: '718-7', system: SYSTEM.LOINC, display: 'Hemoglobin [Mass/volume] in Blood' },
  { code: '2339-0', system: SYSTEM.LOINC, display: 'Glucose [Mass/volume] in Blood' },
  { code: '2345-7', system: SYSTEM.LOINC, display: 'Glucose [Mass/volume] in Serum or Plasma' },
  { code: '4548-4', system: SYSTEM.LOINC, display: 'Hemoglobin A1c/Hemoglobin.total in Blood' },
  { code: '2093-3', system: SYSTEM.LOINC, display: 'Cholesterol [Mass/volume] in Serum or Plasma' },
  { code: '2571-8', system: SYSTEM.LOINC, display: 'Triglycerides [Mass/volume] in Serum or Plasma' },
  { code: '2085-9', system: SYSTEM.LOINC, display: 'HDL Cholesterol [Mass/volume] in Serum or Plasma' },
  { code: '2089-1', system: SYSTEM.LOINC, display: 'LDL Cholesterol [Mass/volume] in Serum or Plasma' },
  { code: '24331-1', system: SYSTEM.LOINC, display: 'Lipid panel in Serum or Plasma' },
  { code: '1742-6', system: SYSTEM.LOINC, display: 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma' },
  { code: '1920-8', system: SYSTEM.LOINC, display: 'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma' },
  { code: '1975-2', system: SYSTEM.LOINC, display: 'Bilirubin.total [Mass/volume] in Serum or Plasma' },
  { code: '6768-6', system: SYSTEM.LOINC, display: 'Alkaline phosphatase [Enzymatic activity/volume] in Serum or Plasma' },
  { code: '24325-3', system: SYSTEM.LOINC, display: 'Hepatic function panel' },
  { code: '2160-0', system: SYSTEM.LOINC, display: 'Creatinine [Mass/volume] in Serum or Plasma' },
  { code: '3094-0', system: SYSTEM.LOINC, display: 'Urea nitrogen [Mass/volume] in Serum or Plasma' },
  { code: '24362-6', system: SYSTEM.LOINC, display: 'Renal function panel' },
  { code: '3016-3', system: SYSTEM.LOINC, display: 'Thyrotropin [Units/volume] in Serum or Plasma' },
  { code: '3051-0', system: SYSTEM.LOINC, display: 'Triiodothyronine (T3) [Mass/volume] in Serum or Plasma' },
  { code: '3026-2', system: SYSTEM.LOINC, display: 'Thyroxine (T4) [Mass/volume] in Serum or Plasma' },
  { code: '24356-8', system: SYSTEM.LOINC, display: 'Urinalysis complete panel' },
  { code: '789-8', system: SYSTEM.LOINC, display: 'Erythrocytes [#/volume] in Blood' },
  { code: '6690-2', system: SYSTEM.LOINC, display: 'Leukocytes [#/volume] in Blood' },
  { code: '777-3', system: SYSTEM.LOINC, display: 'Platelets [#/volume] in Blood' },
  { code: '4544-3', system: SYSTEM.LOINC, display: 'Hematocrit [Volume Fraction] of Blood' },
  { code: '30341-2', system: SYSTEM.LOINC, display: 'Erythrocyte sedimentation rate' },
  { code: '1988-5', system: SYSTEM.LOINC, display: 'C reactive protein [Mass/volume] in Serum or Plasma' },
  { code: '5902-2', system: SYSTEM.LOINC, display: 'Prothrombin time (PT)' },
  { code: '6301-6', system: SYSTEM.LOINC, display: 'INR in Platelet poor plasma' },
  { code: '2951-2', system: SYSTEM.LOINC, display: 'Sodium [Moles/volume] in Serum or Plasma' },
  { code: '2823-3', system: SYSTEM.LOINC, display: 'Potassium [Moles/volume] in Serum or Plasma' },
  { code: '17861-6', system: SYSTEM.LOINC, display: 'Calcium [Mass/volume] in Serum or Plasma' },
  { code: '2947-0', system: SYSTEM.LOINC, display: 'Chloride [Moles/volume] in Serum or Plasma' },
  { code: '1751-7', system: SYSTEM.LOINC, display: 'Albumin [Mass/volume] in Serum or Plasma' },
  { code: '2880-3', system: SYSTEM.LOINC, display: 'Protein [Mass/volume] in Serum or Plasma' },
  { code: '2965-2', system: SYSTEM.LOINC, display: 'Uric acid [Mass/volume] in Serum or Plasma' },
  { code: '14979-9', system: SYSTEM.LOINC, display: 'aPTT in Platelet poor plasma' },
  { code: '32623-1', system: SYSTEM.LOINC, display: 'Platelet mean volume [Entitic volume] in Blood' },
  { code: '94500-6', system: SYSTEM.LOINC, display: 'SARS-CoV-2 (COVID-19) RNA [Presence] in Respiratory specimen' },
];

const LAB_KEYWORDS: Array<{ keywords: string[]; entry: CodingEntry }> = [
  { keywords: ['cbc', 'complete blood count', 'blood count', 'hemogram'], entry: LAB_LOINC_TABLE[0] },
  { keywords: ['hemoglobin', 'hb', 'haemoglobin', 'hgb'], entry: LAB_LOINC_TABLE[1] },
  { keywords: ['blood sugar', 'blood glucose', 'rbs', 'fbs', 'fasting blood sugar', 'random blood sugar', 'glucose'], entry: LAB_LOINC_TABLE[2] },
  { keywords: ['ppbs', 'post prandial', 'pp blood sugar'], entry: LAB_LOINC_TABLE[3] },
  { keywords: ['hba1c', 'glycated hemoglobin', 'a1c', 'glycosylated'], entry: LAB_LOINC_TABLE[4] },
  { keywords: ['cholesterol', 'total cholesterol'], entry: LAB_LOINC_TABLE[5] },
  { keywords: ['triglycerides', 'tg', 'triglyceride'], entry: LAB_LOINC_TABLE[6] },
  { keywords: ['hdl', 'hdl cholesterol', 'good cholesterol'], entry: LAB_LOINC_TABLE[7] },
  { keywords: ['ldl', 'ldl cholesterol', 'bad cholesterol'], entry: LAB_LOINC_TABLE[8] },
  { keywords: ['lipid profile', 'lipid panel', 'lipids'], entry: LAB_LOINC_TABLE[9] },
  { keywords: ['alt', 'sgpt', 'alanine aminotransferase', 'alanine transaminase'], entry: LAB_LOINC_TABLE[10] },
  { keywords: ['ast', 'sgot', 'aspartate aminotransferase', 'aspartate transaminase'], entry: LAB_LOINC_TABLE[11] },
  { keywords: ['bilirubin', 'total bilirubin'], entry: LAB_LOINC_TABLE[12] },
  { keywords: ['alp', 'alkaline phosphatase'], entry: LAB_LOINC_TABLE[13] },
  { keywords: ['lft', 'liver function', 'hepatic function', 'liver panel'], entry: LAB_LOINC_TABLE[14] },
  { keywords: ['creatinine', 'serum creatinine', 'sr creatinine'], entry: LAB_LOINC_TABLE[15] },
  { keywords: ['bun', 'urea', 'blood urea nitrogen', 'blood urea'], entry: LAB_LOINC_TABLE[16] },
  { keywords: ['kft', 'rft', 'kidney function', 'renal function', 'renal panel'], entry: LAB_LOINC_TABLE[17] },
  { keywords: ['tsh', 'thyroid stimulating hormone', 'thyrotropin'], entry: LAB_LOINC_TABLE[18] },
  { keywords: ['t3', 'triiodothyronine'], entry: LAB_LOINC_TABLE[19] },
  { keywords: ['t4', 'thyroxine'], entry: LAB_LOINC_TABLE[20] },
  { keywords: ['urine routine', 'urinalysis', 'urine analysis', 'urine test', 'urine r/m', 'urine examination'], entry: LAB_LOINC_TABLE[21] },
  { keywords: ['rbc count', 'red blood cell', 'erythrocyte count'], entry: LAB_LOINC_TABLE[22] },
  { keywords: ['wbc', 'white blood cell', 'leukocyte count', 'wbc count', 'tlc'], entry: LAB_LOINC_TABLE[23] },
  { keywords: ['platelet', 'platelet count', 'plt'], entry: LAB_LOINC_TABLE[24] },
  { keywords: ['hematocrit', 'hct', 'pcv', 'packed cell volume'], entry: LAB_LOINC_TABLE[25] },
  { keywords: ['esr', 'sed rate', 'sedimentation rate'], entry: LAB_LOINC_TABLE[26] },
  { keywords: ['crp', 'c reactive protein', 'c-reactive protein'], entry: LAB_LOINC_TABLE[27] },
  { keywords: ['pt', 'prothrombin time'], entry: LAB_LOINC_TABLE[28] },
  { keywords: ['inr'], entry: LAB_LOINC_TABLE[29] },
  { keywords: ['sodium', 'na+', 'serum sodium'], entry: LAB_LOINC_TABLE[30] },
  { keywords: ['potassium', 'k+', 'serum potassium'], entry: LAB_LOINC_TABLE[31] },
  { keywords: ['calcium', 'ca', 'serum calcium'], entry: LAB_LOINC_TABLE[32] },
  { keywords: ['chloride', 'cl'], entry: LAB_LOINC_TABLE[33] },
  { keywords: ['albumin', 'serum albumin'], entry: LAB_LOINC_TABLE[34] },
  { keywords: ['total protein', 'protein'], entry: LAB_LOINC_TABLE[35] },
  { keywords: ['uric acid'], entry: LAB_LOINC_TABLE[36] },
  { keywords: ['aptt', 'activated partial thromboplastin time'], entry: LAB_LOINC_TABLE[37] },
  { keywords: ['mpv', 'mean platelet volume'], entry: LAB_LOINC_TABLE[38] },
  { keywords: ['covid', 'covid-19', 'rtpcr', 'rt-pcr', 'sars-cov-2', 'corona'], entry: LAB_LOINC_TABLE[39] },
];

// ─── Fuzzy Lookup Functions ──────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fuzzyMatch(input: string, keywords: string[]): boolean {
  const norm = normalize(input);
  return keywords.some(kw => {
    const normKw = normalize(kw);
    return norm.includes(normKw) || normKw.includes(norm);
  });
}

export function lookupDiagnosis(text: string): FHIRCodeableConcept {
  const match = ICD10_KEYWORDS.find(k => fuzzyMatch(text, k.keywords));
  if (match) {
    return {
      coding: [{ system: match.entry.system, code: match.entry.code, display: match.entry.display }],
      text,
    };
  }
  return { text };
}

export function lookupLabTest(testName: string): FHIRCodeableConcept {
  const match = LAB_KEYWORDS.find(k => fuzzyMatch(testName, k.keywords));
  if (match) {
    return {
      coding: [{ system: match.entry.system, code: match.entry.code, display: match.entry.display }],
      text: testName,
    };
  }
  return { text: testName };
}

// ─── UUID helpers ────────────────────────────────────────────────────────────

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function urnUUID(uuid: string): string {
  return `urn:uuid:${uuid}`;
}
