/**
 * SMS Service Utility
 *
 * Supports MSG91 (preferred) and Twilio as providers.
 * Configure via environment variables:
 *
 *   SMS_PROVIDER=msg91 | twilio | console (default: console for local dev)
 *
 *   For MSG91:
 *     MSG91_AUTH_KEY   — API auth key
 *     MSG91_SENDER_ID  — 6-char sender ID (e.g. MEDSNC)
 *     MSG91_TEMPLATE_ID — (optional) DLT template ID for transactional SMS
 *
 *   For Twilio:
 *     TWILIO_ACCOUNT_SID
 *     TWILIO_AUTH_TOKEN
 *     TWILIO_FROM_NUMBER — e.g. +15005550006
 */

import https from 'https';

export interface SMSOptions {
  to: string;       // Mobile number (10 digits or with country code)
  message: string;
  templateId?: string;
}

export interface SMSResult {
  success: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;
}

async function sendMsg91(opts: SMSOptions): Promise<SMSResult> {
  const authKey   = process.env.MSG91_AUTH_KEY;
  const senderId  = process.env.MSG91_SENDER_ID || 'MEDSNC';
  const templateId = opts.templateId || process.env.MSG91_TEMPLATE_ID;

  if (!authKey) throw new Error('MSG91_AUTH_KEY not configured');

  const payload = JSON.stringify({
    sender:   senderId,
    route:    '4',
    country:  '91',
    sms: [{ message: opts.message, to: [normalisePhone(opts.to)] }],
    ...(templateId ? { template_id: templateId } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.msg91.com',
        path:     '/api/v2/sendsms',
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', authkey: authKey },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.type === 'success') {
              resolve({ success: true, provider: 'msg91', messageId: json.message });
            } else {
              resolve({ success: false, provider: 'msg91', error: json.message });
            }
          } catch {
            resolve({ success: false, provider: 'msg91', error: body });
          }
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

async function sendTwilio(opts: SMSOptions): Promise<SMSResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) throw new Error('Twilio credentials not configured');

  const body = new URLSearchParams({
    To:   `+${normalisePhone(opts.to)}`,
    From: from,
    Body: opts.message,
  }).toString();

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          Authorization:    `Basic ${auth}`,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(b);
            if (json.sid) {
              resolve({ success: true, provider: 'twilio', messageId: json.sid });
            } else {
              resolve({ success: false, provider: 'twilio', error: json.message || b });
            }
          } catch {
            resolve({ success: false, provider: 'twilio', error: b });
          }
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

function sendConsole(opts: SMSOptions): SMSResult {
  console.log(`[SMS:console] To: ${opts.to} | Message: ${opts.message}`);
  return { success: true, provider: 'console', messageId: `console-${Date.now()}` };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendSMS(opts: SMSOptions): Promise<SMSResult> {
  const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();
  try {
    if (provider === 'msg91')   return await sendMsg91(opts);
    if (provider === 'twilio')  return await sendTwilio(opts);
    return sendConsole(opts);
  } catch (err: any) {
    console.error('[SMS] Error:', err.message);
    return { success: false, provider, error: err.message };
  }
}

// ── Pre-built message templates ───────────────────────────────────────────────

export async function sendAppointmentConfirmation(data: {
  mobile: string;
  patientName: string;
  doctorName: string;
  date: string;
  time: string;
  hospitalName: string;
}): Promise<SMSResult> {
  return sendSMS({
    to:      data.mobile,
    message: `Dear ${data.patientName}, your appointment with ${data.doctorName} at ${data.hospitalName} is confirmed for ${data.date} at ${data.time}. Please arrive 15 mins early. - MediSync`,
  });
}

export async function sendCheckInNotification(data: {
  mobile: string;
  patientName: string;
  doctorName: string;
  tokenNumber?: string;
  hospitalName: string;
}): Promise<SMSResult> {
  const token = data.tokenNumber ? ` Your token: ${data.tokenNumber}.` : '';
  return sendSMS({
    to:      data.mobile,
    message: `Dear ${data.patientName}, you have been checked in for ${data.doctorName} at ${data.hospitalName}.${token} - MediSync`,
  });
}

export async function sendDischargeNotification(data: {
  mobile: string;
  patientName: string;
  hospitalName: string;
  admissionNumber: string;
}): Promise<SMSResult> {
  return sendSMS({
    to:      data.mobile,
    message: `Dear ${data.patientName}, you have been discharged from ${data.hospitalName} (Admission: ${data.admissionNumber}). Thank you for choosing us. - MediSync`,
  });
}

export async function sendOTP(data: {
  mobile: string;
  otp: string;
  purpose?: string;
}): Promise<SMSResult> {
  return sendSMS({
    to:      data.mobile,
    message: `Your MediSync OTP for ${data.purpose || 'verification'} is ${data.otp}. Valid for 10 minutes. Do not share it with anyone.`,
  });
}

export default { sendSMS, sendAppointmentConfirmation, sendCheckInNotification, sendDischargeNotification, sendOTP };
