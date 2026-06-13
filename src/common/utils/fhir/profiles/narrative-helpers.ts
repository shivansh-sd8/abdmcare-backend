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

/**
 * Render a single Investigation.results blob as a short summary line.
 * Mirrors the priority order in `parseResults` from `resources/diagnostic-report.ts`:
 *
 *   1. Modern lab-template envelope `{ parameters: [...], sampleType, … }`
 *      → "Haemoglobin: 1 g/dL (Low); RBC Count: 2 10⁶/μL (Low); …"
 *      Followed by a "Sample: Blood - EDTA" / "Validated by: …" suffix when
 *      those fields are populated. Empty fields are dropped (the previous
 *      version emitted "validatedBy: ; sampleCollectedAt: 2026-..." junk).
 *   2. Bare array of analyte rows (legacy)
 *   3. Plain string — used as-is
 *
 * Anything else collapses to the test name + status without a result blob;
 * we deliberately do NOT JSON-stringify objects into the narrative anymore.
 */
function summariseInvestigationResults(rawResults: unknown, fallbackNotes?: string | null): string {
  if (rawResults == null) return fallbackNotes || '';
  let parsed: any;
  try {
    parsed = typeof rawResults === 'string' ? JSON.parse(rawResults) : rawResults;
  } catch {
    return typeof rawResults === 'string' ? rawResults : (fallbackNotes || '');
  }

  const formatAnalyte = (a: any) => {
    const name = a?.name || a?.parameter || a?.test || '';
    if (!name) return '';
    const value = a?.value ?? a?.result;
    const unit = a?.unit || a?.units;
    const flag = typeof a?.flag === 'string' ? a.flag.trim().toUpperCase() : '';
    const flagSuffix = flag === 'H' ? ' (High)' : flag === 'L' ? ' (Low)' : flag === 'A' ? ' (Abnormal)' : '';
    if (value === undefined || value === '' || value === null) {
      return `${name}: —${flagSuffix}`;
    }
    return `${name}: ${value}${unit ? ' ' + unit : ''}${flagSuffix}`;
  };

  // Modern envelope.
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.parameters)) {
    const lines = parsed.parameters.map(formatAnalyte).filter(Boolean);
    const head = lines.join('; ');
    const tail: string[] = [];
    if (typeof parsed.sampleType === 'string' && parsed.sampleType.trim()) tail.push(`Sample: ${parsed.sampleType.trim()}`);
    if (typeof parsed.validatedBy === 'string' && parsed.validatedBy.trim()) tail.push(`Validated by: ${parsed.validatedBy.trim()}`);
    return [head, ...tail].filter(Boolean).join('. ');
  }
  // Bare array.
  if (Array.isArray(parsed)) {
    return parsed.map(formatAnalyte).filter(Boolean).join('; ');
  }
  // Plain string.
  if (typeof parsed === 'string') return parsed;
  // Anything else → fall back to notes; do NOT spill objects to the wire.
  return fallbackNotes || '';
}

export function investigationsNarrative(input: FHIRBundleInput): string {
  if (!input.investigations || !input.investigations.length) return '';
  const rows: string[][] = input.investigations.map((inv) => [
    inv.testName || '—',
    inv.status || '—',
    summariseInvestigationResults(inv.results, inv.notes) || '—',
  ]);
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

/**
 * Render the "Invoice" section narrative — one row per Payment, plus a final
 * "Total" row aggregating amounts. Receipt and transaction columns are kept
 * in their own column so the PHR app can show patients exactly which receipt
 * an invoice corresponds to.
 */
export function invoicesNarrative(input: FHIRBundleInput): string {
  const payments = input.payments || [];
  if (!payments.length) return '';
  let total = 0;
  const rows: string[][] = payments.map((p) => {
    const amount = typeof p.amount === 'string' ? Number(p.amount) : (p.amount ?? 0);
    if (Number.isFinite(amount)) total += Number(amount);
    const date = p.paidAt
      ? new Date(p.paidAt).toLocaleDateString('en-IN')
      : new Date(p.createdAt).toLocaleDateString('en-IN');
    return [
      p.receiptNumber || p.transactionId || p.id.slice(0, 8),
      p.description || (p.admissionId ? 'Inpatient bill' : 'Consultation bill'),
      p.paymentMethod || '—',
      p.status || '—',
      date,
      `₹${Number(amount).toFixed(2)}`,
    ];
  });
  rows.push(['', '', '', '', 'Total', `₹${total.toFixed(2)}`]);
  return buildNarrativeTable(
    ['Receipt', 'Description', 'Method', 'Status', 'Date', 'Amount'],
    rows,
  );
}
