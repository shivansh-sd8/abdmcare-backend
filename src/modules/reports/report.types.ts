/**
 * Hospital Report — single source of truth for the data shape that every
 * renderer (PDF, Excel, CSV bundle) consumes.
 *
 * The service layer builds this object once per request; renderers slice it
 * into their own format. Adding a new section means: add a field here, fill
 * it in `report.service.ts`, then surface it in each renderer.
 */

export type ReportPreset =
  | 'today'
  | 'week'      // last 7 IST days
  | 'month'     // last 30 IST days
  | 'quarter'   // last 90 IST days
  | 'year'      // last 365 IST days
  | 'all'       // hospital lifetime
  | 'custom';

export interface ReportDateRange {
  preset: ReportPreset;
  /** Inclusive UTC instant for the start of the IST window. null if "all". */
  from: Date | null;
  /** Inclusive UTC instant for the end of the IST window. null if "all". */
  to: Date | null;
  /** Pretty IST label, e.g. "01 Jun 2026 – 30 Jun 2026". */
  label: string;
}

export interface ReportHeader {
  hospital: {
    id: string;
    name: string;
    code: string;
    type: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
    email: string;
    website: string | null;
    hipId: string | null;
    hiuId: string | null;
    hfrFacilityId: string | null;
    abdmEnabled: boolean;
  } | null;
  range: ReportDateRange;
  generatedAt: string;            // ISO timestamp
  generatedAtIst: string;         // IST-formatted human string
  generatedBy: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  /** True when the report runs cross-hospital (Super Admin, no scope). */
  crossHospital: boolean;
}

export interface PatientKpis {
  totalLifetime: number;
  totalInRange: number;
  abhaLinkedLifetime: number;
  abhaLinkedInRange: number;
  abhaPercentLifetime: number;        // 0..100
  abhaPercentInRange: number;         // 0..100
  kycVerifiedLifetime: number;
  genderSplit: { gender: string; count: number }[];
  ageBuckets: { bucket: string; count: number }[];     // computed from dob
  topCities: { city: string; count: number }[];        // top 5
}

export interface PatientRosterRow {
  uhid: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  gender: string;
  dob: string | null;                  // YYYY-MM-DD
  age: number | null;
  mobile: string;
  email: string | null;
  abhaNumber: string | null;
  abhaAddress: string | null;
  kycStatus: string | null;            // PENDING / VERIFIED / FAILED / null
  abhaLinkedAt: string | null;         // ISO
  city: string | null;
  state: string | null;
  registeredAt: string;                // ISO
  registrationSource: string;
  visitsInRange: number;
  lastVisitAt: string | null;          // ISO
  lifetimeSpend: number;               // INR
}

export interface EncounterStats {
  totalInRange: number;
  byType: { type: string; count: number }[];
  byStatus: { status: string; count: number }[];
  avgPerDay: number;
  dailyTrend: { date: string; label: string; count: number }[];
}

export interface DoctorPerformanceRow {
  doctorId: string;
  name: string;
  specialization: string;
  department: string | null;
  hprId: string | null;
  registrationNo: string;
  isActive: boolean;
  uniquePatients: number;
  encounters: number;
  opd: number;
  ipd: number;
  emergency: number;
  teleconsult: number;
  followUps: number;
  daysWorked: number;
  avgPatientsPerDay: number;
  appointmentsCancelled: number;
  appointmentsNoShow: number;
  revenueAttributed: number;            // sum(consultationFee) for completed encounters
  /** Per-doctor counts at multiple cadences (always over the report's range). */
  trends: {
    daily: { date: string; label: string; count: number }[];   // up to 30 rows
    weekly: { weekStart: string; count: number }[];            // up to 12 rows
    monthly: { month: string; count: number }[];               // up to 12 rows
    yearly: { year: string; count: number }[];                 // up to 5 rows
  };
}

export interface AppointmentStats {
  total: number;
  scheduled: number;
  completed: number;
  cancelled: number;
  noShow: number;
  byDoctor: { doctorId: string; name: string; total: number; completed: number; cancelled: number; noShow: number }[];
}

export interface IpdStats {
  admissionsInRange: number;
  currentlyAdmitted: number;
  discharges: number;
  avgLengthOfStay: number;              // days
  bedOccupancyPercent: number;          // current snapshot
  totalIpdRevenue: number;
  byWard: { wardId: string; ward: string; type: string; admissions: number; revenue: number }[];
}

export interface PharmacyStats {
  dispensedQty: number;
  pharmacyRevenue: number;
  topByQty: { medicineId: string; name: string; qty: number; revenue: number }[];
  topByRevenue: { medicineId: string; name: string; qty: number; revenue: number }[];
  currentStockValue: number;
  lowStockCount: number;
  expiringSoonCount: number;            // expiring within 90 days
}

export interface LabStats {
  ordered: number;
  completed: number;
  pending: number;
  avgTatHours: number;                  // null-safe → 0 if not computable
  byCategory: { category: string; count: number }[];
}

export interface StaffCollectionRow {
  /** User ID, or null when the row aggregates payments with no recorded collector. */
  collectorId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  paymentCount: number;
  total: number;
  /** Money handled per channel — useful for cash-vs-digital reconciliation. */
  byMethod: { method: string; amount: number; count: number }[];
  firstCollectedAt: string | null;   // ISO
  lastCollectedAt: string | null;    // ISO
}

export interface BillingStats {
  totalRevenue: number;
  bySource: { consultation: number; pharmacy: number; labs: number; scans: number; ipd: number };
  byMethod: { method: string; amount: number; count: number }[];
  outstanding: { pending: number; partial: number };
  discountsGiven: number;
  dailyTrend: { date: string; label: string; revenue: number }[];
  /**
   * Who actually rang up each rupee. Sorted by total desc. Includes a
   * synthetic "Unattributed" row for legacy payments that pre-date the
   * `collectedById` column.
   */
  byStaff: StaffCollectionRow[];
}

export interface AbdmStats {
  consents: {
    requested: number;
    granted: number;
    denied: number;
    revoked: number;
    expired: number;
    purged: number;
  };
  careContextsLinked: number;
  scanShareCheckIns: number;
  externalRecordsReceived: number;
}

export interface HospitalReport {
  header: ReportHeader;
  patientKpis: PatientKpis;
  patientRoster: PatientRosterRow[];
  encounters: EncounterStats;
  doctors: DoctorPerformanceRow[];
  appointments: AppointmentStats;
  ipd: IpdStats;
  pharmacy: PharmacyStats;
  lab: LabStats;
  billing: BillingStats;
  abdm: AbdmStats;
}
