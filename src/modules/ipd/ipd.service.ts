import prisma from '../../common/config/database';
import smsService from '../../common/utils/smsService';
import documentService from '../document/document.service';
import logger from '../../common/config/logger';

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

  // ── Delete operations (only if not occupied) ────────────────────────────

  async deleteBed(bedId: string, hospitalId: string) {
    const bed = await prisma.bed.findFirst({
      where: { id: bedId, ward: { hospitalId } },
    });
    if (!bed) throw new Error('Bed not found');
    if (bed.status === 'OCCUPIED') throw new Error('Cannot delete an occupied bed');

    const activeAdmission = await prisma.admission.findFirst({
      where: { bedId, status: { in: ['ADMITTED', 'DISCHARGE_READY'] } },
    });
    if (activeAdmission) throw new Error('Cannot delete bed with active admission');

    return prisma.bed.delete({ where: { id: bedId } });
  }

  async deleteWard(wardId: string, hospitalId: string) {
    const ward = await prisma.ward.findFirst({
      where: { id: wardId, hospitalId },
      include: { beds: { select: { id: true, status: true } } },
    });
    if (!ward) throw new Error('Ward not found');

    const occupiedBeds = (ward as any).beds.filter((b: any) => b.status === 'OCCUPIED');
    if (occupiedBeds.length > 0) throw new Error('Cannot delete ward with occupied beds');

    const activeAdmissions = await prisma.admission.count({
      where: { wardId, status: { in: ['ADMITTED', 'DISCHARGE_READY'] } },
    });
    if (activeAdmissions > 0) throw new Error('Cannot delete ward with active admissions');

    // Delete all beds first, then the ward
    await prisma.bed.deleteMany({ where: { wardId } });
    return prisma.ward.delete({ where: { id: wardId } });
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
            prescriptions: true,  // EncounterPrescription (old-style)
            labOrders: true,
          },
          orderBy: { visitDate: 'asc' },
        },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!admission) throw new Error('Admission not found');

    // Attach new-style Prescription rows (created during IPD rounds) grouped by encounterId
    const roundEncounterIds = (admission as any).rounds.map((r: any) => r.id);
    const rxByAdmission = await (prisma as any).prescription.findMany({
      where: {
        OR: [
          { admissionId },
          ...(roundEncounterIds.length ? [{ encounterId: { in: roundEncounterIds } }] : []),
        ],
      },
      include: {
        doctor: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { issuedAt: 'asc' },
    });

    // Attach to each round by encounterId for easy UI access
    const rxByEncounter: Record<string, any[]> = {};
    rxByAdmission.forEach((rx: any) => {
      const key = rx.encounterId || 'admission';
      if (!rxByEncounter[key]) rxByEncounter[key] = [];
      rxByEncounter[key].push(rx);
    });

    const rounds = (admission as any).rounds.map((round: any) => ({
      ...round,
      newPrescriptions: rxByEncounter[round.id] || [],
    }));

    return {
      ...(admission as any),
      rounds,
      allPrescriptions: rxByAdmission, // full flat list for the UI summary panel
    };
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
    // Verify patient belongs to this hospital
    const patient = await prisma.patient.findUnique({
      where: { id: data.patientId },
      select: { hospitalId: true },
    });
    if (!patient) throw new Error('Patient not found');
    if (patient.hospitalId !== hospitalId) {
      throw new Error('Access denied: Patient belongs to a different hospital');
    }

    // Prevent duplicate active admissions for the same patient (ADMITTED or DISCHARGE_READY)
    const existingActive = await prisma.admission.findFirst({
      where: { patientId: data.patientId, hospitalId, status: { in: ['ADMITTED', 'DISCHARGE_READY'] } },
      select: { admissionNumber: true, status: true },
    });
    if (existingActive) {
      throw new Error(`Patient already has an active admission (${existingActive.admissionNumber}, status: ${existingActive.status}). Discharge first before readmitting.`);
    }

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

    // Clear the doctor's "admission recommended" flag on the originating OPD
    // encounter — the recommendation has been acted on, so the warning badge
    // should disappear from appointment / encounter / patient profile rows.
    if (data.encounterId) {
      await prisma.encounter.updateMany({
        where: { id: data.encounterId, admissionRequired: true },
        data:  { admissionRequired: false },
      });
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
      where: { id: admissionId, hospitalId },
    });
    if (!admission) throw new Error('Admission not found');
    if (admission.status === 'DISCHARGE_READY') throw new Error('Patient is already marked as discharge-ready');
    if (admission.status === 'DISCHARGED') throw new Error('Patient is already discharged');
    if (admission.status !== 'ADMITTED') throw new Error(`Cannot mark discharge-ready from status: ${admission.status}`);

    return prisma.admission.update({
      where: { id: admissionId },
      data:  { status: 'DISCHARGE_READY', dischargeReadyAt: new Date(), dischargeReadyBy: userId },
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
  }, _userRole?: string) {
    const admission = await prisma.admission.findFirst({
      where:   { id: admissionId, hospitalId },
      include: { patient: { select: { firstName: true, lastName: true, mobile: true } } },
    });
    if (!admission) throw new Error('Admission not found');

    if (admission.status === 'DISCHARGED') {
      throw new Error('Patient is already discharged');
    }

    // Discharge-ready is a hard prerequisite for *every* role — including
    // SUPER_ADMIN. Clinical sign-off must always come from a doctor before
    // billing settles. If a force-override is ever needed, that should be a
    // separate, audited endpoint — not a quiet bypass here.
    if (admission.status === 'ADMITTED') {
      throw new Error('Doctor must mark patient as discharge-ready before discharge can proceed');
    }

    if (admission.status !== 'DISCHARGE_READY') {
      throw new Error(`Cannot discharge from status: ${admission.status}`);
    }

    const dischargedAt  = data.dischargedAt ? new Date(data.dischargedAt) : new Date();
    const days          = Math.max(1, Math.ceil(
      (dischargedAt.getTime() - admission.admittedAt.getTime()) / (1000 * 60 * 60 * 24),
    ));
    const wardCharges   = days * Number(admission.dailyCharges);

    // Aggregate lab/medicine charges from IPD round encounters + admission-linked items ONLY
    // Do NOT re-include OPD encounter charges if OPD was already billed/paid
    const opdEncounterId = (admission as any).encounterId as string | null;
    const roundIds = (await prisma.encounter.findMany({
      where:  { admissionId: admissionId },
      select: { id: true },
    })).map(e => e.id);

    // Check if OPD encounter was already paid — if so, exclude it from IPD bill
    let opdAlreadyPaid = false;
    let consultationFee = 0;
    if (opdEncounterId) {
      const opdEnc = await prisma.encounter.findUnique({
        where:  { id: opdEncounterId },
        select: { consultationFee: true, paymentCollected: true, paymentStatus: true, totalAmount: true },
      });
      const opdPaid = Number(opdEnc?.paymentCollected ?? 0);
      opdAlreadyPaid = opdPaid > 0 || opdEnc?.paymentStatus === 'PAID';
      if (!opdAlreadyPaid) {
        consultationFee = Number(opdEnc?.consultationFee ?? 0);
      }
    }

    // Only include OPD encounter in charge queries if it wasn't already paid
    const encIdsForCharges = [
      ...(!opdAlreadyPaid && opdEncounterId ? [opdEncounterId] : []),
      ...roundIds,
    ];

    const labInvestigations = await prisma.investigation.findMany({
      where: {
        hospitalId,
        OR: [
          { admissionId: admissionId },
          ...(encIdsForCharges.length ? [{ encounterId: { in: encIdsForCharges } }] : []),
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
          ...(encIdsForCharges.length ? [{ encounterId: { in: encIdsForCharges } }] : []),
        ],
      },
      select: { totalCharges: true },
    });
    const medicineCharges = dispensedRx.reduce((s, r) => s + Number(r.totalCharges ?? 0), 0);

    const computedTotal = wardCharges + consultationFee + labCharges + medicineCharges;
    const discount      = (admission as any).discountAmount || 0;
    const afterDiscount = Math.max(0, computedTotal - discount);
    const totalAmount   = data.totalAmount ?? afterDiscount;
    const collected     = data.paymentCollected ?? 0;
    const alreadyPaid   = Number(admission.advancePaid);
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

    // Mark linked OPD encounter + its appointment as COMPLETED on discharge
    if (opdEncounterId) {
      await prisma.encounter.updateMany({
        where: { id: opdEncounterId, status: { not: 'COMPLETED' } },
        data:  { status: 'COMPLETED' },
      });
      // Appointment references encounter via encounterId
      await prisma.appointment.updateMany({
        where: { encounterId: opdEncounterId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        data:  { status: 'COMPLETED' },
      });
    }

    // Mark all IPD round encounters as COMPLETED
    if (roundIds.length > 0) {
      await prisma.encounter.updateMany({
        where: { id: { in: roundIds }, status: { not: 'COMPLETED' } },
        data:  { status: 'COMPLETED' },
      });
    }

    // Fire-and-forget: generate discharge summary document + SMS with download link
    try {
      const hospitalRecord = await prisma.hospital.findUnique({
        where: { id: hospitalId },
        select: { name: true },
      });
      const hospitalName = hospitalRecord?.name || 'MediSync Hospital';
      const patientName = `${admission.patient?.firstName || ''} ${admission.patient?.lastName || ''}`.trim();
      const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5000';

      // Generate discharge summary data and store as document
      this.getDischargeSummary(admissionId, hospitalId)
        .then(async (summaryData) => {
          const summaryJson = Buffer.from(JSON.stringify(summaryData), 'utf-8');

          const doc = await documentService.generateDocument({
            patientId:   admission.patientId,
            admissionId,
            type:        'DISCHARGE_SUMMARY',
            hospitalId,
            generatedBy: 'system',
            content:     summaryJson,
            fileName:    `discharge_summary_${admission.admissionNumber}.pdf`,
          });

          // Send SMS with time-limited download link
          if (admission.patient?.mobile) {
            const token = documentService.generateDownloadToken(doc.id, 60 * 24);
            const downloadUrl = `${baseUrl}/api/documents/public/${token}`;

            await smsService.sendSMS({
              to: admission.patient.mobile,
              message: `Dear ${patientName}, you have been discharged from ${hospitalName} (Admission: ${admission.admissionNumber}). Download your discharge summary: ${downloadUrl} (valid 24hrs). Thank you. - MediSync`,
            });
          }
        })
        .catch((docErr) => {
          logger.error('Failed to generate discharge document or send SMS', { error: docErr.message, admissionId });
        });

      // Fallback: still send basic discharge SMS even if document generation is slow
      if (admission.patient?.mobile) {
        smsService.sendDischargeNotification({
          mobile:          admission.patient.mobile,
          patientName,
          hospitalName,
          admissionNumber: admission.admissionNumber,
        }).catch(() => {/* silent */});
      }
    } catch (smsDocErr) {
      logger.error('Discharge SMS/document block failed', { error: (smsDocErr as any).message, admissionId });
    }

    return { ...updated, days, wardCharges, consultationFee, labCharges, medicineCharges, totalAmount, balance: Math.max(0, totalAmount - totalReceived) };
  }

  // ── Apply Discount (ADMIN/SUPER_ADMIN only) ─────────────────────────────

  async applyDiscount(admissionId: string, hospitalId: string, data: {
    amount: number;
    reason?: string;
    approvedBy: string;
  }) {
    const admission = await prisma.admission.findFirst({
      where: { id: admissionId, hospitalId, status: { in: ['ADMITTED', 'DISCHARGE_READY'] } },
    });
    if (!admission) throw new Error('Active admission not found');
    if (data.amount < 0) throw new Error('Discount amount must be non-negative');

    return prisma.admission.update({
      where: { id: admissionId },
      data: {
        discountAmount: data.amount,
        discountReason: data.reason || undefined,
        discountApprovedBy: data.approvedBy,
      },
    });
  }

  // ── Collect partial payment during stay ─────────────────────────────────

  async collectPayment(admissionId: string, hospitalId: string, data: {
    amount: number;
    paymentMethod: string;
    transactionRef?: string;
  }) {
    const admission = await prisma.admission.findFirst({
      where: { id: admissionId, hospitalId },
      include: { patient: { select: { firstName: true, lastName: true } } },
    });
    if (!admission) throw new Error('Admission not found');
    if (admission.status === 'DISCHARGED') throw new Error('Cannot collect payment on a discharged admission. Use the discharge billing flow instead.');
    if (!['ADMITTED', 'DISCHARGE_READY'].includes(admission.status)) throw new Error(`Cannot collect payment on admission with status: ${admission.status}`);
    if (admission.paymentStatus === 'PAID') throw new Error('All payments have already been collected for this admission');
    if (data.amount <= 0) throw new Error('Amount must be greater than zero');

    const newAdvance = (Number(admission.advancePaid) || 0) + data.amount;

    await prisma.admission.update({
      where: { id: admissionId },
      data: {
        advancePaid: newAdvance,
        paymentStatus: 'PARTIAL',
      },
    });

    const payment = await prisma.payment.create({
      data: {
        patientId:     admission.patientId,
        hospitalId,
        admissionId,
        amount:        data.amount,
        paymentMethod: data.paymentMethod as any,
        status:        'PAID',
        paidAt:        new Date(),
        transactionId: data.transactionRef || undefined,
        receiptNumber: generateReceiptNumber(),
        description:   `IPD Payment — ${admission.admissionNumber}`,
      },
    });

    return { admission: { ...admission, advancePaid: newAdvance }, payment };
  }

  // ── Get itemized bill preview for an admission ──────────────────────────

  async getAdmissionBill(admissionId: string, hospitalId: string) {
    const admission = await prisma.admission.findFirst({
      where: { id: admissionId, hospitalId },
      select: {
        admittedAt: true, dischargedAt: true,
        dailyCharges: true, advancePaid: true, admissionNumber: true,
        encounterId: true, discountAmount: true, discountReason: true, status: true,
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
    const wardCharges = days * Number(admission.dailyCharges);

    // IPD daily-round encounter IDs
    const roundEncounters = await prisma.encounter.findMany({
      where:  { admissionId },
      select: { id: true, visitDate: true, diagnosis: true },
      orderBy: { visitDate: 'asc' },
    });
    const roundIds = roundEncounters.map(e => e.id);

    // Check if OPD encounter was already paid — if so, exclude it from IPD bill to avoid double-counting
    let opdAlreadyPaid = false;
    let consultationFee = 0;
    let opdDoctor: string | undefined;
    if (admission.encounterId) {
      const opdEncounter = await prisma.encounter.findUnique({
        where:  { id: admission.encounterId },
        select: {
          consultationFee: true, paymentCollected: true, paymentStatus: true,
          doctor: { select: { firstName: true, lastName: true, specialization: true } },
        },
      });
      if (opdEncounter) {
        const opdPaid = Number(opdEncounter.paymentCollected ?? 0);
        opdAlreadyPaid = opdPaid > 0 || opdEncounter.paymentStatus === 'PAID';
        if (!opdAlreadyPaid) {
          consultationFee = Number(opdEncounter.consultationFee ?? 0);
        }
        if (opdEncounter.doctor) {
          opdDoctor = `Dr. ${opdEncounter.doctor.firstName} ${opdEncounter.doctor.lastName}${opdEncounter.doctor.specialization ? ` (${opdEncounter.doctor.specialization})` : ''}`;
        }
      }
    }

    // Encounter IDs to search for charges: only IPD rounds + unpaid OPD encounter
    const encIdsForCharges = [
      ...(!opdAlreadyPaid && admission.encounterId ? [admission.encounterId] : []),
      ...roundIds,
    ];

    // ── Lab investigations ─────────────────────────────────────────────────
    const labInvestigations = encIdsForCharges.length
      ? await prisma.investigation.findMany({
          where: {
            hospitalId,
            OR: [
              { admissionId },
              { encounterId: { in: encIdsForCharges } },
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
    const allEncounterIds = [
      ...(admission.encounterId ? [admission.encounterId] : []),
      ...roundIds,
    ];
    const labOrders = allEncounterIds.length ? await prisma.labOrder.findMany({
      where:  { encounterId: { in: allEncounterIds } },
      select: { testName: true, testType: true, status: true, encounterId: true },
    }) : [];
    const investigationTestNames = new Set(labInvestigations.map(i => i.testName.toLowerCase()));
    const extraLabOrders = labOrders.filter(lo => !investigationTestNames.has(lo.testName.toLowerCase()));

    // ── Prescriptions (Prescription table — new-style) ────────────────────
    const prescriptions = encIdsForCharges.length
      ? await prisma.prescription.findMany({
          where: {
            OR: [
              { admissionId },
              { encounterId: { in: encIdsForCharges } },
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

    // Bill only investigations that are actually completed. Pending / in-progress
    // tests will be billed once they finish — including them here causes patients
    // to pay for samples that were never reported. Cancelled tests are skipped.
    const billableInvestigations = labInvestigations.filter(
      (i) => i.status === 'COMPLETED',
    );
    const labCharges      = billableInvestigations.reduce((s, i) => s + Number(i.amount ?? 0), 0);
    const medicineCharges = prescriptions.filter(r => r.status === 'DISPENSED')
                                         .reduce((s, r) => s + Number(r.totalCharges ?? 0), 0);

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
      discount:         (admission as any).discountAmount || 0,
      discountReason:   (admission as any).discountReason || null,
      totalAfterDiscount: Math.max(0, total - ((admission as any).discountAmount || 0)),
      advancePaid:      admission.advancePaid,
      balance:          Math.max(0, total - ((admission as any).discountAmount || 0) - Number(admission.advancePaid)),
      status:           (admission as any).status,
      labItems:         labInvestigations,
      extraLabOrders,
      rxItems:          prescriptions,
      encPrescriptions,
      rounds:           roundEncounters,
    };
  }

  // ── Discharge Summary data (for PDF generation) ─────────────────────────

  async getDischargeSummary(admissionId: string, hospitalId: string) {
    const admission = await (prisma.admission as any).findFirst({
      where: { id: admissionId, hospitalId },
      include: {
        patient: {
          select: {
            id: true, firstName: true, lastName: true, uhid: true, mobile: true,
            gender: true, dob: true, bloodGroup: true, email: true, address: true,
          },
        },
        ward: { select: { name: true, type: true, dailyCharges: true } },
        bed: { select: { bedNumber: true } },
        encounter: {
          include: {
            doctor: { select: { id: true, firstName: true, lastName: true, specialization: true, registrationNo: true } },
            prescriptions: true,
            labOrders: true,
          },
        },
      },
    });
    if (!admission) throw new Error('Admission not found');

    const rounds = await prisma.encounter.findMany({
      where: { admissionId },
      include: {
        doctor: { select: { firstName: true, lastName: true, specialization: true } },
      },
      orderBy: { visitDate: 'asc' },
    });

    const hospital = await prisma.hospital.findUnique({
      where: { id: hospitalId },
      select: {
        name: true, addressLine1: true, city: true, state: true,
        country: true, phone: true, email: true, website: true, gstNumber: true,
      },
    });

    const bill = await this.getAdmissionBill(admissionId, hospitalId);

    const roundIds = rounds.map(r => r.id);
    const opdEncId = admission.encounter?.id;
    const allEncIds = [...(opdEncId ? [opdEncId] : []), ...roundIds];
    const investigations = allEncIds.length ? await prisma.investigation.findMany({
      where: {
        hospitalId,
        OR: [
          { admissionId },
          { encounterId: { in: allEncIds } },
        ],
      },
      select: { testName: true, testType: true, results: true, status: true, reportedAt: true, orderedAt: true },
      orderBy: { orderedAt: 'asc' },
    }) : [];

    const prescriptions = allEncIds.length ? await prisma.prescription.findMany({
      where: {
        OR: [
          { admissionId },
          { encounterId: { in: allEncIds } },
        ],
      },
      select: { medications: true, status: true, issuedAt: true },
      orderBy: { issuedAt: 'desc' },
    }) : [];

    const now = new Date();
    const endDate = admission.dischargedAt ?? now;
    const days = Math.max(1, Math.ceil((endDate.getTime() - admission.admittedAt.getTime()) / 86400000));

    const doctorMap = new Map<string, any>();
    if (admission.encounter?.doctor) {
      const d = admission.encounter.doctor;
      doctorMap.set(d.id, { name: `Dr. ${d.firstName} ${d.lastName}`, specialization: d.specialization, role: 'Admitting Doctor' });
    }
    rounds.forEach(r => {
      if (r.doctor && !doctorMap.has(r.doctorId)) {
        doctorMap.set(r.doctorId, { name: `Dr. ${r.doctor.firstName} ${r.doctor.lastName}`, specialization: r.doctor.specialization, role: 'Attending Doctor' });
      }
    });

    // Parse patient address (stored as JSON)
    const addr = admission.patient?.address;
    let addressStr = '';
    if (typeof addr === 'string') addressStr = addr;
    else if (addr && typeof addr === 'object') {
      addressStr = [addr.line1, addr.addressLine1, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ');
    }

    return {
      hospital,
      patient: { ...admission.patient, addressFormatted: addressStr },
      admission: {
        admissionNumber: admission.admissionNumber,
        admittedAt: admission.admittedAt,
        dischargedAt: admission.dischargedAt,
        ward: admission.ward?.name,
        bed: admission.bed?.bedNumber,
        days,
        admissionReason: admission.admissionReason,
        diagnosis: admission.diagnosis,
        notes: admission.notes,
        status: admission.status,
      },
      doctors: Array.from(doctorMap.values()),
      rounds: rounds.map(r => ({
        date: r.visitDate,
        doctor: `Dr. ${r.doctor?.firstName || ''} ${r.doctor?.lastName || ''}`.trim(),
        notes: r.notes,
        diagnosis: r.diagnosis,
        vitals: r.vitalSigns ? JSON.stringify(r.vitalSigns) : undefined,
      })),
      investigations: investigations.map(inv => ({
        testName: inv.testName,
        testType: inv.testType,
        result: inv.results ? (typeof inv.results === 'string' ? inv.results : JSON.stringify(inv.results)) : undefined,
        date: inv.orderedAt || inv.reportedAt,
        status: inv.status,
      })),
      medications: prescriptions.flatMap(rx => {
        const meds = Array.isArray(rx.medications) ? rx.medications : [];
        return (meds as any[]).map(m => ({
          name: m.name || m.medicineName || '',
          dosage: m.dosage || '',
          frequency: m.frequency || '',
          duration: m.duration || '',
          instructions: m.instructions || '',
        }));
      }),
      billing: {
        wardCharges: bill.wardCharges,
        consultationFee: bill.consultationFee,
        labCharges: bill.labCharges,
        medicineCharges: bill.medicineCharges,
        totalAmount: bill.total,
        advancePaid: bill.advancePaid,
        amountCollected: admission.paymentCollected || 0,
        balance: bill.balance,
      },
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
      const maintenanceBeds = ward.beds.filter((b: any) => b.status === 'UNDER_MAINTENANCE').length;
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
        maintenanceBeds,
        occupancyRate,
        beds: ward.beds.map((b: any) => ({
          id:              b.id,
          bedNumber:       b.bedNumber,
          status:          b.status,
          bedType:         b.bedType,
          hasOxygen:       b.hasOxygen,
          hasVentilator:   b.hasVentilator,
          hasMonitor:      b.hasMonitor,
          hasSuction:      b.hasSuction,
          cleaningStatus:  b.cleaningStatus,
          lastCleanedAt:   b.lastCleanedAt,
          maintenanceNote: b.maintenanceNote,
          maintenanceFrom: b.maintenanceFrom,
          maintenanceTo:   b.maintenanceTo,
          currentPatient:  b.admissions[0]?.patient ?? null,
          admittedAt:      b.admissions[0]?.admittedAt ?? null,
        })),
      };
    });
  }

  // ── Bulk Bed Creation ───────────────────────────────────────────────────────

  async bulkCreateBeds(wardId: string, hospitalId: string, data: {
    prefix: string;
    startNumber: number;
    count: number;
    bedType?: string;
    hasOxygen?: boolean;
    hasVentilator?: boolean;
    hasMonitor?: boolean;
    hasSuction?: boolean;
  }) {
    const ward = await prisma.ward.findFirst({ where: { id: wardId, hospitalId } });
    if (!ward) throw new Error('Ward not found');
    if (data.count <= 0 || data.count > 100) throw new Error('Count must be between 1 and 100');

    const beds = [];
    for (let i = 0; i < data.count; i++) {
      const num = data.startNumber + i;
      const bedNumber = `${data.prefix}${String(num).padStart(3, '0')}`;
      beds.push({
        bedNumber,
        wardId,
        status: 'AVAILABLE' as any,
        bedType: (data.bedType as any) || 'STANDARD',
        hasOxygen: data.hasOxygen || false,
        hasVentilator: data.hasVentilator || false,
        hasMonitor: data.hasMonitor || false,
        hasSuction: data.hasSuction || false,
      });
    }

    const result = await prisma.bed.createMany({ data: beds, skipDuplicates: true });
    logger.info(`Bulk created ${result.count} beds in ward ${ward.name} (${hospitalId})`);
    return { created: result.count, wardId, wardName: ward.name };
  }

  // ── Update Bed Details ──────────────────────────────────────────────────────

  async updateBedDetails(bedId: string, hospitalId: string, data: {
    bedType?: string;
    hasOxygen?: boolean;
    hasVentilator?: boolean;
    hasMonitor?: boolean;
    hasSuction?: boolean;
    cleaningStatus?: string;
    lastCleanedBy?: string;
    maintenanceNote?: string;
    maintenanceFrom?: string;
    maintenanceTo?: string;
  }) {
    const bed = await prisma.bed.findFirst({
      where: { id: bedId, ward: { hospitalId } },
    });
    if (!bed) throw new Error('Bed not found');

    const update: any = {};
    if (data.bedType !== undefined) update.bedType = data.bedType;
    if (data.hasOxygen !== undefined) update.hasOxygen = data.hasOxygen;
    if (data.hasVentilator !== undefined) update.hasVentilator = data.hasVentilator;
    if (data.hasMonitor !== undefined) update.hasMonitor = data.hasMonitor;
    if (data.hasSuction !== undefined) update.hasSuction = data.hasSuction;

    if (data.cleaningStatus !== undefined) {
      update.cleaningStatus = data.cleaningStatus;
      if (data.cleaningStatus === 'CLEAN') {
        update.lastCleanedAt = new Date();
        update.lastCleanedBy = data.lastCleanedBy || null;
      }
    }

    if (data.maintenanceNote !== undefined) update.maintenanceNote = data.maintenanceNote;
    if (data.maintenanceFrom !== undefined) {
      update.maintenanceFrom = new Date(data.maintenanceFrom);
      update.status = 'UNDER_MAINTENANCE';
    }
    if (data.maintenanceTo !== undefined) update.maintenanceTo = new Date(data.maintenanceTo);

    // Clear maintenance when dates are removed
    if (data.maintenanceFrom === null) {
      update.maintenanceFrom = null;
      update.maintenanceTo = null;
      update.maintenanceNote = null;
      if (bed.status === 'UNDER_MAINTENANCE') update.status = 'AVAILABLE';
    }

    return prisma.bed.update({ where: { id: bedId }, data: update });
  }

  // ── Bed Transfer ────────────────────────────────────────────────────────────

  async transferBed(hospitalId: string, data: {
    admissionId: string;
    toWardId: string;
    toBedId?: string;
    reason?: string;
    transferredBy?: string;
  }) {
    const admission = await prisma.admission.findFirst({
      where: { id: data.admissionId, hospitalId, status: 'ADMITTED' },
      include: { ward: true, bed: true },
    });
    if (!admission) throw new Error('Active admission not found');

    const toWard = await prisma.ward.findFirst({ where: { id: data.toWardId, hospitalId } });
    if (!toWard) throw new Error('Destination ward not found');

    // Validate destination bed
    if (data.toBedId) {
      const toBed = await prisma.bed.findFirst({
        where: { id: data.toBedId, wardId: data.toWardId, status: 'AVAILABLE' },
      });
      if (!toBed) throw new Error('Destination bed not available');
    }

    // Create transfer record
    const transfer = await (prisma as any).bedTransfer.create({
      data: {
        admissionId:    data.admissionId,
        fromWardId:     admission.wardId,
        fromBedId:      admission.bedId,
        toWardId:       data.toWardId,
        toBedId:        data.toBedId || null,
        reason:         data.reason,
        transferredBy:  data.transferredBy,
        newDailyCharges: toWard.dailyCharges,
        hospitalId,
      },
    });

    // Release old bed: BedStatus is the runtime status (set to AVAILABLE after
    // patient leaves) while cleaningStatus is a separate housekeeping signal.
    // Setting status to a CleaningStatus value (NEEDS_CLEANING) breaks the
    // Postgres enum and causes a hard 500.
    if (admission.bedId) {
      await prisma.bed.update({
        where: { id: admission.bedId },
        data: { status: 'AVAILABLE', cleaningStatus: 'NEEDS_CLEANING' },
      });
    }

    // Occupy new bed
    if (data.toBedId) {
      await prisma.bed.update({
        where: { id: data.toBedId },
        data: { status: 'OCCUPIED' },
      });
    }

    // Update admission record
    await prisma.admission.update({
      where: { id: data.admissionId },
      data: {
        wardId:       data.toWardId,
        bedId:        data.toBedId || null,
        dailyCharges: toWard.dailyCharges,
      },
    });

    logger.info(`Bed transfer: admission ${admission.admissionNumber} from ward ${admission.wardId} to ${data.toWardId}`);
    return transfer;
  }

  // ── Transfer History ────────────────────────────────────────────────────────

  async getTransferHistory(admissionId: string, hospitalId: string) {
    return (prisma as any).bedTransfer.findMany({
      where: { admissionId, hospitalId },
      include: {
        fromWard: { select: { name: true, type: true } },
        fromBed:  { select: { bedNumber: true } },
        toWard:   { select: { name: true, type: true } },
        toBed:    { select: { bedNumber: true } },
      },
      orderBy: { transferredAt: 'desc' },
    });
  }

  // ── Bed Analytics ───────────────────────────────────────────────────────────

  async getBedAnalytics(hospitalId: string) {
    const wards = await prisma.ward.findMany({
      where: { hospitalId, isActive: true },
      include: {
        beds: true,
        admissions: { where: { status: 'ADMITTED' } },
      },
    });

    // Overall stats
    let totalBeds = 0;
    let occupiedBeds = 0;
    let availableBeds = 0;
    let maintenanceBeds = 0;
    let reservedBeds = 0;
    let needsCleaning = 0;

    const wardStats = wards.map((ward) => {
      const wb = ward.beds.length;
      const occ = ward.beds.filter((b: any) => b.status === 'OCCUPIED').length;
      const avail = ward.beds.filter((b: any) => b.status === 'AVAILABLE').length;
      const maint = ward.beds.filter((b: any) => b.status === 'UNDER_MAINTENANCE').length;
      const res = ward.beds.filter((b: any) => b.status === 'RESERVED').length;
      const cleaning = ward.beds.filter((b: any) => b.cleaningStatus === 'NEEDS_CLEANING' || b.cleaningStatus === 'IN_PROGRESS').length;

      totalBeds += wb;
      occupiedBeds += occ;
      availableBeds += avail;
      maintenanceBeds += maint;
      reservedBeds += res;
      needsCleaning += cleaning;

      return {
        wardId:    ward.id,
        wardName:  ward.name,
        wardType:  ward.type,
        totalBeds: wb,
        occupiedBeds: occ,
        availableBeds: avail,
        maintenanceBeds: maint,
        reservedBeds: res,
        needsCleaning: cleaning,
        occupancyRate: wb > 0 ? Math.round((occ / wb) * 100) : 0,
        dailyCharges: ward.dailyCharges,
      };
    });

    // Recent transfers count (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const recentTransfers = await (prisma as any).bedTransfer.count({
      where: { hospitalId, transferredAt: { gte: weekAgo } },
    });

    // Discharges last 7 days (for bed turnover)
    const recentDischarges = await prisma.admission.count({
      where: { hospitalId, status: 'DISCHARGED', dischargedAt: { gte: weekAgo } },
    });

    const overallOccupancy = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;
    const turnoverRate = totalBeds > 0 ? Number((recentDischarges / totalBeds).toFixed(2)) : 0;

    return {
      summary: {
        totalBeds,
        occupiedBeds,
        availableBeds,
        maintenanceBeds,
        reservedBeds,
        needsCleaning,
        overallOccupancy,
        recentTransfers,
        recentDischarges,
        turnoverRate,
      },
      wardStats,
    };
  }
}

export default new IPDService();
