import prisma from '../../common/config/database';
import logger from '../../common/config/logger';
import { rethrowServiceError } from '../../common/utils/serviceErrors';
import { AppError } from '../../common/middleware/errorHandler';
import { getEffectiveHospitalId } from '../../common/utils/scope';
import { istDayRange, istDayRangeOf, istWindowStart, istDayStart } from '../../common/utils/dateRange';
import {
  HospitalReport,
  ReportPreset,
  ReportDateRange,
  PatientRosterRow,
  DoctorPerformanceRow,
} from './report.types';

const DAY_MS = 24 * 60 * 60 * 1000;

const istLong = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

const istIsoDate = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Asia/Kolkata',
});

const istDateTime = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});

function num(value: any): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function calcAge(dob: Date | null | undefined): number | null {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob).getTime();
  if (ms < 0) return null;
  return Math.floor(ms / (365.25 * DAY_MS));
}

function ageBucket(age: number | null): string {
  if (age === null) return 'Unknown';
  if (age < 18) return '0-17';
  if (age < 40) return '18-39';
  if (age < 60) return '40-59';
  return '60+';
}

/**
 * Resolve the date-range query into the canonical UTC instants we store in
 * Prisma. Boundaries are IST-aware via istDayRangeOf so reports always
 * agree with what dashboards show on the same wall clock day.
 *
 * - For relative presets we anchor on "today (IST)" and walk back N days.
 * - For "all" we return null/null so callers fall back to lifetime queries.
 * - For "custom" both `from` and `to` are required and are interpreted as
 *   IST calendar dates (start = 00:00 IST, end = 23:59:59.999 IST).
 */
export function resolveRange(
  preset: ReportPreset,
  fromIso?: string,
  toIso?: string,
): ReportDateRange {
  const today = istDayRange(0);

  switch (preset) {
    case 'today':
      return {
        preset,
        from: today.start,
        to: today.end,
        label: `${istLong.format(today.start)} (Today)`,
      };
    case 'week': {
      const start = istWindowStart(7);
      return {
        preset,
        from: start,
        to: today.end,
        label: `${istLong.format(start)} – ${istLong.format(today.start)}`,
      };
    }
    case 'month': {
      const start = istWindowStart(30);
      return {
        preset,
        from: start,
        to: today.end,
        label: `${istLong.format(start)} – ${istLong.format(today.start)}`,
      };
    }
    case 'quarter': {
      const start = istWindowStart(90);
      return {
        preset,
        from: start,
        to: today.end,
        label: `${istLong.format(start)} – ${istLong.format(today.start)}`,
      };
    }
    case 'year': {
      const start = istWindowStart(365);
      return {
        preset,
        from: start,
        to: today.end,
        label: `${istLong.format(start)} – ${istLong.format(today.start)}`,
      };
    }
    case 'all':
      return {
        preset,
        from: null,
        to: null,
        label: 'All time',
      };
    case 'custom': {
      if (!fromIso || !toIso) {
        throw new AppError('Custom range requires both `from` and `to` (YYYY-MM-DD)', 400);
      }
      const startWin = istDayRangeOf(fromIso);
      const endWin = istDayRangeOf(toIso);
      if (startWin.start.getTime() > endWin.end.getTime()) {
        throw new AppError('`from` must be on or before `to`', 400);
      }
      return {
        preset,
        from: startWin.start,
        to: endWin.end,
        label: `${istLong.format(startWin.start)} – ${istLong.format(endWin.start)}`,
      };
    }
    default:
      throw new AppError(`Unknown preset: ${preset}`, 400);
  }
}

/**
 * Inclusive Prisma date-range filter for the resolved range. When the range
 * is "all" we return undefined so the caller can omit the filter altogether.
 */
function dateFilter(range: ReportDateRange): { gte: Date; lte: Date } | undefined {
  if (!range.from || !range.to) return undefined;
  return { gte: range.from, lte: range.to };
}

/**
 * Generate an IST-day bucket series for the resolved range, capped to `cap`
 * rows so a "year" preset doesn't render 365 sparkline columns. We always
 * pick the most-recent `cap` days since those are the most useful for a
 * trend line. For "all" we walk back `cap` days from today.
 */
function dayBuckets(range: ReportDateRange, cap: number): Array<ReturnType<typeof istDayRange>> {
  const out: Array<ReturnType<typeof istDayRange>> = [];
  let span = cap;
  if (range.from && range.to) {
    const todayStart = istDayRange(0).start.getTime();
    const fromMs = range.from.getTime();
    const totalDays = Math.max(1, Math.round((todayStart - fromMs) / DAY_MS) + 1);
    span = Math.min(cap, totalDays);
  }
  for (let i = span - 1; i >= 0; i--) out.push(istDayRange(i));
  return out;
}

/**
 * Hospital scoping helper that fails closed: ADMIN/SUPER_ADMIN can call the
 * report module, but SUPER_ADMIN MUST have a scoped hospital because a
 * cross-hospital roll-up isn't supported in v1 of this feature.
 */
function requireHospitalScope(currentUser: any): string {
  const id = getEffectiveHospitalId(currentUser);
  if (!id) {
    throw new AppError(
      'Reports require a hospital scope. Super Admin: pick a hospital from the global selector first.',
      400,
    );
  }
  return id;
}

class ReportService {
  /**
   * Build the unified `HospitalReport` object. Renderers (PDF/XLSX/CSV)
   * consume this — they don't talk to Prisma themselves.
   *
   * Design note: every section is awaited inside `Promise.all` so a wide
   * "all-time" report doesn't serialise 11 round-trips to Postgres. Each
   * helper does its own scoping by hospitalId.
   */
  async buildHospitalReport(currentUser: any, range: ReportDateRange): Promise<HospitalReport> {
    try {
      const hospitalId = requireHospitalScope(currentUser);
      const dateF = dateFilter(range);

      const [
        hospital,
        patientKpis,
        patientRoster,
        encounterStats,
        doctorRows,
        appointmentStats,
        ipdStats,
        pharmacyStats,
        labStats,
        billingStats,
        abdmStats,
      ] = await Promise.all([
        this.fetchHospital(hospitalId),
        this.buildPatientKpis(hospitalId, dateF),
        this.buildPatientRoster(hospitalId, dateF, range),
        this.buildEncounterStats(hospitalId, dateF, range),
        this.buildDoctorRows(hospitalId, dateF, range),
        this.buildAppointmentStats(hospitalId, dateF),
        this.buildIpdStats(hospitalId, dateF, range),
        this.buildPharmacyStats(hospitalId, dateF),
        this.buildLabStats(hospitalId, dateF),
        this.buildBillingStats(hospitalId, dateF, range),
        this.buildAbdmStats(hospitalId, dateF),
      ]);

      const now = new Date();
      const header = {
        hospital: hospital
          ? {
              id: hospital.id,
              name: hospital.name,
              code: hospital.code,
              type: String(hospital.type),
              address: [hospital.addressLine1, hospital.addressLine2].filter(Boolean).join(', '),
              city: hospital.city,
              state: hospital.state,
              pincode: hospital.pincode,
              phone: hospital.phone,
              email: hospital.email,
              website: hospital.website,
              hipId: hospital.hipId,
              hiuId: hospital.hiuId,
              hfrFacilityId: hospital.hfrFacilityId,
              abdmEnabled: hospital.abdmEnabled,
            }
          : null,
        range,
        generatedAt: now.toISOString(),
        generatedAtIst: istDateTime.format(now),
        generatedBy: {
          id: currentUser?.id || '',
          name: [currentUser?.firstName, currentUser?.lastName].filter(Boolean).join(' ') || currentUser?.email || 'Admin',
          email: currentUser?.email || '',
          role: currentUser?.role || '',
        },
        crossHospital: false,
      };

      return {
        header,
        patientKpis,
        patientRoster,
        encounters: encounterStats,
        doctors: doctorRows,
        appointments: appointmentStats,
        ipd: ipdStats,
        pharmacy: pharmacyStats,
        lab: labStats,
        billing: billingStats,
        abdm: abdmStats,
      };
    } catch (error: any) {
      logger.error('Failed to build hospital report', error);
      rethrowServiceError(error);
    }
  }

  private async fetchHospital(hospitalId: string) {
    return prisma.hospital.findUnique({ where: { id: hospitalId } });
  }

  private async buildPatientKpis(hospitalId: string, dateF: { gte: Date; lte: Date } | undefined) {
    const lifetimeWhere = { hospitalId };
    const inRangeWhere: any = { hospitalId };
    if (dateF) inRangeWhere.createdAt = dateF;

    const [
      totalLifetime,
      totalInRange,
      abhaLifetime,
      abhaInRange,
      kycVerified,
      genderGroups,
      cityRows,
      ageRows,
    ] = await Promise.all([
      prisma.patient.count({ where: lifetimeWhere }),
      prisma.patient.count({ where: inRangeWhere }),
      prisma.patient.count({
        where: { ...lifetimeWhere, abhaNumber: { not: null } },
      }),
      prisma.patient.count({
        where: { ...inRangeWhere, abhaNumber: { not: null } },
      }),
      prisma.abhaRecord.count({
        where: { kycStatus: 'VERIFIED', patient: { hospitalId } },
      }),
      prisma.patient.groupBy({
        by: ['gender'],
        where: lifetimeWhere,
        _count: { _all: true },
      }),
      prisma.$queryRawUnsafe<Array<{ city: string | null; count: bigint }>>(
        `SELECT (address->>'city') AS city, COUNT(*)::bigint AS count
           FROM patients
          WHERE "hospitalId" = $1 AND (address->>'city') IS NOT NULL AND (address->>'city') <> ''
          GROUP BY (address->>'city')
          ORDER BY count DESC
          LIMIT 5`,
        hospitalId,
      ),
      prisma.patient.findMany({
        where: lifetimeWhere,
        select: { dob: true },
      }),
    ]);

    const ageBucketCounts: Record<string, number> = { '0-17': 0, '18-39': 0, '40-59': 0, '60+': 0, Unknown: 0 };
    for (const r of ageRows) {
      const b = ageBucket(calcAge(r.dob));
      ageBucketCounts[b] = (ageBucketCounts[b] || 0) + 1;
    }

    return {
      totalLifetime,
      totalInRange,
      abhaLinkedLifetime: abhaLifetime,
      abhaLinkedInRange: abhaInRange,
      abhaPercentLifetime: totalLifetime ? Math.round((abhaLifetime / totalLifetime) * 1000) / 10 : 0,
      abhaPercentInRange: totalInRange ? Math.round((abhaInRange / totalInRange) * 1000) / 10 : 0,
      kycVerifiedLifetime: kycVerified,
      genderSplit: genderGroups.map((g) => ({ gender: String(g.gender), count: g._count._all })),
      ageBuckets: Object.entries(ageBucketCounts)
        .filter(([, v]) => v > 0)
        .map(([bucket, count]) => ({ bucket, count })),
      topCities: cityRows.map((r) => ({ city: r.city || 'Unknown', count: Number(r.count) })),
    };
  }

  /**
   * Patient roster: every patient that was either registered in the range or
   * had at least one encounter / appointment / admission in the range. We
   * batch the activity-rollup queries (visits-in-range, last visit, lifetime
   * spend) to avoid N+1 round-trips.
   */
  private async buildPatientRoster(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
    range: ReportDateRange,
  ): Promise<PatientRosterRow[]> {
    // 1. Find candidate patient ids: registered in range OR had activity in range.
    let candidateIds: Set<string>;
    if (!dateF) {
      const all = await prisma.patient.findMany({
        where: { hospitalId },
        select: { id: true },
      });
      candidateIds = new Set(all.map((p) => p.id));
    } else {
      const [registered, encountered, appointed, admitted] = await Promise.all([
        prisma.patient.findMany({
          where: { hospitalId, createdAt: dateF },
          select: { id: true },
        }),
        prisma.encounter.findMany({
          where: { patient: { hospitalId }, createdAt: dateF },
          select: { patientId: true },
          distinct: ['patientId'],
        }),
        prisma.appointment.findMany({
          where: { hospitalId, scheduledAt: dateF },
          select: { patientId: true },
          distinct: ['patientId'],
        }),
        prisma.admission.findMany({
          where: { hospitalId, admittedAt: dateF },
          select: { patientId: true },
          distinct: ['patientId'],
        }),
      ]);
      candidateIds = new Set<string>();
      registered.forEach((p) => candidateIds.add(p.id));
      encountered.forEach((p) => candidateIds.add(p.patientId));
      appointed.forEach((p) => candidateIds.add(p.patientId));
      admitted.forEach((p) => candidateIds.add(p.patientId));
    }

    if (candidateIds.size === 0) return [];
    const ids = Array.from(candidateIds);

    // 2. Fetch core patient rows + ABHA records in one go.
    const patients = await prisma.patient.findMany({
      where: { id: { in: ids } },
      include: { abhaRecord: true },
    });

    // 3. Aggregate visits-in-range, last-visit and lifetime-spend per patient.
    const [encsInRange, lastEncs, paidPayments] = await Promise.all([
      prisma.encounter.groupBy({
        by: ['patientId'],
        where: dateF
          ? { patientId: { in: ids }, createdAt: dateF }
          : { patientId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.encounter.groupBy({
        by: ['patientId'],
        where: { patientId: { in: ids } },
        _max: { createdAt: true },
      }),
      prisma.payment.groupBy({
        by: ['patientId'],
        where: { patientId: { in: ids }, status: 'PAID' },
        _sum: { amount: true },
      }),
    ]);

    const visitsByPatient = new Map(encsInRange.map((r) => [r.patientId, r._count._all]));
    const lastVisitByPatient = new Map(
      lastEncs.map((r) => [r.patientId, r._max.createdAt ? r._max.createdAt.toISOString() : null]),
    );
    const spendByPatient = new Map(paidPayments.map((r) => [r.patientId, num(r._sum.amount)]));

    // 4. Project to flat rows.
    const rows: PatientRosterRow[] = patients.map((p) => {
      const addr = (p.address as any) || {};
      return {
        uhid: p.uhid,
        firstName: p.firstName,
        lastName: p.lastName,
        middleName: p.middleName,
        gender: String(p.gender),
        dob: p.dob ? istIsoDate.format(new Date(p.dob)) : null,
        age: calcAge(p.dob),
        mobile: p.mobile,
        email: p.email,
        abhaNumber: p.abhaNumber,
        abhaAddress: p.abhaAddress,
        kycStatus: p.abhaRecord ? String(p.abhaRecord.kycStatus) : null,
        abhaLinkedAt: p.abhaRecord?.createdAt ? p.abhaRecord.createdAt.toISOString() : null,
        city: addr.city || null,
        state: addr.state || null,
        registeredAt: p.createdAt.toISOString(),
        registrationSource: String(p.registrationSource),
        visitsInRange: visitsByPatient.get(p.id) || 0,
        lastVisitAt: lastVisitByPatient.get(p.id) || null,
        lifetimeSpend: spendByPatient.get(p.id) || 0,
      };
    });

    // Most recent activity first (date scoped).
    rows.sort((a, b) => {
      const av = a.lastVisitAt || a.registeredAt;
      const bv = b.lastVisitAt || b.registeredAt;
      return bv.localeCompare(av);
    });

    // Hint to keep `range` referenced (avoid unused-var lint when not needed).
    void range;
    return rows;
  }

  private async buildEncounterStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
    range: ReportDateRange,
  ) {
    const where: any = { patient: { hospitalId } };
    if (dateF) where.createdAt = dateF;

    const [total, byTypeRaw, byStatusRaw] = await Promise.all([
      prisma.encounter.count({ where }),
      prisma.encounter.groupBy({ by: ['type'], where, _count: { _all: true } }),
      prisma.encounter.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    // Daily trend, capped to 30 buckets so a year-long preset still renders.
    const buckets = dayBuckets(range, 30);
    const dailyTrend = await Promise.all(
      buckets.map(async (b) => {
        const c = await prisma.encounter.count({
          where: {
            patient: { hospitalId },
            createdAt: { gte: b.start, lte: b.end },
          },
        });
        return { date: b.start.toISOString(), label: b.label, count: c };
      }),
    );

    const totalDays = dailyTrend.length || 1;
    const sumDaily = dailyTrend.reduce((acc, r) => acc + r.count, 0);

    return {
      totalInRange: total,
      byType: byTypeRaw.map((r) => ({ type: String(r.type), count: r._count._all })),
      byStatus: byStatusRaw.map((r) => ({ status: String(r.status), count: r._count._all })),
      avgPerDay: Math.round((sumDaily / totalDays) * 10) / 10,
      dailyTrend,
    };
  }

  /**
   * Per-doctor performance rows. Heavy lifting is done client-side (in JS)
   * over a single batch fetch of encounters + appointments because Prisma
   * groupBy can't return the multi-cadence buckets we want in one query.
   */
  private async buildDoctorRows(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
    range: ReportDateRange,
  ): Promise<DoctorPerformanceRow[]> {
    const doctors = await prisma.doctor.findMany({
      where: { hospitalId },
      include: { department: { select: { name: true } } },
    });
    if (doctors.length === 0) return [];
    const docIds = doctors.map((d) => d.id);

    const encounterWhere: any = { doctorId: { in: docIds }, patient: { hospitalId } };
    if (dateF) encounterWhere.createdAt = dateF;

    const apptWhere: any = { doctorId: { in: docIds }, hospitalId };
    if (dateF) apptWhere.scheduledAt = dateF;

    const [encs, appts] = await Promise.all([
      prisma.encounter.findMany({
        where: encounterWhere,
        select: {
          doctorId: true,
          patientId: true,
          type: true,
          status: true,
          createdAt: true,
          consultationFee: true,
        },
      }),
      prisma.appointment.findMany({
        where: apptWhere,
        select: {
          doctorId: true,
          status: true,
          type: true,
          scheduledAt: true,
        },
      }),
    ]);

    const empty = (): DoctorPerformanceRow => ({
      doctorId: '',
      name: '',
      specialization: '',
      department: null,
      hprId: null,
      registrationNo: '',
      isActive: true,
      uniquePatients: 0,
      encounters: 0,
      opd: 0,
      ipd: 0,
      emergency: 0,
      teleconsult: 0,
      followUps: 0,
      daysWorked: 0,
      avgPatientsPerDay: 0,
      appointmentsCancelled: 0,
      appointmentsNoShow: 0,
      revenueAttributed: 0,
      trends: { daily: [], weekly: [], monthly: [], yearly: [] },
    });

    const byDoctor = new Map<string, {
      patients: Set<string>;
      days: Set<string>;
      perDay: Map<string, number>;
    } & DoctorPerformanceRow>();

    for (const d of doctors) {
      const row = empty();
      row.doctorId = d.id;
      row.name = `Dr. ${d.firstName} ${d.lastName}`;
      row.specialization = d.specialization;
      row.department = d.department?.name || null;
      row.hprId = d.hprId;
      row.registrationNo = d.registrationNo;
      row.isActive = d.isActive;
      byDoctor.set(d.id, {
        ...(row as any),
        patients: new Set<string>(),
        days: new Set<string>(),
        perDay: new Map<string, number>(),
      });
    }

    for (const e of encs) {
      const r = byDoctor.get(e.doctorId);
      if (!r) continue;
      r.encounters += 1;
      r.patients.add(e.patientId);
      const istKey = istIsoDate.format(new Date(e.createdAt));
      r.days.add(istKey);
      r.perDay.set(istKey, (r.perDay.get(istKey) || 0) + 1);
      const t = String(e.type);
      if (t === 'OPD') r.opd += 1;
      else if (t === 'IPD') r.ipd += 1;
      else if (t === 'EMERGENCY') r.emergency += 1;
      else if (t === 'TELECONSULTATION') r.teleconsult += 1;
      if (String(e.status) === 'COMPLETED') {
        r.revenueAttributed += num(e.consultationFee);
      }
    }

    for (const a of appts) {
      const r = byDoctor.get(a.doctorId);
      if (!r) continue;
      const status = String(a.status);
      if (status === 'CANCELLED') r.appointmentsCancelled += 1;
      else if (status === 'NO_SHOW') r.appointmentsNoShow += 1;
      if (String(a.type) === 'FOLLOW_UP') r.followUps += 1;
    }

    void range;
    const out: DoctorPerformanceRow[] = [];
    for (const r of byDoctor.values()) {
      r.uniquePatients = r.patients.size;
      r.daysWorked = r.days.size;
      r.avgPatientsPerDay = r.daysWorked
        ? Math.round((r.uniquePatients / r.daysWorked) * 10) / 10
        : 0;
      r.trends = this.buildDoctorTrends(r.perDay);
      const { patients: _p, days: _d, perDay: _pd, ...flat } = r as any;
      out.push(flat as DoctorPerformanceRow);
    }

    out.sort((a, b) => b.encounters - a.encounters);
    return out;
  }

  /**
   * Roll a per-day count map up to the four cadences the UI promises:
   * daily (last 30 days), weekly (last 12 ISO-ish weeks), monthly (last 12
   * months), yearly (last 5 years). All anchored at the IST calendar.
   */
  private buildDoctorTrends(perDay: Map<string, number>) {
    const todayIst = istIsoDate.format(new Date());

    const daily: { date: string; label: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = istDayRange(i);
      daily.push({
        date: d.start.toISOString(),
        label: d.label,
        count: perDay.get(d.isoDate) || 0,
      });
    }

    const weekly: { weekStart: string; count: number }[] = [];
    for (let w = 11; w >= 0; w--) {
      let count = 0;
      const startDay = istDayStart(w * 7 + 6);
      const startIso = istIsoDate.format(startDay);
      for (let i = 0; i < 7; i++) {
        const di = istIsoDate.format(istDayStart(w * 7 + i));
        count += perDay.get(di) || 0;
      }
      weekly.push({ weekStart: startIso, count });
    }

    // Aggregate per-day → per-month and per-year. Use IST date strings.
    const byMonth = new Map<string, number>();
    const byYear = new Map<string, number>();
    for (const [iso, count] of perDay.entries()) {
      const yyyymm = iso.substring(0, 7);
      const yyyy = iso.substring(0, 4);
      byMonth.set(yyyymm, (byMonth.get(yyyymm) || 0) + count);
      byYear.set(yyyy, (byYear.get(yyyy) || 0) + count);
    }

    const monthly = Array.from(byMonth.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([month, count]) => ({ month, count }));

    const yearly = Array.from(byYear.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-5)
      .map(([year, count]) => ({ year, count }));

    void todayIst;
    return { daily, weekly, monthly, yearly };
  }

  private async buildAppointmentStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
  ) {
    const where: any = { hospitalId };
    if (dateF) where.scheduledAt = dateF;

    const [total, byStatus, byDoctorRaw, doctors] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.appointment.groupBy({
        by: ['doctorId', 'status'],
        where,
        _count: { _all: true },
      }),
      prisma.doctor.findMany({
        where: { hospitalId },
        select: { id: true, firstName: true, lastName: true },
      }),
    ]);

    const docMap = new Map(
      doctors.map((d) => [d.id, `Dr. ${d.firstName} ${d.lastName}`]),
    );

    const aggByDoctor = new Map<string, { name: string; total: number; completed: number; cancelled: number; noShow: number }>();
    for (const r of byDoctorRaw) {
      if (!r.doctorId) continue;
      const acc = aggByDoctor.get(r.doctorId) || {
        name: docMap.get(r.doctorId) || 'Doctor',
        total: 0,
        completed: 0,
        cancelled: 0,
        noShow: 0,
      };
      acc.total += r._count._all;
      const s = String(r.status);
      if (s === 'COMPLETED') acc.completed += r._count._all;
      else if (s === 'CANCELLED') acc.cancelled += r._count._all;
      else if (s === 'NO_SHOW') acc.noShow += r._count._all;
      aggByDoctor.set(r.doctorId, acc);
    }

    const byMap = new Map<string, number>();
    for (const r of byStatus) byMap.set(String(r.status), r._count._all);

    return {
      total,
      scheduled: byMap.get('SCHEDULED') || 0,
      completed: byMap.get('COMPLETED') || 0,
      cancelled: byMap.get('CANCELLED') || 0,
      noShow: byMap.get('NO_SHOW') || 0,
      byDoctor: Array.from(aggByDoctor.entries())
        .map(([doctorId, v]) => ({ doctorId, ...v }))
        .sort((a, b) => b.total - a.total),
    };
  }

  private async buildIpdStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
    range: ReportDateRange,
  ) {
    const inRangeWhere: any = { hospitalId };
    if (dateF) inRangeWhere.admittedAt = dateF;

    const [admissions, currentlyAdmitted, dischargesAgg, ipdRevenueAgg, byWardRaw, wards, beds, bedsOccupied] = await Promise.all([
      prisma.admission.findMany({
        where: inRangeWhere,
        select: { wardId: true, totalAmount: true, admittedAt: true, dischargedAt: true, status: true },
      }),
      prisma.admission.count({
        where: { hospitalId, status: 'ADMITTED' },
      }),
      prisma.admission.aggregate({
        where: dateF
          ? { hospitalId, dischargedAt: dateF }
          : { hospitalId, dischargedAt: { not: null } },
        _count: { _all: true },
      }),
      prisma.payment.aggregate({
        where: dateF
          ? { hospitalId, status: 'PAID', admissionId: { not: null }, createdAt: dateF }
          : { hospitalId, status: 'PAID', admissionId: { not: null } },
        _sum: { amount: true },
      }),
      prisma.admission.groupBy({
        by: ['wardId'],
        where: inRangeWhere,
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.ward.findMany({
        where: { hospitalId },
        select: { id: true, name: true, type: true, totalBeds: true },
      }),
      prisma.bed.count({
        where: { ward: { hospitalId } },
      }),
      prisma.bed.count({
        where: { ward: { hospitalId }, status: 'OCCUPIED' },
      }),
    ]);

    // Avg LoS in days, computed only on completed (discharged) stays.
    let totalDays = 0;
    let losCount = 0;
    for (const a of admissions) {
      if (a.dischargedAt && a.admittedAt) {
        totalDays += Math.max(1, Math.round((a.dischargedAt.getTime() - a.admittedAt.getTime()) / DAY_MS));
        losCount += 1;
      }
    }
    const avgLos = losCount ? Math.round((totalDays / losCount) * 10) / 10 : 0;

    const wardMap = new Map(wards.map((w) => [w.id, w]));
    const byWard = byWardRaw.map((r) => {
      const w = wardMap.get(r.wardId);
      return {
        wardId: r.wardId,
        ward: w?.name || 'Unknown',
        type: w ? String(w.type) : 'GENERAL',
        admissions: r._count._all,
        revenue: num(r._sum.totalAmount),
      };
    });

    void range;
    return {
      admissionsInRange: admissions.length,
      currentlyAdmitted,
      discharges: dischargesAgg._count._all,
      avgLengthOfStay: avgLos,
      bedOccupancyPercent: beds ? Math.round((bedsOccupied / beds) * 1000) / 10 : 0,
      totalIpdRevenue: num(ipdRevenueAgg._sum.amount),
      byWard,
    };
  }

  private async buildPharmacyStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
  ) {
    // Dispensing data lives on prescriptions where status = 'DISPENSED'.
    // Prescription has no direct hospitalId column; we scope by joining
    // through patient.hospitalId.
    const dispenseWhere: any = {
      status: 'DISPENSED',
      patient: { hospitalId },
    };
    if (dateF) dispenseWhere.dispensedAt = dateF;

    const [
      dispensed,
      stockBatches,
      lowStock,
      expiringSoon,
    ] = await Promise.all([
      prisma.prescription.findMany({
        where: dispenseWhere,
        select: { medications: true, totalCharges: true },
      }),
      prisma.inventoryBatch.findMany({
        where: { hospitalId, quantityAvailable: { gt: 0 } },
        select: { quantityAvailable: true, costPrice: true, medicineId: true },
      }),
      prisma.medicine.findMany({
        where: { hospitalId, isActive: true },
        select: { id: true, reorderLevel: true, batches: { select: { quantityAvailable: true } } },
      }),
      prisma.inventoryBatch.count({
        where: {
          hospitalId,
          quantityAvailable: { gt: 0 },
          expiryDate: { lte: new Date(Date.now() + 90 * DAY_MS) },
        },
      }),
    ]);

    let dispensedQty = 0;
    let pharmacyRevenue = 0;
    const byMedQty = new Map<string, { qty: number; revenue: number; name: string }>();

    for (const p of dispensed) {
      pharmacyRevenue += num(p.totalCharges);
      const meds = (p.medications as any[]) || [];
      for (const m of meds) {
        const q = num(m.quantity) || 0;
        const price = num(m.price) || 0;
        const name = String(m.name || m.medicineName || 'Unknown');
        dispensedQty += q;
        const existing = byMedQty.get(name) || { qty: 0, revenue: 0, name };
        existing.qty += q;
        existing.revenue += q * price;
        byMedQty.set(name, existing);
      }
    }

    const topByQty = Array.from(byMedQty.values())
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10)
      .map((r) => ({ medicineId: '', name: r.name, qty: r.qty, revenue: r.revenue }));
    const topByRevenue = Array.from(byMedQty.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((r) => ({ medicineId: '', name: r.name, qty: r.qty, revenue: r.revenue }));

    let stockValue = 0;
    for (const b of stockBatches) {
      stockValue += num(b.quantityAvailable) * num(b.costPrice);
    }

    let lowStockCount = 0;
    for (const m of lowStock) {
      const onHand = m.batches.reduce((acc, b) => acc + num(b.quantityAvailable), 0);
      if (onHand <= num(m.reorderLevel)) lowStockCount += 1;
    }

    return {
      dispensedQty,
      pharmacyRevenue,
      topByQty,
      topByRevenue,
      currentStockValue: stockValue,
      lowStockCount,
      expiringSoonCount: expiringSoon,
    };
  }

  private async buildLabStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
  ) {
    const where: any = { hospitalId };
    if (dateF) where.orderedAt = dateF;

    const [ordered, byStatus, byCategory, completedRows] = await Promise.all([
      prisma.investigation.count({ where }),
      prisma.investigation.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      prisma.investigation.groupBy({
        by: ['testType'],
        where,
        _count: { _all: true },
      }),
      prisma.investigation.findMany({
        where: { ...where, status: 'COMPLETED', resultEnteredAt: { not: null } },
        select: { orderedAt: true, resultEnteredAt: true },
      }),
    ]);

    const statusMap = new Map<string, number>();
    for (const r of byStatus) statusMap.set(String(r.status), r._count._all);

    let totalTatHours = 0;
    let tatCount = 0;
    for (const r of completedRows) {
      if (r.resultEnteredAt && r.orderedAt) {
        const hrs = (r.resultEnteredAt.getTime() - r.orderedAt.getTime()) / (60 * 60 * 1000);
        if (hrs > 0) {
          totalTatHours += hrs;
          tatCount += 1;
        }
      }
    }

    return {
      ordered,
      completed: statusMap.get('COMPLETED') || 0,
      pending: (statusMap.get('ORDERED') || 0)
        + (statusMap.get('SAMPLE_COLLECTED') || 0)
        + (statusMap.get('IN_PROGRESS') || 0),
      avgTatHours: tatCount ? Math.round((totalTatHours / tatCount) * 10) / 10 : 0,
      byCategory: byCategory.map((r) => ({
        category: r.testType || 'Unknown',
        count: r._count._all,
      })),
    };
  }

  private async buildBillingStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
    range: ReportDateRange,
  ) {
    const paidWhere: any = { hospitalId, status: 'PAID' };
    if (dateF) paidWhere.createdAt = dateF;
    const allWhere: any = { hospitalId };
    if (dateF) allWhere.createdAt = dateF;

    const encWhere: any = { paymentStatus: 'PAID', patient: { hospitalId } };
    if (dateF) encWhere.createdAt = dateF;

    const [paidAgg, methodGroups, statusGroups, sourcesAgg, ipdRevenue, discountAgg] = await Promise.all([
      prisma.payment.aggregate({
        where: paidWhere,
        _sum: { amount: true },
      }),
      prisma.payment.groupBy({
        by: ['paymentMethod'],
        where: paidWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.payment.groupBy({
        by: ['status'],
        where: allWhere,
        _sum: { amount: true },
      }),
      prisma.encounter.aggregate({
        where: encWhere,
        _sum: {
          consultationFee: true,
          medicineCharges: true,
          labCharges: true,
          scanCharges: true,
        },
      }),
      prisma.payment.aggregate({
        where: { ...paidWhere, admissionId: { not: null } },
        _sum: { amount: true },
      }),
      prisma.encounter.aggregate({
        where: encWhere,
        _sum: { discountAmount: true },
      }),
    ]);

    const statusMap = new Map<string, number>();
    for (const r of statusGroups) statusMap.set(String(r.status), num(r._sum.amount));

    const buckets = dayBuckets(range, 30);
    const dailyTrend = await Promise.all(
      buckets.map(async (b) => {
        const agg = await prisma.payment.aggregate({
          where: {
            hospitalId,
            status: 'PAID',
            createdAt: { gte: b.start, lte: b.end },
          },
          _sum: { amount: true },
        });
        return {
          date: b.start.toISOString(),
          label: b.label,
          revenue: num(agg._sum.amount),
        };
      }),
    );

    return {
      totalRevenue: num(paidAgg._sum.amount),
      bySource: {
        consultation: num(sourcesAgg._sum.consultationFee),
        pharmacy: num(sourcesAgg._sum.medicineCharges),
        labs: num(sourcesAgg._sum.labCharges),
        scans: num(sourcesAgg._sum.scanCharges),
        ipd: num(ipdRevenue._sum.amount),
      },
      byMethod: methodGroups.map((r) => ({
        method: String(r.paymentMethod),
        amount: num(r._sum.amount),
        count: r._count._all,
      })),
      outstanding: {
        pending: statusMap.get('PENDING') || 0,
        partial: statusMap.get('PARTIAL') || 0,
      },
      discountsGiven: num(discountAgg._sum.discountAmount),
      dailyTrend,
      byStaff: await this.buildStaffCollections(hospitalId, dateF),
    };
  }

  /**
   * Per-staff collection rollup. Walks the Payment ledger (PAID rows only)
   * within the report window, groups by `collectedById`, and decorates each
   * group with the user's name + role + per-method breakdown.
   *
   * Payments without a recorded collector — older rows from before the
   * `collectedById` column existed — fall into a single synthetic
   * "Unattributed" bucket so revenue still reconciles to `totalRevenue`.
   */
  private async buildStaffCollections(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
  ) {
    const where: any = { hospitalId, status: 'PAID' };
    if (dateF) where.createdAt = dateF;

    const payments = await prisma.payment.findMany({
      where,
      select: {
        amount: true,
        paymentMethod: true,
        collectedById: true,
        collectedAt: true,
        paidAt: true,
        createdAt: true,
        collectedBy: {
          select: { id: true, firstName: true, lastName: true, role: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      // Hard cap to keep memory predictable on large windows. 50k payments
      // ~ a 5-year tail for a busy hospital — far above any realistic
      // single-report range. We document this so the UI can hint at it.
      take: 50000,
    });

    interface Acc {
      collectorId: string | null;
      name: string;
      role: string | null;
      email: string | null;
      paymentCount: number;
      total: number;
      methods: Map<string, { amount: number; count: number }>;
      first: Date | null;
      last: Date | null;
    }
    const groups = new Map<string, Acc>();

    for (const p of payments) {
      const id = p.collectedById ?? null;
      const key = id ?? '__unattributed__';
      const existing = groups.get(key);
      const acc: Acc = existing ?? {
        collectorId: id,
        name: p.collectedBy
          ? `${p.collectedBy.firstName} ${p.collectedBy.lastName}`.trim()
          : 'Unattributed',
        role: p.collectedBy?.role ?? null,
        email: p.collectedBy?.email ?? null,
        paymentCount: 0,
        total: 0,
        methods: new Map(),
        first: null,
        last: null,
      };
      acc.paymentCount += 1;
      acc.total += Number(p.amount || 0);

      const methodKey = String(p.paymentMethod || 'UNKNOWN');
      const m = acc.methods.get(methodKey) || { amount: 0, count: 0 };
      m.amount += Number(p.amount || 0);
      m.count += 1;
      acc.methods.set(methodKey, m);

      const stamp = p.collectedAt ?? p.paidAt ?? p.createdAt;
      if (stamp) {
        if (!acc.first || stamp < acc.first) acc.first = stamp;
        if (!acc.last  || stamp > acc.last)  acc.last  = stamp;
      }
      if (!existing) groups.set(key, acc);
    }

    const round = (n: number) => Math.round(n * 100) / 100;

    return Array.from(groups.values())
      .map((g) => ({
        collectorId: g.collectorId,
        name: g.name,
        role: g.role,
        email: g.email,
        paymentCount: g.paymentCount,
        total: round(g.total),
        byMethod: Array.from(g.methods.entries())
          .map(([method, v]) => ({
            method,
            amount: round(v.amount),
            count: v.count,
          }))
          .sort((a, b) => b.amount - a.amount),
        firstCollectedAt: g.first ? g.first.toISOString() : null,
        lastCollectedAt: g.last ? g.last.toISOString() : null,
      }))
      .sort((a, b) => b.total - a.total);
  }

  private async buildAbdmStats(
    hospitalId: string,
    dateF: { gte: Date; lte: Date } | undefined,
  ) {
    const consentWhere: any = { patient: { hospitalId } };
    if (dateF) consentWhere.createdAt = dateF;

    const [
      requested,
      granted,
      denied,
      revoked,
      expired,
      purged,
      careCtx,
      shares,
      external,
    ] = await Promise.all([
      prisma.consent.count({ where: consentWhere }),
      prisma.consent.count({ where: { ...consentWhere, status: 'GRANTED' } }),
      prisma.consent.count({ where: { ...consentWhere, status: 'DENIED' } }),
      prisma.consent.count({ where: { ...consentWhere, status: 'REVOKED' } }),
      prisma.consent.count({ where: { ...consentWhere, status: 'EXPIRED' } }),
      prisma.consent.count({ where: { ...consentWhere, purgedAt: { not: null } } }),
      prisma.careContext.count({
        where: dateF
          ? { patient: { hospitalId }, createdAt: dateF, linkStatus: 'LINKED' }
          : { patient: { hospitalId }, linkStatus: 'LINKED' },
      }),
      prisma.receivedShare.count({
        where: dateF
          ? { hospitalId, receivedAt: dateF }
          : { hospitalId },
      }),
      prisma.externalHealthRecord.count({
        where: dateF
          ? { hospitalId, receivedAt: dateF }
          : { hospitalId },
      }),
    ]);

    return {
      consents: { requested, granted, denied, revoked, expired, purged },
      careContextsLinked: careCtx,
      scanShareCheckIns: shares,
      externalRecordsReceived: external,
    };
  }
}

export default new ReportService();

