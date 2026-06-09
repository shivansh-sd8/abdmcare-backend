import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';
import logger from '../common/config/logger';

interface ImmunizationCreate {
  patientId: string;
  encounterId?: string;
  vaccineName: string;
  vaccineCode?: string;
  manufacturer?: string;
  lotNumber?: string;
  expiryDate?: string;
  doseNumber?: number;
  totalDoses?: number;
  site?: string;
  route?: string;
  doseQuantity?: number;
  doseUnit?: string;
  administeredAt: string;
  administeredBy?: string;
  reason?: string;
  notes?: string;
}

class ImmunizationService {
  async createImmunization(data: ImmunizationCreate, user: any) {
    const patient = await prisma.patient.findUnique({
      where: { id: data.patientId },
      select: { id: true, hospitalId: true },
    });
    if (!patient) throw new AppError('Patient not found', 404);

    if (user?.role !== 'SUPER_ADMIN' && user?.hospitalId && patient.hospitalId && patient.hospitalId !== user.hospitalId) {
      throw new AppError('Access denied: patient belongs to a different hospital', 403);
    }

    const created = await prisma.immunization.create({
      data: {
        patientId: data.patientId,
        encounterId: data.encounterId || null,
        vaccineName: data.vaccineName,
        vaccineCode: data.vaccineCode || null,
        manufacturer: data.manufacturer || null,
        lotNumber: data.lotNumber || null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        doseNumber: data.doseNumber ?? null,
        totalDoses: data.totalDoses ?? null,
        site: data.site || null,
        route: data.route || null,
        doseQuantity: data.doseQuantity != null ? data.doseQuantity as any : null,
        doseUnit: data.doseUnit || null,
        administeredAt: new Date(data.administeredAt),
        administeredBy: data.administeredBy || user?.id || null,
        reason: data.reason || null,
        notes: data.notes || null,
        hospitalId: patient.hospitalId || null,
      },
    });

    logger.info('Immunization recorded', { id: created.id, patientId: data.patientId, vaccine: data.vaccineName });
    return created;
  }

  async listForPatient(patientId: string, user: any) {
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, hospitalId: true },
    });
    if (!patient) throw new AppError('Patient not found', 404);

    if (user?.role !== 'SUPER_ADMIN' && user?.hospitalId && patient.hospitalId && patient.hospitalId !== user.hospitalId) {
      throw new AppError('Access denied', 403);
    }

    return prisma.immunization.findMany({
      where: { patientId },
      orderBy: { administeredAt: 'desc' },
    });
  }

  async deleteImmunization(id: string, user: any) {
    const im = await prisma.immunization.findUnique({ where: { id } });
    if (!im) throw new AppError('Immunization not found', 404);

    if (user?.role !== 'SUPER_ADMIN' && user?.hospitalId && im.hospitalId && im.hospitalId !== user.hospitalId) {
      throw new AppError('Access denied', 403);
    }
    await prisma.immunization.delete({ where: { id } });
    return { message: 'Immunization deleted' };
  }
}

export default new ImmunizationService();
