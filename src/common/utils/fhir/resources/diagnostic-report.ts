import { FHIRResource, FHIRReference, NRCES_PROFILES, SYSTEM, generateUUID, urnUUID, lookupLabTest } from '../coding-tables';

interface InvestigationInput {
  id: string;
  testName: string;
  testType: string;
  status: string;
  results?: any;
  notes?: string | null;
  orderedAt: Date;
  reportedAt?: Date | null;
}

export interface DiagnosticReportResult {
  reports: Array<{ uuid: string; resource: FHIRResource }>;
  observations: Array<{ uuid: string; resource: FHIRResource }>;
}

/**
 * Internal shape for one analyte parsed out of `Investigation.results`.
 * Mirrors the lab template field names we let lab techs fill in
 * (`InvestigationQueue.tsx` → `parameters[]`).
 */
interface ParsedAnalyte {
  name: string;
  value: string | number;
  unit?: string;
  /** N | H | L | A (abnormal) — for FHIR `interpretation`. */
  flag?: string;
  /** "12.0 – 17.0" → split into low/high quantities. */
  referenceRange?: string;
  /** e.g. "Complete Blood Count" — used for grouping in narrative + as Observation panel context. */
  subGroup?: string;
}

interface InvestigationMeta {
  /** "Blood - EDTA", "Serum", "Urine", … → FHIR Specimen. */
  sampleType?: string | null;
  sampleCollectedAt?: Date | null;
  labTechnicianName?: string | null;
  validatedBy?: string | null;
  /** Free-text comment from the lab tech. */
  notes?: string | null;
}

function mapDiagnosticStatus(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'final';
    case 'IN_PROGRESS': return 'preliminary';
    case 'CANCELLED': return 'cancelled';
    default: return 'registered';
  }
}

/**
 * Map our `flag` value (single letter from the lab template) to a FHIR
 * `interpretation` coding from the v3-ObservationInterpretation table.
 */
function flagToInterpretation(flag?: string): { coding: any[]; text?: string } | undefined {
  if (!flag) return undefined;
  const normalised = String(flag).trim().toUpperCase();
  const map: Record<string, { code: string; display: string }> = {
    N: { code: 'N', display: 'Normal' },
    H: { code: 'H', display: 'High' },
    L: { code: 'L', display: 'Low' },
    A: { code: 'A', display: 'Abnormal' },
    HH: { code: 'HH', display: 'Critically high' },
    LL: { code: 'LL', display: 'Critically low' },
  };
  const entry = map[normalised];
  if (!entry) return undefined;
  return {
    coding: [{
      system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
      code: entry.code,
      display: entry.display,
    }],
    text: entry.display,
  };
}

/**
 * Split a "12.0 – 17.0" / "12-17" / "<150" / ">7.4" range string into a
 * FHIR ReferenceRange element. Preserves the original text in `.text` so
 * unparseable ranges still render usefully in PHR apps.
 */
function parseReferenceRange(rangeText?: string, unit?: string): any | undefined {
  if (!rangeText) return undefined;
  const text = String(rangeText).trim();
  if (!text) return undefined;
  const result: any = { text };
  // Normalise dash variants (en-dash, em-dash, hyphen, "to") to a single split token.
  const split = text
    .replace(/\u2013|\u2014|—|to/gi, '-')
    .split('-')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const parseNum = (s: string): number | null => {
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isNaN(n) ? null : n;
  };
  if (split.length === 2) {
    const lo = parseNum(split[0]);
    const hi = parseNum(split[1]);
    if (lo != null) result.low = { value: lo, ...(unit && { unit }) };
    if (hi != null) result.high = { value: hi, ...(unit && { unit }) };
  } else if (text.startsWith('<')) {
    const hi = parseNum(text);
    if (hi != null) result.high = { value: hi, ...(unit && { unit }) };
  } else if (text.startsWith('>')) {
    const lo = parseNum(text);
    if (lo != null) result.low = { value: lo, ...(unit && { unit }) };
  }
  return result;
}

/**
 * Parse `Investigation.results` into the analytes array + metadata.
 * Recognised shapes (matched in this priority order):
 *   1. `{ parameters: [{name, value, unit, flag, referenceRange, subGroup}, …], sampleType, sampleCollectedAt, labTechnicianName, validatedBy, notes }`
 *      ← what `InvestigationQueue.tsx` writes today
 *   2. raw array `[{parameter|test|name, value|result, unit|units}, …]` (legacy)
 *   3. flat key/value object — only when keys look like analyte names, NOT report metadata
 *
 * Everything else returns `{ analytes: null, meta: {} }` and the caller
 * falls back to embedding the raw text as a single Observation.
 */
function parseResults(results: any): { analytes: ParsedAnalyte[] | null; meta: InvestigationMeta } {
  const meta: InvestigationMeta = {};
  if (results == null) return { analytes: null, meta };
  let parsed: any;
  try {
    parsed = typeof results === 'string' ? JSON.parse(results) : results;
  } catch {
    return { analytes: null, meta };
  }
  if (!parsed || typeof parsed !== 'object') return { analytes: null, meta };

  // Shape 1 — modern lab-template results envelope.
  if (!Array.isArray(parsed) && Array.isArray(parsed.parameters)) {
    if (typeof parsed.sampleType === 'string' && parsed.sampleType.trim()) meta.sampleType = parsed.sampleType.trim();
    if (parsed.sampleCollectedAt) {
      const d = new Date(parsed.sampleCollectedAt);
      if (!isNaN(d.getTime())) meta.sampleCollectedAt = d;
    }
    if (typeof parsed.labTechnicianName === 'string' && parsed.labTechnicianName.trim()) meta.labTechnicianName = parsed.labTechnicianName.trim();
    if (typeof parsed.validatedBy === 'string' && parsed.validatedBy.trim()) meta.validatedBy = parsed.validatedBy.trim();
    if (typeof parsed.notes === 'string' && parsed.notes.trim()) meta.notes = parsed.notes.trim();
    const analytes: ParsedAnalyte[] = parsed.parameters
      .filter((r: any) => r && (r.name || r.parameter || r.test))
      .map((r: any) => ({
        name: String(r.parameter ?? r.test ?? r.name ?? 'Unknown'),
        value: r.value ?? r.result ?? '',
        unit: r.unit || r.units || undefined,
        flag: r.flag || undefined,
        referenceRange: r.referenceRange || r.range || undefined,
        subGroup: r.subGroup || r.group || undefined,
      }));
    return { analytes, meta };
  }

  // Shape 2 — bare array of analyte rows.
  if (Array.isArray(parsed)) {
    const analytes: ParsedAnalyte[] = parsed
      .filter((r: any) => r && (r.parameter || r.test || r.name))
      .map((r: any) => ({
        name: String(r.parameter ?? r.test ?? r.name ?? 'Unknown'),
        value: r.value ?? r.result ?? '',
        unit: r.unit || r.units || undefined,
        flag: r.flag || undefined,
        referenceRange: r.referenceRange || r.range || undefined,
        subGroup: r.subGroup || r.group || undefined,
      }));
    return { analytes, meta };
  }

  // Shape 3 — DELIBERATELY rejected. The legacy fallback used to flatten
  // `{ parameters: [...], sampleType: …, validatedBy: … }` into pseudo-analytes
  // (one named "parameters" with the whole array stringified, plus one each
  // for sampleType/validatedBy/etc). That produced the giant raw-JSON blob
  // that PHR apps render as the "Investigations" section. We now refuse to
  // shred report metadata into Observations — the only valid analyte source
  // is shape 1 or 2 above.
  return { analytes: null, meta };
}

function buildAnalyteObservation(
  analyte: ParsedAnalyte,
  effectiveDate: string,
  patientRef: FHIRReference,
  encounterRef?: FHIRReference,
): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();
  const numericValue = typeof analyte.value === 'number'
    ? analyte.value
    : parseFloat(String(analyte.value));
  const isNumeric = !isNaN(numericValue) && isFinite(numericValue);
  const interpretation = flagToInterpretation(analyte.flag);
  const refRange = parseReferenceRange(analyte.referenceRange, analyte.unit);

  const resource: FHIRResource = {
    resourceType: 'Observation',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Observation] },
    status: 'final',
    category: [{
      coding: [{
        system: SYSTEM.FHIR_OBSERVATION_CATEGORY,
        code: 'laboratory',
        display: 'Laboratory',
      }],
    }],
    code: {
      text: analyte.subGroup ? `${analyte.name} (${analyte.subGroup})` : analyte.name,
    },
    subject: patientRef,
    ...(encounterRef && { encounter: encounterRef }),
    effectiveDateTime: effectiveDate,
    ...(isNumeric
      ? {
          valueQuantity: {
            value: numericValue,
            ...(analyte.unit && { unit: analyte.unit, system: 'http://unitsofmeasure.org' }),
          },
        }
      : { valueString: String(analyte.value || '—') }),
    ...(interpretation && { interpretation: [interpretation] }),
    ...(refRange && { referenceRange: [refRange] }),
  };

  return { uuid, resource };
}

function buildSpecimenResource(meta: InvestigationMeta, patientRef: FHIRReference): { uuid: string; resource: FHIRResource } | null {
  if (!meta.sampleType) return null;
  const uuid = generateUUID();
  return {
    uuid,
    resource: {
      resourceType: 'Specimen',
      id: uuid,
      meta: { profile: [NRCES_PROFILES.Specimen] },
      status: 'available',
      type: { text: meta.sampleType },
      subject: patientRef,
      ...(meta.sampleCollectedAt && {
        collection: { collectedDateTime: meta.sampleCollectedAt.toISOString() },
      }),
    },
  };
}

/**
 * Compose a clean human-readable conclusion line, e.g.:
 *   "Haemoglobin: 1 g/dL (Low — ref 12.0 – 17.0); Total RBC Count: 2 10⁶/μL (Low — ref 4.5 – 5.5)"
 * The PHR app surfaces this as `DiagnosticReport.conclusion`. Empty/normal
 * runs collapse to a short "All values within normal range" so we don't
 * spam the patient with verbose data they can already see in the analytes.
 */
function buildConclusion(analytes: ParsedAnalyte[], meta: InvestigationMeta): string | undefined {
  if (analytes.length === 0) return undefined;
  const allNormal = analytes.every((a) => !a.flag || String(a.flag).toUpperCase() === 'N');
  if (allNormal && !meta.notes) {
    return `All ${analytes.length} parameter${analytes.length === 1 ? '' : 's'} within reference range.`;
  }
  const parts: string[] = analytes.map((a) => {
    const valueText = a.value !== undefined && a.value !== '' ? `${a.value}${a.unit ? ' ' + a.unit : ''}` : '—';
    const interp = flagToInterpretation(a.flag);
    const flagSuffix = interp && interp.text && interp.text !== 'Normal'
      ? ` (${interp.text}${a.referenceRange ? ` — ref ${a.referenceRange}` : ''})`
      : '';
    return `${a.name}: ${valueText}${flagSuffix}`;
  });
  const head = parts.join('; ');
  return meta.notes ? `${head}. ${meta.notes}` : head;
}

export function buildDiagnosticReports(
  investigations: InvestigationInput[],
  patientRef: FHIRReference,
  practitionerRef: FHIRReference,
  encounterRef?: FHIRReference,
): DiagnosticReportResult {
  const reports: Array<{ uuid: string; resource: FHIRResource }> = [];
  const observations: Array<{ uuid: string; resource: FHIRResource }> = [];

  for (const inv of investigations) {
    const reportUuid = generateUUID();
    const code = lookupLabTest(inv.testName);
    const { analytes, meta } = parseResults(inv.results);
    // Prefer the lab-tech recorded sample-collection time over the order time.
    const effectiveDate = (
      meta.sampleCollectedAt
      || inv.reportedAt
      || inv.orderedAt
    ).toISOString();
    const issuedDate = (inv.reportedAt || inv.orderedAt).toISOString();

    const observationRefs: FHIRReference[] = [];
    let conclusion: string | undefined;

    if (analytes && analytes.length > 0) {
      for (const analyte of analytes) {
        const obs = buildAnalyteObservation(analyte, effectiveDate, patientRef, encounterRef);
        observations.push(obs);
        observationRefs.push({ reference: urnUUID(obs.uuid), display: analyte.name });
      }
      conclusion = buildConclusion(analytes, meta);
    } else if (inv.results) {
      // Couldn't make sense of `results` but it's non-empty — embed the raw
      // string as a single Observation note so the PHR shows SOMETHING rather
      // than dropping the result silently. Avoid stringifying objects (we no
      // longer want raw JSON blobs leaking into the wire).
      const rawString = typeof inv.results === 'string'
        ? inv.results
        : meta.notes || '(see attached report)';
      const obs = buildAnalyteObservation(
        { name: inv.testName, value: rawString },
        effectiveDate,
        patientRef,
        encounterRef,
      );
      observations.push(obs);
      observationRefs.push({ reference: urnUUID(obs.uuid), display: inv.testName });
      conclusion = rawString;
    }

    // Build the optional Specimen and add it to the bundle alongside the
    // analyte Observations. PHR apps that render `DiagnosticReport.specimen`
    // get the sample type without us having to stuff "sampleType" into a
    // pseudo-Observation.
    const specimen = buildSpecimenResource(meta, patientRef);
    if (specimen) {
      // Stowed in the same observations list so the bundle builder picks it
      // up. The list is misnamed for legacy reasons; treat it as "auxiliary
      // resources alongside the report".
      observations.push(specimen);
    }

    // Performer string → contained Practitioner-like reference. We DON'T
    // mint a real Practitioner resource for the lab tech (no NPI/HPR), so
    // keep it as a display-only reference inside `performer[]`.
    const labPerformer = meta.labTechnicianName
      ? [{ display: `Lab technician: ${meta.labTechnicianName}` }]
      : [];

    const resource: FHIRResource = {
      resourceType: 'DiagnosticReport',
      id: reportUuid,
      meta: { profile: [NRCES_PROFILES.DiagnosticReport] },
      status: mapDiagnosticStatus(inv.status),
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
          code: inv.testType === 'RADIOLOGY' ? 'RAD' : 'LAB',
          display: inv.testType === 'RADIOLOGY' ? 'Radiology' : 'Laboratory',
        }],
      }],
      code,
      subject: patientRef,
      ...(encounterRef && { encounter: encounterRef }),
      effectiveDateTime: effectiveDate,
      issued: issuedDate,
      // performer: ordering clinician + (optional) lab tech display reference
      performer: [practitionerRef, ...labPerformer],
      resultsInterpreter: meta.validatedBy
        ? [practitionerRef, { display: `Validated by: ${meta.validatedBy}` }]
        : [practitionerRef],
      ...(specimen && { specimen: [{ reference: urnUUID(specimen.uuid), display: meta.sampleType! }] }),
      ...(observationRefs.length > 0 && { result: observationRefs }),
      ...(conclusion && { conclusion }),
      ...(inv.notes && { presentedForm: [{ contentType: 'text/plain', data: Buffer.from(inv.notes).toString('base64') }] }),
    };

    reports.push({ uuid: reportUuid, resource });
  }

  return { reports, observations };
}
