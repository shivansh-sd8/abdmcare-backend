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
    const [hospital, appointments, encounters, prescriptions, vitals, investigations, payments] =
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
        v.temperature      ? `Temp: ${v.temperature}°F`       : null,
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

    // Sort all events chronologically (newest first)
    timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    logger.info('EHR timeline built', { patientId, events: timeline.length });

    const totalLabOrders = encounters.reduce((s, e) => s + (e.labOrders?.length || 0), 0);

    return {
      patient,
      hospital,
      timeline,
      summary: {
        totalAppointments:  appointments.length,
        totalEncounters:    encounters.length,
        totalPrescriptions: prescriptions.length,
        totalVitals:        vitals.length,
        totalInvestigations: investigations.length,
        totalLabOrders,
        totalPayments:      payments.length,
        lastVisit:          appointments[appointments.length - 1]?.scheduledAt || null,
      },
    };
  }
}

export default new EhrService();
