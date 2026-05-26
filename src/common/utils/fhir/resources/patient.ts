import { FHIRResource, SYSTEM, NRCES_PROFILES, generateUUID } from '../coding-tables';

interface PatientInput {
  id: string;
  firstName: string;
  lastName: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  dob?: Date | null;
  mobile: string;
  email?: string | null;
  address?: any;
  abhaNumber?: string | null;
  abhaAddress?: string | null;
  abhaRecord?: {
    abhaNumber: string;
    abhaAddress?: string | null;
  } | null;
}

function mapGender(g: string): string {
  switch (g) {
    case 'MALE': return 'male';
    case 'FEMALE': return 'female';
    default: return 'other';
  }
}

export function buildPatient(patient: PatientInput): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();
  const identifiers: any[] = [];

  const abhaNum = patient.abhaRecord?.abhaNumber || patient.abhaNumber;
  if (abhaNum) {
    identifiers.push({
      type: {
        coding: [{ system: SYSTEM.FHIR_IDENTIFIER_TYPE, code: 'MR', display: 'Medical record number' }],
      },
      system: 'https://healthid.ndhm.gov.in',
      value: abhaNum,
    });
  }

  const abhaAddr = patient.abhaRecord?.abhaAddress || patient.abhaAddress;
  if (abhaAddr) {
    identifiers.push({
      type: {
        coding: [{ system: SYSTEM.FHIR_IDENTIFIER_TYPE, code: 'MR', display: 'Medical record number' }],
      },
      system: 'https://healthid.ndhm.gov.in',
      value: abhaAddr,
    });
  }

  const addr = patient.address;
  const fhirAddress: any[] = [];
  if (addr) {
    const parsed = typeof addr === 'string' ? {} : addr;
    fhirAddress.push({
      use: 'home',
      type: 'both',
      text: [parsed.line, parsed.district, parsed.state, parsed.pincode].filter(Boolean).join(', '),
      city: parsed.district || undefined,
      state: parsed.state || undefined,
      postalCode: parsed.pincode || undefined,
      country: 'IN',
    });
  }

  const resource: FHIRResource = {
    resourceType: 'Patient',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Patient] },
    ...(identifiers.length > 0 && { identifier: identifiers }),
    name: [{
      use: 'official',
      text: `${patient.firstName} ${patient.lastName}`,
      family: patient.lastName,
      given: [patient.firstName],
    }],
    gender: mapGender(patient.gender),
    ...(patient.dob && { birthDate: patient.dob.toISOString().split('T')[0] }),
    telecom: [
      { system: 'phone', value: patient.mobile, use: 'mobile' },
      ...(patient.email ? [{ system: 'email' as const, value: patient.email, use: 'home' as const }] : []),
    ],
    ...(fhirAddress.length > 0 && { address: fhirAddress }),
  };

  return { uuid, resource };
}
