import prisma from '../../common/config/database';
import crypto from 'crypto';
import logger from '../../common/config/logger';
import { AppError } from '../../common/middleware/errorHandler';
import fs from 'fs';
import path from 'path';
import { getEffectiveHospitalId } from '../../common/utils/scope';

const UPLOAD_DIR = process.env.DOCUMENT_STORAGE_PATH || path.join(process.cwd(), 'uploads', 'documents');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export interface GenerateDocumentParams {
  patientId: string;
  encounterId?: string;
  admissionId?: string;
  type: string;
  hospitalId: string;
  generatedBy?: string;
  content: Buffer;
  fileName?: string;
}

export class DocumentService {
  async generateDocument(params: GenerateDocumentParams) {
    const fileId = crypto.randomUUID();
    const fileName = params.fileName || `${params.type.toLowerCase()}_${fileId}.pdf`;
    const filePath = path.join(UPLOAD_DIR, `${fileId}.pdf`);

    fs.writeFileSync(filePath, params.content);

    const checksum = crypto.createHash('sha256').update(params.content).digest('hex');
    const sizeBytes = params.content.length;

    const document = await prisma.document.create({
      data: {
        patientId:   params.patientId,
        encounterId: params.encounterId,
        admissionId: params.admissionId,
        type:        params.type as any,
        fileName,
        storageUrl:  filePath,
        mimeType:    'application/pdf',
        sizeBytes,
        checksum,
        hospitalId:  params.hospitalId,
        generatedBy: params.generatedBy,
      },
    });

    logger.info('Document generated', { documentId: document.id, type: params.type, patientId: params.patientId });

    return { id: document.id, storageUrl: filePath, checksum };
  }

  async getDocumentById(id: string, currentUser?: { role?: string; hospitalId?: string }) {
    const where: any = { id };
    if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      if (!currentUser.hospitalId) {
        throw new AppError('Document not found', 404);
      }
      where.hospitalId = currentUser.hospitalId;
    }

    const document = await prisma.document.findFirst({
      where,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, uhid: true } },
      },
    });

    if (!document) throw new AppError('Document not found', 404);
    return document;
  }

  async getDocumentsByPatient(
    patientId: string,
    currentUser?: { role?: string; hospitalId?: string; scopedHospitalId?: string },
    filters?: { type?: string }
  ) {
    const where: any = { patientId };
    // Effective hospital: non-SUPER_ADMIN must be scoped to their JWT;
    // SUPER_ADMIN with the global "viewing as" scope only sees that hospital;
    // unscoped SUPER_ADMIN sees all hospitals' docs for the patient.
    const effectiveHospitalId = getEffectiveHospitalId(currentUser);
    if (effectiveHospitalId) {
      where.hospitalId = effectiveHospitalId;
    } else if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      // Non-super-admin user without a hospital — fail closed.
      return [];
    }
    if (filters?.type) {
      where.type = filters.type;
    }

    return prisma.document.findMany({
      where,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, uhid: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async downloadDocument(
    id: string,
    currentUser?: { role?: string; hospitalId?: string }
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const document = await this.getDocumentById(id, currentUser);

    if (!fs.existsSync(document.storageUrl)) {
      throw new AppError('Document file not found on disk', 404);
    }

    const buffer = fs.readFileSync(document.storageUrl);
    return { buffer, fileName: document.fileName, mimeType: document.mimeType };
  }

  async getDocumentStats(hospitalId?: string) {
    const where: any = {};
    if (hospitalId) {
      where.hospitalId = hospitalId;
    }

    const stats = await prisma.document.groupBy({
      by: ['type'],
      where,
      _count: { id: true },
    });

    const total = stats.reduce((sum, s) => sum + s._count.id, 0);

    return {
      total,
      byType: stats.map(s => ({ type: s.type, count: s._count.id })),
    };
  }

  /**
   * Generate a time-limited download token for a document.
   * Returns a URL path that the public download endpoint can validate.
   */
  generateDownloadToken(documentId: string, expiresInMinutes = 60 * 24): string {
    const expiresAt = Date.now() + expiresInMinutes * 60 * 1000;
    const payload = `${documentId}:${expiresAt}`;
    const hmac = crypto.createHmac('sha256', process.env.JWT_SECRET || 'abhaayushman-doc-secret')
      .update(payload)
      .digest('hex');
    const token = Buffer.from(`${payload}:${hmac}`).toString('base64url');
    return token;
  }

  validateDownloadToken(token: string): { documentId: string; valid: boolean } {
    try {
      const decoded = Buffer.from(token, 'base64url').toString();
      const [documentId, expiresAtStr, hmac] = decoded.split(':');
      const expiresAt = parseInt(expiresAtStr, 10);

      if (Date.now() > expiresAt) {
        return { documentId, valid: false };
      }

      const expectedHmac = crypto.createHmac('sha256', process.env.JWT_SECRET || 'abhaayushman-doc-secret')
        .update(`${documentId}:${expiresAtStr}`)
        .digest('hex');

      return { documentId, valid: hmac === expectedHmac };
    } catch {
      return { documentId: '', valid: false };
    }
  }
}

export default new DocumentService();
