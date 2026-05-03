import prisma from '../../common/config/database';
import smsService from '../../common/utils/smsService';

function generateAdmissionNumber(): string {
  const now = new Date();
  const yy   = String(now.getFullYear()).slice(-2);
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `IPD${yy}${mm}${rand}`;
}

function generateEncounterId(): string {
  return `ENC-IPD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
}

function generateReceiptNumber(): string {
  return `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
}

export class IPDService {
  // ── Ward operations ──────────────────────────────────────────────────────

  async listWards(hospitalId: string) {
    return prisma.ward.findMany({
      where: { hospitalId, isActive: true },
      include: {
        _count: { select: { beds: true, admissions: { where: { status: 'ADMITTED' } } } },
        beds: { orderBy: { bedNumber: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createWard(hospitalId: string, data: {
    name: string;
    type?: string;
    floor?: string;
    totalBeds?: number;
    dailyCharges?: number;
  }) {
    return prisma.ward.create({
      data: {
        name:         data.name,
        type:         (data.type as any) || 'GENERAL',
        floor:        data.floor,
        totalBeds:    data.totalBeds    || 0,
        dailyCharges: data.dailyCharges || 0,
        hospitalId,
      },
    });
  }

  async updateWard(wardId: string, hospitalId: string, data: Partial<{
    name: string;
    type: string;
    floor: string;
    totalBeds: number;
    dailyCharges: number;
    isActive: boolean;
  }>) {
    const ward = await prisma.ward.findFirst({ where: { id: wardId, hospitalId } });
    if (!ward) throw new Error('Ward not found');
    return prisma.ward.update({ where: { id: wardId }, data: data as any });
  }

  // ── Bed operations ───────────────────────────────────────────────────────

  async createBed(wardId: string, hospitalId: string, bedNumber: string) {
    const ward = await prisma.ward.findFirst({ where: { id: wardId, hospitalId } });
    if (!ward) throw new Error('Ward not found');
    return prisma.bed.create({ data: { bedNumber, wardId, status: 'AVAILABLE' } });
  }

  async updateBedStatus(bedId: string, hospitalId: string, status: string) {
    const bed = await prisma.bed.findFirst({
      where: { id: bedId, ward: { hospitalId } },
    });
    if (!bed) throw new Error('Bed not found');
    return prisma.bed.update({ where: { id: bedId }, data: { status: status as any } });
  }

  // ── Admission operations ─────────────────────────────────────────────────

  async listAdmissions(hospitalId: string, filters: {
    status?: string;
    wardId?: string;
    page?: number;
    limit?: number;
  } = {}) {
    const { status, wardId, page = 1, limit = 25 } = filters;
    const where: any = { hospitalId };
    if (status) where.status = status;
    if (wardId) where.wardId = wardId;

    const [admissions, total] = await Promise.all([
      prisma.admission.findMany({
        where,
        include: {
          patient:  { select: { id: true, firstName: true, lastName: true, uhid: true, mobile: true, gender: true, dob: true } },
          ward:     { select: { id: true, name: true, type: true, dailyCharges: true } },
          bed:      { select: { id: true, bedNumber: true } },
          encounter:{ select: { id: true, diagnosis: true, chiefComplaint: true } },
          _count:   { select: { rounds: true } },
        },
        orderBy: { admittedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.admission.count({ where }),
    ]);

    return { admissions, total, page, limit };
  }

  async getAdmissionById(admissionId: string, hospitalId: string) {
    const admission = await prisma.admission.findFirst({
      where: { id: admissionId, hospitalId },
      include: {
        patient:  { select: { id: true, firstName: true, lastName: true, uhid: true, mobile: true, gender: true, dob: true, bloodGroup: true } },
        ward:     { include: { beds: true } },
        bed:      true,
        encounter:{ include: { prescriptions: true, labOrders: true } },
        rounds:   {
          include: {
            doctor: { select: { id: true, firstName: true, lastName: true, specialization: true } },
            prescriptions: true,
            labOrders: true,
          },
          orderBy: { visitDate: 'asc' },
        },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!admission) throw new Error('Admission not found');
    return admission;
  }

  async admitPatient(hospitalId: string, data: {
    patientId: string;
    encounterId?: string;
    wardId: string;
    bedId?: string;
    admittedBy?: string;
    admissionReason?: string;
    diagnosis?: string;
    dailyCharges?: number;
    advancePaid?: number;
    advanceMethod?: string;
    advanceTransactionRef?: string;
    notes?: string;
  }) {
    // Ward must belong to this hospital
    const ward = await prisma.ward.findFirst({ where: { id: data.wardId, hospitalId } });
    if (!ward) throw new Error('Ward not found in this hospital');

    if (data.bedId) {
      const bed = await prisma.bed.findFirst({ where: { id: data.bedId, wardId: data.wardId } });
      if (!bed)                    throw new Error('Bed not found in specified ward');
      if (bed.status === 'OCCUPIED') throw new Error('Bed is already occupied');
    }

    // Use ward's standard daily charge if not overridden
    const resolvedDailyCharges = data.dailyCharges ?? ward.dailyCharges;

    const admissionNumber = generateAdmissionNumber();
    const admission = await prisma.admission.create({
      data: {
        admissionNumber,
        patientId:       data.patientId,
        encounterId:     data.encounterId,
        wardId:          data.wardId,
        bedId:           data.bedId,
        hospitalId,
        admittedBy:      data.admittedBy,
        admissionReason: data.admissionReason,
        diagnosis:       data.diagnosis,
        dailyCharges:    resolvedDailyCharges,
        advancePaid:     data.advancePaid || 0,
        notes:           data.notes,
        paymentStatus:   data.advancePaid && data.advancePaid > 0 ? 'PARTIAL' : 'PENDING',
        status:          'ADMITTED',
      },
      include: {
        patient: { select: { firstName: true, lastName: true, uhid: true } },
        ward:    { select: { name: true, dailyCharges: true } },
        bed:     { select: { bedNumber: true } },
      },
    });

    // Mark bed occupied
    if (data.bedId) {
      await prisma.bed.update({ where: { id: data.bedId }, data: { status: 'OCCUPIED' } });
    }

    // If advance was paid, record a payment entry
    if (data.advancePaid && data.advancePaid > 0) {
      await prisma.payment.create({
        data: {
          patientId:     data.patientId,
          hospitalId,
          admissionId:   admission.id,
          amount:        data.advancePaid,
          paymentMethod: (data.advanceMethod as any) || 'CASH',
          status:        'PAID',
          paidAt:        new Date(),
          transactionId: data.advanceTransactionRef || undefined,
          receiptNumber: generateReceiptNumber(),
          description:   `IPD Advance — ${admissionNumber}`,
        },
      });
    }

    return admission;
  }

  async updateAdmission(admissionId: string, hospitalId: string, data: Partial<{
    wardId: string;
    bedId: string;
    admissionReason: string;
    diagnosis: string;
    dailyCharges: number;
    advancePaid: number;
    notes: string;
  }>) {
    const admission = await prisma.admission.findFirst({ where: { id: admissionId, hospitalId } });
    if (!admission) throw new Error('Admission not found');
    return prisma.admission.update({ where: { id: admissionId }, data: data as any });
  }

  // ── IPD Daily Rounds ─────────────────────────────────────────────────────

  async getAdmissionRounds(admissionId: string, hospitalId: string) {
    // Verify admission belongs to this hospital
    const admission = await prisma.admission.findFirst({ where: { id: admissionId, hospitalId } });
    if (!admission) throw new Error('Admission not found');

    return prisma.encounter.findMany({
      where: { admissionId },
      include: {
        doctor: { select: { id: true, firstName: true, lastName: true, specialization: true } },
        prescriptions: true,
        labOrders: true,
      },
      orderBy: { visitDate: 'asc' },
    });
  }

  async createAdmissionRound(admissionId: string, hospitalId: string, data: {
    doctorId: string;
    diagnosis?: string;
    notes?: string;
    prescriptions?: Array<{
      medicineId?: string;
      medicineName: string;
      dosage: string;
      frequency: string;
      duration: string;
      instructions?: string;
    }>;
    labOrders?: Array<{
      testName: string;
      testType?: string;
      priority?: string;
      instructions?: string;
    }>;
    vitalSigns?: any;
  }) {
    const admission = await prisma.admission.findFirst({
      where:   { id: admissionId, hospitalId, status: 'ADMITTED' },
      include: { patient: true },
    });
    if (!admission) throw new Error('Active admission not found');

    // Verify doctor belongs to this hospital
    const doctor = await prisma.doctor.findFirst({ where: { id: data.doctorId, hospitalId } });
    if (!doctor) throw new Error('Doctor not found in this hospital');

    const encounterId = generateEncounterId();

    const round = await prisma.encounter.create({
      data: {
        encounterId,
        type:        'IPD',
        patientId:   admission.patientId,
        doctorId:    data.doctorId,
        admissionId,
        chiefComplaint: 'IPD Daily Round',
        diagnosis:   data.diagnosis,
        notes:       data.notes,
        vitalSigns:  data.vitalSigns,
        visitDate:   new Date(),
        status:      'COMPLETED',
      },
    });

    // Save vitals to Vitals table (feeds EHR timeline + vitals history)
    if (data.vitalSigns && typeof data.vitalSigns === 'object') {
      const vs = data.vitalSigns as any;
      const hasVitals = vs.temperature || vs.bloodPressureSystolic || vs.heartRate ||
                        vs.oxygenSaturation || vs.weight || vs.height;
      if (hasVitals) {
        await prisma.vitals.create({
          data: {
            patientId:              admission.patientId,
            encounterId:            round.id,
            temperature:            vs.temperature            ? parseFloat(vs.temperature)  : undefined,
            bloodPressureSystolic:  vs.bloodPressureSystolic  ? parseInt(vs.bloodPressureSystolic) : undefined,
            bloodPressureDiastolic: vs.bloodPressureDiastolic ? parseInt(vs.bloodPressureDiastolic) : undefined,
            heartRate:              vs.heartRate              ? parseInt(vs.heartRate)      : undefined,
            respiratoryRate:        vs.respiratoryRate        ? parseInt(vs.respiratoryRate) : undefined,
            oxygenSaturation:       vs.oxygenSaturation       ? parseFloat(vs.oxygenSaturation) : undefined,
            weight:                 vs.weight                 ? parseFloat(vs.weight)       : undefined,
            height:                 vs.height                 ? parseFloat(vs.height)       : undefined,
            bmi:                    vs.bmi                    ? parseFloat(vs.bmi)          : undefined,
            recordedAt:             new Date(),
          },
        });
      }
    }

    // Create lab orders — also create Investigation records (lab queue) with admissionId
    if (data.labOrders?.length) {
      await prisma.labOrder.createMany({
        data: data.labOrders.map((l) => ({
          orderId:     `LO-IPD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
          encounterId: round.id,
          testName:    l.testName,
          testType:    l.testType || 'LAB',
          priority:    (l.priority as any) || 'ROUTINE',
          status:      'PENDING',
        })),
      });
      // Bridge to Investigation table (lab queue) with admissionId for discharge billing
      await prisma.investigation.createMany({
        data: data.labOrders.map((l) => ({
          patientId:   admission.patientId,
          doctorId:    data.doctorId,
          hospitalId,
          encounterId: round.id,
          admissionId,
          testName:    l.testName,
          testType:    l.testType || 'LAB',
          priority:    (l.priority as any) || 'ROUTINE',
          status:      'ORDERED',
        })),
        skipDuplicates: true,
      });
    }

    // Bridge prescriptions to Prescription table with admissionId
    if (data.prescriptions?.length) {
      await prisma.prescription.create({
        data: {
          patientId:   admission.patientId,
          doctorId:    data.doctorId,
          encounterId: round.id,
          admissionId,
          medications: data.prescriptions.map((p) => ({
            name:         p.medicineName,
            dosage:       p.dosage,
            frequency:    p.frequency,
            duration:     p.duration,
            instructions: p.instructions || '',
            quantity:     1,
          })),
        },
      });
    }

    // Update the admission's diagnosis if updated in this round
    if (data.diagnosis) {
      await prisma.admission.update({
        where: { id: admissionId },
        data:  { diagnosis: data.diagnosis },
      });
    }

    return prisma.encounter.findUnique({
      where: { id: round.id },
      include: {
        doctor:        { select: { id: true, firstName: true, lastName: true } },
        prescriptions: true,
        labOrders:     true,
      },
    });
  }

  // ── Discharge ready (doctor signals; receptionist executes) ───────────────

  async markDischargeReady(admissionId: string, hospitalId: string, userId: string) {
    const admission = await prisma.admission.findFirst({
      where: { id: admissionId, hospitalId, status: 'ADMITTED' },
    });
    if (!admission) throw new Error('Active admission not found');

    return prisma.admission.update({
      where: { id: admissionId },
      data:  { dischargeReadyAt: new Date(), dischargeReadyBy: userId },
    });
  }

  // ── Discharge ─────────────────────────────────────────────────────────────

  async dischargePatient(admissionId: string, hospitalId: string, data: {
    dischargedAt?: Date;
    notes?: string;
    totalAmount?: number;
    paymentCollected?: number;
    paymentMethod?: string;   // CASH, UPI, CARD, BANK_TRANSFER
    transactionRef?: string;
  }) {
    const admission = await prisma.admission.findFirst({
      where:   { id: admissionId, hospitalId, status: 'ADMITTED' },
      include: { patient: { select: { firstName: true, lastName: true, mobile: true } } },
    });
    if (!admission) throw new Error('Active admission not found');

    const dischargedAt  = data.dischargedAt ? new Date(data.dischargedAt) : new Date();
    const days          = Math.max(1, Math.ceil(
      (dischargedAt.getTime() - admission.admittedAt.getTime()) / (1000 * 60 * 60 * 24),
    ));
    const wardCharges   = days * admission.dailyCharges;

    // Aggregate lab/medicine charges via both OPD encounter + round encounters
    const opdEncounterId = (admission as any).encounterId as string | null;
    const roundIds = (await prisma.encounter.findMany({
      where:  { admissionId: admissionId },
      select: { id: true },
    })).map(e => e.id);

    const allEncIds = [...(opdEncounterId ? [opdEncounterId] : []), ...roundIds];

    const labInvestigations = await prisma.investigation.findMany({
      where: {
        hospitalId,
        OR: [
          { admissionId: admissionId },
          ...(allEncIds.length ? [{ encounterId: { in: allEncIds } }] : []),
        ],
      },
      select: { amount: true },
    });
    const labCharges = labInvestigations.reduce((s, i) => s + Number(i.amount ?? 0), 0);

    const dispensedRx = await prisma.prescription.findMany({
      where: {
        status: 'DISPENSED',
        OR: [
          { admissionId: admissionId },
          ...(allEncIds.length ? [{ encounterId: { in: allEncIds } }] : []),
        ],
      },
      select: { totalCharges: true },
    });
    const medicineCharges = dispensedRx.reduce((s, r) => s + Number(r.totalCharges ?? 0), 0);

    // OPD consultation fee from the triggering encounter
    let consultationFee = 0;
    if (opdEncounterId) {
      const opdEnc = await prisma.encounter.findUnique({
        where:  { id: opdEncounterId },
        select: { consultationFee: true },
      });
      consultationFee = Number(opdEnc?.consultationFee ?? 0);
    }

    const computedTotal = wardCharges + consultationFee + labCharges + medicineCharges;
    const totalAmount   = data.totalAmount ?? computedTotal;
    const collected     = data.paymentCollected ?? 0;
    const alreadyPaid   = admission.advancePaid;
    const totalReceived = collected + alreadyPaid;
    const paymentStatus = totalReceived >= totalAmount ? 'PAID'
                        : totalReceived > 0            ? 'PARTIAL'
                        :                               'PENDING';

    const updated = await prisma.admission.update({
      where: { id: admissionId },
      data:  {
        status:            'DISCHARGED',
        dischargedAt,
        notes:             data.notes ?? admission.notes ?? undefined,
        totalAmount,
        paymentCollected:  collected,
        paymentMethod:     data.paymentMethod,
        transactionRef:    data.transactionRef,
        paymentSettledAt:  collected > 0 ? new Date() : undefined,
        paymentStatus,
      },
    });

    // Free the bed
    if (admission.bedId) {
      await prisma.bed.update({ where: { id: admission.bedId }, data: { status: 'AVAILABLE' } });
    }

    // Create a Payment record for the discharge settlement
    if (collected > 0) {
      await prisma.payment.create({
        data: {
          patientId:     admission.patientId,
          hospitalId,
          admissionId:   admissionId,
          amount:        collected,
          paymentMethod: (data.paymentMethod as any) || 'CASH',
          status:        'PAID',
          paidAt:        new Date(),
          transactionId: data.transactionRef || undefined,
          receiptNumber: generateReceiptNumber(),
          description:   `IPD Discharge — ${admission.admissionNumber} (${days}d)`,
        },
      });
    }

    // SMS notification
    if (admission.patient?.mobile) {
      smsService.sendDischargeNotification({
        mobile:          admission.patient.mobile,
        patientName:     `${admission.patient.firstName} ${admission.patient.lastName}`,
        hospitalName:    'MediSync Hospital',
        admissionNumber: admission.admissionNumber,
      }).catch(() => {/* silent */});
    }

    return { ...updated, days, wardCharges, labCharges, medicineCharges, totalAmount, balance: Math.max(0, totalAmount - totalReceived) };
  }

  // ── Get itemized bill preview for an admission ──────────────────────────

  async getAdmissionBill(admissionId: string, hospitalId: string) {
    const admission = await prisma.admission.findFirst({
      where: { id: admissionId, hospitalId },
      select: {
        admittedAt: true, dischargedAt: true,
        dailyCharges: true, advancePaid: true, admissionNumber: true,
        encounterId: true,  // OPD encounter that triggered the admission
        patient: { select: { firstName: true, lastName: true, uhid: true } },
        ward:    { select: { name: true } },
        bed:     { select: { bedNumber: true } },
      },
    });
    if (!admission) throw new Error('Admission not found');

    const now         = new Date();
    const endDate     = admission.dischargedAt ?? now;
    const days        = Math.max(1, Math.ceil(
      (endDate.getTime() - admission.admittedAt.getTime()) / (1000 * 60 * 60 * 24)));
    const wardCharges = days * admission.dailyCharges;

    // IPD daily-round encounter IDs
    const roundEncounters = await prisma.encounter.findMany({
      where:  { admissionId },
      select: { id: true, visitDate: true, diagnosis: true },
      orderBy: { visitDate: 'asc' },
    });
    const roundIds = roundEncounters.map(e => e.id);

    // All encounter IDs to search across: OPD trigger + all IPD rounds
    const allEncounterIds = [
      ...(admission.encounterId ? [admission.encounterId] : []),
      ...roundIds,
    ];

    // ── Lab investigations ─────────────────────────────────────────────────
    const labInvestigations = allEncounterIds.length
      ? await prisma.investigation.findMany({
          where: {
            hospitalId,
            OR: [
              { admissionId },
              { encounterId: { in: allEncounterIds } },
            ],
          },
          select: { id: true, testName: true, testType: true, amount: true, status: true, reportedAt: true, encounterId: true },
          orderBy: { orderedAt: 'asc' },
        })
      : await prisma.investigation.findMany({
          where: { admissionId, hospitalId },
          select: { id: true, testName: true, testType: true, amount: true, status: true, reportedAt: true, encounterId: true },
          orderBy: { orderedAt: 'asc' },
        });

    // LabOrders as fallback for encounters that have no matching Investigation rows
    const labOrders = allEncounterIds.length ? await prisma.labOrder.findMany({
      where:  { encounterId: { in: allEncounterIds } },
      select: { testName: true, testType: true, status: true, encounterId: true },
    }) : [];
    const investigationTestNames = new Set(labInvestigations.map(i => i.testName.toLowerCase()));
    const extraLabOrders = labOrders.filter(lo => !investigationTestNames.has(lo.testName.toLowerCase()));

    // ── Prescriptions (Prescription table — new-style) ────────────────────
    const prescriptions = allEncounterIds.length
      ? await prisma.prescription.findMany({
          where: {
            OR: [
              { admissionId },
              { encounterId: { in: allEncounterIds } },
            ],
          },
          select: { medications: true, totalCharges: true, status: true, issuedAt: true, encounterId: true },
          orderBy: { issuedAt: 'asc' },
        })
      : await prisma.prescription.findMany({
          where: { admissionId },
          select: { medications: true, totalCharges: true, status: true, issuedAt: true, encounterId: true },
          orderBy: { issuedAt: 'asc' },
        });

    // ── EncounterPrescriptions (old-style, pre-migration) ─────────────────
    const encPrescriptions = allEncounterIds.length ? await prisma.encounterPrescription.findMany({
      where:  { encounterId: { in: allEncounterIds } },
      select: { medicineName: true, dosage: true, frequency: true, duration: true, quantity: true, price: true, encounterId: true },
    }) : [];

    const labCharges      = labInvestigations.reduce((s, i) => s + Number(i.amount ?? 0), 0);
    const medicineCharges = prescriptions.filter(r => r.status === 'DISPENSED')
                                         .reduce((s, r) => s + Number(r.totalCharges ?? 0), 0);

    // OPD consultation fee from the triggering encounter
    let consultationFee = 0;
    let opdDoctor: string | undefined;
    if (admission.encounterId) {
      const opdEncounter = await prisma.encounter.findUnique({
        where:  { id: admission.encounterId },
        select: {
          consultationFee: true,
          doctor: { select: { firstName: true, lastName: true, specialization: true } },
        },
      });
      if (opdEncounter) {
        consultationFee = Number(opdEncounter.consultationFee ?? 0);
        if (opdEncounter.doctor) {
          opdDoctor = `Dr. ${opdEncounter.doctor.firstName} ${opdEncounter.doctor.lastName}${opdEncounter.doctor.specialization ? ` (${opdEncounter.doctor.specialization})` : ''}`;
        }
      }
    }

    const total = wardCharges + consultationFee + labCharges + medicineCharges;

    return {
      admissionNumber:  admission.admissionNumber,
      patient:          admission.patient,
      ward:             admission.ward?.name,
      bed:              admission.bed?.bedNumber,
      days,
      dailyRate:        admission.dailyCharges,
      wardCharges,
      consultationFee,
      opdDoctor,
      labCharges,
      medicineCharges,
      total,
      advancePaid:      admission.advancePaid,
      balance:          Math.max(0, total - admission.advancePaid),
      labItems:         labInvestigations,
      extraLabOrders,
      rxItems:          prescriptions,
      encPrescriptions,
      rounds:           roundEncounters,
    };
  }

  // ── Ward overview for Ward Manager ───────────────────────────────────────

  async getWardOverview(hospitalId: string) {
    const wards = await prisma.ward.findMany({
      where:   { hospitalId, isActive: true },
      include: {
        beds: {
          include: {
            admissions: {
              where:   { status: 'ADMITTED' },
              include: { patient: { select: { firstName: true, lastName: true, uhid: true } } },
              take:    1,
              orderBy: { admittedAt: 'desc' },
            },
          },
        },
      },
    });

    return wards.map((ward) => {
      const totalBeds     = ward.beds.length || ward.totalBeds;
      const occupiedBeds  = ward.beds.filter((b: any) => b.status === 'OCCUPIED').length;
      const availableBeds = ward.beds.filter((b: any) => b.status === 'AVAILABLE').length;
      const occupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

      return {
        id:           ward.id,
        name:         ward.name,
        type:         ward.type,
        floor:        ward.floor,
        dailyCharges: ward.dailyCharges,
        totalBeds,
        occupiedBeds,
        availableBeds,
        occupancyRate,
        beds: ward.beds.map((b: any) => ({
          id:             b.id,
          bedNumber:      b.bedNumber,
          status:         b.status,
          currentPatient: b.admissions[0]?.patient ?? null,
          admittedAt:     b.admissions[0]?.admittedAt ?? null,
        })),
      };
    });
  }
}

export default new IPDService();
