export interface FhirBundle {
  resourceType: 'Bundle';
  id: string;
  type: 'document' | 'collection';
  timestamp: string;
  entry: FhirBundleEntry[];
}

export interface FhirBundleEntry {
  fullUrl?: string;
  resource: FhirResource;
}

export type FhirResource =
  | FhirComposition
  | FhirPatient
  | FhirPractitioner
  | FhirMedicationRequest
  | FhirDiagnosticReport
  | FhirObservation
  | FhirCondition
  | FhirProcedure;

export interface FhirComposition {
  resourceType: 'Composition';
  id: string;
  status: 'preliminary' | 'final' | 'amended';
  type: {
    coding: Array<{
      system: string;
      code: string;
      display: string;
    }>;
  };
  subject: {
    reference: string;
  };
  date: string;
  author: Array<{
    reference: string;
  }>;
  title: string;
  section?: Array<{
    title: string;
    code?: {
      coding: Array<{
        system: string;
        code: string;
      }>;
    };
    entry?: Array<{
      reference: string;
    }>;
  }>;
}

export interface FhirPatient {
  resourceType: 'Patient';
  id: string;
  identifier: Array<{
    type?: {
      coding: Array<{
        system: string;
        code: string;
      }>;
    };
    system: string;
    value: string;
  }>;
  name: Array<{
    text: string;
    family?: string;
    given?: string[];
  }>;
  gender: 'male' | 'female' | 'other';
  birthDate: string;
  telecom?: Array<{
    system: 'phone' | 'email';
    value: string;
  }>;
}

export interface FhirPractitioner {
  resourceType: 'Practitioner';
  id: string;
  identifier: Array<{
    system: string;
    value: string;
  }>;
  name: Array<{
    text: string;
  }>;
}

export interface FhirMedicationRequest {
  resourceType: 'MedicationRequest';
  id: string;
  status: 'active' | 'completed' | 'cancelled';
  intent: 'order';
  medicationCodeableConcept: {
    coding: Array<{
      system: string;
      code: string;
      display: string;
    }>;
    text: string;
  };
  subject: {
    reference: string;
  };
  authoredOn: string;
  dosageInstruction?: Array<{
    text: string;
    timing?: {
      repeat: {
        frequency: number;
        period: number;
        periodUnit: string;
      };
    };
  }>;
}

export interface FhirDiagnosticReport {
  resourceType: 'DiagnosticReport';
  id: string;
  status: 'registered' | 'partial' | 'preliminary' | 'final';
  code: {
    coding: Array<{
      system: string;
      code: string;
      display: string;
    }>;
  };
  subject: {
    reference: string;
  };
  effectiveDateTime: string;
  result?: Array<{
    reference: string;
  }>;
}

export interface FhirObservation {
  resourceType: 'Observation';
  id: string;
  status: 'registered' | 'preliminary' | 'final';
  code: {
    coding: Array<{
      system: string;
      code: string;
      display: string;
    }>;
  };
  subject: {
    reference: string;
  };
  effectiveDateTime: string;
  valueQuantity?: {
    value: number;
    unit: string;
    system: string;
    code: string;
  };
  valueString?: string;
}

export interface FhirCondition {
  resourceType: 'Condition';
  id: string;
  clinicalStatus: {
    coding: Array<{
      system: string;
      code: string;
    }>;
  };
  code: {
    coding: Array<{
      system: string;
      code: string;
      display: string;
    }>;
    text: string;
  };
  subject: {
    reference: string;
  };
  recordedDate: string;
}

export interface FhirProcedure {
  resourceType: 'Procedure';
  id: string;
  status: 'preparation' | 'in-progress' | 'completed';
  code: {
    coding: Array<{
      system: string;
      code: string;
      display: string;
    }>;
    text: string;
  };
  subject: {
    reference: string;
  };
  performedDateTime: string;
}
