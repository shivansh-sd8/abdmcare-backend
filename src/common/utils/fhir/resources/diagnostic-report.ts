import { FHIRResource, FHIRReference, NRCES_PROFILES, generateUUID, lookupLabTest } from '../coding-tables';

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

function mapDiagnosticStatus(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'final';
    case 'IN_PROGRESS': return 'preliminary';
    case 'CANCELLED': return 'cancelled';
    default: return 'registered';
  }
}

export function buildDiagnosticReports(
  investigations: InvestigationInput[],
  patientRef: FHIRReference,
  practitionerRef: FHIRReference,
  encounterRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  return investigations.map(inv => {
    const uuid = generateUUID();
    const code = lookupLabTest(inv.testName);

    let conclusion: string | undefined;
    if (inv.results) {
      try {
        const parsed = typeof inv.results === 'string' ? JSON.parse(inv.results) : inv.results;
        if (typeof parsed === 'string') {
          conclusion = parsed;
        } else if (Array.isArray(parsed)) {
          conclusion = parsed.map((r: any) => `${r.parameter || r.test || ''}: ${r.value || ''} ${r.unit || ''}`.trim()).join('; ');
        } else if (typeof parsed === 'object') {
          conclusion = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join('; ');
        }
      } catch {
        conclusion = String(inv.results);
      }
    }

    const resource: FHIRResource = {
      resourceType: 'DiagnosticReport',
      id: uuid,
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
      effectiveDateTime: (inv.reportedAt || inv.orderedAt).toISOString(),
      issued: (inv.reportedAt || inv.orderedAt).toISOString(),
      resultsInterpreter: [practitionerRef],
      ...(conclusion && { conclusion }),
      ...(inv.notes && { presentedForm: [{ contentType: 'text/plain', data: Buffer.from(inv.notes).toString('base64') }] }),
    };

    return { uuid, resource };
  });
}
