import { Request, Response, NextFunction } from 'express';
import reportService, { resolveRange } from './report.service';
import { renderHospitalReportPdf } from './report.renderer.pdf';
import { renderHospitalReportXlsx } from './report.renderer.xlsx';
import { renderHospitalReportZip } from './report.renderer.csv';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import auditLogService from '../../services/auditLogService';
import { ReportPreset } from './report.types';

const VALID_PRESETS: ReportPreset[] = [
  'today', 'week', 'month', 'quarter', 'year', 'all', 'custom',
];

function readPreset(req: Request): ReportPreset {
  const raw = String(req.query.preset || 'month').toLowerCase() as ReportPreset;
  if (!VALID_PRESETS.includes(raw)) {
    return 'month';
  }
  return raw;
}

function readRange(req: Request) {
  const preset = readPreset(req);
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  return resolveRange(preset, from, to);
}

/**
 * Build a filename suffix that survives shell + Excel + browser save dialogs:
 *   "Shivansh-Test-Facility_2026-06-12_month"
 */
function safeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

function downloadName(report: { header: { hospital: { name: string } | null; range: { preset: string; from: Date | null } } }, ext: string) {
  const hospital = report.header.hospital?.name || 'Hospital';
  const preset = report.header.range.preset;
  const stamp = new Date().toISOString().substring(0, 10);
  return `${safeFilename(hospital)}_report_${preset}_${stamp}${ext}`;
}

class ReportController {
  /**
   * JSON preview / sanity-check endpoint. The frontend hits this first to
   * render the KPI tiles before the user commits to a download.
   */
  getReportJson = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const range = readRange(req);
      const report = await reportService.buildHospitalReport(currentUser, range);
      ResponseHandler.success(res, 'Hospital report generated', report);
    },
  );

  /**
   * PDF executive summary. Streams pdfkit output straight to the response.
   */
  downloadPdf = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const range = readRange(req);
      const report = await reportService.buildHospitalReport(currentUser, range);
      const filename = downloadName(report, '.pdf');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      await renderHospitalReportPdf(report, res);
      await this.audit(req, 'pdf', range.preset, filename);
    },
  );

  /**
   * Excel multi-sheet workbook.
   */
  downloadXlsx = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const range = readRange(req);
      const report = await reportService.buildHospitalReport(currentUser, range);
      const filename = downloadName(report, '.xlsx');

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      await renderHospitalReportXlsx(report, res);
      await this.audit(req, 'xlsx', range.preset, filename);
    },
  );

  /**
   * CSV bundle (zip).
   */
  downloadZip = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const range = readRange(req);
      const report = await reportService.buildHospitalReport(currentUser, range);
      const filename = downloadName(report, '.zip');

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      await renderHospitalReportZip(report, res);
      await this.audit(req, 'csv', range.preset, filename);
    },
  );

  /**
   * Compliance breadcrumb so we always know who pulled which dataset and
   * when. Reports contain regulated data (ABHA numbers, demographics) so
   * this is non-negotiable.
   *
   * We bypass `auditLogService.logAction` because that helper hardcodes
   * `userType: 'USER'` which isn't a valid value of the `UserType` enum
   * (PATIENT | DOCTOR | ADMIN | SYSTEM). Going through `createLog` directly
   * lets us pass the correct enum and keeps the audit row from being
   * silently dropped on Prisma validation.
   */
  private async audit(req: Request, format: string, preset: string, filename: string) {
    const user = (req as any).user;
    if (!user?.id) return;
    try {
      await auditLogService.createLog({
        userId: user.id,
        action: 'DOWNLOAD',
        module: 'reports',
        resourceType: 'HospitalReport',
        requestData: { format, preset, filename, query: req.query },
        status: 'SUCCESS',
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.get('user-agent'),
        userType: 'ADMIN',
      });
    } catch (err) {
      logger.warn('Failed to write audit log for report download', err as any);
    }
  }
}

export default new ReportController();
