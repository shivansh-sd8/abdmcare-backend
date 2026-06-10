import prisma from '../../common/config/database';
import logger from '../../common/config/logger';
import { rethrowServiceError } from '../../common/utils/serviceErrors';
import { getEffectiveHospitalId } from '../../common/utils/scope';
import { istDayRange, istHourOf, istWindowStart } from '../../common/utils/dateRange';

/**
 * Dashboard service — small, daily-driver aggregations for the role
 * dashboards. Everything here is hospital-scoped through `getEffectiveHospitalId`,
 * so a normal user always sees their hospital, a SUPER_ADMIN with a global
 * "viewing as" hospital scope sees that hospital, and an unscoped SUPER_ADMIN
 * sees platform-wide totals (which is what the SuperAdmin dashboard wants).
 */
export class DashboardService {
  /**
   * Day-by-day series for the last `days` days. Returned as an array ordered
   * oldest → newest with a short `label` ("Mon", "Tue", …) and an ISO `date`
   * for the start of that day. Always returns one row per day so the chart
   * never goes empty even if there is no activity.
   */
  async getDailyTrends(currentUser: any, days = 7) {
    try {
      const hospitalId = getEffectiveHospitalId(currentUser);
      const N = Math.min(Math.max(days, 1), 30); // clamp 1..30

      const out: Array<{
        date: string;
        label: string;
        patients: number;
        appointments: number;
        encounters: number;
        admissions: number;
        revenue: number;
      }> = [];

      for (let i = N - 1; i >= 0; i--) {
        // IST-aware day boundaries — guards against UTC-server skew on
        // Render. `i=0` is today-IST, `i=6` is six IST days ago.
        const { start: dayStart, end: dayEnd, label } = istDayRange(i);

        const patientsWhere: any = { createdAt: { gte: dayStart, lte: dayEnd } };
        const appointmentsWhere: any = { scheduledAt: { gte: dayStart, lte: dayEnd } };
        const encountersWhere: any = { createdAt: { gte: dayStart, lte: dayEnd } };
        const admissionsWhere: any = { admittedAt: { gte: dayStart, lte: dayEnd } };
        const paymentsWhere: any = {
          status: 'PAID',
          createdAt: { gte: dayStart, lte: dayEnd },
        };

        // Hospital scoping. patientsWhere/admissionsWhere/paymentsWhere have
        // a direct hospitalId. Appointment + encounter use a relation filter
        // through patient.hospitalId — Encounter has no direct hospitalId
        // column.
        if (hospitalId) {
          patientsWhere.hospitalId = hospitalId;
          appointmentsWhere.hospitalId = hospitalId;
          encountersWhere.patient = { hospitalId };
          admissionsWhere.hospitalId = hospitalId;
          paymentsWhere.hospitalId = hospitalId;
        }

        const [patients, appointments, encounters, admissions, revenueAgg] =
          await Promise.all([
            prisma.patient.count({ where: patientsWhere }),
            prisma.appointment.count({ where: appointmentsWhere }),
            prisma.encounter.count({ where: encountersWhere }),
            prisma.admission.count({ where: admissionsWhere }),
            prisma.payment.aggregate({
              where: paymentsWhere,
              _sum: { amount: true },
            }),
          ]);

        out.push({
          date: dayStart.toISOString(),
          label,
          patients,
          appointments,
          encounters,
          admissions,
          revenue: Number((revenueAgg as any)?._sum?.amount || 0),
        });
      }

      return { success: true, data: out };
    } catch (error: any) {
      logger.error('Failed to compute dashboard trends', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Today's appointment load by 2-hour bucket. Useful on the doctor and
   * receptionist dashboards to answer "when am I going to be slammed?"
   */
  async getTodayHourlyLoad(currentUser: any) {
    try {
      const hospitalId = getEffectiveHospitalId(currentUser);
      const { start: dayStart, end: dayEnd } = istDayRange(0);

      const where: any = { scheduledAt: { gte: dayStart, lte: dayEnd } };
      if (hospitalId) where.hospitalId = hospitalId;

      // Doctor dashboard: only their own appointments. Other roles see all.
      if (currentUser?.role === 'DOCTOR' && currentUser.doctorId) {
        where.doctorId = currentUser.doctorId;
      }

      const appts = await prisma.appointment.findMany({
        where,
        select: { scheduledAt: true, status: true },
      });

      // 2-hour buckets from 08:00 to 20:00.
      const buckets = [
        { label: '8 AM',  start: 8,  end: 10 },
        { label: '10 AM', start: 10, end: 12 },
        { label: '12 PM', start: 12, end: 14 },
        { label: '2 PM',  start: 14, end: 16 },
        { label: '4 PM',  start: 16, end: 18 },
        { label: '6 PM',  start: 18, end: 20 },
      ];

      const counts = buckets.map((b) => ({ hour: b.label, total: 0, completed: 0 }));
      for (const a of appts) {
        // Bucket by IST hour, not server-local hour, so a 14:00 IST appt
        // lands in "2 PM" regardless of server TZ.
        const h = istHourOf(new Date(a.scheduledAt));
        const idx = buckets.findIndex((b) => h >= b.start && h < b.end);
        if (idx >= 0) {
          counts[idx].total += 1;
          if (a.status === 'COMPLETED') counts[idx].completed += 1;
        }
      }
      return { success: true, data: counts };
    } catch (error: any) {
      logger.error('Failed to compute hourly load', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Revenue split by source for the last `days` days, summed across the
   * caller's hospital scope. We pull the per-encounter charge columns
   * (`consultationFee`, `medicineCharges`, `labCharges`, `scanCharges`) and
   * use `paymentStatus = 'PAID'` so we only count realised revenue. This
   * lets the Admin dashboard answer "where is the money coming from?".
   */
  async getRevenueBySource(currentUser: any, days = 7) {
    try {
      const hospitalId = getEffectiveHospitalId(currentUser);
      const N = Math.min(Math.max(days, 1), 90);
      const since = istWindowStart(N);

      const where: any = {
        paymentStatus: 'PAID',
        createdAt: { gte: since },
      };
      if (hospitalId) where.patient = { hospitalId };

      const agg = await prisma.encounter.aggregate({
        where,
        _sum: {
          consultationFee: true,
          medicineCharges: true,
          labCharges: true,
          scanCharges: true,
          totalAmount: true,
        },
      });

      return {
        success: true,
        data: {
          consultation: Number(agg._sum.consultationFee || 0),
          pharmacy:    Number(agg._sum.medicineCharges  || 0),
          labs:        Number(agg._sum.labCharges       || 0),
          scans:       Number(agg._sum.scanCharges      || 0),
          total:       Number(agg._sum.totalAmount      || 0),
          since: since.toISOString(),
        },
      };
    } catch (error: any) {
      logger.error('Failed to compute revenue by source', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Top doctors by completed encounters in the last `days` days. Used on the
   * Admin dashboard to celebrate / rebalance load.
   */
  async getTopDoctors(currentUser: any, days = 7, limit = 5) {
    try {
      const hospitalId = getEffectiveHospitalId(currentUser);
      const N = Math.min(Math.max(days, 1), 90);
      const since = istWindowStart(N);

      const where: any = {
        createdAt: { gte: since },
        status: 'COMPLETED',
      };
      if (hospitalId) where.patient = { hospitalId };

      // groupBy on `doctorId` then look up doctors in one batch.
      const grouped = await prisma.encounter.groupBy({
        by: ['doctorId'],
        where,
        _count: { _all: true },
        _sum: { consultationFee: true },
      });

      const sorted = grouped
        .filter((g) => g.doctorId)
        .sort((a, b) => (b._count._all || 0) - (a._count._all || 0))
        .slice(0, Math.min(Math.max(limit, 1), 20));

      const doctorIds = sorted.map((g) => g.doctorId).filter(Boolean) as string[];
      const docs = doctorIds.length
        ? await prisma.doctor.findMany({
            where: { id: { in: doctorIds } },
            select: {
              id: true, firstName: true, lastName: true, specialization: true,
            },
          })
        : [];
      const byId = new Map(docs.map((d) => [d.id, d]));

      const data = sorted.map((g) => {
        const d = g.doctorId ? byId.get(g.doctorId) : undefined;
        return {
          doctorId: g.doctorId,
          name: d ? `Dr. ${d.firstName} ${d.lastName}` : 'Doctor',
          specialization: d?.specialization || null,
          encounters: g._count._all,
          revenue: Number(g._sum.consultationFee || 0),
        };
      });

      return { success: true, data };
    } catch (error: any) {
      logger.error('Failed to compute top doctors', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Encounter status distribution in the last `days` days. Useful on the
   * Admin dashboard to spot bottlenecks (lots of LAB_PENDING etc.).
   */
  async getEncounterStatus(currentUser: any, days = 7) {
    try {
      const hospitalId = getEffectiveHospitalId(currentUser);
      const N = Math.min(Math.max(days, 1), 90);
      const since = istWindowStart(N);

      const where: any = { createdAt: { gte: since } };
      if (hospitalId) where.patient = { hospitalId };

      const grouped = await prisma.encounter.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      });

      return {
        success: true,
        data: grouped.map((g) => ({
          status: g.status,
          count: g._count._all,
        })),
      };
    } catch (error: any) {
      logger.error('Failed to compute encounter status', error);
      rethrowServiceError(error);
    }
  }
}

export default new DashboardService();
