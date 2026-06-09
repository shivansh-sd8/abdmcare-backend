import { Request, Response, NextFunction } from 'express';
import documentService from './document.service';
import { AppError } from '../../common/middleware/errorHandler';

function ok(res: Response, data: any) {
  res.json({ success: true, data });
}

export async function generateDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).user;
    const { patientId, encounterId, admissionId, type, fileName } = req.body;

    if (!patientId || !type) throw new AppError('patientId and type are required', 400);

    let content: Buffer;
    if ((req as any).file) {
      content = (req as any).file.buffer;
    } else if (req.body.content) {
      content = Buffer.from(req.body.content, 'base64');
    } else {
      throw new AppError('PDF content required (file upload or base64 content field)', 400);
    }

    const result = await documentService.generateDocument({
      patientId,
      encounterId,
      admissionId,
      type,
      hospitalId: user.hospitalId,
      generatedBy: user.id,
      content,
      fileName,
    });

    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function getDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).user;
    const data = await documentService.getDocumentById(req.params.id, user);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function downloadDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).user;
    const { buffer, fileName, mimeType } = await documentService.downloadDocument(req.params.id, user);

    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  } catch (e) { next(e); }
}

export async function listDocuments(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).user;
    const { patientId, type } = req.query as any;

    if (!patientId) throw new AppError('patientId query parameter is required', 400);

    const data = await documentService.getDocumentsByPatient(patientId, user, { type });
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getDocumentStats(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).user;
    const hospitalId = user?.role === 'SUPER_ADMIN'
      ? (req.query.hospitalId as string | undefined)
      : user?.hospitalId;
    const data = await documentService.getDocumentStats(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function publicDownload(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.params;
    const { documentId, valid } = documentService.validateDownloadToken(token);

    if (!valid) throw new AppError('Download link has expired or is invalid', 403);

    const { buffer, fileName, mimeType } = await documentService.downloadDocument(documentId);

    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  } catch (e) { next(e); }
}
