import PDFDocument from 'pdfkit';
import { Writable } from 'stream';
import { HospitalReport } from './report.types';

/**
 * Server-side PDF generator for the hospital report. Uses pdfkit directly
 * (no third-party table plugin) — gives us tight control over layout and
 * keeps the dep tree small. The renderer streams into the supplied
 * Writable so the controller can pipe straight to res.
 *
 * Conventions used everywhere:
 *  - 1-column section header bands with a thin accent stripe
 *  - Plain "key: value" rows for KPIs (compact, scannable)
 *  - Tables built by hand with column widths in `cols`
 *  - Roster table is hard-capped at PDF_ROSTER_CAP rows (full data lives in
 *    the xlsx / csv export)
 */

const PDF_ROSTER_CAP = 50_000;
const PRIMARY = '#1F2A44';        // header text & rules
const ACCENT  = '#0F766E';        // teal — section bars, totals
const MUTED   = '#6B7280';        // captions

interface Geom {
  page: { width: number; height: number };
  margin: number;
  contentWidth: number;
  contentHeight: number;
}

function geom(doc: PDFKit.PDFDocument): Geom {
  const m = 36;
  return {
    page: { width: doc.page.width, height: doc.page.height },
    margin: m,
    contentWidth: doc.page.width - 2 * m,
    contentHeight: doc.page.height - 2 * m,
  };
}

function nf(n: number, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat('en-IN', opts).format(n || 0);
}
function inr(n: number) {
  return `Rs ${nf(n, { maximumFractionDigits: 2 })}`;
}

/**
 * Add a section heading: a thin accent bar + bold title. Triggers a page
 * break first if there isn't enough vertical room left to draw at least
 * the heading + a couple of body lines.
 */
function heading(doc: PDFKit.PDFDocument, label: string) {
  const g = geom(doc);
  if (doc.y + 70 > g.page.height - g.margin) doc.addPage();
  doc.moveDown(0.5);
  const y = doc.y;
  doc.save()
    .rect(g.margin, y, 4, 18)
    .fill(ACCENT)
    .restore();
  doc.fillColor(PRIMARY)
    .font('Helvetica-Bold').fontSize(13)
    .text(label, g.margin + 12, y + 1);
  doc.moveDown(0.6);
  doc.fillColor(PRIMARY).font('Helvetica').fontSize(10);
}

function caption(doc: PDFKit.PDFDocument, text: string) {
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(text);
  doc.fillColor(PRIMARY).font('Helvetica').fontSize(10);
}

/**
 * Two-column key:value grid. Used for the header block + KPI sections so a
 * lot of small data points fit on a page.
 */
function kvGrid(doc: PDFKit.PDFDocument, rows: Array<[string, string]>, cols = 2) {
  const g = geom(doc);
  const colW = g.contentWidth / cols;
  const rowH = 16;
  const startY = doc.y;
  for (let i = 0; i < rows.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = g.margin + col * colW;
    const y = startY + row * rowH;
    if (y + rowH > g.page.height - g.margin) {
      doc.addPage();
      // restart the next chunk on a fresh page
      const remaining = rows.slice(i);
      kvGrid(doc, remaining, cols);
      return;
    }
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(rows[i][0], x, y, { width: colW - 6 });
    doc.fillColor(PRIMARY).font('Helvetica-Bold').fontSize(10).text(rows[i][1], x, y + 9, { width: colW - 6 });
  }
  const totalRows = Math.ceil(rows.length / cols);
  doc.y = startY + totalRows * rowH + 6;
  doc.font('Helvetica').fontSize(10).fillColor(PRIMARY);
}

/**
 * Generic horizontal table. Pages itself if rows overflow. `cols` is an
 * array of { header, width, align?, get(row) }. Total widths should match
 * the available content width.
 */
function table<T>(
  doc: PDFKit.PDFDocument,
  cols: Array<{ header: string; width: number; align?: 'left' | 'right' | 'center'; get: (r: T) => string }>,
  rows: T[],
  opts: { maxRows?: number; zebra?: boolean } = {},
) {
  const g = geom(doc);
  const cap = opts.maxRows ?? rows.length;
  const visible = rows.slice(0, cap);
  const lineH = 14;
  const totalW = cols.reduce((acc, c) => acc + c.width, 0);
  const startX = g.margin + Math.max(0, (g.contentWidth - totalW) / 2);

  const drawHeader = () => {
    if (doc.y + lineH * 2 > g.page.height - g.margin) doc.addPage();
    let x = startX;
    doc.save().rect(startX, doc.y - 2, totalW, lineH + 2).fill('#F3F4F6').restore();
    doc.fillColor(PRIMARY).font('Helvetica-Bold').fontSize(9);
    for (const c of cols) {
      doc.text(c.header, x + 4, doc.y, { width: c.width - 8, align: c.align || 'left' });
      x += c.width;
    }
    doc.font('Helvetica').fontSize(9);
    doc.y += lineH;
  };

  drawHeader();

  for (let i = 0; i < visible.length; i++) {
    if (doc.y + lineH > g.page.height - g.margin - 12) {
      doc.addPage();
      drawHeader();
    }
    if (opts.zebra && i % 2 === 1) {
      doc.save().rect(startX, doc.y - 2, totalW, lineH).fill('#FAFAFA').restore();
    }
    const r = visible[i];
    let x = startX;
    doc.fillColor(PRIMARY).font('Helvetica').fontSize(9);
    for (const c of cols) {
      doc.text(c.get(r), x + 4, doc.y, { width: c.width - 8, align: c.align || 'left' });
      x += c.width;
    }
    doc.y += lineH;
  }

  if (rows.length > visible.length) {
    doc.moveDown(0.4);
    doc.fillColor(MUTED).fontSize(8.5)
      .text(`Showing ${visible.length.toLocaleString()} of ${rows.length.toLocaleString()} rows. Full data is in the Excel and CSV exports.`);
    doc.fillColor(PRIMARY).fontSize(10);
  }
  doc.moveDown(0.4);
}

/**
 * Page numbers + brand footer. Called at the very end so we know the total
 * page count before stamping each page.
 */
function paginate(doc: PDFKit.PDFDocument, hospitalName: string) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const g = geom(doc);
    const y = g.page.height - g.margin / 2 - 6;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`${hospitalName} · Hospital Report · AbhaAyushman ABDM HIMS`, g.margin, y, {
        width: g.contentWidth,
        align: 'left',
      });
    doc.text(`Page ${i + 1} of ${range.count}`, g.margin, y, {
      width: g.contentWidth,
      align: 'right',
    });
  }
}

export function renderHospitalReportPdf(report: HospitalReport, output: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      bufferPages: true,
      info: {
        Title: `Hospital Report — ${report.header.hospital?.name || 'AbhaAyushman'}`,
        Author: 'AbhaAyushman',
        Subject: 'Hospital Operating Report',
        CreationDate: new Date(),
      },
    });

    output.on('error', reject);
    doc.on('error', reject);
    doc.pipe(output);
    output.on('finish', () => resolve());

    try {
      renderCover(doc, report);
      renderPatientKpis(doc, report);
      renderEncounters(doc, report);
      renderDoctors(doc, report);
      renderAppointments(doc, report);
      renderIpd(doc, report);
      renderBilling(doc, report);
      renderPharmacy(doc, report);
      renderLab(doc, report);
      renderAbdm(doc, report);
      renderRoster(doc, report);

      paginate(doc, report.header.hospital?.name || 'Hospital');
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderCover(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const g = geom(doc);
  const h = r.header.hospital;

  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10)
    .text('AbhaAyushman ABDM HIMS', g.margin, g.margin);

  doc.fillColor(PRIMARY).font('Helvetica-Bold').fontSize(22).moveDown(0.3)
    .text('Hospital Operating Report');

  doc.font('Helvetica').fontSize(11).fillColor(MUTED).moveDown(0.2)
    .text(h ? h.name : 'Hospital');
  if (h) {
    doc.text(`${h.address || ''}${h.address ? ', ' : ''}${h.city}, ${h.state} ${h.pincode}`);
    doc.text(`${h.phone || ''}  ·  ${h.email || ''}${h.website ? `  ·  ${h.website}` : ''}`);
  }
  doc.moveDown(0.8).fillColor(PRIMARY);

  // Range / generation card
  const cardY = doc.y;
  doc.save()
    .roundedRect(g.margin, cardY, g.contentWidth, 70, 6)
    .fillAndStroke('#F8FAFC', '#E5E7EB')
    .restore();

  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
    .text('REPORTING WINDOW', g.margin + 14, cardY + 10);
  doc.fillColor(PRIMARY).font('Helvetica-Bold').fontSize(13)
    .text(r.header.range.label, g.margin + 14, cardY + 22);

  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
    .text('GENERATED', g.margin + g.contentWidth / 2, cardY + 10);
  doc.fillColor(PRIMARY).font('Helvetica-Bold').fontSize(11)
    .text(r.header.generatedAtIst, g.margin + g.contentWidth / 2, cardY + 22);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`By ${r.header.generatedBy.name} (${r.header.generatedBy.role})`, g.margin + g.contentWidth / 2, cardY + 38);

  doc.y = cardY + 80;

  // Hospital identity grid
  if (h) {
    heading(doc, 'Hospital identity');
    kvGrid(doc, [
      ['Hospital code', h.code || '—'],
      ['Type', h.type || '—'],
      ['HIP ID', h.hipId || '—'],
      ['HIU ID', h.hiuId || '—'],
      ['HFR Facility ID', h.hfrFacilityId || '—'],
      ['ABDM enabled', h.abdmEnabled ? 'Yes' : 'No'],
    ], 2);
  }
}

function renderPatientKpis(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const k = r.patientKpis;
  heading(doc, 'Patients & ABHA');
  kvGrid(doc, [
    ['Total registered (lifetime)', nf(k.totalLifetime)],
    ['Registered in range', nf(k.totalInRange)],
    ['ABHA-linked (lifetime)', `${nf(k.abhaLinkedLifetime)} (${k.abhaPercentLifetime}%)`],
    ['ABHA-linked in range', `${nf(k.abhaLinkedInRange)} (${k.abhaPercentInRange}%)`],
    ['KYC verified (lifetime)', nf(k.kycVerifiedLifetime)],
    ['', ''],
  ], 2);

  caption(doc, 'Gender split (lifetime)');
  kvGrid(doc, k.genderSplit.map((g) => [g.gender, nf(g.count)] as [string, string]), 3);

  caption(doc, 'Age buckets (lifetime)');
  kvGrid(doc, k.ageBuckets.map((b) => [b.bucket, nf(b.count)] as [string, string]), 3);

  if (k.topCities.length) {
    caption(doc, 'Top cities (lifetime)');
    kvGrid(doc, k.topCities.map((c) => [c.city, nf(c.count)] as [string, string]), 3);
  }
}

function renderEncounters(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const e = r.encounters;
  heading(doc, 'Encounters');
  kvGrid(doc, [
    ['Total in range', nf(e.totalInRange)],
    ['Avg per day', nf(e.avgPerDay)],
  ], 2);

  caption(doc, 'By type');
  kvGrid(doc, e.byType.map((b) => [b.type, nf(b.count)] as [string, string]), 4);

  caption(doc, 'By status');
  kvGrid(doc, e.byStatus.map((b) => [b.status, nf(b.count)] as [string, string]), 3);

  if (e.dailyTrend.length) {
    caption(doc, `Daily trend (last ${e.dailyTrend.length} days)`);
    table(
      doc,
      [
        { header: 'Day', width: 80, get: (r: any) => r.label },
        { header: 'Date', width: 130, get: (r: any) => r.date.substring(0, 10) },
        { header: 'Encounters', width: 100, align: 'right', get: (r: any) => nf(r.count) },
      ],
      e.dailyTrend,
      { zebra: true },
    );
  }
}

function renderDoctors(doc: PDFKit.PDFDocument, r: HospitalReport) {
  if (r.doctors.length === 0) return;
  heading(doc, 'Doctor performance');
  caption(doc, `Encounters and revenue attributed in the report range, sorted by encounter volume.`);

  table(
    doc,
    [
      { header: 'Doctor', width: 150, get: (d: any) => d.name },
      { header: 'Spec.', width: 90, get: (d: any) => d.specialization || '—' },
      { header: 'Patients', width: 55, align: 'right', get: (d: any) => nf(d.uniquePatients) },
      { header: 'Visits', width: 50, align: 'right', get: (d: any) => nf(d.encounters) },
      { header: 'OPD', width: 38, align: 'right', get: (d: any) => nf(d.opd) },
      { header: 'IPD', width: 38, align: 'right', get: (d: any) => nf(d.ipd) },
      { header: 'Avg/Day', width: 50, align: 'right', get: (d: any) => nf(d.avgPatientsPerDay) },
      { header: 'Revenue', width: 70, align: 'right', get: (d: any) => inr(d.revenueAttributed) },
    ],
    r.doctors,
    { zebra: true },
  );

  // Per-doctor cadence table — one row per doctor across daily/weekly/monthly/yearly buckets.
  caption(doc, 'Patient counts by cadence');
  table(
    doc,
    [
      { header: 'Doctor', width: 150, get: (d: any) => d.name },
      { header: 'Today', width: 50, align: 'right', get: (d: any) => nf((d.trends.daily.at(-1) || { count: 0 }).count) },
      { header: 'Last 7d', width: 60, align: 'right', get: (d: any) => nf(d.trends.daily.slice(-7).reduce((a: number, x: any) => a + x.count, 0)) },
      { header: 'Last 30d', width: 60, align: 'right', get: (d: any) => nf(d.trends.daily.reduce((a: number, x: any) => a + x.count, 0)) },
      { header: 'This month', width: 70, align: 'right', get: (d: any) => nf((d.trends.monthly.at(-1) || { count: 0 }).count) },
      { header: 'This year', width: 70, align: 'right', get: (d: any) => nf((d.trends.yearly.at(-1) || { count: 0 }).count) },
      { header: 'All time', width: 70, align: 'right', get: (d: any) => nf(d.encounters) },
    ],
    r.doctors,
    { zebra: true },
  );
}

function renderAppointments(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const a = r.appointments;
  heading(doc, 'Appointments');
  kvGrid(doc, [
    ['Total', nf(a.total)],
    ['Scheduled', nf(a.scheduled)],
    ['Completed', nf(a.completed)],
    ['Cancelled', nf(a.cancelled)],
    ['No-show', nf(a.noShow)],
  ], 3);

  if (a.byDoctor.length) {
    caption(doc, 'By doctor');
    table(
      doc,
      [
        { header: 'Doctor', width: 220, get: (r: any) => r.name },
        { header: 'Total', width: 60, align: 'right', get: (r: any) => nf(r.total) },
        { header: 'Completed', width: 80, align: 'right', get: (r: any) => nf(r.completed) },
        { header: 'Cancelled', width: 80, align: 'right', get: (r: any) => nf(r.cancelled) },
        { header: 'No-show', width: 70, align: 'right', get: (r: any) => nf(r.noShow) },
      ],
      a.byDoctor,
      { zebra: true, maxRows: 50 },
    );
  }
}

function renderIpd(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const i = r.ipd;
  heading(doc, 'IPD / Admissions');
  kvGrid(doc, [
    ['Admissions in range', nf(i.admissionsInRange)],
    ['Currently admitted', nf(i.currentlyAdmitted)],
    ['Discharges', nf(i.discharges)],
    ['Avg length of stay (days)', nf(i.avgLengthOfStay)],
    ['Bed occupancy', `${i.bedOccupancyPercent}%`],
    ['Total IPD revenue', inr(i.totalIpdRevenue)],
  ], 2);

  if (i.byWard.length) {
    caption(doc, 'By ward');
    table(
      doc,
      [
        { header: 'Ward', width: 200, get: (r: any) => r.ward },
        { header: 'Type', width: 90, get: (r: any) => r.type },
        { header: 'Admissions', width: 100, align: 'right', get: (r: any) => nf(r.admissions) },
        { header: 'Revenue', width: 110, align: 'right', get: (r: any) => inr(r.revenue) },
      ],
      i.byWard,
      { zebra: true },
    );
  }
}

function renderBilling(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const b = r.billing;
  heading(doc, 'Billing & Revenue');
  kvGrid(doc, [
    ['Total revenue (paid)', inr(b.totalRevenue)],
    ['Discounts given', inr(b.discountsGiven)],
    ['Pending', inr(b.outstanding.pending)],
    ['Partial', inr(b.outstanding.partial)],
  ], 2);

  caption(doc, 'By source');
  kvGrid(doc, [
    ['Consultation', inr(b.bySource.consultation)],
    ['Pharmacy', inr(b.bySource.pharmacy)],
    ['Labs', inr(b.bySource.labs)],
    ['Scans', inr(b.bySource.scans)],
    ['IPD', inr(b.bySource.ipd)],
  ], 3);

  if (b.byMethod.length) {
    caption(doc, 'By payment method');
    table(
      doc,
      [
        { header: 'Method', width: 150, get: (r: any) => r.method },
        { header: 'Transactions', width: 120, align: 'right', get: (r: any) => nf(r.count) },
        { header: 'Amount', width: 150, align: 'right', get: (r: any) => inr(r.amount) },
      ],
      b.byMethod,
      { zebra: true },
    );
  }

  if (b.dailyTrend.length) {
    caption(doc, `Daily revenue (last ${b.dailyTrend.length} days)`);
    table(
      doc,
      [
        { header: 'Day', width: 80, get: (r: any) => r.label },
        { header: 'Date', width: 130, get: (r: any) => r.date.substring(0, 10) },
        { header: 'Revenue', width: 100, align: 'right', get: (r: any) => inr(r.revenue) },
      ],
      b.dailyTrend,
      { zebra: true },
    );
  }

  // Staff-wise collection: who actually rang up the rupees in this window.
  // Useful for desk-level accountability — shows how cash/digital splits
  // by collector so admins can spot mis-attributed receipts at a glance.
  if (b.byStaff.length) {
    caption(doc, 'Collections by staff');
    table(
      doc,
      [
        { header: 'Collector', width: 140, get: (r: any) => r.name },
        { header: 'Role', width: 80, get: (r: any) => r.role || '—' },
        { header: 'Receipts', width: 60, align: 'right', get: (r: any) => nf(r.paymentCount) },
        { header: 'Cash', width: 70, align: 'right', get: (r: any) =>
          inr(r.byMethod.find((m: any) => m.method === 'CASH')?.amount || 0) },
        { header: 'Digital', width: 80, align: 'right', get: (r: any) =>
          inr(r.byMethod
            .filter((m: any) => m.method !== 'CASH')
            .reduce((s: number, m: any) => s + (m.amount || 0), 0)) },
        { header: 'Total', width: 80, align: 'right', get: (r: any) => inr(r.total) },
      ],
      b.byStaff,
      { zebra: true },
    );
  }
}

function renderPharmacy(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const p = r.pharmacy;
  heading(doc, 'Pharmacy');
  kvGrid(doc, [
    ['Dispensed quantity (range)', nf(p.dispensedQty)],
    ['Pharmacy revenue (range)', inr(p.pharmacyRevenue)],
    ['Current stock value', inr(p.currentStockValue)],
    ['Items below reorder level', nf(p.lowStockCount)],
    ['Batches expiring within 90d', nf(p.expiringSoonCount)],
  ], 2);

  if (p.topByQty.length) {
    caption(doc, 'Top medicines by quantity dispensed');
    table(
      doc,
      [
        { header: 'Medicine', width: 280, get: (r: any) => r.name },
        { header: 'Qty', width: 80, align: 'right', get: (r: any) => nf(r.qty) },
        { header: 'Revenue', width: 110, align: 'right', get: (r: any) => inr(r.revenue) },
      ],
      p.topByQty,
      { zebra: true },
    );
  }
}

function renderLab(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const l = r.lab;
  heading(doc, 'Lab & Investigations');
  kvGrid(doc, [
    ['Tests ordered', nf(l.ordered)],
    ['Completed', nf(l.completed)],
    ['Pending', nf(l.pending)],
    ['Avg TAT (hrs)', nf(l.avgTatHours)],
  ], 2);

  if (l.byCategory.length) {
    caption(doc, 'By category');
    table(
      doc,
      [
        { header: 'Category', width: 220, get: (r: any) => r.category },
        { header: 'Count', width: 100, align: 'right', get: (r: any) => nf(r.count) },
      ],
      l.byCategory,
      { zebra: true },
    );
  }
}

function renderAbdm(doc: PDFKit.PDFDocument, r: HospitalReport) {
  const a = r.abdm;
  heading(doc, 'ABDM Activity');
  kvGrid(doc, [
    ['Consents requested', nf(a.consents.requested)],
    ['Granted', nf(a.consents.granted)],
    ['Denied', nf(a.consents.denied)],
    ['Revoked', nf(a.consents.revoked)],
    ['Expired', nf(a.consents.expired)],
    ['Purged', nf(a.consents.purged)],
    ['Care contexts linked', nf(a.careContextsLinked)],
    ['Scan & Share check-ins', nf(a.scanShareCheckIns)],
    ['HIU records received', nf(a.externalRecordsReceived)],
  ], 2);
}

function renderRoster(doc: PDFKit.PDFDocument, r: HospitalReport) {
  if (r.patientRoster.length === 0) return;
  doc.addPage();
  heading(doc, 'Patient roster');
  caption(
    doc,
    `${r.patientRoster.length.toLocaleString()} patients with activity in the report range. ABHA-linked patients are highlighted with their ABHA address; numeric figures are inclusive of the report window.`,
  );

  table(
    doc,
    [
      { header: 'UHID', width: 70, get: (p: any) => p.uhid },
      { header: 'Name', width: 130, get: (p: any) => `${p.firstName} ${p.lastName}` },
      { header: 'Sex', width: 32, get: (p: any) => (p.gender || '').slice(0, 1) },
      { header: 'Age', width: 28, align: 'right', get: (p: any) => p.age != null ? String(p.age) : '—' },
      { header: 'Mobile', width: 80, get: (p: any) => p.mobile },
      { header: 'ABHA', width: 105, get: (p: any) => p.abhaNumber || '—' },
      { header: 'KYC', width: 50, get: (p: any) => p.kycStatus || '—' },
      { header: 'Visits', width: 38, align: 'right', get: (p: any) => String(p.visitsInRange) },
      { header: 'Last visit', width: 65, get: (p: any) => p.lastVisitAt ? p.lastVisitAt.substring(0, 10) : '—' },
      { header: 'Spend', width: 60, align: 'right', get: (p: any) => inr(p.lifetimeSpend) },
    ],
    r.patientRoster,
    { zebra: true, maxRows: PDF_ROSTER_CAP },
  );
}
