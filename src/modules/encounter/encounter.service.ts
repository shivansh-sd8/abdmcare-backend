import prisma from '../../common/config/database';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

interface UpdateConsultationRequest {
  chiefComplaint?: string;
  historyOfPresentIllness?: string;
  pastMedicalHistory?: string;
  physicalExamination?: string;
  provisionalDiagnosis?: string;
  finalDiagnosis?: string;
  vitalSigns?: any;
  notes?: string;
  followUpDate?: string;
  admissionRequired?: boolean;
  referralRequired?: boolean;
  prescriptions?: Array<{
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string;
    quantity?: number;
  }>;
  labOrders?: Array<{
    testName: string;
    testType?: string;
    priority?: string;
  }>;
  referrals?: Array<{
    referredToDoctorId: string;
    reason: string;
    notes?: string;
    urgency?: string;
  }>;
}

class EncounterService {

  // ── Recalculate encounter status from actual DB state ────────────────────
  // Handles race conditions where lab/pharmacy complete out-of-order.
  // Called by investigation/prescription services after completing items.
  async recalculateEncounterStatus(encounterId: string): Promise<string> {
    const [pendingLabs, pendingRx] = await Promise.all([
      prisma.investigation.count({
        where: { encounterId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      }),
      prisma.prescription.count({
        where: { encounterId, status: { not: 'DISPENSED' } },
      }),
    ]);

    if (pendingLabs > 0) return 'LAB_PENDING';
    if (pendingRx > 0) return 'PHARMACY_PENDING';
    return 'BILLING_PENDING';
  }

  // ── Full encounter snapshot (single source of truth for documents) ───────
  async getEncounterFull(id: string, currentUser?: any) {
    const encounter = await prisma.encounter.findUnique({
      where: { id },
      include: {
        patient: { include: { abhaRecord: true } },
        doctor: { include: { department: true } },
        prescriptions: true,
        labOrders: true,
        referrals: { include: { referredToDoctor: true } },
        appointment: true,
      },
    });

    if (!encounter) throw new AppError('Encounter not found', 404);

    if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      if (currentUser.hospitalId && encounter.patient.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Access denied to this encounter', 403);
      }
    }

    // Fetch related data in parallel
    const [vitals, investigations, rxRecords, payments, hospital] = await Promise.all([
      prisma.vitals.findMany({
        where: { patientId: encounter.patientId, encounterId: id },
        orderBy: { recordedAt: 'desc' },
        take: 1,
      }).then(rows => rows[0] || null).catch(() => null),

      prisma.investigation.findMany({
        where: { encounterId: id },
        include: { doctor: { select: { firstName: true, lastName: true } } },
        orderBy: { orderedAt: 'desc' },
      }),

      prisma.prescription.findMany({
        where: { encounterId: id },
        include: { doctor: { select: { firstName: true, lastName: true } } },
        orderBy: { issuedAt: 'desc' },
      }),

      prisma.payment.findMany({
        where: { appointmentId: encounter.appointment?.id },
        orderBy: { createdAt: 'desc' },
      }),

      encounter.patient.hospitalId
        ? prisma.hospital.findUnique({
            where: { id: encounter.patient.hospitalId },
            select: {
              name: true, addressLine1: true, city: true, state: true,
              country: true, phone: true, email: true, website: true, gstNumber: true,
            },
          })
        : null,
    ]);

    // If no encounter-specific vitals, try latest patient vitals
    let latestVitals = vitals;
    if (!latestVitals) {
      latestVitals = await prisma.vitals.findFirst({
        where: { patientId: encounter.patientId },
        orderBy: { recordedAt: 'desc' },
      });
    }

    return {
      success: true,
      data: {
        ...encounter,
        vitals: latestVitals,
        investigations,
        pharmacyPrescriptions: rxRecords,
        payments,
        hospital,
        billing: {
          consultationFee: Number(encounter.consultationFee ?? 0),
          labCharges: Number(encounter.labCharges ?? 0),
          medicineCharges: Number(encounter.medicineCharges ?? 0),
          scanCharges: Number(encounter.scanCharges ?? 0),
          totalAmount: Number(encounter.totalAmount ?? 0),
          paymentCollected: Number(encounter.paymentCollected ?? 0),
          paymentStatus: encounter.paymentStatus || 'PENDING',
          balance: Math.max(0, Number(encounter.totalAmount ?? 0) - Number(encounter.paymentCollected ?? 0)),
        },
      },
    };
  }

  async getEncounterById(id: string, currentUser?: any) {
    try {
      const encounter = await prisma.encounter.findUnique({
        where: { id },
        include: {
          patient: {
            include: {
              abhaRecord: true,
            },
          },
          doctor: true,
          prescriptions: true,
          labOrders: true,
          referrals: {
            include: {
              referredToDoctor: true,
            },
          },
          appointment: true,
        },
      });

      if (!encounter) {
        throw new AppError('Encounter not found', 404);
      }

      // Hospital isolation check
      if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
        if (currentUser.hospitalId && encounter.patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied to this encounter', 403);
        }
      }

      return {
        success: true,
        data: encounter,
      };
    } catch (error: any) {
      logger.error('Failed to fetch encounter', error);
      throw new AppError(
        error.message || 'Failed to fetch encounter',
        error.statusCode || 500
      );
    }
  }

  async getDoctorEncounters(doctorId: string, status?: string, currentUser?: any, patientId?: string, limit?: number) {
    try {
      let targetDoctorId = doctorId;

      // If doctorId looks like a user ID (UUID format), try to find the doctor record
      if (doctorId && currentUser?.role === 'DOCTOR') {
        const doctor = await prisma.doctor.findFirst({
          where: {
            OR: [
              { id: doctorId },
              { email: currentUser.email },
            ],
          },
        });

        if (doctor) {
          targetDoctorId = doctor.id;
        }
      }

      const where: any = {};

      // Only filter by doctor if no patientId is provided (patient history doesn't need doctor filter)
      if (targetDoctorId && !patientId) {
        where.doctorId = targetDoctorId;
      }

      // Filter by patientId — critical for preventing cross-patient data leaks
      if (patientId) {
        where.patientId = patientId;
      }

      if (status) {
        where.status = status;
      }

      // Hospital isolation — non-SUPER_ADMIN users only see their hospital's data
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.patient = {
          ...(where.patient || {}),
          hospitalId: currentUser.hospitalId,
        };
      }

      const encounters = await prisma.encounter.findMany({
        where,
        include: {
          patient: {
            include: {
              abhaRecord: true,
            },
          },
          doctor: true,
          appointment: {
            include: {
              patient: {
                include: {
                  abhaRecord: true,
                },
              },
            },
          },
        },
        orderBy: {
          visitDate: 'desc',
        },
        ...(limit ? { take: limit } : {}),
      });

      return {
        success: true,
        data: encounters,
      };
    } catch (error: any) {
      logger.error('Failed to fetch doctor encounters', error);
      throw new AppError(
        error.message || 'Failed to fetch encounters',
        error.statusCode || 500
      );
    }
  }

  async updateConsultation(id: string, data: UpdateConsultationRequest, currentUser?: any) {
    try {
      // Verify encounter exists and doctor has access
      const encounter = await prisma.encounter.findUnique({
        where: { id },
        include: {
          patient: true,
        },
      });

      if (!encounter) {
        throw new AppError('Encounter not found', 404);
      }

      // Hospital isolation: non-SUPER_ADMIN users must belong to the same hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (encounter.patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: encounter does not belong to your hospital', 403);
        }
      }

      // Only the assigned doctor or admin can update
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'ADMIN' && currentUser.role !== 'RECEPTIONIST') {
        if (currentUser.role === 'DOCTOR') {
          // JWT stores the User id, not the Doctor table id — resolve via email
          const doctorRecord = await prisma.doctor.findFirst({
            where: {
              OR: [
                { id: currentUser.doctorId ?? '' },
                { email: currentUser.email ?? '' },
              ],
            },
          });
          const resolvedDoctorId = doctorRecord?.id;
          if (!resolvedDoctorId || encounter.doctorId !== resolvedDoctorId) {
            throw new AppError('Only the assigned doctor can update this consultation', 403);
          }
        }
      }

      // Update encounter
      const updatedEncounter = await prisma.encounter.update({
        where: { id },
        data: {
          chiefComplaint:            data.chiefComplaint,
          historyOfPresentIllness:   data.historyOfPresentIllness,
          pastMedicalHistory:        data.pastMedicalHistory,
          physicalExamination:       data.physicalExamination,
          provisionalDiagnosis:      data.provisionalDiagnosis,
          finalDiagnosis:            data.finalDiagnosis,
          vitalSigns:                data.vitalSigns,
          notes:                     data.notes,
          followUpDate:              data.followUpDate ? new Date(data.followUpDate) : undefined,
          admissionRequired:         data.admissionRequired,
          referralRequired:          data.referralRequired,
        },
      });

      // Replace prescriptions: delete existing ones first, then recreate
      if (data.prescriptions !== undefined) {
        await prisma.encounterPrescription.deleteMany({ where: { encounterId: id } });
        if (data.prescriptions.length > 0) {
          await prisma.encounterPrescription.createMany({
            data: data.prescriptions.map((rx) => ({
              encounterId: id,
              ...rx,
            })),
          });
        }
      }

      // Replace lab orders: delete existing ones first, then recreate
      if (data.labOrders !== undefined) {
        await prisma.labOrder.deleteMany({ where: { encounterId: id } });
        if (data.labOrders.length > 0) {
          await prisma.labOrder.createMany({
            data: data.labOrders.map((order) => ({
              encounterId: id,
              orderId: `LAB-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
              testName: order.testName,
              testType: order.testType,
              priority: (order.priority as any) || 'ROUTINE',
            })),
          });
        }

        // Sync Investigation rows: add newly-ordered ones, remove cancelled ORDERED ones
        const existingInvestigations = await prisma.investigation.findMany({
          where: { encounterId: id, status: { in: ['ORDERED', 'SAMPLE_COLLECTED'] } },
          select: { id: true, testName: true },
        });
        const newTestNames = new Set(data.labOrders.map(l => l.testName.toLowerCase()));
        const existingTestNames = new Set(existingInvestigations.map(i => i.testName.toLowerCase()));

        // Remove ORDERED investigations that are no longer in the list
        const toRemove = existingInvestigations.filter(i => !newTestNames.has(i.testName.toLowerCase()));
        if (toRemove.length > 0) {
          await prisma.investigation.deleteMany({ where: { id: { in: toRemove.map(i => i.id) } } });
        }

        // Add new investigations for tests not yet tracked
        const toAdd = data.labOrders.filter(o => !existingTestNames.has(o.testName.toLowerCase()));
        if (toAdd.length > 0) {
          const enc = await prisma.encounter.findUnique({
            where: { id },
            select: { patientId: true, doctorId: true, patient: { select: { hospitalId: true } } },
          });
          if (enc) {
            if (!enc.patient.hospitalId) {
              logger.warn(`Skipping investigation creation: patient ${enc.patientId} has no hospitalId`);
            } else {
              await prisma.investigation.createMany({
                data: toAdd.map((order) => ({
                  patientId:   enc.patientId,
                  doctorId:    enc.doctorId,
                  hospitalId:  enc.patient.hospitalId!,
                  encounterId: id,
                  testName:    order.testName,
                  testType:    order.testType || 'LAB',
                  priority:    (order.priority as any) || 'ROUTINE',
                  status:      'ORDERED',
                })),
                skipDuplicates: true,
              });
            }
          }
        }
      }

      // Add referrals
      if (data.referrals && data.referrals.length > 0) {
        await prisma.referral.createMany({
          data: data.referrals.map((ref) => ({
            encounterId: id,
            referralId: `REF-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            referredToDoctorId: ref.referredToDoctorId,
            reason: ref.reason,
            notes: ref.notes,
            urgency: (ref.urgency as any) || 'ROUTINE',
          })),
        });
      }

      // Update EMR record
      await prisma.emrRecord.updateMany({
        where: { encounterId: id },
        data: {
          fhirData: {
            resourceType: 'Encounter',
            id: encounter.encounterId,
            status: 'finished',
            diagnosis: data.finalDiagnosis,
            prescriptions: data.prescriptions,
            labOrders: data.labOrders,
          },
        },
      });

      logger.info('Consultation updated successfully', { encounterId: id });

      return {
        success: true,
        data: updatedEncounter,
        message: 'Consultation updated successfully',
      };
    } catch (error: any) {
      logger.error('Failed to update consultation', error);
      throw new AppError(
        error.message || 'Failed to update consultation',
        error.statusCode || 500
      );
    }
  }

  async completeConsultation(
    id: string, 
    data?: { 
      diagnosis?: string; 
      notes?: string; 
      prescription?: any; 
      labTestsOrdered?: any; 
      scansOrdered?: any; 
      followUpDate?: Date;
      consultationFee?: number;
    }, 
    _currentUser?: any
  ) {
    try {
      const encounter = await prisma.encounter.findUnique({
        where: { id },
        include: {
          appointment: true,
          patient: true,
          labOrders: true,
          prescriptions: true,
        },
      });

      if (!encounter) {
        throw new AppError('Encounter not found', 404);
      }

      // Hospital isolation
      if (_currentUser && _currentUser.role !== 'SUPER_ADMIN' && _currentUser.hospitalId) {
        if (encounter.patient.hospitalId !== _currentUser.hospitalId) {
          throw new AppError('Access denied: encounter does not belong to your hospital', 403);
        }
      }

      // Determine next status based on what was ordered
      const hasLabTests = data?.labTestsOrdered && data.labTestsOrdered.length > 0;
      const hasScans = data?.scansOrdered && data.scansOrdered.length > 0;
      const hasPrescription = data?.prescription && data.prescription.length > 0;

      let nextStatus: any;
      if (hasLabTests || hasScans) {
        nextStatus = 'LAB_PENDING';
      } else if (hasPrescription) {
        nextStatus = 'PHARMACY_PENDING';
      } else {
        nextStatus = 'BILLING_PENDING';
      }

      // Update encounter with all consultation data
      // Resolve consultationFee: explicit > doctor fee > hospital default > 0
      let resolvedFee: number = data?.consultationFee ?? 0;
      if (!resolvedFee) {
        const doctor = await prisma.doctor.findUnique({
          where: { id: encounter.doctorId },
          select: { consultationFee: true, hospitalId: true },
        });
        if (doctor?.consultationFee) {
          resolvedFee = Number(doctor.consultationFee);
        } else if (doctor?.hospitalId) {
          const hospital = await prisma.hospital.findUnique({
            where: { id: doctor.hospitalId },
            select: { defaultOpdCharge: true },
          });
          resolvedFee = Number(hospital?.defaultOpdCharge ?? 0);
        }
      }

      const updatedEncounter = await prisma.encounter.update({
        where: { id },
        data: {
          diagnosis: data?.diagnosis || encounter.diagnosis,
          notes: data?.notes || encounter.notes,
          prescription: data?.prescription || encounter.prescription,
          labTestsOrdered: data?.labTestsOrdered || encounter.labTestsOrdered,
          scansOrdered: data?.scansOrdered || encounter.scansOrdered,
          followUpDate: data?.followUpDate || encounter.followUpDate,
          consultationFee: resolvedFee,
          totalAmount: resolvedFee
            + Number(encounter.labCharges ?? 0)
            + Number(encounter.medicineCharges ?? 0)
            + Number(encounter.scanCharges ?? 0),
          status: nextStatus,
        },
      });

      // Update appointment status: only mark COMPLETED when encounter is fully done
      if (encounter.appointment) {
        await prisma.appointment.update({
          where: { id: encounter.appointment.id },
          data: {
            status: nextStatus === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS',
          },
        });
      }

      // Update EMR with final diagnosis
      await prisma.emrRecord.updateMany({
        where: { encounterId: id },
        data: {
          fhirData: {
            resourceType: 'Encounter',
            id: encounter.encounterId,
            status: 'finished',
            diagnosis: data?.diagnosis,
            subject: {
              reference: `Patient/${encounter.patient.uhid}`,
              display: `${encounter.patient.firstName} ${encounter.patient.lastName}`,
            },
          },
        },
      });

      logger.info('Consultation completed', { encounterId: id, diagnosis: data?.diagnosis });

      // ── Bridge LabOrders → Investigation (lab queue) ─────────────────────
      // Incrementally sync: add new lab orders not yet in Investigation table
      if (encounter.labOrders.length > 0) {
        const existingInvestigations = await prisma.investigation.findMany({
          where: { encounterId: id },
          select: { testName: true },
        });
        const existingTestNames = new Set(existingInvestigations.map(i => i.testName.toLowerCase()));
        const toCreate = encounter.labOrders.filter(lo => !existingTestNames.has(lo.testName.toLowerCase()));
        if (toCreate.length > 0 && encounter.patient.hospitalId) {
          await prisma.investigation.createMany({
            data: toCreate.map((lo) => ({
              patientId:   encounter.patientId,
              doctorId:    encounter.doctorId,
              hospitalId:  encounter.patient.hospitalId!,
              encounterId: id,
              testName:    lo.testName,
              testType:    lo.testType || 'LAB',
              priority:    (lo.priority as string) || 'ROUTINE',
              status:      'ORDERED',
            })),
            skipDuplicates: true,
          });
          logger.info('Synced Investigation records from LabOrders', { encounterId: id, added: toCreate.length });
        }
      }

      // ── Bridge EncounterPrescriptions → Prescription (pharmacy queue) ─────
      // Upsert: update existing Prescription or create new one
      if (encounter.prescriptions.length > 0) {
        const medications = encounter.prescriptions.map((p) => ({
          name:         p.medicineName,
          dosage:       p.dosage,
          frequency:    p.frequency,
          duration:     p.duration,
          instructions: p.instructions || '',
          quantity:     p.quantity ?? 1,
          price:        p.price ? Number(p.price) : null,
        }));
        const existingRx = await prisma.prescription.findFirst({ where: { encounterId: id } });
        if (existingRx) {
          // Update existing prescription medications (only if still PENDING — not yet dispensed)
          if (existingRx.status === 'PENDING') {
            await prisma.prescription.update({
              where: { id: existingRx.id },
              data: {
                medications,
                diagnosis: data?.diagnosis || encounter.diagnosis || undefined,
                notes:     data?.notes    || encounter.notes    || undefined,
              },
            });
          }
        } else {
          await prisma.prescription.create({
            data: {
              patientId:   encounter.patientId,
              doctorId:    encounter.doctorId,
              encounterId: id,
              admissionId: (encounter as any).admissionId ?? undefined,
              medications,
              diagnosis:   data?.diagnosis || encounter.diagnosis || undefined,
              notes:       data?.notes    || encounter.notes    || undefined,
            },
          });
        }
        logger.info('Synced Prescription record from EncounterPrescriptions', { encounterId: id });
      }

      // ── Zero-cost auto-complete ─────────────────────────────────────────────
      // If no labs, no Rx, and fee is 0 → skip BILLING_PENDING, go to COMPLETED
      if (nextStatus === 'BILLING_PENDING' && resolvedFee === 0) {
        await prisma.encounter.update({
          where: { id },
          data: { status: 'COMPLETED', paymentStatus: 'PAID', billGenerated: true },
        });
        if (encounter.appointment) {
          await prisma.appointment.update({
            where: { id: encounter.appointment.id },
            data: { status: 'COMPLETED' },
          });
        }
        logger.info('Zero-cost consultation auto-completed', { encounterId: id });
        updatedEncounter.status = 'COMPLETED' as any;
      }

      // ── Upsert Vitals from consultation vitalSigns ──────────────────────────
      if (data?.diagnosis && encounter.vitalSigns && typeof encounter.vitalSigns === 'object') {
        const vs = encounter.vitalSigns as any;
        const hasVitals = vs.temperature || vs.bloodPressureSystolic || vs.heartRate ||
                          vs.oxygenSaturation || vs.weight || vs.height;
        if (hasVitals) {
          const existing = await prisma.vitals.findFirst({
            where: { patientId: encounter.patientId, encounterId: id },
          });
          if (!existing) {
            await prisma.vitals.create({
              data: {
                patientId:              encounter.patientId,
                encounterId:            id,
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
            logger.info('Vitals saved from encounter consultation', { encounterId: id });
          }
        }
      }

      return {
        success: true,
        data: updatedEncounter,
        message: 'Consultation completed successfully',
      };
    } catch (error: any) {
      logger.error('Failed to complete consultation', error);
      throw new AppError(
        error.message || 'Failed to complete consultation',
        error.statusCode || 500
      );
    }
  }

  async collectPayment(id: string, data: {
    paymentMethod: string;
    paymentCollected: number;
    transactionRef?: string;
  }, currentUser?: any) {
    if (!data.paymentCollected || data.paymentCollected <= 0) {
      throw new AppError('Payment amount must be greater than zero', 400);
    }
    if (!data.paymentMethod) {
      throw new AppError('Payment method is required', 400);
    }

    const encounter = await prisma.encounter.findUnique({
      where: { id },
      include: { patient: true, appointment: true },
    });
    if (!encounter) throw new AppError('Encounter not found', 404);
    if (currentUser?.role !== 'SUPER_ADMIN' && encounter.patient.hospitalId !== currentUser?.hospitalId) {
      throw new AppError('Access denied', 403);
    }

    // Prevent collecting payment on already fully paid encounters
    if (encounter.paymentStatus === 'PAID') {
      throw new AppError('Payment has already been fully collected for this encounter', 400);
    }

    const totalAmount   = Number(encounter.totalAmount ?? 0);
    const discountAmt   = Number((encounter as any).discountAmount ?? 0);
    const effectiveTotal = Math.max(0, totalAmount - discountAmt);
    const previouslyPaid = Number(encounter.paymentCollected ?? 0);
    const newPayment    = Number(data.paymentCollected ?? 0);
    const cumulativePaid = previouslyPaid + newPayment;
    const paymentStatus = effectiveTotal > 0 && cumulativePaid >= effectiveTotal
      ? 'PAID'
      : cumulativePaid > 0
        ? 'PARTIAL'
        : 'PENDING';
    const receiptNumber = `RCPT-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        paymentStatus,
        paymentCollected: cumulativePaid,
        paymentMethod:    data.paymentMethod,
        transactionRef:   data.transactionRef,
        status:           paymentStatus === 'PAID' ? 'COMPLETED' : undefined,
        billGenerated:    true,
      },
    });

    // Create auditable Payment row only if actual money was collected
    if (newPayment > 0 && encounter.patient.hospitalId) {
      await prisma.payment.create({
        data: {
          patientId:     encounter.patientId,
          hospitalId:    encounter.patient.hospitalId,
          appointmentId: encounter.appointment?.id,
          amount:        newPayment,
          paymentMethod: data.paymentMethod as any,
          status:        'PAID',
          receiptNumber,
          transactionId: data.transactionRef || undefined,
          description:   `OPD consultation payment — ${encounter.encounterId}`,
          paidAt:        new Date(),
          createdBy:     currentUser?.id,
          items: {
            consultationFee:  Number(encounter.consultationFee  ?? 0),
            labCharges:       Number(encounter.labCharges       ?? 0),
            medicineCharges:  Number(encounter.medicineCharges  ?? 0),
            scanCharges:      Number(encounter.scanCharges      ?? 0),
            total:            totalAmount,
            thisPayment:      newPayment,
            cumulativePaid:   cumulativePaid,
          },
        },
      });
    }

    // Mark appointment completed now that payment is collected
    if (encounter.appointment) {
      await prisma.appointment.update({
        where: { id: encounter.appointment.id },
        data: { status: 'COMPLETED' },
      });
    }

    logger.info('OPD payment collected', { encounterId: id, amount: data.paymentCollected, receipt: receiptNumber });
    return { ...updated, receiptNumber };
  }

  async applyDiscount(id: string, data: { amount: number; reason?: string; approvedBy: string }, currentUser?: any) {
    const encounter = await prisma.encounter.findUnique({
      where: { id },
      include: { patient: { select: { hospitalId: true } } },
    });
    if (!encounter) throw new AppError('Encounter not found', 404);
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && encounter.patient?.hospitalId !== currentUser.hospitalId) {
      throw new AppError('Access denied: Encounter belongs to a different hospital', 403);
    }
    if (data.amount < 0) throw new AppError('Discount amount must be non-negative', 400);

    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        discountAmount: data.amount,
        discountReason: data.reason || undefined,
        discountApprovedBy: data.approvedBy,
      },
    });

    logger.info('OPD discount applied', { encounterId: id, amount: data.amount, approvedBy: data.approvedBy });
    return updated;
  }
}

export default new EncounterService();
