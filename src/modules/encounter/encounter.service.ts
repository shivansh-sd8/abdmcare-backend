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

  async getDoctorEncounters(doctorId: string, status?: string, currentUser?: any) {
    try {
      let targetDoctorId = doctorId;

      // If doctorId looks like a user ID (UUID format), try to find the doctor record
      if (doctorId && currentUser?.role === 'DOCTOR') {
        // Check if this is a user ID by trying to find a doctor with this userId
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

      const where: any = { doctorId: targetDoctorId };

      if (status) {
        where.status = status;
      }

      // Hospital isolation
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.patient = {
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
      let nextStatus: any = 'COMPLETED';
      const hasLabTests = data?.labTestsOrdered && data.labTestsOrdered.length > 0;
      // Scans route to LAB_PENDING (same Investigation queue) until radiology is wired
      const hasScans = data?.scansOrdered && data.scansOrdered.length > 0;
      const hasPrescription = data?.prescription && data.prescription.length > 0;

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
          totalAmount: resolvedFee,  // labs + meds will be added when completed/dispensed
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
        if (toCreate.length > 0) {
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
    const encounter = await prisma.encounter.findUnique({
      where: { id },
      include: { patient: true, appointment: true },
    });
    if (!encounter) throw new AppError('Encounter not found', 404);
    if (currentUser?.role !== 'SUPER_ADMIN' && encounter.patient.hospitalId !== currentUser?.hospitalId) {
      throw new AppError('Access denied', 403);
    }

    const totalAmount = Number(encounter.totalAmount ?? 0);
    const receiptNumber = `RCPT-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // Mark encounter as paid + completed
    const updated = await prisma.encounter.update({
      where: { id },
      data: {
        paymentStatus:    'PAID',
        paymentCollected: data.paymentCollected,
        paymentMethod:    data.paymentMethod,
        transactionRef:   data.transactionRef,
        status:           'COMPLETED',
        billGenerated:    true,
      },
    });

    // Create auditable Payment row (same as IPD discharge does)
    await prisma.payment.create({
      data: {
        patientId:     encounter.patientId,
        hospitalId:    encounter.patient.hospitalId!,
        appointmentId: encounter.appointment?.id,
        amount:        data.paymentCollected,
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
          total:            totalAmount,
        },
      },
    });

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
}

export default new EncounterService();
