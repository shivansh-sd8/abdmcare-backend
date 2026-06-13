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
  // Newly surfaced — these are the FHIR resource types ABDM HIPs commonly
  // attach but the previous parser silently dropped, so the UI only ever saw
  // structured tables and missed the real "document" content.
  procedures: Array<{ code: string; display: string; status: string; date?: string }>;
  immunizations: Array<{ code: string; display: string; status: string; date?: string }>;
  allergies: Array<{ code: string; display: string; criticality?: string; reaction?: string }>;
  // The Composition's `text.div` is the human-readable rendered version of
  // the entire document (FHIR-required Narrative). For OPConsult/discharge
  // this is effectively the "document body" the clinician should read first.
  // We also capture per-section narratives so the UI can show a structured
  // document view instead of a flat table.
  narrative?: string;
  sections?: Array<{ title: string; html: string }>;
  // DocumentReference attachments — typically scanned reports, uploaded
  // prescriptions, lab PDFs. Each carries either an inline base64 blob or
  // an external URL plus its content type (e.g. application/pdf, image/png).
  documents: Array<{
    title: string;
    contentType: string;
    url?: string;
    data?: string;       // base64 — large; UI shows a "view inline" toggle
    size?: number;
    creation?: string;
  }>;
  sourceHIP?: string;
  compositionTitle?: string;
  compositionDate?: string;
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

function extractProcedure(resource: any): ParsedFHIRData['procedures'][0] {
  const { code, display } = extractCoding(resource.code);
  const date = resource.performedDateTime
    || resource.performedPeriod?.start
    || resource.meta?.lastUpdated;
  return {
    code,
    display,
    status: resource.status || 'unknown',
    date,
  };
}

function extractImmunization(resource: any): ParsedFHIRData['immunizations'][0] {
  const { code, display } = extractCoding(resource.vaccineCode);
  return {
    code,
    display,
    status: resource.status || 'unknown',
    date: resource.occurrenceDateTime || resource.recorded || resource.meta?.lastUpdated,
  };
}

function extractAllergy(resource: any): ParsedFHIRData['allergies'][0] {
  const { code, display } = extractCoding(resource.code);
  // FHIR allergy can have multiple reactions; surface the first manifestation
  // as a short summary string. Anything more elaborate goes into the raw
  // bundle which the UI can show on demand.
  const firstReaction = resource.reaction?.[0]?.manifestation?.[0];
  const reactionText = firstReaction
    ? extractCoding(firstReaction).display || firstReaction.text || ''
    : '';
  return {
    code,
    display,
    criticality: resource.criticality,
    reaction: reactionText,
  };
}

function extractDocumentReference(resource: any): ParsedFHIRData['documents'][0] {
  // FHIR DocumentReference always exposes its body via `content[].attachment`.
  // We surface the first attachment (HIPs nearly always send one); UIs that
  // want a multi-page view can fall back to the rawBundle.
  const attachment = resource.content?.[0]?.attachment || {};
  return {
    title: resource.description
      || attachment.title
      || extractCoding(resource.type).display
      || 'Document',
    contentType: attachment.contentType || 'application/octet-stream',
    url: attachment.url,
    data: attachment.data,
    size: typeof attachment.size === 'number' ? attachment.size : undefined,
    creation: attachment.creation || resource.date,
  };
}

// FHIR Narrative.div is XHTML wrapped in <div xmlns="http://www.w3.org/1999/xhtml">.
// We strip the namespace + outer div so the UI can render it as inline HTML
// without attribute clutter or risk of leaking unexpected XML.
function cleanNarrative(narrative: any): string | undefined {
  const div: string | undefined = narrative?.div;
  if (typeof div !== 'string' || !div.length) return undefined;
  return div
    .replace(/<div\s+xmlns=["']http:\/\/www\.w3\.org\/1999\/xhtml["']\s*>/i, '<div>')
    .trim();
}

export function parseFHIRBundle(bundle: any): ParsedFHIRData {
  const result: ParsedFHIRData = {
    patientInfo: { name: 'Unknown', gender: 'unknown' },
    encounters: [],
    conditions: [],
    observations: [],
    medications: [],
    reports: [],
    procedures: [],
    immunizations: [],
    allergies: [],
    documents: [],
  };

  if (!bundle || !Array.isArray(bundle.entry)) return result;

  for (const entry of bundle.entry) {
    const resource = entry.resource || entry;
    if (!resource?.resourceType) continue;

    switch (resource.resourceType) {
      case 'Composition': {
        result.compositionTitle = resource.title;
        result.compositionDate = resource.date;
        if (resource.custodian?.display) {
          result.sourceHIP = resource.custodian.display;
        }
        // Top-level Composition.text is the document narrative — the
        // human-readable version of the WHOLE document.
        const topNarrative = cleanNarrative(resource.text);
        if (topNarrative) result.narrative = topNarrative;
        // Each section has its own narrative (Diagnoses, Medications, etc.).
        // Surface them individually so the UI can render a "structured
        // document" view that matches what the patient sees in their PHR.
        if (Array.isArray(resource.section)) {
          result.sections = resource.section
            .map((s: any) => {
              const html = cleanNarrative(s?.text);
              if (!html) return null;
              return { title: s.title || extractCoding(s.code).display || 'Section', html };
            })
            .filter(Boolean) as Array<{ title: string; html: string }>;
        }
        break;
      }

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
      case 'MedicationStatement':
        result.medications.push(extractMedication(resource));
        break;

      case 'DiagnosticReport':
        result.reports.push(extractDiagnosticReport(resource));
        break;

      case 'Procedure':
        result.procedures.push(extractProcedure(resource));
        break;

      case 'Immunization':
        result.immunizations.push(extractImmunization(resource));
        break;

      case 'AllergyIntolerance':
        result.allergies.push(extractAllergy(resource));
        break;

      case 'DocumentReference':
        result.documents.push(extractDocumentReference(resource));
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
