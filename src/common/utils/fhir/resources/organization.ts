import { FHIRResource, NRCES_PROFILES, generateUUID } from '../coding-tables';

interface HospitalInput {
  id: string;
  name: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  pincode: string;
  hipId?: string | null;
  registrationNumber?: string | null;
}

export function buildOrganization(hospital: HospitalInput): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();

  const identifiers: any[] = [];
  if (hospital.hipId) {
    identifiers.push({
      system: 'https://facility.ndhm.gov.in',
      value: hospital.hipId,
    });
  }
  if (hospital.registrationNumber) {
    identifiers.push({
      system: 'https://www.mciindia.org/facility',
      value: hospital.registrationNumber,
    });
  }

  const addressText = [hospital.addressLine1, hospital.addressLine2, hospital.city, hospital.state, hospital.pincode]
    .filter(Boolean)
    .join(', ');

  const resource: FHIRResource = {
    resourceType: 'Organization',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Organization] },
    ...(identifiers.length > 0 && { identifier: identifiers }),
    name: hospital.name,
    telecom: [
      { system: 'phone', value: hospital.phone, use: 'work' },
      { system: 'email', value: hospital.email, use: 'work' },
    ],
    address: [{
      use: 'work',
      type: 'physical',
      text: addressText,
      line: [hospital.addressLine1, hospital.addressLine2].filter(Boolean),
      city: hospital.city,
      state: hospital.state,
      postalCode: hospital.pincode,
      country: 'IN',
    }],
  };

  return { uuid, resource };
}
