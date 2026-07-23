import {
  FHIRResource,
  FHIRReference,
  NRCES_PROFILES,
  SYSTEM,
  generateUUID,
} from '../coding-tables';

// ─────────────────────────────────────────────────────────────────────────────
// FHIR R4 Invoice — used by NRCeS InvoiceRecord (M2 Health Record Formats).
// One row in our `Payment` table maps to ONE Invoice resource. The Invoice
// captures:
//   • invoice number (receiptNumber / transactionId / row id),
//   • subject + recipient (always the patient),
//   • issuer (the hospital/Organization),
//   • date (paidAt or createdAt),
//   • status (FHIR R4: draft | issued | balanced | cancelled | entered-in-error),
//   • lineItem[] (one per non-zero charge bucket from `Payment.items`),
//   • totalNet / totalGross (Payment.amount),
//   • paymentTerms (free-text capturing method, transaction reference, who
//     collected it, and how much of the cumulative total was settled).
// ─────────────────────────────────────────────────────────────────────────────

export interface InvoiceInput {
  id: string;
  amount: number | string | null;
  paymentMethod?: string | null;
  status: 'PENDING' | 'PAID' | 'PARTIAL' | 'REFUNDED' | 'CANCELLED' | string;
  receiptNumber?: string | null;
  transactionId?: string | null;
  description?: string | null;
  items?: Record<string, unknown> | null;
  paidAt?: Date | null;
  createdAt: Date;
  appointmentId?: string | null;
  admissionId?: string | null;
}

const CURRENCY = 'INR';

const STATUS_MAP: Record<string, 'draft' | 'issued' | 'balanced' | 'cancelled' | 'entered-in-error'> = {
  PENDING: 'issued',
  PAID: 'balanced',
  PARTIAL: 'issued',
  REFUNDED: 'cancelled',
  CANCELLED: 'cancelled',
};

// Friendly labels for the line-item bucket names we store on
// `Payment.items` (consultationFee, labCharges, …). Anything else is title-
// cased on the fly.
const ITEM_LABELS: Record<string, string> = {
  consultationFee: 'Consultation Fee',
  labCharges: 'Laboratory Charges',
  medicineCharges: 'Pharmacy Charges',
  scanCharges: 'Imaging / Scan Charges',
  roomCharges: 'Room Charges',
  surgeryCharges: 'Procedure Charges',
  nursingCharges: 'Nursing Charges',
  miscCharges: 'Other Charges',
};

function humanise(key: string): string {
  if (ITEM_LABELS[key]) return ITEM_LABELS[key];
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function toAmount(value: number | string | null | undefined): { value: number; currency: string } {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return { value: Number.isFinite(n) ? Number(n) : 0, currency: CURRENCY };
}

function deriveLineItems(input: InvoiceInput): Array<{
  sequence: number;
  chargeItemCodeableConcept: { text: string };
  priceComponent: Array<{ type: string; amount: { value: number; currency: string } }>;
}> {
  const items: Array<{ sequence: number; chargeItemCodeableConcept: { text: string }; priceComponent: any[] }> = [];
  const meta: Record<string, unknown> = (input.items as any) || {};
  let seq = 1;

  // Skip the metadata bookkeeping fields; they aren't billable lines.
  const skip = new Set(['total', 'thisPayment', 'cumulativePaid', 'previouslyPaid']);

  for (const [key, raw] of Object.entries(meta)) {
    if (skip.has(key)) continue;
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    const numeric = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    items.push({
      sequence: seq++,
      chargeItemCodeableConcept: { text: humanise(key) },
      priceComponent: [
        {
          type: 'base',
          amount: { value: Number(numeric), currency: CURRENCY },
        },
      ],
    });
  }

  // Fallback — if items JSON is missing or had no positive line items, emit a
  // single line for the total amount with the description.
  if (items.length === 0) {
    items.push({
      sequence: 1,
      chargeItemCodeableConcept: {
        text: input.description?.trim() || (input.admissionId ? 'Inpatient bill' : 'Consultation bill'),
      },
      priceComponent: [
        {
          type: 'base',
          amount: toAmount(input.amount),
        },
      ],
    });
  }

  return items;
}

function buildPaymentTerms(input: InvoiceInput): string {
  const parts: string[] = [];
  if (input.paymentMethod) parts.push(`Method: ${input.paymentMethod}`);
  if (input.transactionId) parts.push(`Txn: ${input.transactionId}`);
  if (input.paidAt) parts.push(`Paid on: ${new Date(input.paidAt).toLocaleString('en-IN')}`);
  const meta: any = input.items || {};
  if (typeof meta.thisPayment === 'number' && Number.isFinite(meta.thisPayment)) {
    parts.push(`Settled this transaction: ₹${meta.thisPayment}`);
  }
  if (typeof meta.cumulativePaid === 'number' && Number.isFinite(meta.cumulativePaid)) {
    parts.push(`Cumulative paid: ₹${meta.cumulativePaid}`);
  }
  return parts.join('; ');
}

export function buildInvoice(
  input: InvoiceInput,
  patientRef: FHIRReference,
  organizationRef: FHIRReference,
): { uuid: string; resource: FHIRResource } {
  const uuid = generateUUID();
  const status = STATUS_MAP[input.status] || 'issued';
  const lineItem = deriveLineItems(input);
  const total = toAmount(input.amount);
  const date = (input.paidAt || input.createdAt).toISOString();

  const identifier: any[] = [];
  if (input.receiptNumber) {
    identifier.push({
      system: 'https://abdm-care.invoice/receipt',
      value: input.receiptNumber,
      type: {
        coding: [{
          system: SYSTEM.FHIR_IDENTIFIER_TYPE,
          code: 'INV',
          display: 'Invoice number',
        }],
      },
    });
  }
  identifier.push({
    system: 'urn:abdm-care:payment',
    value: input.id,
  });

  const resource: FHIRResource = {
    resourceType: 'Invoice',
    id: uuid,
    meta: { profile: [NRCES_PROFILES.Invoice] },
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Invoice ${input.receiptNumber || input.id} — ₹${total.value} ${CURRENCY} (${status}).</p></div>`,
    },
    identifier,
    status,
    type: {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
        code: 'FININV',
        display: 'Financial Invoice',
      }],
      text: input.description?.trim() || 'Invoice',
    },
    subject: patientRef,
    recipient: patientRef,
    date,
    issuer: organizationRef,
    lineItem,
    totalNet: total,
    totalGross: total,
  };

  const paymentTerms = buildPaymentTerms(input);
  if (paymentTerms) {
    resource.paymentTerms = paymentTerms;
  }

  return { uuid, resource };
}

export function buildInvoices(
  payments: InvoiceInput[],
  patientRef: FHIRReference,
  organizationRef: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  return (payments || []).map((p) => buildInvoice(p, patientRef, organizationRef));
}
