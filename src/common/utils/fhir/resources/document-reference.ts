import {
  BundleEntry, FHIRReference, FHIRResource, NRCES_PROFILES, SYSTEM,
  generateUUID, urnUUID,
} from '../coding-tables';

// ─────────────────────────────────────────────────────────────────────────────
// FHIR DocumentReference (M2 — unstructured data / HealthDocumentRecord).
//
// This is the resource that carries a HIP's *unstructured* artefacts — scanned
// lab reports, uploaded prescriptions, discharge PDFs, gate passes, receipts —
// into the ABDM data-push bundle. Each attachment is inlined as base64 in
// `content[].attachment.data` so the HIU/PHR app can render or download it
// without a second network hop.
//
// NRCeS profile: https://nrces.in/ndhm/fhir/r4/StructureDefinition/DocumentReference
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentInput {
  id: string;
  /** Human-readable title (falls back to the internal DocumentType label). */
  title?: string | null;
  /** Internal DocumentType enum value (LAB_REPORT, PRESCRIPTION, …). */
  docType?: string | null;
  /** MIME type of the attachment, e.g. application/pdf, image/png. */
  contentType: string;
  /** Base64-encoded file bytes. */
  data: string;
  /** Byte size of the decoded file, if known. */
  size?: number | null;
  /** Original creation/upload time. */
  creation?: Date | string | null;
}

// Map the internal DocumentType enum to a DocumentReference.type LOINC coding.
// Unknown/OTHER types fall back to the generic "Record artifact" concept so the
// resource still validates against the NRCeS value set.
const DOC_TYPE_CODING: Record<string, { system: string; code: string; display: string }> = {
  LAB_REPORT:        { system: SYSTEM.LOINC, code: '11502-2', display: 'Laboratory report' },
  PRESCRIPTION:      { system: SYSTEM.LOINC, code: '57833-6', display: 'Prescription for medication' },
  ADMISSION_SUMMARY: { system: SYSTEM.LOINC, code: '18842-5', display: 'Discharge summary' },
  IPD_BILL:          { system: SYSTEM.LOINC, code: '48768-6', display: 'Payment sources Document' },
  RECEIPT:           { system: SYSTEM.LOINC, code: '48768-6', display: 'Payment sources Document' },
  GATE_PASS:         { system: SYSTEM.SNOMED, code: '419891008', display: 'Record artifact' },
  FULL_EHR:          { system: SYSTEM.LOINC, code: '34133-9', display: 'Summary of episode note' },
  OTHER:             { system: SYSTEM.SNOMED, code: '419891008', display: 'Record artifact' },
};

function typeCoding(docType?: string | null) {
  const key = (docType || 'OTHER').toUpperCase();
  return DOC_TYPE_CODING[key] || DOC_TYPE_CODING.OTHER;
}

function toIso(value?: Date | string | null): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Build one FHIR DocumentReference per uploaded document. Returns the same
 * `{ uuid, resource }` shape the other resource builders use so the caller can
 * assemble bundle entries + Composition section references consistently.
 */
export function buildDocumentReferences(
  documents: DocumentInput[],
  patientRef: FHIRReference,
  authorRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  if (!documents?.length) return [];

  return documents
    .filter((doc) => !!doc.data)
    .map((doc) => {
      const uuid = generateUUID();
      const coding = typeCoding(doc.docType);
      const title = doc.title || coding.display || 'Health Document';

      const resource: FHIRResource = {
        resourceType: 'DocumentReference',
        id: uuid,
        meta: { profile: [NRCES_PROFILES.DocumentReference] },
        status: 'current',
        docStatus: 'final',
        type: { coding: [coding], text: title },
        subject: patientRef,
        date: toIso(doc.creation),
        ...(authorRef ? { author: [authorRef] } : {}),
        content: [
          {
            attachment: {
              contentType: doc.contentType || 'application/octet-stream',
              language: 'en-IN',
              data: doc.data,
              title,
              creation: toIso(doc.creation),
              ...(typeof doc.size === 'number' ? { size: doc.size } : {}),
            },
          },
        ],
      };

      return { uuid, resource };
    });
}

/** Convenience: wrap built DocumentReference resources as bundle entries. */
export function documentEntriesFrom(
  built: Array<{ uuid: string; resource: FHIRResource }>,
): BundleEntry[] {
  return built.map((d) => ({ fullUrl: urnUUID(d.uuid), resource: d.resource }));
}
