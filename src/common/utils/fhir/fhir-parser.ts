// ─────────────────────────────────────────────────────────────────────────────
// FHIR Bundle Parser — Extracts structured data from incoming FHIR documents
// Used by HIU to parse health records received from HIPs via ABDM
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedFHIRData {
  patientInfo: { name: string; gender: string; dob?: string };
  encounters: Array<{ date: string; type: string; status: string }>;
  conditions: Array<{ code: string; display: string; clinicalStatus: string }>;
  observations: Array<{ code: string; display: string; value: string; unit: string; date: string }>;
  medications: Array<{ name: string; dosage: string; frequency: string; status: string }>;
  reports: Array<{ code: string; display: string; status: string; conclusion?: string }>;
  sourceHIP?: string;
  compositionTitle?: string;
}

function extractCoding(codeableConcept: any): { code: string; display: string } {
  if (!codeableConcept) return { code: '', display: '' };
  const coding = codeableConcept.coding?.[0] || {};
  return {
    code: coding.code || codeableConcept.code || '',
    display: coding.display || codeableConcept.text || '',
  };
}

function extractPatient(resource: any): ParsedFHIRData['patientInfo'] {
  const nameObj = resource.name?.[0] || {};
  const parts = [nameObj.prefix, nameObj.given, nameObj.family, nameObj.suffix]
    .flat()
    .filter(Boolean);
  return {
    name: nameObj.text || parts.join(' ') || 'Unknown',
    gender: resource.gender || 'unknown',
    dob: resource.birthDate,
  };
}

function extractEncounter(resource: any): ParsedFHIRData['encounters'][0] {
  const { display } = extractCoding(resource.type?.[0]);
  return {
    date: resource.period?.start || resource.meta?.lastUpdated || '',
    type: display || resource.class?.display || resource.class?.code || 'Unknown',
    status: resource.status || 'unknown',
  };
}

function extractCondition(resource: any): ParsedFHIRData['conditions'][0] {
  const { code, display } = extractCoding(resource.code);
  const clinicalStatus = resource.clinicalStatus?.coding?.[0]?.code
    || resource.clinicalStatus?.text
    || 'unknown';
  return { code, display, clinicalStatus };
}

function extractObservation(resource: any): ParsedFHIRData['observations'][0] {
  const { code, display } = extractCoding(resource.code);
  let value = '';
  let unit = '';

  if (resource.valueQuantity) {
    value = String(resource.valueQuantity.value ?? '');
    unit = resource.valueQuantity.unit || resource.valueQuantity.code || '';
  } else if (resource.valueString) {
    value = resource.valueString;
  } else if (resource.valueCodeableConcept) {
    const v = extractCoding(resource.valueCodeableConcept);
    value = v.display || v.code;
  } else if (resource.component) {
    value = resource.component
      .map((c: any) => {
        const cd = extractCoding(c.code);
        const v = c.valueQuantity ? `${c.valueQuantity.value} ${c.valueQuantity.unit || ''}` : '';
        return `${cd.display}: ${v}`;
      })
      .join('; ');
  }

  return {
    code,
    display,
    value,
    unit,
    date: resource.effectiveDateTime || resource.issued || resource.meta?.lastUpdated || '',
  };
}

function extractMedication(resource: any): ParsedFHIRData['medications'][0] {
  const med = extractCoding(resource.medicationCodeableConcept);
  const dosageInst = resource.dosageInstruction?.[0] || {};
  const timing = dosageInst.timing?.code?.text
    || dosageInst.timing?.repeat?.frequency
    || dosageInst.text
    || '';
  const dose = dosageInst.doseAndRate?.[0]?.doseQuantity
    ? `${dosageInst.doseAndRate[0].doseQuantity.value} ${dosageInst.doseAndRate[0].doseQuantity.unit || ''}`
    : dosageInst.text || '';

  return {
    name: med.display || med.code || 'Unknown',
    dosage: dose,
    frequency: String(timing),
    status: resource.status || 'unknown',
  };
}

function extractDiagnosticReport(resource: any): ParsedFHIRData['reports'][0] {
  const { code, display } = extractCoding(resource.code);
  return {
    code,
    display,
    status: resource.status || 'unknown',
    conclusion: resource.conclusion,
  };
}

export function parseFHIRBundle(bundle: any): ParsedFHIRData {
  const result: ParsedFHIRData = {
    patientInfo: { name: 'Unknown', gender: 'unknown' },
    encounters: [],
    conditions: [],
    observations: [],
    medications: [],
    reports: [],
  };

  if (!bundle || !Array.isArray(bundle.entry)) return result;

  for (const entry of bundle.entry) {
    const resource = entry.resource || entry;
    if (!resource?.resourceType) continue;

    switch (resource.resourceType) {
      case 'Composition':
        result.compositionTitle = resource.title;
        if (resource.custodian?.display) {
          result.sourceHIP = resource.custodian.display;
        }
        break;

      case 'Patient':
        result.patientInfo = extractPatient(resource);
        break;

      case 'Encounter':
        result.encounters.push(extractEncounter(resource));
        break;

      case 'Condition':
        result.conditions.push(extractCondition(resource));
        break;

      case 'Observation':
        result.observations.push(extractObservation(resource));
        break;

      case 'MedicationRequest':
        result.medications.push(extractMedication(resource));
        break;

      case 'DiagnosticReport':
        result.reports.push(extractDiagnosticReport(resource));
        break;

      case 'Organization':
        if (!result.sourceHIP && resource.name) {
          result.sourceHIP = resource.name;
        }
        break;
    }
  }

  return result;
}
