// ─────────────────────────────────────────────────────────────────────────────
// Section narrative builders — shared across profiles.
//
// FHIR R4 / NRCeS profiles require Composition.section.text (the human-
// readable rendering of the section) when entries are present. Without it
// the receiving HIU can only show resource codes/displays — there's no
// "document body" to render. These helpers turn the data we already have on
// FHIRBundleInput into small HTML tables/lists that the HIU then
// dangerouslySetInnerHTML's into the patient profile.
// ─────────────────────────────────────────────────────────────────────────────

import type { FHIRBundleInput } from '../fhir-builder';
import { buildNarrativeTable, buildNarrativeList } from '../resources/composition';

export function vitalsNarrative(vitals: FHIRBundleInput['vitals']): string {
  if (!vitals || !vitals.length) return '';
  const rows: string[][] = [];
  for (const v of vitals) {
    if (v.bloodPressureSystolic && v.bloodPressureDiastolic) {
      rows.push(['Blood Pressure', `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`, 'mmHg']);
    }
    if (v.heartRate) rows.push(['Heart Rate', String(v.heartRate), 'bpm']);
    if (v.respiratoryRate) rows.push(['Respiratory Rate', String(v.respiratoryRate), '/min']);
    if (v.temperature) rows.push(['Temperature', String(v.temperature), '°F']);
    if (v.oxygenSaturation) rows.push(['SpO₂', String(v.oxygenSaturation), '%']);
    if (v.weight) rows.push(['Weight', String(v.weight), 'kg']);
    if (v.height) rows.push(['Height', String(v.height), 'cm']);
    if (v.bmi) rows.push(['BMI', String(v.bmi), 'kg/m²']);
  }
  return rows.length ? buildNarrativeTable(['Vital', 'Value', 'Unit'], rows) : '';
}

export function diagnosisNarrative(encounter: FHIRBundleInput['encounter']): string {
  const text = encounter.finalDiagnosis || encounter.diagnosis || encounter.provisionalDiagnosis || '';
  if (!text.trim()) return '';
  return buildNarrativeList(text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean));
}

export function allergiesNarrative(encounter: FHIRBundleInput['encounter']): string {
  // We always emit at least one AllergyIntolerance resource (a sentinel "no
  // known allergies" entry when the field is blank) so the section ALWAYS
  // has an entry. The narrative must mirror that or the receiver sees a
  // section with refs but no readable text.
  if (!encounter.allergies?.trim()) return '<p>No known allergies.</p>';
  return buildNarrativeList(encounter.allergies.split(/[,;\n]/).map(s => s.trim()).filter(Boolean));
}

export function medicationsNarrative(input: FHIRBundleInput): string {
  const rows: string[][] = (input.encounterPrescriptions || []).map(m => [
    m.medicineName || '—',
    m.dosage || '—',
    m.frequency || '—',
    m.duration || '—',
    m.instructions || '—',
  ]);
  if (!rows.length && input.prescriptions) {
    for (const p of input.prescriptions) {
      const meds = Array.isArray(p.medications) ? p.medications : [];
      for (const m of meds) {
        rows.push([
          m.name || m.medicineName || '—',
          m.dosage || '—',
          m.frequency || '—',
          m.duration || '—',
          m.instructions || '—',
        ]);
      }
    }
  }
  return rows.length ? buildNarrativeTable(['Medicine', 'Dosage', 'Frequency', 'Duration', 'Instructions'], rows) : '';
}

export function investigationsNarrative(input: FHIRBundleInput): string {
  if (!input.investigations || !input.investigations.length) return '';
  const rows: string[][] = input.investigations.map(inv => {
    let resultStr = inv.notes || '';
    if (inv.results) {
      try {
        const r = typeof inv.results === 'string' ? JSON.parse(inv.results) : inv.results;
        if (Array.isArray(r)) {
          resultStr = r
            .map((x: any) => `${x.parameter || x.test || x.name}: ${x.value}${x.unit ? ' ' + x.unit : ''}`)
            .join('; ');
        } else if (typeof r === 'object' && r !== null) {
          resultStr = Object.entries(r)
            .map(([k, v]: [string, any]) => {
              if (v && typeof v === 'object' && v.value !== undefined) {
                return `${k}: ${v.value}${v.unit ? ' ' + v.unit : ''}`;
              }
              return `${k}: ${v}`;
            })
            .join('; ');
        } else {
          resultStr = String(r);
        }
      } catch {
        // keep notes
      }
    }
    return [inv.testName || '—', inv.status || '—', resultStr || '—'];
  });
  return rows.length ? buildNarrativeTable(['Test', 'Status', 'Result'], rows) : '';
}

export function immunizationsNarrative(input: FHIRBundleInput): string {
  if (!input.immunizations || !input.immunizations.length) return '';
  const rows: string[][] = input.immunizations.map(im => [
    (im as any).vaccineName || (im as any).vaccine || '—',
    (im as any).doseNumber ? `Dose ${(im as any).doseNumber}` : '—',
    (im as any).administeredDate ? new Date((im as any).administeredDate).toLocaleDateString('en-IN') : '—',
    (im as any).lotNumber || '—',
  ]);
  return rows.length ? buildNarrativeTable(['Vaccine', 'Dose', 'Date', 'Lot No.'], rows) : '';
}
