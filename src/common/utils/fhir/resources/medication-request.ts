import { FHIRResource, FHIRReference, NRCES_PROFILES, generateUUID } from '../coding-tables';

interface MedicationItem {
  medicineName?: string;
  name?: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
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
    dosageInstruction.push({
      text: [med.dosage, med.frequency, med.duration, med.instructions].filter(Boolean).join(' - '),
      ...(med.frequency && {
        timing: { code: { text: med.frequency } },
      }),
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
