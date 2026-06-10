import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';
import { istDayRange } from '../common/utils/dateRange';

interface CreatePaymentDTO {
  patientId: string;
  hospitalId: string;
  appointmentId?: string;
  amount: number;
  paymentMethod: string;
  description?: string;
  items?: any;
  createdBy?: string;
}

interface UpdatePaymentDTO {
  status?: string;
  transactionId?: string;
  paidAt?: Date;
}

class PaymentService {
  async createPayment(data: CreatePaymentDTO) {
    if (!data.amount || data.amount <= 0) {
      throw new AppError('Payment amount must be greater than zero', 400);
    }
    if (!data.patientId) {
      throw new AppError('Patient ID is required', 400);
    }
    if (!data.hospitalId) {
      throw new AppError('Hospital ID is required', 400);
    }

    // Multi-tenant guard: the patient must belong to the same hospital the
    // payment is being created in. The controller forces hospitalId to the
    // caller's JWT for non-SUPER_ADMIN, so this catches a UUID-guessing
    // attempt to attach a payment to another hospital's patient.
    const patient = await prisma.patient.findUnique({
      where: { id: data.patientId },
      select: { id: true, hospitalId: true },
    });
    if (!patient) throw new AppError('Patient not found', 404);
    if (patient.hospitalId && patient.hospitalId !== data.hospitalId) {
      throw new AppError('Patient does not belong to this hospital', 403);
    }

    const receiptNumber = `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    const payment = await prisma.payment.create({
      data: {
        patientId: data.patientId,
        hospitalId: data.hospitalId,
        appointmentId: data.appointmentId,
        amount: data.amount,
        paymentMethod: data.paymentMethod as any,
        description: data.description,
        items: data.items,
        receiptNumber,
        createdBy: data.createdBy,
        status: 'PENDING',
      },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
            mobile: true,
          },
        },
        hospital: {
          select: {
            name: true,
            code: true,
          },
        },
        appointment: {
          select: {
            appointmentId: true,
            scheduledAt: true,
          },
        },
      },
    });

    return payment;
  }

  async getAllPayments(filters: {
    hospitalId?: string;
    patientId?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const { hospitalId, patientId, status, startDate, endDate, page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (hospitalId) where.hospitalId = hospitalId;
    if (patientId) where.patientId = patientId;
    if (status) where.status = status;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          patient: {
            select: {
              firstName: true,
              lastName: true,
              uhid: true,
              mobile: true,
            },
          },
          hospital: {
            select: {
              name: true,
              code: true,
            },
          },
          appointment: {
            select: {
              appointmentId: true,
              scheduledAt: true,
            },
          },
        },
      }),
      prisma.payment.count({ where }),
    ]);

    return {
      payments,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getPaymentById(id: string, currentUser?: any) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
            mobile: true,
            email: true,
          },
        },
        hospital: {
          select: {
            name: true,
            code: true,
            addressLine1: true,
            city: true,
            state: true,
            phone: true,
            email: true,
          },
        },
        appointment: {
          select: {
            appointmentId: true,
            scheduledAt: true,
            doctor: {
              select: {
                firstName: true,
                lastName: true,
                specialization: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && payment.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Payment belongs to different hospital', 403);
    }

    return payment;
  }

  async updatePayment(id: string, data: UpdatePaymentDTO, currentUser?: any) {
    const payment = await prisma.payment.findUnique({
      where: { id },
    });

    if (!payment) {
      throw new AppError('Payment not found', 404);
    }

    // Hospital isolation check
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && payment.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Payment belongs to different hospital', 403);
    }

    const updated = await prisma.payment.update({
      where: { id },
      data: {
        status: data.status as any,
        transactionId: data.transactionId || undefined,
        paidAt: data.paidAt,
      },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            uhid: true,
          },
        },
      },
    });

    return updated;
  }

  async markAsPaid(id: string, transactionId?: string, currentUser?: any) {
    return this.updatePayment(id, {
      status: 'PAID',
      transactionId,
      paidAt: new Date(),
    }, currentUser);
  }

  async getConsolidatedBilling(hospitalId?: string, patientId?: string) {
    // ── Build query filters ──────────────────────────────────────────────────
    // Encounter has no hospitalId — filter via patient.hospitalId relation
    const hospitalFilter: any = hospitalId ? { hospitalId } : {};
    const patientFilter: any  = patientId  ? { patientId }  : {};
    const encounterWhere: any = {
      ...patientFilter,
      ...(hospitalId ? { patient: { hospitalId } } : {}),
    };
    // Prescription has no hospitalId — filter via patient.hospitalId
    const prescriptionWhere: any = {
      ...patientFilter,
      ...(hospitalId ? { patient: { hospitalId } } : {}),
    };
    const directFilter = { ...hospitalFilter, ...patientFilter };
    const patientSelect = { id: true, firstName: true, lastName: true, uhid: true, mobile: true };

    const [
      allEncounters, allAdmissions, allPayments,
      allInvestigations, allPrescriptions,
    ] = await Promise.all([
      prisma.encounter.findMany({
        where: encounterWhere,
        include: {
          patient: { select: patientSelect },
          doctor: { select: { firstName: true, lastName: true, specialization: true } },
        },
        orderBy: { visitDate: 'desc' },
        take: 500,
      }),
      (prisma as any).admission.findMany({
        where: directFilter,
        include: {
          patient: { select: patientSelect },
          ward: { select: { name: true, type: true, dailyCharges: true } },
          bed: { select: { bedNumber: true } },
        },
        orderBy: { admittedAt: 'desc' },
        take: 200,
      }),
      prisma.payment.findMany({
        where: directFilter,
        include: { patient: { select: patientSelect } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      prisma.investigation.findMany({
        where: directFilter,
        include: {
          patient: { select: patientSelect },
          doctor: { select: { firstName: true, lastName: true } },
        },
        orderBy: { orderedAt: 'desc' },
        take: 500,
      }),
      prisma.prescription.findMany({
        where: prescriptionWhere,
        include: {
          patient: { select: patientSelect },
          doctor: { select: { firstName: true, lastName: true } },
        },
        orderBy: { issuedAt: 'desc' },
        take: 500,
      }),
    ]);

    // ── Build unified bill items ─────────────────────────────────────────────
    //
    // Charges are computed from ACTUAL linked items (investigations, prescriptions)
    // rather than potentially stale encounter fields. This ensures consistency
    // with discharge bill computation.

    const allBills: any[] = [];
    const encounterIds = new Set(allEncounters.map((e: any) => e.id));
    const admissionIds = new Set(allAdmissions.map((a: any) => a.id));

    // Pre-build lookup maps: encounterId → linked investigation/prescription totals
    const invByEnc = new Map<string, { lab: number; scan: number }>();
    const rxByEnc = new Map<string, number>();
    allInvestigations.forEach((inv: any) => {
      if (!inv.encounterId) return;
      const amt = parseFloat(inv.amount || '0');
      if (amt <= 0) return;
      const cur = invByEnc.get(inv.encounterId) || { lab: 0, scan: 0 };
      if (inv.testType === 'RADIOLOGY') { cur.scan += amt; } else { cur.lab += amt; }
      invByEnc.set(inv.encounterId, cur);
    });
    allPrescriptions.forEach((rx: any) => {
      if (!rx.encounterId || rx.status !== 'DISPENSED') return;
      const charges = parseFloat(rx.totalCharges || '0');
      if (charges > 0) {
        rxByEnc.set(rx.encounterId, (rxByEnc.get(rx.encounterId) || 0) + charges);
      }
    });

    // 1. OPD Encounters — use actual linked items for accurate charges
    allEncounters.forEach((e: any) => {
      if (e.type === 'IPD') return;

      const consultation = parseFloat(e.consultationFee || '0');
      const linkedInv = invByEnc.get(e.id) || { lab: 0, scan: 0 };
      const linkedRx = rxByEnc.get(e.id) || 0;
      const lab      = Math.max(parseFloat(e.labCharges || '0'), linkedInv.lab);
      const scan     = Math.max(parseFloat(e.scanCharges || '0'), linkedInv.scan);
      const medicine = Math.max(parseFloat(e.medicineCharges || '0'), linkedRx);
      const total = consultation + lab + medicine + scan;
      const discount = parseFloat(e.discountAmount || '0');
      const effectiveTotal = Math.max(0, total - discount);
      const paid  = parseFloat(e.paymentCollected || '0');
      allBills.push({
        id: e.id, type: 'OPD', patient: e.patient, doctor: e.doctor,
        date: e.visitDate, consultation, lab, medicine, scan, ward: 0,
        total: effectiveTotal, discount, paid, outstanding: Math.max(0, effectiveTotal - paid),
        discountReason: e.discountReason || null,
        discountApprovedBy: e.discountApprovedBy || null,
        status: e.paymentStatus || 'PENDING', diagnosis: e.finalDiagnosis || e.diagnosis,
      });
    });

    // 2. IPD Admissions — ward charges + actual linked round encounter charges
    allAdmissions.forEach((a: any) => {
      const wardRate = parseFloat(a.dailyCharges || a.ward?.dailyCharges || '0');
      const days = a.dischargedAt
        ? Math.max(1, Math.ceil((new Date(a.dischargedAt).getTime() - new Date(a.admittedAt).getTime()) / 86400000))
        : Math.max(1, Math.ceil((Date.now() - new Date(a.admittedAt).getTime()) / 86400000));
      const wardCharges = wardRate * days;

      let roundLab = 0, roundMedicine = 0, roundConsultation = 0, roundScan = 0;
      if (!a.dischargedAt) {
        allEncounters
          .filter((e: any) => e.type === 'IPD' && e.admissionId === a.id)
          .forEach((e: any) => {
            roundConsultation += parseFloat(e.consultationFee || '0');
            const inv = invByEnc.get(e.id) || { lab: 0, scan: 0 };
            const rx = rxByEnc.get(e.id) || 0;
            roundLab += inv.lab;
            roundScan += inv.scan;
            roundMedicine += rx;
          });
      }

      const grossTotal = parseFloat(a.totalAmount || '0') || (wardCharges + roundConsultation + roundLab + roundMedicine + roundScan);
      const discount = parseFloat(a.discountAmount || '0');
      const total = Math.max(0, grossTotal - discount);
      const advancePaid = parseFloat(a.advancePaid || '0');
      const dischargePaid = parseFloat(a.paymentCollected || '0');
      const totalReceived = advancePaid + dischargePaid;
      allBills.push({
        id: a.id, type: 'IPD', patient: a.patient, ward: a.ward, bed: a.bed,
        date: a.admittedAt, dischargedAt: a.dischargedAt, admissionStatus: a.status,
        consultation: roundConsultation, lab: roundLab, medicine: roundMedicine, scan: roundScan,
        wardCharges, wardRate, days, advancePaid, discount,
        total, paid: totalReceived, outstanding: Math.max(0, total - totalReceived),
        discountReason: a.discountReason || null,
        discountApprovedBy: a.discountApprovedBy || null,
        status: a.paymentStatus || 'PENDING', diagnosis: a.diagnosis, admissionNumber: a.admissionNumber,
      });
    });

    // Build encounter payment status lookup for detail row display
    const encPayStatus = new Map<string, string>();
    allEncounters.forEach((e: any) => encPayStatus.set(e.id, e.paymentStatus || 'PENDING'));

    // 3. LAB items — linked items reflect parent encounter's payment status
    allInvestigations.forEach((inv: any) => {
      const amount = parseFloat(inv.amount || '0');
      const isLinked = inv.encounterId && encounterIds.has(inv.encounterId);
      if (amount > 0) {
        const parentStatus = inv.encounterId ? encPayStatus.get(inv.encounterId) : undefined;
        const effectiveStatus = !isLinked ? 'PENDING' : (parentStatus === 'PAID' ? 'PAID' : 'PENDING');
        allBills.push({
          id: inv.id, type: 'LAB', patient: inv.patient, doctor: inv.doctor,
          date: inv.orderedAt, testName: inv.testName, testType: inv.testType,
          total: amount,
          paid: effectiveStatus === 'PAID' ? amount : 0,
          outstanding: effectiveStatus === 'PAID' ? 0 : amount,
          status: effectiveStatus,
          isDetail: isLinked,
        });
      }
    });

    // 4. PHARMACY items — same logic as lab
    allPrescriptions.forEach((rx: any) => {
      const charges = parseFloat(rx.totalCharges || '0');
      const isLinked = rx.encounterId && encounterIds.has(rx.encounterId);
      if (charges > 0) {
        const parentStatus = rx.encounterId ? encPayStatus.get(rx.encounterId) : undefined;
        const effectiveStatus = !isLinked ? 'PENDING' : (parentStatus === 'PAID' ? 'PAID' : 'PENDING');
        const meds = Array.isArray(rx.medications) ? rx.medications : [];
        allBills.push({
          id: rx.id, type: 'PHARMACY', patient: rx.patient, doctor: rx.doctor,
          date: rx.issuedAt, medCount: meds.length,
          total: charges,
          paid: effectiveStatus === 'PAID' ? charges : 0,
          outstanding: effectiveStatus === 'PAID' ? 0 : charges,
          status: effectiveStatus,
          isDetail: isLinked,
        });
      }
    });

    // Separate bills into primary (used for stats) and detail (for visibility only)
    const primaryBills = allBills.filter(b => !b.isDetail);
    const pendingBills = primaryBills.filter(b => b.status !== 'PAID' && b.outstanding > 0);

    // Completed Payment rows (receipts) — not billed items, just records of money received
    const completedPayments = allPayments.filter((p: any) => p.status === 'PAID');
    const pendingPaymentRecords = allPayments.filter((p: any) => p.status === 'PENDING');

    // Standalone pending payments (not linked to encounter/admission) are actual bills
    pendingPaymentRecords.forEach((p: any) => {
      const isReceipt = p.admissionId && admissionIds.has(p.admissionId);
      if (!isReceipt) {
        const amt = parseFloat(p.amount || '0');
        pendingBills.push({
          id: p.id, type: 'PAYMENT', patient: p.patient, date: p.createdAt,
          total: amt, paid: 0, outstanding: amt,
          description: p.description, status: 'PENDING',
        });
      }
    });

    // ── Patient-wise aggregation — primary sources only ──────────────────────
    const patientAgg: Record<string, any> = {};
    const ensurePatient = (pid: string, patient: any) => {
      if (!patientAgg[pid]) {
        patientAgg[pid] = {
          patient, consultation: 0, lab: 0, medicine: 0, ward: 0, scan: 0, other: 0,
          totalBilled: 0, totalPaid: 0,
        };
      }
    };

    primaryBills.forEach((b) => {
      if (!b.patient?.id) return;
      ensurePatient(b.patient.id, b.patient);
      const agg = patientAgg[b.patient.id];
      agg.totalBilled += b.total || 0;
      agg.totalPaid   += b.paid  || 0;
      if (b.type === 'OPD') {
        agg.consultation += b.consultation || 0;
        agg.lab          += b.lab          || 0;
        agg.medicine     += b.medicine     || 0;
        agg.scan         += b.scan         || 0;
      } else if (b.type === 'IPD') {
        agg.ward += b.wardCharges || b.total || 0;
      } else if (b.type === 'LAB') {
        agg.lab += b.total || 0;
      } else if (b.type === 'PHARMACY') {
        agg.medicine += b.total || 0;
      } else {
        agg.other += b.total || 0;
      }
    });

    const round = (n: number) => Math.round(n * 100) / 100;
    const patientWise = Object.values(patientAgg).map((p: any) => ({
      patient: p.patient,
      consultation: round(p.consultation),
      lab: round(p.lab),
      medicine: round(p.medicine),
      ward: round(p.ward),
      scan: round(p.scan),
      other: round(p.other),
      totalBilled: round(p.totalBilled),
      totalPaid: round(p.totalPaid),
      balance: round(p.totalBilled - p.totalPaid),
    })).sort((a, b) => b.balance - a.balance);

    // ── Stats ────────────────────────────────────────────────────────────────
    const totalOutstanding = pendingBills.reduce((s, b) => s + (b.outstanding || 0), 0);
    // IST-anchored: "today" and "this month" should match the user's wall
    // clock, not the server's. UTC servers would otherwise drop the first
    // ~5.5 hours of an IST day from these totals.
    const todayStart = istDayRange(0).start;
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const istMonthStartIso = `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00+05:30`;
    const monthStart = new Date(istMonthStartIso);

    // Revenue = Payment rows (receipts) — single source of truth for collected money
    const todayCollections = completedPayments
      .filter((p: any) => p.paidAt && new Date(p.paidAt) >= todayStart)
      .reduce((s: number, p: any) => s + parseFloat(p.amount || '0'), 0);
    const monthRevenue = completedPayments
      .filter((p: any) => p.paidAt && new Date(p.paidAt) >= monthStart)
      .reduce((s: number, p: any) => s + parseFloat(p.amount || '0'), 0);

    return {
      stats: {
        totalOutstanding: round(totalOutstanding),
        todayCollections: round(todayCollections),
        monthRevenue: round(monthRevenue),
        totalBills: primaryBills.length,
        pendingCount: pendingBills.length,
      },
      pendingBills,
      allBills,
      completedPayments,
      patientWise,
    };
  }

  async getPaymentStats(hospitalId?: string) {
    const where: any = {};
    if (hospitalId) where.hospitalId = hospitalId;

    const [totalRevenue, todayRevenue, pendingPayments, paidPayments] = await Promise.all([
      prisma.payment.aggregate({
        where: { ...where, status: 'PAID' },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: {
          ...where,
          status: 'PAID',
          paidAt: {
            gte: istDayRange(0).start,
          },
        },
        _sum: { amount: true },
      }),
      prisma.payment.count({
        where: { ...where, status: 'PENDING' },
      }),
      prisma.payment.count({
        where: { ...where, status: 'PAID' },
      }),
    ]);

    return {
      totalRevenue: Number(totalRevenue._sum.amount || 0),
      todayRevenue: Number(todayRevenue._sum.amount || 0),
      pendingPayments,
      paidPayments,
    };
  }
}

export default new PaymentService();
