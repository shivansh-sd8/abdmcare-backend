import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

class EhrService {
  // ── Patient list with full EHR summary counts from DB ─────────────────────
  async getPatientList(hospitalId?: string, search?: string) {
    const where: any = { isActive: true };
    if (hospitalId) where.hospitalId = hospitalId;
    if (search) {
      where.OR = [
        { firstName:    { contains: search, mode: 'insensitive' } },
        { lastName:     { contains: search, mode: 'insensitive' } },
        { uhid:         { contains: search, mode: 'insensitive' } },
        { mobile:       { contains: search, mode: 'insensitive' } },
        { email:        { contains: search, mode: 'insensitive' } },
      ];
    }

    const patients = await prisma.patient.findMany({
      where,
      select: {
        id: true,
        uhid: true,
        firstName: true,
        lastName: true,
        gender: true,
        dob: true,
        mobile: true,
        bloodGroup: true,
        createdAt: true,
        abhaRecord: {
          select: { abhaAddress: true, abhaNumber: true },
        },
        _count: {
          select: {
            appointments:  true,
            encounters:    true,
            prescriptions: true,
            vitals:        true,
            investigations: true,
            payments:      true,
          },
        },
        appointments: {
          orderBy: { scheduledAt: 'desc' },
          take: 1,
          select: {
            scheduledAt:   true,
            status:        true,
            opdCardNumber: true,
            checkedInAt:   true,
            type:          true,
          },
        },
        encounters: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            status:         true,
            finalDiagnosis: true,
            diagnosis:      true,
            visitDate:      true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return patients;
  }

  // ── Full EHR timeline for a single patient — all events from DB ────────────
  async getPatientEHR(patientId: string, currentUser?: any) {
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      include: { abhaRecord: true },
    });

    if (!patient) throw new AppError('Patient not found', 404);

    if (
      currentUser &&
      currentUser.role !== 'SUPER_ADMIN' &&
      patient.hospitalId !== currentUser.hospitalId
    ) {
      throw new AppError('Access denied', 403);
    }

    // Fetch hospital info and all patient-linked events in parallel
    const [hospital, appointments, encounters, prescriptions, vitals, investigations, payments, admissions] =
      await Promise.all([
        prisma.hospital.findUnique({
          where: { id: patient.hospitalId ?? '' },
          select: {
            id: true, name: true,
            addressLine1: true, addressLine2: true,
            city: true, state: true, pincode: true,
            phone: true, email: true, website: true,
            registrationNumber: true, gstNumber: true,
          },
        }),
        prisma.appointment.findMany({
          where: { patientId },
          include: {
            doctor: {
              select: {
                firstName: true, lastName: true,
                specialization: true, registrationNo: true,
              },
            },
          },
          orderBy: { scheduledAt: 'asc' },
        }),

        prisma.encounter.findMany({
          where: { patientId },
          include: {
            doctor: {
              select: { firstName: true, lastName: true, specialization: true },
            },
            prescriptions: true,
            labOrders: true,
          },
          orderBy: { visitDate: 'asc' },
        }),

        prisma.prescription.findMany({
          where: { patientId },
          include: {
            doctor: { select: { firstName: true, lastName: true } },
          },
          orderBy: { issuedAt: 'asc' },
        }),

        prisma.vitals.findMany({
          where: { patientId },
          orderBy: { recordedAt: 'asc' },
        }),

        prisma.investigation.findMany({
          where: { patientId },
          include: {
            doctor: { select: { firstName: true, lastName: true } },
          },
          orderBy: { orderedAt: 'asc' },
        }),

        prisma.payment.findMany({
          where: { patientId },
          orderBy: { createdAt: 'asc' },
        }),

        (prisma as any).admission.findMany({
          where: { patientId },
          select: {
            id: true, admissionNumber: true, status: true,
            admittedAt: true, dischargedAt: true,
            admissionReason: true, diagnosis: true, notes: true,
            dailyCharges: true, advancePaid: true,
            ward: { select: { name: true, type: true } },
            bed:  { select: { bedNumber: true } },
          },
          orderBy: { admittedAt: 'asc' },
        }),
      ]);

    // ── Build unified timeline ────────────────────────────────────────────────
    const timeline: any[] = [];

    // 1. Registration (always first)
    timeline.push({
      id:          `reg-${patient.id}`,
      type:        'REGISTRATION',
      date:        patient.createdAt,
      title:       'Patient Registered',
      description: `UHID: ${patient.uhid}  ·  ${patient.gender || ''}`,
      data: {
        uhid:       patient.uhid,
        mobile:     patient.mobile,
        email:      patient.email,
        bloodGroup: patient.bloodGroup,
        dob:        patient.dob,
        abhaAddress: patient.abhaRecord?.abhaAddress,
      },
    });

    // 2. Appointments + check-ins
    appointments.forEach((apt) => {
      timeline.push({
        id:          `apt-${apt.id}`,
        type:        'APPOINTMENT',
        date:        apt.scheduledAt,
        title:       `Appointment — ${apt.type}`,
        description: `Dr. ${apt.doctor?.firstName} ${apt.doctor?.lastName}  ·  ${apt.status}`,
        status:      apt.status,
        data: {
          appointmentId: apt.appointmentId,
          type:          apt.type,
          duration:      apt.duration,
          doctor:        apt.doctor,
          notes:         apt.notes,
        },
      });

      if (apt.checkedInAt) {
        timeline.push({
          id:          `checkin-${apt.id}`,
          type:        'CHECK_IN',
          date:        apt.checkedInAt,
          title:       'Patient Checked In',
          description: `OPD Card: ${apt.opdCardNumber || 'Generated'}`,
          data: { opdCardNumber: apt.opdCardNumber },
        });
      }
    });

    // 3. Vitals recorded
    vitals.forEach((v) => {
      const parts = [
        v.bloodPressureSystolic && v.bloodPressureDiastolic
          ? `BP: ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic} mmHg`
          : null,
        v.heartRate        ? `Pulse: ${v.heartRate} bpm`      : null,
        v.temperature      ? `Temp: ${v.temperature}°C`       : null,
        v.oxygenSaturation ? `SpO₂: ${v.oxygenSaturation}%`  : null,
        v.weight           ? `Wt: ${v.weight} kg`             : null,
      ].filter(Boolean);

      timeline.push({
        id:          `vit-${v.id}`,
        type:        'VITALS',
        date:        v.recordedAt || v.createdAt,
        title:       'Vitals Recorded',
        description: parts.join('  ·  ') || 'Vitals recorded',
        data: {
          temperature:            v.temperature,
          bloodPressureSystolic:  v.bloodPressureSystolic,
          bloodPressureDiastolic: v.bloodPressureDiastolic,
          heartRate:              v.heartRate,
          respiratoryRate:        v.respiratoryRate,
          oxygenSaturation:       v.oxygenSaturation,
          weight:                 v.weight,
          height:                 v.height,
          bmi:                    v.bmi,
          recordedBy:             v.recordedBy,
          notes:                  v.notes,
        },
      });
    });

    // 4. Consultations/Encounters
    encounters.forEach((enc) => {
      timeline.push({
        id:          `enc-${enc.id}`,
        type:        'CONSULTATION',
        date:        enc.visitDate || enc.createdAt,
        title:       `Consultation — ${enc.type}`,
        description: enc.finalDiagnosis || enc.diagnosis || enc.chiefComplaint || 'Consultation',
        status:      enc.status,
        data: {
          chiefComplaint:          enc.chiefComplaint,
          historyOfPresentIllness: enc.historyOfPresentIllness,
          physicalExamination:     enc.physicalExamination,
          provisionalDiagnosis:    enc.provisionalDiagnosis,
          finalDiagnosis:          enc.finalDiagnosis || enc.diagnosis,
          notes:                   enc.notes,
          followUpDate:            enc.followUpDate,
          admissionRequired:       enc.admissionRequired,
          referralRequired:        enc.referralRequired,
          doctor:                  enc.doctor,
          prescriptions:           enc.prescriptions,
          labOrders:               enc.labOrders,
        },
      });

      // Lab orders from this encounter as separate events
      enc.labOrders?.forEach((lo) => {
        timeline.push({
          id:          `lo-${lo.id}`,
          type:        'LAB_ORDER',
          date:        lo.orderedAt || enc.visitDate || enc.createdAt,
          title:       `Lab Test Ordered — ${lo.testName}`,
          description: `${lo.testType || 'Lab'}  ·  Priority: ${lo.priority || 'ROUTINE'}  ·  ${lo.status || 'PENDING'}`,
          status:      lo.status,
          data: {
            orderId:       lo.orderId,
            testName:      lo.testName,
            testType:      lo.testType,
            priority:      lo.priority,
            status:        lo.status,
            results:       lo.results,
            resultNotes:   lo.resultNotes,
            completedAt:   lo.completedAt,
          },
        });
      });
    });

    // 5. Investigations (patient-level, from lab/radiology)
    investigations.forEach((inv) => {
      timeline.push({
        id:          `inv-${inv.id}`,
        type:        'INVESTIGATION',
        date:        inv.orderedAt || inv.createdAt,
        title:       `Investigation — ${inv.testName}`,
        description: `${inv.testType || 'Test'}  ·  ${inv.status}  ·  Priority: ${inv.priority}`,
        status:      inv.status,
        data: {
          testName:           inv.testName,
          testType:           inv.testType,
          status:             inv.status,
          priority:           inv.priority,
          instructions:       inv.instructions,
          results:            inv.results,
          reportUrl:          inv.reportUrl,
          notes:              inv.notes,
          sampleCollectedAt:  inv.sampleCollectedAt,
          reportedAt:         inv.reportedAt,
          doctor:             inv.doctor,
        },
      });
    });

    // 6. Prescriptions
    prescriptions.forEach((rx) => {
      const meds = Array.isArray(rx.medications) ? (rx.medications as any[]) : [];
      timeline.push({
        id:          `rx-${rx.id}`,
        type:        'PRESCRIPTION',
        date:        rx.issuedAt,
        title:       'Prescription Issued',
        description: `${meds.length} medicine${meds.length !== 1 ? 's' : ''}${rx.diagnosis ? `  ·  ${rx.diagnosis}` : ''}`,
        data: {
          medications: meds,
          diagnosis:   rx.diagnosis,
          doctor:      rx.doctor,
          notes:       rx.notes,
          validUntil:  rx.validUntil,
        },
      });
    });

    // 7. Payments
    payments.forEach((pay) => {
      timeline.push({
        id:          `pay-${pay.id}`,
        type:        'PAYMENT',
        date:        pay.paidAt || pay.createdAt,
        title:       `Payment — ₹${pay.amount}`,
        description: `${pay.paymentMethod || 'Unknown'}  ·  ${pay.status}  ·  ${pay.description || ''}`,
        status:      pay.status,
        data: {
          amount:        pay.amount,
          paymentMethod: pay.paymentMethod,
          status:        pay.status,
          transactionId: pay.transactionId,
          receiptNumber: pay.receiptNumber,
          description:   pay.description,
        },
      });
    });

    // 8. IPD Admissions
    admissions.forEach((adm: any) => {
      timeline.push({
        id:          `adm-${adm.id}`,
        type:        'ADMISSION',
        date:        adm.admittedAt,
        title:       `IPD Admitted — ${adm.ward?.name ?? 'Ward'}`,
        description: `${adm.admissionNumber}  ·  ${adm.status}${adm.admissionReason ? `  ·  ${adm.admissionReason}` : ''}`,
        status:      adm.status,
        data: {
          admissionNumber: adm.admissionNumber,
          ward:            adm.ward?.name,
          wardType:        adm.ward?.type,
          bed:             adm.bed?.bedNumber,
          admittedAt:      adm.admittedAt,
          dischargedAt:    adm.dischargedAt,
          admissionReason: adm.admissionReason,
          diagnosis:       adm.diagnosis,
          notes:           adm.notes,
          dailyCharges:    adm.dailyCharges,
          advancePaid:     adm.advancePaid,
        },
      });
      if (adm.dischargedAt) {
        timeline.push({
          id:          `dsc-${adm.id}`,
          type:        'DISCHARGE',
          date:        adm.dischargedAt,
          title:       'IPD Discharged',
          description: `${adm.admissionNumber}  ·  ${adm.diagnosis ?? ''}`,
          data: {
            admissionNumber: adm.admissionNumber,
            dischargedAt:    adm.dischargedAt,
            diagnosis:       adm.diagnosis,
          },
        });
      }
    });

    // Sort all events chronologically (newest first)
    timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    logger.info('EHR timeline built', { patientId, events: timeline.length });

    const totalLabOrders = encounters.reduce((s, e) => s + (e.labOrders?.length || 0), 0);

    return {
      patient,
      hospital,
      timeline,
      summary: {
        totalAppointments:   appointments.length,
        totalEncounters:     encounters.length,
        totalPrescriptions:  prescriptions.length,
        totalVitals:         vitals.length,
        totalInvestigations: investigations.length,
        totalAdmissions:     admissions.length,
        totalLabOrders,
        totalPayments:      payments.length,
        lastVisit:          appointments[appointments.length - 1]?.scheduledAt || null,
      },
    };
  }
  // ── Structured patient profile for unified Patient Profile page ────────────
  async getPatientProfile(patientId: string, currentUser?: any) {
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      include: { abhaRecord: true },
    });
    if (!patient) throw new AppError('Patient not found', 404);
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && patient.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied', 403);
    }

    const [
      hospital, encounters, prescriptions, vitals, investigations,
      payments, admissions, appointments, consents,
    ] = await Promise.all([
      patient.hospitalId
        ? prisma.hospital.findUnique({
            where: { id: patient.hospitalId },
            select: { id: true, name: true, addressLine1: true, city: true, state: true, phone: true },
          })
        : null,
      prisma.encounter.findMany({
        where: { patientId },
        include: {
          doctor: { select: { id: true, firstName: true, lastName: true, specialization: true } },
        },
        orderBy: { visitDate: 'desc' },
      }),
      prisma.prescription.findMany({
        where: { patientId },
        include: { doctor: { select: { firstName: true, lastName: true } } },
        orderBy: { issuedAt: 'desc' },
      }),
      prisma.vitals.findMany({
        where: { patientId },
        orderBy: { recordedAt: 'desc' },
      }),
      prisma.investigation.findMany({
        where: { patientId },
        include: { doctor: { select: { firstName: true, lastName: true } } },
        orderBy: { orderedAt: 'desc' },
      }),
      prisma.payment.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
      }),
      (prisma as any).admission.findMany({
        where: { patientId },
        include: {
          ward: { select: { name: true, type: true, dailyCharges: true } },
          bed: { select: { bedNumber: true } },
        },
        orderBy: { admittedAt: 'desc' },
      }),
      prisma.appointment.findMany({
        where: { patientId },
        include: { doctor: { select: { firstName: true, lastName: true, specialization: true } } },
        orderBy: { scheduledAt: 'desc' },
      }),
      prisma.consent.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // ── Billing overview ──────────────────────────────────────────────────────
    //
    // Charge computation uses ACTUAL linked items (investigations, prescriptions)
    // as source of truth, not denormalized encounter fields which can be stale.
    //
    // For each OPD encounter, we compute: consultationFee (from encounter) +
    // sum of linked investigation amounts + sum of linked dispensed prescription charges.
    // This ensures patient profile always matches what the discharge bill would compute.

    let consultationCharges = 0;
    let labCharges = 0;
    let medicineCharges = 0;
    let scanCharges = 0;
    let wardCharges = 0;
    let otherCharges = 0;
    let totalBilled = 0;
    let totalPaid = 0;

    const chargeItems: any[] = [];

    // Track encounter IDs that generated Payment rows to avoid double-counting
    const encounterPaymentDescriptions = new Set<string>();

    // Pre-build lookup maps: encounterId → linked investigation/prescription totals
    const invByEncounter = new Map<string, { lab: number; scan: number }>();
    const rxByEncounter = new Map<string, number>();
    investigations.forEach((inv: any) => {
      if (!inv.encounterId) return;
      const amt = parseFloat(inv.amount || '0');
      if (amt <= 0) return;
      const cur = invByEncounter.get(inv.encounterId) || { lab: 0, scan: 0 };
      if (inv.testType === 'RADIOLOGY') {
        cur.scan += amt;
      } else {
        cur.lab += amt;
      }
      invByEncounter.set(inv.encounterId, cur);
    });
    prescriptions.forEach((rx: any) => {
      if (!rx.encounterId || rx.status !== 'DISPENSED') return;
      const charges = parseFloat(rx.totalCharges || '0');
      if (charges > 0) {
        rxByEncounter.set(rx.encounterId, (rxByEncounter.get(rx.encounterId) || 0) + charges);
      }
    });

    // 1. OPD Encounters — primary source of OPD charges
    //    EXCLUDE IPD round encounters (type === 'IPD') — their charges belong to the admission
    encounters.forEach((e: any) => {
      if (e.type === 'IPD') return;

      const cf = parseFloat(e.consultationFee || '0');

      // Use actual linked items instead of potentially stale encounter fields
      const linkedInv = invByEncounter.get(e.id) || { lab: 0, scan: 0 };
      const linkedRx = rxByEncounter.get(e.id) || 0;

      // Take the max of encounter field vs actual items to handle both stale and correct scenarios
      const lc = Math.max(parseFloat(e.labCharges || '0'), linkedInv.lab);
      const sc = Math.max(parseFloat(e.scanCharges || '0'), linkedInv.scan);
      const mc = Math.max(parseFloat(e.medicineCharges || '0'), linkedRx);

      const total = cf + lc + mc + sc;
      const paid = parseFloat(e.paymentCollected || '0');

      consultationCharges += cf;
      labCharges += lc;
      medicineCharges += mc;
      scanCharges += sc;
      totalBilled += total;
      totalPaid += paid;

      if (total > 0 || cf > 0) {
        chargeItems.push({
          id: e.id, type: 'OPD', date: e.visitDate, status: e.paymentStatus || 'PENDING',
          description: `Consultation — Dr. ${e.doctor?.firstName || ''} ${e.doctor?.lastName || ''}`.trim(),
          detail: e.finalDiagnosis || e.diagnosis || e.chiefComplaint,
          consultation: cf, lab: lc, medicine: mc, scan: sc, ward: 0,
          total, paid, outstanding: Math.max(0, total - paid),
        });
      }
      encounterPaymentDescriptions.add(e.encounterId);
    });

    // Build encounter payment status lookup for detail row display
    const encPaymentStatus = new Map<string, string>();
    encounters.forEach((e: any) => {
      encPaymentStatus.set(e.id, e.paymentStatus || 'PENDING');
    });

    // 2. Lab investigations — detail rows for linked items, primary rows for standalone
    investigations.forEach((inv: any) => {
      const amt = parseFloat(inv.amount || '0');
      if (amt <= 0) return;

      const isStandalone = !inv.encounterId;

      if (isStandalone) {
        const isRadiology = inv.testType === 'RADIOLOGY';
        if (isRadiology) { scanCharges += amt; } else { labCharges += amt; }
        totalBilled += amt;
      }

      // Linked items reflect the parent encounter's payment status, not test completion
      const parentPayStatus = inv.encounterId ? encPaymentStatus.get(inv.encounterId) : undefined;
      const effectiveStatus = isStandalone
        ? 'PENDING'
        : (parentPayStatus === 'PAID' ? 'PAID' : 'PENDING');
      const effectivePaid = effectiveStatus === 'PAID' ? amt : 0;

      chargeItems.push({
        id: inv.id, type: 'LAB', date: inv.orderedAt,
        status: effectiveStatus,
        description: `${inv.testName} (${inv.testType || 'Lab'})`,
        detail: `Dr. ${inv.doctor?.firstName || ''} ${inv.doctor?.lastName || ''}`.trim(),
        consultation: 0, lab: amt, medicine: 0, scan: 0, ward: 0,
        total: amt, paid: effectivePaid, outstanding: amt - effectivePaid,
        isDetail: !isStandalone,
        testStatus: inv.status,
      });
    });

    // 3. Prescriptions — detail rows for linked items, primary rows for standalone
    prescriptions.forEach((rx: any) => {
      const charges = parseFloat(rx.totalCharges || '0');
      if (charges <= 0) return;

      const isStandalone = !rx.encounterId;
      if (isStandalone) {
        medicineCharges += charges;
        totalBilled += charges;
      }

      const parentPayStatus = rx.encounterId ? encPaymentStatus.get(rx.encounterId) : undefined;
      const effectiveStatus = isStandalone
        ? 'PENDING'
        : (parentPayStatus === 'PAID' ? 'PAID' : 'PENDING');
      const effectivePaid = effectiveStatus === 'PAID' ? charges : 0;

      const meds = Array.isArray(rx.medications) ? rx.medications : [];
      chargeItems.push({
        id: rx.id, type: 'PHARMACY', date: rx.issuedAt,
        status: effectiveStatus,
        description: `Prescription — ${meds.length} medication(s)`,
        detail: `Dr. ${rx.doctor?.firstName || ''} ${rx.doctor?.lastName || ''}`.trim(),
        consultation: 0, lab: 0, medicine: charges, scan: 0, ward: 0,
        total: charges, paid: effectivePaid, outstanding: charges - effectivePaid,
        isDetail: !isStandalone,
        dispensed: rx.status === 'DISPENSED',
      });
    });

    // 4. IPD Admissions — ward charges + linked round encounter charges
    //    For active admissions, compute running total from actual linked items
    admissions.forEach((a: any) => {
      const wRate = a.dailyCharges || a.ward?.dailyCharges || 0;
      const days = a.dischargedAt
        ? Math.max(1, Math.ceil((new Date(a.dischargedAt).getTime() - new Date(a.admittedAt).getTime()) / 86400000))
        : Math.max(1, Math.ceil((Date.now() - new Date(a.admittedAt).getTime()) / 86400000));
      const wc = wRate * days;

      // For active admissions, compute charges from actual linked items of round encounters
      let roundLab = 0, roundMed = 0, roundCon = 0, roundScan = 0;
      if (!a.dischargedAt) {
        const roundIds = encounters
          .filter((e: any) => e.type === 'IPD' && e.admissionId === a.id)
          .map((e: any) => e.id);

        roundIds.forEach((rid: string) => {
          const inv = invByEncounter.get(rid) || { lab: 0, scan: 0 };
          const rx = rxByEncounter.get(rid) || 0;
          const enc = encounters.find((e: any) => e.id === rid);
          roundCon += Number(enc?.consultationFee ?? 0);
          roundLab += inv.lab;
          roundScan += inv.scan;
          roundMed += rx;
        });
      }

      const total = a.totalAmount || (wc + roundCon + roundLab + roundMed + roundScan);
      const advance = a.advancePaid || 0;
      const dischargePaid = a.paymentCollected || 0;
      const paid = advance + dischargePaid;

      wardCharges += wc;
      if (!a.dischargedAt) {
        labCharges += roundLab;
        medicineCharges += roundMed;
        consultationCharges += roundCon;
        scanCharges += roundScan;
      }
      totalBilled += total;
      totalPaid += paid;

      chargeItems.push({
        id: a.id, type: 'IPD', date: a.admittedAt, status: a.paymentStatus || 'PENDING',
        description: `IPD — ${a.ward?.name || 'Ward'} (${days} day${days > 1 ? 's' : ''})`,
        detail: a.admissionNumber,
        consultation: roundCon, lab: roundLab, medicine: roundMed, scan: roundScan, ward: wc,
        total, paid, outstanding: Math.max(0, total - paid),
        advancePaid: advance,
      });
    });

    // 5. Standalone Payments — only those NOT created by encounter/admission collect-payment
    //    (Payment rows created by collectPayment have descriptions containing encounter IDs)
    payments.forEach((p: any) => {
      const desc = p.description || '';
      const isOpdReceipt = encounterPaymentDescriptions.size > 0 &&
        Array.from(encounterPaymentDescriptions).some(eid => desc.includes(eid));
      const isIpdReceipt = desc.startsWith('IPD ');

      if (isOpdReceipt || isIpdReceipt) {
        // This is a receipt for an encounter/admission payment — show as detail only, don't add to totals
        chargeItems.push({
          id: p.id, type: 'RECEIPT', date: p.paidAt || p.createdAt, status: p.status,
          description: p.description || 'Payment Receipt',
          detail: `${p.paymentMethod || ''} · ${p.receiptNumber || ''}`.trim(),
          consultation: 0, lab: 0, medicine: 0, scan: 0, ward: 0,
          total: 0, paid: p.amount || 0, outstanding: 0,
          isDetail: true,
        });
      } else if (p.status === 'PAID') {
        otherCharges += p.amount || 0;
        totalBilled += p.amount || 0;
        totalPaid += p.amount || 0;
        chargeItems.push({
          id: p.id, type: 'PAYMENT', date: p.paidAt || p.createdAt, status: 'PAID',
          description: p.description || 'Payment',
          detail: `${p.paymentMethod || ''} · ${p.receiptNumber || ''}`.trim(),
          consultation: 0, lab: 0, medicine: 0, scan: 0, ward: 0,
          total: p.amount, paid: p.amount, outstanding: 0,
        });
      } else if (p.status === 'PENDING') {
        otherCharges += p.amount || 0;
        totalBilled += p.amount || 0;
        chargeItems.push({
          id: p.id, type: 'PAYMENT', date: p.createdAt, status: 'PENDING',
          description: p.description || 'Pending Payment',
          detail: p.receiptNumber || '',
          consultation: 0, lab: 0, medicine: 0, scan: 0, ward: 0,
          total: p.amount, paid: 0, outstanding: p.amount,
        });
      }
    });

    chargeItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const round = (n: number) => Math.round(n * 100) / 100;

    const activeAdmission = admissions.find((a: any) => a.status === 'ADMITTED') || null;

    logger.info('Patient profile built', { patientId });

    return {
      patient: { ...patient, abhaRecord: patient.abhaRecord },
      hospital,
      summary: {
        totalEncounters: encounters.length,
        totalPrescriptions: prescriptions.length,
        totalVitals: vitals.length,
        totalInvestigations: investigations.length,
        totalPayments: payments.length,
        totalAdmissions: admissions.length,
        totalAppointments: appointments.length,
        totalConsents: consents.length,
      },
      billingOverview: {
        totalBilled: round(totalBilled),
        totalPaid: round(totalPaid),
        totalOutstanding: round(totalBilled - totalPaid),
        consultation: round(consultationCharges),
        lab: round(labCharges),
        medicine: round(medicineCharges),
        scan: round(scanCharges),
        ward: round(wardCharges),
        other: round(otherCharges),
      },
      chargeItems,
      latestVitals: vitals[0] || null,
      activeAdmission,
      encounters,
      prescriptions,
      vitals,
      investigations,
      payments,
      admissions,
      appointments,
      consents,
    };
  }
}

export default new EhrService();
