// Lightweight SMTP mailer used for transactional outbound mail (enquiries,
// invitations, etc.). Designed to fail gracefully when SMTP is not configured
// — the app keeps running and callers get back a `delivered: false` flag they
// can react to (typically: persist to DB / log so we still capture intent).

import nodemailer, { Transporter } from 'nodemailer';
import logger from '../config/logger';

export interface SendMailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

export interface SendMailResult {
  delivered: boolean;
  messageId?: string;
  reason?: string;
}

let cachedTransporter: Transporter | null | undefined;

/**
 * Build an SMTP transporter from env vars. Returns `null` (and warns once) if
 * the required SMTP_HOST/SMTP_USER are missing.
 */
const getTransporter = (): Transporter | null => {
  if (cachedTransporter !== undefined) return cachedTransporter ?? null;

  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;

  if (!host || !user || !password) {
    logger.warn(
      'Mailer not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASSWORD). Outbound mail will be skipped.',
    );
    cachedTransporter = null;
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  // Default `secure` to true for 465, false for everything else, unless
  // `SMTP_SECURE` overrides it.
  const secureEnv = process.env.SMTP_SECURE?.toLowerCase();
  const secure =
    secureEnv === 'true' ? true : secureEnv === 'false' ? false : port === 465;

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: password },
  });

  logger.info('Mailer configured', { host, port, secure });
  return cachedTransporter;
};

export const isMailerConfigured = (): boolean => getTransporter() !== null;

export const sendMail = async (input: SendMailInput): Promise<SendMailResult> => {
  const transporter = getTransporter();
  if (!transporter) {
    return { delivered: false, reason: 'SMTP not configured' };
  }

  const from =
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    'no-reply@localhost';

  try {
    const info = await transporter.sendMail({
      from,
      to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      cc: input.cc,
      bcc: input.bcc,
    });
    return { delivered: true, messageId: info.messageId };
  } catch (err: any) {
    logger.error('Mailer.sendMail failed', { error: err?.message, to: input.to, subject: input.subject });
    return { delivered: false, reason: err?.message || 'send failed' };
  }
};

export default { sendMail, isMailerConfigured };
