import { FHIRResource, FHIRReference, NRCES_PROFILES, generateUUID } from '../coding-tables';

interface MedicationItem {
  medicineName?: string;
  name?: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
  quantity?: number | string;
}

interface PrescriptionInput {
  id: string;
  medications?: any;
  diagnosis?: string | null;
  issuedAt: Date;
}

interface EncounterPrescriptionInput {
  id: string;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions?: string | null;
}

function parseMedications(prescription: PrescriptionInput): MedicationItem[] {
  if (!prescription.medications) return [];
  if (Array.isArray(prescription.medications)) return prescription.medications;
  try {
    const parsed = typeof prescription.medications === 'string'
      ? JSON.parse(prescription.medications)
      : prescription.medications;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface FHIRTiming {
  repeat?: {
    frequency: number;
    period: number;
    periodUnit: string;
    when?: string[];
  };
  code?: { coding: Array<{ system: string; code: string; display: string }>; text: string };
}

const FREQUENCY_MAP: Record<string, { timing: FHIRTiming; display: string }> = {
  OD: {
    timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' }, code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'QD', display: 'Every day' }], text: 'Once daily' } },
    display: 'Once daily',
  },
  BD: {
    timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' }, code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'BID', display: 'Twice a day' }], text: 'Twice daily' } },
    display: 'Twice daily',
  },
  TDS: {
    timing: { repeat: { frequency: 3, period: 1, periodUnit: 'd' }, code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'TID', display: 'Three times a day' }], text: 'Three times daily' } },
    display: 'Three times daily',
  },
  QID: {
    timing: { repeat: { frequency: 4, period: 1, periodUnit: 'd' }, code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'QID', display: 'Four times a day' }], text: 'Four times daily' } },
    display: 'Four times daily',
  },
  HS: {
    timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['HS'] }, code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'HS', display: 'At bedtime' }], text: 'At bedtime' } },
    display: 'At bedtime',
  },
  SOS: {
    timing: { code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'PRN', display: 'As needed' }], text: 'As needed (SOS)' } },
    display: 'As needed (SOS)',
  },
};

function parseFrequencyTiming(frequency: string): { timing: any } | null {
  const key = frequency.trim().toUpperCase();
  const mapped = FREQUENCY_MAP[key];
  if (mapped) return { timing: mapped.timing };
  return null;
}

function buildSingleMedicationRequest(
  med: MedicationItem,
  authoredOn: Date,
  patientRef: FHIRReference,
  practitionerRef: FHIRReference,
  encounterRef?: FHIRReference,
): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();
  const medName = med.medicineName || med.name || 'Unknown medication';

  const dosageInstruction: any[] = [];
  if (med.dosage || med.frequency || med.duration) {
    const structuredTiming = med.frequency ? parseFrequencyTiming(med.frequency) : null;

    dosageInstruction.push({
      text: [med.dosage, med.frequency, med.duration, med.instructions].filter(Boolean).join(' - '),
      ...(structuredTiming
        ? structuredTiming
        : med.frequency ? { timing: { code: { text: med.frequency } } } : {}
      ),
      ...(med.dosage && {
        doseAndRate: [{ doseQuantity: { value: 1, unit: med.dosage } }],
      }),
    });
  }

  const resource: FHIRResource = {
    resourceType: 'MedicationRequest',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.MedicationRequest] },
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: {
      text: medName,
    },
    subject: patientRef,
    ...(encounterRef && { encounter: encounterRef }),
    authoredOn: authoredOn.toISOString(),
    requester: practitionerRef,
    ...(dosageInstruction.length > 0 && { dosageInstruction }),
    ...(med.instructions && { note: [{ text: med.instructions }] }),
    ...(med.quantity && {
      dispenseRequest: {
        quantity: { value: Number(med.quantity), unit: 'unit' },
      },
    }),
    substitution: { allowedBoolean: true },
  };

  return { uuid, resource };
}

export function buildMedicationRequests(
  prescriptions: PrescriptionInput[],
  encounterPrescriptions: EncounterPrescriptionInput[],
  authoredOn: Date,
  patientRef: FHIRReference,
  practitionerRef: FHIRReference,
  encounterRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  const results: Array<{ uuid: string; resource: FHIRResource }> = [];

  for (const rx of prescriptions) {
    const meds = parseMedications(rx);
    for (const med of meds) {
      results.push(buildSingleMedicationRequest(med, rx.issuedAt, patientRef, practitionerRef, encounterRef));
    }
  }

  for (const ep of encounterPrescriptions) {
    const med: MedicationItem = {
      medicineName: ep.medicineName,
      dosage: ep.dosage,
      frequency: ep.frequency,
      duration: ep.duration,
      instructions: ep.instructions || undefined,
    };
    results.push(buildSingleMedicationRequest(med, authoredOn, patientRef, practitionerRef, encounterRef));
  }

  return results;
}
