import {
  FHIRResource, FHIRReference, SYSTEM,
  generateUUID, urnUUID, COMPOSITION_TYPE,
} from '../coding-tables';

export interface CompositionSection {
  title: string;
  code: { coding: ReadonlyArray<{ readonly system: string; readonly code: string; readonly display: string }> };
  entry?: FHIRReference[];
  text?: { status: string; div: string };
}

export interface CompositionTypeCoding {
  system: string;
  code: string;
  display: string;
}

export interface CompositionInput {
  profileUrl: string;
  title: string;
  date: string;
  patientRef: FHIRReference;
  practitionerRef: FHIRReference;
  organizationRef: FHIRReference;
  encounterRef?: FHIRReference;
  sections: CompositionSection[];
  /**
   * Per-profile Composition.type SNOMED coding. Each ABDM record format mandates
   * a specific code (see COMPOSITION_TYPE). When omitted, defaults to the
   * OPConsultRecord coding for backwards compatibility.
   */
  typeCoding?: CompositionTypeCoding;
}

export function buildComposition(input: CompositionInput): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();

  const typeCoding = input.typeCoding || COMPOSITION_TYPE.OPConsultRecord;

  const sections = input.sections.filter(s => (s.entry && s.entry.length > 0) || s.text);

  // ── Auto-generate Composition.text.div ──────────────────────────────────
  // FHIR R4 / NRCeS profiles REQUIRE Composition.text. Without it the
  // patient's PHR app and any HIU has no human-readable rendering of the
  // document — they're stuck showing only the resource codes/displays.
  // We assemble the document narrative by concatenating each section's own
  // narrative (or its title + bullet of entries when no per-section
  // narrative was supplied). This is what shows up as the "document body"
  // when the bundle is rendered.
  const docHeader = `<h2>${escapeHtml(input.title)}</h2>`
    + (input.patientRef.display ? `<p><strong>Patient:</strong> ${escapeHtml(input.patientRef.display)}</p>` : '')
    + (input.practitionerRef.display ? `<p><strong>Provider:</strong> ${escapeHtml(input.practitionerRef.display)}</p>` : '')
    + `<p><strong>Date:</strong> ${escapeHtml(formatDateForNarrative(input.date))}</p>`;
  const sectionsBody = sections
    .map(s => {
      // Use the per-section narrative if present. We deliberately skip ref-
      // only sections without narrative — emitting raw `urn:uuid:...` lines
      // is worse than nothing for a human reader and the receiver will still
      // see the structured entries via the FHIR parser.
      const innerDiv = s.text?.div ? stripOuterDiv(s.text.div) : '';
      if (!innerDiv) return '';
      return `<h3>${escapeHtml(s.title)}</h3>${innerDiv}`;
    })
    .filter(Boolean)
    .join('');
  const compositionDiv = `<div xmlns="http://www.w3.org/1999/xhtml">${docHeader}${sectionsBody}</div>`;

  const resource: FHIRResource = {
    resourceType: 'Composition',
    id: uuid,
    meta: { profile: [input.profileUrl] },
    text: {
      status: 'generated',
      div: compositionDiv,
    },
    status: 'final',
    type: {
      coding: [{
        system: typeCoding.system,
        code: typeCoding.code,
        display: typeCoding.display,
      }],
      text: input.title,
    },
    subject: input.patientRef,
    date: input.date,
    author: [input.practitionerRef],
    attester: [{
      mode: 'professional',
      time: new Date().toISOString(),
      party: input.practitionerRef,
    }],
    title: input.title,
    custodian: input.organizationRef,
    ...(input.encounterRef && { encounter: input.encounterRef }),
    section: sections,
  };

  return { uuid, resource };
}

function formatDateForNarrative(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function stripOuterDiv(html: string): string {
  return html
    .replace(/^<div\s+xmlns=["']http:\/\/www\.w3\.org\/1999\/xhtml["']\s*>/i, '')
    .replace(/<\/div>\s*$/i, '');
}

// Section code constants per NRCeS
export const SECTION_CODES = {
  chiefComplaint: {
    coding: [{ system: SYSTEM.LOINC, code: '10154-3', display: 'Chief complaint' }],
  },
  allergies: {
    coding: [{ system: SYSTEM.LOINC, code: '48765-2', display: 'Allergies and adverse reactions' }],
  },
  medicalHistory: {
    coding: [{ system: SYSTEM.LOINC, code: '11348-0', display: 'History of past illness' }],
  },
  physicalExamination: {
    coding: [{ system: SYSTEM.LOINC, code: '29545-1', display: 'Physical findings' }],
  },
  vitalSigns: {
    coding: [{ system: SYSTEM.LOINC, code: '8716-3', display: 'Vital signs' }],
  },
  diagnosis: {
    coding: [{ system: SYSTEM.LOINC, code: '29308-4', display: 'Diagnosis' }],
  },
  medications: {
    coding: [{ system: SYSTEM.LOINC, code: '10160-0', display: 'History of Medication use' }],
  },
  investigations: {
    coding: [{ system: SYSTEM.LOINC, code: '30954-2', display: 'Relevant diagnostic tests/laboratory data' }],
  },
  procedures: {
    coding: [{ system: SYSTEM.LOINC, code: '29554-3', display: 'Procedure' }],
  },
  followUp: {
    coding: [{ system: SYSTEM.LOINC, code: '18776-5', display: 'Plan of care' }],
  },
  dischargeDiagnosis: {
    coding: [{ system: SYSTEM.LOINC, code: '11535-2', display: 'Hospital discharge Dx' }],
  },
  dischargeMedications: {
    coding: [{ system: SYSTEM.LOINC, code: '10183-2', display: 'Hospital discharge medications' }],
  },
  dischargeInstructions: {
    coding: [{ system: SYSTEM.LOINC, code: '8653-8', display: 'Hospital Discharge instructions' }],
  },
  hospitalCourse: {
    coding: [{ system: SYSTEM.LOINC, code: '8648-8', display: 'Hospital course' }],
  },
  // ── M2 ImmunizationRecord sections ────────────────────────────────────────
  immunization: {
    coding: [{ system: SYSTEM.LOINC, code: '11369-6', display: 'History of Immunization Narrative' }],
  },
  immunizationRecommendation: {
    coding: [{ system: SYSTEM.SNOMED, code: '41000179103', display: 'Immunization record' }],
  },
  // ── M2 WellnessRecord sections ────────────────────────────────────────────
  // Per ABDM Health Record Formats §"Wellness Record" the record has the
  // following sections: Vital Signs, Body Measurements, Physical Activity,
  // General Assessment, Women Health, Lifestyle, Other Observations, and
  // Document Reference.
  bodyMeasurement: {
    coding: [{ system: SYSTEM.LOINC, code: '8716-3', display: 'Vital signs' }], // weight/height/BMI live under Vital Signs panel
  },
  physicalActivity: {
    coding: [{ system: SYSTEM.LOINC, code: '68516-4', display: 'On those days that you exercise, on average how many minutes do you exercise' }],
  },
  generalAssessment: {
    coding: [{ system: SYSTEM.LOINC, code: '10210-3', display: 'Physical findings of General status' }],
  },
  lifestyle: {
    coding: [{ system: SYSTEM.LOINC, code: '29762-2', display: 'Social history' }],
  },
  otherObservations: {
    coding: [{ system: SYSTEM.LOINC, code: '8716-3', display: 'Vital signs' }],
  },
  womenHealth: {
    coding: [{ system: SYSTEM.LOINC, code: '57059-8', display: 'Pregnancy status' }],
  },
  documentReference: {
    coding: [{ system: SYSTEM.LOINC, code: '11488-4', display: 'Consultation note' }],
  },
  // ── M2 InvoiceRecord section ──────────────────────────────────────────────
  // Per ABDM Health Record Formats §"Invoice Record" the bundle has one
  // section ("Invoice") that points to one or more FHIR Invoice resources.
  // No standard LOINC/SNOMED concept exists for an "invoice section"; ABDM's
  // sample bundles use a custom code under `https://projecteka.in/sct`.
  invoice: {
    coding: [{ system: 'https://projecteka.in/sct', code: 'Invoice', display: 'Invoice' }],
  },
} as const;

export function makeTextSection(title: string, code: CompositionSection['code'], text: string): CompositionSection {
  return {
    title,
    code,
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeHtml(text)}</div>`,
    },
  };
}

export function makeRefSection(
  title: string,
  code: CompositionSection['code'],
  entries: Array<{ uuid: string }>,
  narrativeHtml?: string,
): CompositionSection {
  return {
    title,
    code,
    entry: entries.map(e => ({ reference: urnUUID(e.uuid) })),
    // FHIR R4: a section SHOULD have a narrative when it has entries — it's
    // the human-readable summary so the patient and any HIU can render the
    // document without resolving every reference. Profiles pass a small HTML
    // table or list summarising the same data the entries describe.
    ...(narrativeHtml ? {
      text: {
        status: 'generated',
        div: `<div xmlns="http://www.w3.org/1999/xhtml">${narrativeHtml}</div>`,
      },
    } : {}),
  };
}

/**
 * Build a small HTML table for a section's narrative. Used by profiles to
 * give ref-based sections (Diagnoses, Medications, Investigations…) a
 * human-readable rendering. Headers + rows are escaped for safety.
 */
export function buildNarrativeTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return '';
  return `<table border="1" cellpadding="4" cellspacing="0">`
    + `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
    + `</table>`;
}

/** Single bullet list — for sections where a 1-column table would feel heavy. */
export function buildNarrativeList(items: string[]): string {
  const filtered = items.filter(s => !!s && s.trim().length);
  if (!filtered.length) return '';
  return `<ul>${filtered.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

/** Free-text paragraph — escaped, with newlines preserved as <br>. */
export function buildNarrativeText(text: string): string {
  if (!text) return '';
  return `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
