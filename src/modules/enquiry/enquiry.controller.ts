import { Request, Response } from 'express';
import { asyncHandler } from '../../common/middleware/errorHandler';
import ResponseHandler from '../../common/utils/response';
import enquiryService from './enquiry.service';
import logger from '../../common/config/logger';

export class EnquiryController {
  /**
   * Public POST /api/v1/enquiry — accept a "Request access" / contact-us
   * submission from the marketing site. Always returns success when the
   * payload is valid; we never expose mail-delivery details to the client.
   */
  submit = asyncHandler(async (req: Request, res: Response) => {
    const honeypot = (req.body?.website || '').toString().trim();
    if (honeypot) {
      // Bots fill hidden fields; respond with a 200 so they don't retry.
      logger.warn('[ENQUIRY] honeypot tripped — silently dropping submission', {
        ip: req.ip,
        honeypot,
      });
      return ResponseHandler.success(res, "Thanks — we'll be in touch shortly.", undefined);
    }

    const result = await enquiryService.submitEnquiry({
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: req.body.phone ? String(req.body.phone).trim() : undefined,
      hospitalName: req.body.hospitalName ? String(req.body.hospitalName).trim() : undefined,
      role: req.body.role ? String(req.body.role).trim() : undefined,
      message: String(req.body.message || '').trim(),
      source: req.body.source ? String(req.body.source).trim() : undefined,
      ip: req.ip,
    });

    // Surface a slightly different, but still friendly message in dev when
    // delivery falls through — helps the implementer notice missing config
    // without leaking that to real users in production.
    if (!result.delivered && process.env.NODE_ENV !== 'production') {
      return ResponseHandler.success(
        res,
        `Enquiry recorded (mail not delivered: ${result.reason || 'unknown'}). It is captured in server logs.`,
        undefined,
      );
    }

    return ResponseHandler.success(
      res,
      "Thanks — we've received your enquiry and will get back to you within 1 business day.",
      undefined,
    );
  });
}

export default new EnquiryController();
