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

interface ParsedAnalyte {
  name: string;
  value: string | number;
  unit?: string;
}

function mapDiagnosticStatus(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'final';
    case 'IN_PROGRESS': return 'preliminary';
    case 'CANCELLED': return 'cancelled';
    default: return 'registered';
  }
}

function parseResultsToAnalytes(results: any): ParsedAnalyte[] | null {
  try {
    const parsed = typeof results === 'string' ? JSON.parse(results) : results;

    if (Array.isArray(parsed)) {
      return parsed
        .filter((r: any) => r && (r.parameter || r.test || r.name))
        .map((r: any) => ({
          name: r.parameter || r.test || r.name || 'Unknown',
          value: r.value ?? r.result ?? '',
          unit: r.unit || r.units || undefined,
        }));
    }

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      if (entries.length > 1 || (entries.length === 1 && typeof entries[0][1] !== 'string')) {
        return entries.map(([key, val]) => {
          if (typeof val === 'object' && val !== null) {
            const obj = val as Record<string, any>;
            return {
              name: key,
              value: obj.value ?? obj.result ?? JSON.stringify(val),
              unit: obj.unit || obj.units || undefined,
            };
          }
          return { name: key, value: String(val) };
        });
      }
    }

    return null;
  } catch {
    return null;
  }
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
      text: analyte.name,
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
      : { valueString: String(analyte.value) }),
  };

  return { uuid, resource };
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
    const effectiveDate = (inv.reportedAt || inv.orderedAt).toISOString();

    const observationRefs: FHIRReference[] = [];
    let conclusion: string | undefined;

    if (inv.results) {
      const analytes = parseResultsToAnalytes(inv.results);

      if (analytes && analytes.length > 0) {
        for (const analyte of analytes) {
          const obs = buildAnalyteObservation(analyte, effectiveDate, patientRef, encounterRef);
          observations.push(obs);
          observationRefs.push({ reference: urnUUID(obs.uuid), display: analyte.name });
        }
        conclusion = analytes
          .map(a => `${a.name}: ${a.value}${a.unit ? ' ' + a.unit : ''}`)
          .join('; ');
      } else {
        const rawString = typeof inv.results === 'string' ? inv.results : JSON.stringify(inv.results);
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
    }

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
      issued: effectiveDate,
      resultsInterpreter: [practitionerRef],
      ...(observationRefs.length > 0 && { result: observationRefs }),
      ...(conclusion && { conclusion }),
      ...(inv.notes && { presentedForm: [{ contentType: 'text/plain', data: Buffer.from(inv.notes).toString('base64') }] }),
    };

    reports.push({ uuid: reportUuid, resource });
  }

  return { reports, observations };
}
