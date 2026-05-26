import {
  FHIRResource, FHIRReference, SYSTEM,
  generateUUID, urnUUID,
} from '../coding-tables';

export interface CompositionSection {
  title: string;
  code: { coding: ReadonlyArray<{ readonly system: string; readonly code: string; readonly display: string }> };
  entry?: FHIRReference[];
  text?: { status: string; div: string };
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
}

export function buildComposition(input: CompositionInput): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();

  const resource: FHIRResource = {
    resourceType: 'Composition',
    id: uuid,
    meta: { profile: [input.profileUrl] },
    status: 'final',
    type: {
      coding: [{
        system: SYSTEM.SNOMED,
        code: '371530004',
        display: 'Clinical consultation report',
      }],
      text: input.title,
    },
    subject: input.patientRef,
    date: input.date,
    author: [input.practitionerRef],
    title: input.title,
    custodian: input.organizationRef,
    ...(input.encounterRef && { encounter: input.encounterRef }),
    section: input.sections.filter(s => (s.entry && s.entry.length > 0) || s.text),
  };

  return { uuid, resource };
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
): CompositionSection {
  return {
    title,
    code,
    entry: entries.map(e => ({ reference: urnUUID(e.uuid) })),
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
