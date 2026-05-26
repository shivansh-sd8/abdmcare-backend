import { Request, Response } from 'express';
import documentService from './document.service';

function ok(res: Response, data: any) {
  res.json({ success: true, data });
}

function err(res: Response, error: any, status = 500) {
  const msg = error?.message || 'Internal server error';
  const code = msg.includes('not found') ? 404 : status;
  res.status(code).json({ success: false, message: msg });
}

export async function generateDocument(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { patientId, encounterId, admissionId, type, fileName } = req.body;

    if (!patientId || !type) {
      res.status(400).json({ success: false, message: 'patientId and type are required' });
      return;
    }

    let content: Buffer;
    if ((req as any).file) {
      content = (req as any).file.buffer;
    } else if (req.body.content) {
      content = Buffer.from(req.body.content, 'base64');
    } else {
      res.status(400).json({ success: false, message: 'PDF content required (file upload or base64 content field)' });
      return;
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
  } catch (e) { err(res, e); }
}

export async function getDocument(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const data = await documentService.getDocumentById(req.params.id, user);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function downloadDocument(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { buffer, fileName, mimeType } = await documentService.downloadDocument(req.params.id, user);

    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  } catch (e) { err(res, e); }
}

export async function listDocuments(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const { patientId, type } = req.query as any;

    if (!patientId) {
      res.status(400).json({ success: false, message: 'patientId query parameter is required' });
      return;
    }

    const data = await documentService.getDocumentsByPatient(patientId, user, { type });
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getDocumentStats(req: Request, res: Response) {
  try {
    const user = (req as any).user;
    const data = await documentService.getDocumentStats(user.hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function publicDownload(req: Request, res: Response) {
  try {
    const { token } = req.params;
    const { documentId, valid } = documentService.validateDownloadToken(token);

    if (!valid) {
      res.status(403).json({ success: false, message: 'Download link has expired or is invalid' });
      return;
    }

    const { buffer, fileName, mimeType } = await documentService.downloadDocument(documentId);

    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length.toString(),
    });
    res.send(buffer);
  } catch (e) { err(res, e); }
}
