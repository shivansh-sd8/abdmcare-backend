import { ProfileName } from '../../common/utils/fhir/fhir-builder';
import logger from '../../common/config/logger';

// ─────────────────────────────────────────────────────────────────────────────
// HIP discovery + hiType helpers (M2 Discovery and Linking)
//
// ABDM's User-Initiated Linking discovery flow (per "discoveryandlinking" doc)
// expects the HIP to:
//   1. Match candidates by every verified identifier the CM sends (Mobile +
//      ABHA number / address, possibly DL + chronic illness etc).
//   2. Confirm uniqueness using a cascade of unverified attributes — Name
//      (with phonetic relaxation), Gender, Year of Birth (±2 years tolerance).
//   3. Return care contexts only when the cascade unambiguously resolves to
//      ONE patient. If multiple match, return "no match".
//   4. Emit a `matchedBy` array enumerating the criteria that contributed.
//
// Per-careContext `hiType` is derived from the encounter contents — encounter
// type alone is not enough (e.g. an OPD encounter that captured only an
// immunization should be reported as hiType=ImmunizationRecord).
// ─────────────────────────────────────────────────────────────────────────────

export type AbdmHiType =
  | 'OPConsultation'
  | 'DischargeSummary'
  | 'Prescription'
  | 'DiagnosticReport'
  | 'ImmunizationRecord'
  | 'WellnessRecord'
  | 'HealthDocumentRecord';

interface DiscoverIdentifier {
  type: string;
  value: string;
}

interface DiscoverPatientHints {
  name?: string;
  gender?: 'M' | 'F' | 'O';
  yearOfBirth?: number;
  verifiedIdentifiers?: DiscoverIdentifier[];
  unverifiedIdentifiers?: DiscoverIdentifier[];
}

interface CandidatePatient {
  id: string;
  firstName: string;
  lastName: string;
  mobile: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  dob: Date | null;
  abhaNumber?: string | null;
  abhaAddress?: string | null;
  abhaRecord?: { abhaNumber: string; abhaAddress?: string | null } | null;
}

export interface MatchResult {
  patient: CandidatePatient | null;
  matchedBy: string[];
  ambiguous: boolean;
}

const SOUNDEX_REPL: Record<string, string> = {
  b: '1', f: '1', p: '1', v: '1',
  c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3',
  l: '4',
  m: '5', n: '5',
  r: '6',
};

/** Soundex (lossy English-language phonetic key). */
export function soundex(text: string): string {
  if (!text) return '0000';
  const lower = text.toLowerCase().replace(/[^a-z]/g, '');
  if (!lower) return '0000';
  const first = lower[0];
  let key = '';
  let prev = SOUNDEX_REPL[first] || '0';
  for (let i = 1; i < lower.length && key.length < 3; i++) {
    const code = SOUNDEX_REPL[lower[i]] || '0';
    if (code !== '0' && code !== prev) key += code;
    if (code !== '0') prev = code;
    else prev = '0';
  }
  return (first.toUpperCase() + (key + '000').slice(0, 3));
}

/** Levenshtein distance. */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function namesMatchPhonetic(a: string, b: string): boolean {
  if (!a || !b) return false;
  const an = a.toLowerCase().trim();
  const bn = b.toLowerCase().trim();
  if (an === bn) return true;
  if (soundex(an) === soundex(bn)) return true;
  // Allow 1-character typo per 5 characters of name.
  const maxDist = Math.max(1, Math.floor(Math.max(an.length, bn.length) / 5));
  return levenshtein(an, bn) <= maxDist;
}

function genderMatches(patient: CandidatePatient, hint?: 'M' | 'F' | 'O'): boolean {
  if (!hint) return true;
  const map: Record<string, 'M' | 'F' | 'O'> = { MALE: 'M', FEMALE: 'F', OTHER: 'O' };
  return map[patient.gender] === hint;
}

function yobMatches(patient: CandidatePatient, hint?: number): boolean {
  if (!hint) return true;
  if (!patient.dob) return false;
  const yob = patient.dob.getFullYear();
  return Math.abs(yob - hint) <= 2;
}

/**
 * Run the M2 discovery cascade on a candidate set returned by the verified-
 * identifier query. Returns the unambiguous winner (or null with `ambiguous=true`
 * if 2+ candidates pass the cascade).
 *
 * Cascade weights:
 *   verified identifier match (Mobile / ABHA number / address) → +5
 *   name phonetic match                                          → +2
 *   gender match                                                 → +1
 *   year of birth match (±2)                                     → +1
 * A candidate is "valid" if the score ≥ 7 OR if the verified identifier alone
 * uniquely identifies them across the candidate set.
 */
export function pickPatientByCascade(
  candidates: CandidatePatient[],
  hints: DiscoverPatientHints,
): MatchResult {
  if (!candidates.length) {
    return { patient: null, matchedBy: [], ambiguous: false };
  }

  // Quick exit: only one candidate, return as-is (verified identifier was
  // unique already).
  if (candidates.length === 1) {
    const matchedBy: string[] = [];
    if (hints.verifiedIdentifiers?.length) {
      for (const id of hints.verifiedIdentifiers) {
        matchedBy.push(id.type);
      }
    }
    return { patient: candidates[0], matchedBy: Array.from(new Set(matchedBy)), ambiguous: false };
  }

  let best: { patient: CandidatePatient; score: number; matchedBy: string[] } | null = null;
  let secondBest = -1;

  for (const c of candidates) {
    let score = 0;
    const matchedBy: string[] = [];

    if (hints.verifiedIdentifiers?.length) {
      for (const id of hints.verifiedIdentifiers) {
        if (id.type === 'MOBILE' && c.mobile === id.value) {
          score += 5; matchedBy.push('MOBILE');
        }
        if ((id.type === 'ABHA_NUMBER' || id.type === 'HEALTH_NUMBER')
          && (c.abhaNumber === id.value || c.abhaRecord?.abhaNumber === id.value)) {
          score += 5; matchedBy.push('ABHA_NUMBER');
        }
        if ((id.type === 'ABHA_ADDRESS' || id.type === 'HEALTH_ID')
          && (c.abhaAddress === id.value || c.abhaRecord?.abhaAddress === id.value)) {
          score += 5; matchedBy.push('ABHA_ADDRESS');
        }
      }
    }

    if (hints.name) {
      const fullName = `${c.firstName} ${c.lastName}`.trim();
      if (namesMatchPhonetic(fullName, hints.name)
        || namesMatchPhonetic(c.firstName, hints.name.split(' ')[0])) {
        score += 2; matchedBy.push('NAME');
      }
    }

    if (hints.gender && genderMatches(c, hints.gender)) {
      score += 1; matchedBy.push('GENDER');
    }

    if (hints.yearOfBirth && yobMatches(c, hints.yearOfBirth)) {
      score += 1; matchedBy.push('YEAR_OF_BIRTH');
    }

    if (!best || score > best.score) {
      secondBest = best?.score ?? -1;
      best = { patient: c, score, matchedBy };
    } else if (score > secondBest) {
      secondBest = score;
    }
  }

  if (!best || best.score < 5) {
    return { patient: null, matchedBy: [], ambiguous: false };
  }

  // Tie-breaker: an exact tie at the top score means the cascade did not
  // disambiguate — per the ABDM flowchart we MUST refuse rather than risk a
  // wrong-patient match. A 1-point gap is acceptable (the leader has at
  // least one stronger signal).
  if (secondBest === best.score) {
    logger.info('HIP: discovery cascade is ambiguous — refusing to match', {
      bestScore: best.score, secondBest,
    });
    return { patient: null, matchedBy: [], ambiguous: true };
  }

  return { patient: best.patient, matchedBy: Array.from(new Set(best.matchedBy)), ambiguous: false };
}

// ─── hiType derivation ──────────────────────────────────────────────────────

interface EncounterContent {
  type: 'OPD' | 'IPD' | 'EMERGENCY' | 'TELECONSULTATION';
  admissionId?: string | null;
  hasImmunization?: boolean;
  hasInvestigation?: boolean;
  hasPrescription?: boolean;
  hasDiagnosis?: boolean;
  isWellnessVisit?: boolean;
}

/**
 * Infer the ABDM hiType for a single care context based on the encounter
 * content, mirroring the FHIR profile selector. When unsure, falls back to
 * 'OPConsultation' (the broadest type that satisfies most consents).
 */
export function deriveHiType(content: EncounterContent): AbdmHiType {
  if (content.hasImmunization && !content.hasDiagnosis && !content.hasInvestigation) {
    return 'ImmunizationRecord';
  }
  if (content.isWellnessVisit) {
    return 'WellnessRecord';
  }
  if (content.type === 'IPD' && content.admissionId) {
    return 'DischargeSummary';
  }
  if (content.hasInvestigation && !content.hasDiagnosis && !content.hasPrescription) {
    return 'DiagnosticReport';
  }
  if (content.hasPrescription && !content.hasDiagnosis && !content.hasInvestigation) {
    return 'Prescription';
  }
  return 'OPConsultation';
}

/**
 * Map a FHIR profile name (used by the bundle builder) to the ABDM hiType
 * string the CM expects on /link/carecontext and on-discover responses.
 */
export function profileToHiType(profile: ProfileName): AbdmHiType {
  switch (profile) {
    case 'OPConsultRecord': return 'OPConsultation';
    case 'DischargeSummaryRecord': return 'DischargeSummary';
    case 'PrescriptionRecord': return 'Prescription';
    case 'DiagnosticReportRecord': return 'DiagnosticReport';
    case 'ImmunizationRecord': return 'ImmunizationRecord';
    case 'WellnessRecord': return 'WellnessRecord';
    case 'HealthDocumentRecord': return 'HealthDocumentRecord';
  }
}

/** Reverse of `profileToHiType`. */
export function hiTypeToProfile(hiType: AbdmHiType): ProfileName {
  switch (hiType) {
    case 'OPConsultation': return 'OPConsultRecord';
    case 'DischargeSummary': return 'DischargeSummaryRecord';
    case 'Prescription': return 'PrescriptionRecord';
    case 'DiagnosticReport': return 'DiagnosticReportRecord';
    case 'ImmunizationRecord': return 'ImmunizationRecord';
    case 'WellnessRecord': return 'WellnessRecord';
    case 'HealthDocumentRecord': return 'HealthDocumentRecord';
  }
}
