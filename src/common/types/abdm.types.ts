export interface AbhaCreationRequest {
  aadhaar?: string;
  mobile?: string;
  otp?: string;
  txnId?: string;
}

export interface AbhaCreationResponse {
  abhaNumber: string;
  abhaAddress?: string;
  name: string;
  gender: string;
  dob: string;
  mobile: string;
  email?: string;
  token: string;
}

export interface AbhaProfileResponse {
  abhaNumber: string;
  abhaAddress: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  name: string;
  gender: string;
  dob: string;
  mobile: string;
  email?: string;
  address: {
    line: string;
    district: string;
    state: string;
    pincode: string;
  };
  kycVerified: boolean;
}

export interface CareContextData {
  patientReference: string;
  careContextReference: string;
  display: string;
}

export interface ConsentRequest {
  purpose: {
    text: string;
    code: string;
  };
  patient: {
    id: string;
  };
  hiu: {
    id: string;
  };
  requester: {
    name: string;
    identifier: {
      type: string;
      value: string;
      system: string;
    };
  };
  hiTypes: string[];
  permission: {
    accessMode: string;
    dateRange: {
      from: string;
      to: string;
    };
    dataEraseAt: string;
    frequency: {
      unit: string;
      value: number;
      repeats: number;
    };
  };
}

export interface ConsentArtifact {
  consentId: string;
  status: string;
  purpose: {
    text: string;
    code: string;
  };
  patient: {
    id: string;
  };
  hip: {
    id: string;
  };
  hiTypes: string[];
  permission: {
    accessMode: string;
    dateRange: {
      from: string;
      to: string;
    };
  };
  careContexts: Array<{
    patientReference: string;
    careContextReference: string;
  }>;
}

export interface HealthInformationRequest {
  consentId: string;
  dateRange: {
    from: string;
    to: string;
  };
  dataPushUrl: string;
  keyMaterial: {
    cryptoAlg: string;
    curve: string;
    dhPublicKey: {
      expiry: string;
      parameters: string;
      keyValue: string;
    };
    nonce: string;
  };
}

export interface DiscoverRequest {
  patient: {
    id: string;
    verifiedIdentifiers?: Array<{
      type: string;
      value: string;
    }>;
    unverifiedIdentifiers?: Array<{
      type: string;
      value: string;
    }>;
  };
}

export interface LinkRequest {
  patient: {
    referenceNumber: string;
    display: string;
    careContexts: Array<{
      referenceNumber: string;
      display: string;
    }>;
  };
}
