import { FHIRResource, SYSTEM, NRCES_PROFILES, generateUUID } from '../coding-tables';

interface DoctorInput {
  id: string;
  firstName: string;
  lastName: string;
  specialization: string;
  qualification: string;
  registrationNo: string;
  hprId?: string | null;
  mobile: string;
  email: string;
}

export function buildPractitioner(doctor: DoctorInput): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();
  const identifiers: any[] = [];

  if (doctor.hprId) {
    identifiers.push({
      type: { coding: [{ system: SYSTEM.FHIR_IDENTIFIER_TYPE, code: 'MD', display: 'Medical License number' }] },
      system: 'https://doctor.ndhm.gov.in',
      value: doctor.hprId,
    });
  }

  identifiers.push({
    type: { coding: [{ system: SYSTEM.FHIR_IDENTIFIER_TYPE, code: 'MD', display: 'Medical License number' }] },
    system: 'https://www.mciindia.org',
    value: doctor.registrationNo,
  });

  const resource: FHIRResource = {
    resourceType: 'Practitioner',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Practitioner] },
    identifier: identifiers,
    name: [{
      use: 'official',
      text: `Dr. ${doctor.firstName} ${doctor.lastName}`,
      prefix: ['Dr.'],
      family: doctor.lastName,
      given: [doctor.firstName],
    }],
    telecom: [
      { system: 'phone', value: doctor.mobile, use: 'work' },
      { system: 'email', value: doctor.email, use: 'work' },
    ],
    qualification: [{
      code: {
        text: doctor.qualification,
      },
    }],
  };

  return { uuid, resource };
}
