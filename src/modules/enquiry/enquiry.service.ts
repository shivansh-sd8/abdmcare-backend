// Enquiry service.
//
// Responsible for capturing inbound "request access" / contact-us submissions
// from the public landing page and forwarding them to our internal mailbox.
//
// We intentionally never throw on a mail-delivery failure — the enquiry is
// always logged via Winston (so it lives in our log retention as a fallback)
// and the controller returns success to the user. If SMTP is not configured
// at all, the same applies: we keep the lead in logs and a future SMTP setup
// will start delivering subsequent enquiries automatically.

import logger from '../../common/config/logger';
import { sendMail, isMailerConfigured } from '../../common/utils/mailer';

export interface EnquiryPayload {
  name: string;
  email: string;
  phone?: string;
  hospitalName?: string;
  role?: string;
  message: string;
  /** Optional context provided by the frontend (e.g. "landing-hero", "cta-banner"). */
  source?: string;
  /** Captured server-side (request IP) for spam triage. */
  ip?: string;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildHtml = (p: EnquiryPayload): string => {
  const row = (label: string, value?: string) =>
    value
      ? `<tr><td style="padding:6px 12px;color:#64748b;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;text-transform:uppercase;letter-spacing:.04em;vertical-align:top;width:120px">${label}</td><td style="padding:6px 12px;color:#0f172a;font:14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif">${escapeHtml(value)}</td></tr>`
      : '';

  return `
  <div style="background:#f6fbf9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#0F766E 0%,#14B8A6 100%);padding:20px 24px;color:white">
        <div style="font:700 18px/1.2 -apple-system,sans-serif;letter-spacing:-.5px">New enquiry — AbhaAyushman</div>
        <div style="font:13px/1.4 -apple-system,sans-serif;opacity:.9;margin-top:4px">A prospect just submitted the access form.</div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:8px 0">
        ${row('Name', p.name)}
        ${row('Email', p.email)}
        ${row('Phone', p.phone)}
        ${row('Hospital', p.hospitalName)}
        ${row('Role', p.role)}
        ${row('Source', p.source)}
        ${row('IP', p.ip)}
      </table>
      <div style="padding:12px 24px 20px">
        <div style="color:#64748b;font:600 12px/1.4 -apple-system,sans-serif;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Message</div>
        <div style="white-space:pre-wrap;color:#0f172a;font:14px/1.7 -apple-system,sans-serif;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px">${escapeHtml(p.message)}</div>
      </div>
      <div style="border-top:1px solid #e2e8f0;padding:12px 24px;color:#94a3b8;font:12px/1.5 -apple-system,sans-serif">
        Reply directly to this email — the prospect's address is set as <code style="font:11px monospace">Reply-To</code>.
      </div>
    </div>
  </div>`;
};

const buildText = (p: EnquiryPayload): string => {
  const lines = [
    'New enquiry — AbhaAyushman',
    '',
    `Name:     ${p.name}`,
    `Email:    ${p.email}`,
    p.phone ? `Phone:    ${p.phone}` : '',
    p.hospitalName ? `Hospital: ${p.hospitalName}` : '',
    p.role ? `Role:     ${p.role}` : '',
    p.source ? `Source:   ${p.source}` : '',
    p.ip ? `IP:       ${p.ip}` : '',
    '',
    'Message:',
    p.message,
    '',
    '— You can reply directly to this email; the sender is set as Reply-To.',
  ];
  return lines.filter(Boolean).join('\n');
};

const getRecipients = (): string[] => {
  const raw =
    process.env.ENQUIRY_TO_EMAILS ||
    process.env.ENQUIRY_TO_EMAIL ||
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    '';
  return raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
};

export const submitEnquiry = async (
  payload: EnquiryPayload,
): Promise<{ delivered: boolean; reason?: string }> => {
  // Always log — this is our durable record even if mail bounces.
  logger.info('[ENQUIRY] new submission', {
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    hospital: payload.hospitalName,
    role: payload.role,
    source: payload.source,
    ip: payload.ip,
    messageLength: payload.message.length,
  });

  const recipients = getRecipients();
  if (recipients.length === 0) {
    logger.warn(
      '[ENQUIRY] No ENQUIRY_TO_EMAILS configured — enquiry retained in logs only.',
    );
    return { delivered: false, reason: 'No recipient configured' };
  }

  if (!isMailerConfigured()) {
    return { delivered: false, reason: 'SMTP not configured' };
  }

  const result = await sendMail({
    to: recipients,
    subject: `[AbhaAyushman] New enquiry from ${payload.name}${payload.hospitalName ? ` (${payload.hospitalName})` : ''}`,
    text: buildText(payload),
    html: buildHtml(payload),
    replyTo: payload.email,
  });

  return { delivered: result.delivered, reason: result.reason };
};

export default { submitEnquiry };
