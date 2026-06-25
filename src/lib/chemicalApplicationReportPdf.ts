/**
 * chemicalApplicationReportPdf — the print-ready, per-job Chemical Application
 * Report PDF (field-app parity #11).
 *
 * This is the official chemical record for one field job — the document handed to
 * a customer or regulator to prove exactly what was applied. It is chemical-centric
 * (one row per product) rather than crew-centric like the applicator field sheet:
 *
 *   • Header band — job #, application date, company letterhead.
 *   • Summary — customer(s) + account(s), applicator, total acres, crop(s), pest(s).
 *   • Fields applied — each field/location with county/state, acres, crop, pest.
 *   • Chemicals applied — one row per product: EPA registration, rate/acre + unit,
 *       total applied + gallon/lb-equivalent conversion, REI (re-entry hours), PHI
 *       (pre-harvest days). EPA reg renders blank when the product has none (the
 *       report is never blocked by a missing reg).
 *
 * The numbers are read from the SHARED `ApplicatorSheetData` gatherer via
 * `buildChemicalApplicationReportData`, so every product, rate, total and gal/lb
 * conversion is byte-identical to the applicator field sheet (#9) for the same job.
 *
 * Follows the dynamic-import + helper pattern of applicatorSheetPdf.ts
 * (drawFooter / ensureRoom / fmtDate, dynamic jsPDF + jspdf-autotable import).
 * No aerial content, no pricing/billing — a compliance record, not an invoice.
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_NAME, COMPANY_CITY, COMPANY_FOOTER_THANKS } from './companyInfo';
import { fmtNum } from './applicatorSheetData';
import {
  buildChemicalApplicationReportData,
  type ChemicalApplicationReportData,
} from './chemicalApplicationReportData';
import type { ApplicatorSheetData } from './applicatorSheetData';

/** Format a YYYY-MM-DD as a local date string (no timezone shift). */
function fmtDate(d: string): string {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString();
}

/**
 * Footer rule + company line on every page. This report is CUSTOMER/REGULATOR-
 * facing (handed out as proof of application), so it uses the customer-safe
 * COMPANY_FOOTER_THANKS — NOT the "Internal Use Only" footer the internal crew
 * documents (applicator field sheet / loader worksheet) carry (Codex P2).
 */
function drawFooter(doc: JsPDFWithAutoTable, margin: number): void {
  const pageW = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(COMPANY_FOOTER_THANKS, pageW / 2, footerY + 12, { align: 'center' });
}

/** Page-break guard: add a page when the next block won't fit. Returns new y. */
function ensureRoom(doc: JsPDFWithAutoTable, y: number, needed: number, margin: number): number {
  if (y + needed > doc.internal.pageSize.getHeight() - 60) {
    doc.addPage();
    return margin;
  }
  return y;
}

/** Draw the chemical application report body onto the doc. */
function drawReport(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  data: ChemicalApplicationReportData,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 56, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('Chemical Application Report', margin, 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(COMPANY_NAME, margin, 40);
  doc.text(COMPANY_CITY, margin, 50);
  doc.setFontSize(9);
  doc.text(`Job ${data.job_number}`, pageW - margin, 26, { align: 'right' });
  doc.text(
    `Application: ${fmtDate(data.application_date)}${data.scheduled_time ? ` ${data.scheduled_time}` : ''}`,
    pageW - margin,
    40,
    { align: 'right' },
  );
  y = 74;

  // ── Customer(s) ──────────────────────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const custLine = data.customers.length > 0
    ? data.customers.map((c) => c.account_number ? `${c.customer_name} (${c.account_number})` : c.customer_name).join(',  ')
    : 'Customer';
  const custLines = doc.splitTextToSize(`Customer(s): ${custLine}`, pageW - margin * 2);
  doc.text(custLines, margin, y);
  y += custLines.length * 13 + 4;

  // ── Summary line (applicator, acres, crop, pest) ─────────────────────────────
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...GRAY);
  const infoParts: string[] = [
    `Applicator: ${data.applicator_name || '________________'}`,
    `Total acres: ${fmtNum(data.total_acres) || '0'}`,
  ];
  doc.text(infoParts.join('     ·     '), margin, y);
  y += 14;
  const cropPest: string[] = [
    `Crop(s): ${data.crops_summary || '—'}`,
    `Pest(s): ${data.pests_summary || '—'}`,
  ];
  const cropPestLines = doc.splitTextToSize(cropPest.join('     ·     '), pageW - margin * 2);
  doc.text(cropPestLines, margin, y);
  y += cropPestLines.length * 12 + 8;

  // ── Fields / locations applied ───────────────────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Fields Applied', margin, y);
  y += 6;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Field / Location', 'County', 'State', 'Crop', 'Pest', 'Acres']],
    body: data.fields.map((f) => [
      f.field_name,
      f.county || '—',
      f.state || '—',
      f.crop || '—',
      f.pest || '—',
      fmtNum(f.acres) || '—',
    ]),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 18;

  // ── Chemicals applied (the chemical-centric core) ────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Chemicals Applied', margin, y);
  y += 6;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Product', 'EPA Reg. No.', 'Rate / Acre', 'Total Applied', 'gal/lb Equiv.', 'REI', 'PHI']],
    body: data.chemicals.map((c) => [
      c.product_name,
      c.epa_registration || '—',
      c.rate_per_acre_display,
      c.total_applied_display,
      c.gl_lb_display,
      c.rei_display,
      c.phi_display,
    ]),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 16;

  // ── Compliance note + certification line ─────────────────────────────────────
  y = ensureRoom(doc, y, 60, margin);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  const note = doc.splitTextToSize(
    'REI = Restricted-Entry Interval (hours workers must stay out of the treated area). '
    + 'PHI = Pre-Harvest Interval (days that must elapse before harvest). '
    + 'Applications made per the product label; observe all label restrictions.',
    pageW - margin * 2,
  );
  doc.text(note, margin, y);
  y += note.length * 10 + 18;

  y = ensureRoom(doc, y, 40, margin);
  doc.setDrawColor(160, 160, 160);
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  const half = (pageW - margin * 2 - 20) / 2;
  doc.line(margin, y + 16, margin + half, y + 16);
  doc.text('Applicator signature', margin, y + 26);
  doc.line(margin + half + 20, y + 16, pageW - margin, y + 16);
  doc.text('Date', margin + half + 20, y + 26);
}

/**
 * Generate and download the per-job Chemical Application Report PDF.
 *
 * @param input    the shared applicator-sheet data (route order already applied) OR
 *                 a pre-built ChemicalApplicationReportData. Passing the shared
 *                 ApplicatorSheetData is preferred so the report reuses the
 *                 gatherer's figures verbatim.
 * @param filename optional download filename.
 */
export async function generateChemicalApplicationReportPdf(
  input: ApplicatorSheetData | ChemicalApplicationReportData,
  filename?: string,
): Promise<void> {
  const data: ChemicalApplicationReportData = 'chemicals' in input
    ? input
    : buildChemicalApplicationReportData(input);

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;

  drawReport(doc, autoTable, data);

  // Footer on every page (drawn last so the page count is final).
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40);
  }

  doc.save(filename || `chemical-application-report-${data.job_number}.pdf`);
}
