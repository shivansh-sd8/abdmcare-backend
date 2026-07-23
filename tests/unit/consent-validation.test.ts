/**
 * Tests for consent validation logic.
 * These verify the business rules that ABDM consent artefacts must satisfy
 * before health data can be shared.
 */

interface ConsentArtefact {
  status: string;
  expiryDate: string;
  hiTypes: string[];
  dateRange: { from: string; to: string };
}

function validateConsent(
  artefact: ConsentArtefact,
  requestedHiTypes: string[],
  requestedDateRange: { from: string; to: string },
): { valid: boolean; reason?: string } {
  if (artefact.status === 'REVOKED') {
    return { valid: false, reason: 'Consent has been revoked' };
  }

  if (artefact.status === 'EXPIRED' || new Date(artefact.expiryDate) < new Date()) {
    return { valid: false, reason: 'Consent has expired' };
  }

  const unsupportedTypes = requestedHiTypes.filter((t) => !artefact.hiTypes.includes(t));
  if (unsupportedTypes.length > 0) {
    return {
      valid: false,
      reason: `HI types not covered by consent: ${unsupportedTypes.join(', ')}`,
    };
  }

  const consentFrom = new Date(artefact.dateRange.from);
  const consentTo = new Date(artefact.dateRange.to);
  const requestFrom = new Date(requestedDateRange.from);
  const requestTo = new Date(requestedDateRange.to);

  if (requestFrom < consentFrom || requestTo > consentTo) {
    return { valid: false, reason: 'Requested date range exceeds consent date range' };
  }

  return { valid: true };
}

describe('Consent Validation', () => {
  const validArtefact: ConsentArtefact = {
    status: 'GRANTED',
    expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    hiTypes: ['OPConsultation', 'Prescription', 'DiagnosticReport'],
    dateRange: {
      from: '2024-01-01T00:00:00Z',
      to: '2026-12-31T23:59:59Z',
    },
  };

  it('should accept a valid consent with matching parameters', () => {
    const result = validateConsent(
      validArtefact,
      ['OPConsultation', 'Prescription'],
      { from: '2025-01-01T00:00:00Z', to: '2025-12-31T23:59:59Z' },
    );
    expect(result.valid).toBe(true);
  });

  it('should reject expired consents', () => {
    const expired: ConsentArtefact = {
      ...validArtefact,
      status: 'EXPIRED',
      expiryDate: '2023-01-01T00:00:00Z',
    };
    const result = validateConsent(expired, ['OPConsultation'], {
      from: '2025-01-01T00:00:00Z',
      to: '2025-06-01T00:00:00Z',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('should reject consents with a past expiryDate even if status is GRANTED', () => {
    const pastExpiry: ConsentArtefact = {
      ...validArtefact,
      expiryDate: '2020-01-01T00:00:00Z',
    };
    const result = validateConsent(pastExpiry, ['OPConsultation'], {
      from: '2024-01-01T00:00:00Z',
      to: '2024-06-01T00:00:00Z',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('should reject revoked consents', () => {
    const revoked: ConsentArtefact = { ...validArtefact, status: 'REVOKED' };
    const result = validateConsent(revoked, ['OPConsultation'], {
      from: '2025-01-01T00:00:00Z',
      to: '2025-06-01T00:00:00Z',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('revoked');
  });

  it('should reject when requested hiTypes are not in consent', () => {
    const result = validateConsent(
      validArtefact,
      ['OPConsultation', 'ImmunizationRecord'],
      { from: '2025-01-01T00:00:00Z', to: '2025-06-01T00:00:00Z' },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('ImmunizationRecord');
  });

  it('should reject when requested date range exceeds consent from', () => {
    const result = validateConsent(validArtefact, ['OPConsultation'], {
      from: '2023-06-01T00:00:00Z',
      to: '2025-06-01T00:00:00Z',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('date range');
  });

  it('should reject when requested date range exceeds consent to', () => {
    const result = validateConsent(validArtefact, ['OPConsultation'], {
      from: '2025-01-01T00:00:00Z',
      to: '2027-06-01T00:00:00Z',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('date range');
  });

  it('should accept exact boundary date ranges', () => {
    const result = validateConsent(validArtefact, ['OPConsultation'], {
      from: '2024-01-01T00:00:00Z',
      to: '2026-12-31T23:59:59Z',
    });
    expect(result.valid).toBe(true);
  });
});
