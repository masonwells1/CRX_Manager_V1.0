/**
 * chemicalSummaryReportPdf — the print-ready, cross-job Chemical Summary Report PDF
 * (field-app parity #12).
 *
 * This is the office's batch view: how much of each chemical went out across a whole
 * set of selected jobs, without opening each job. It is product-centric and SUMMED:
 *
 *   • Header band — title, company letterhead, generated date, # jobs summed.
 *   • Chemical totals — one row per product+unit: total applied (summed across the
 *       included jobs) in its measure unit PLUS the gallon/lb-equivalent re-derived
 *       from the SUMMED quantity, and how many jobs contributed.
 *   • Grand total line — distinct product lines + total acres across the included jobs.
 *   • Jobs included — the jobs whose chemicals ARE in the totals (job # + customer).
 *   • Jobs EXCLUDED — any selected job that could not be summed, with a reason, so the
 *       grand total is never silently wrong (the #12 never-undercount bar).
 *
 * The numbers come from the pure `buildChemicalSummaryReportData` aggregator (keyed by
 * product name + unit, gal/lb re-derived from the sum), so a single included job's
 * figures equal that job's own Chemical Application Report (#11).
 *
 * Customer/office-facing, so it uses COMPANY_FOOTER_THANKS — NOT the internal crew
 * footer. Follows the shared dynamic-import + helper pattern of applicatorSheetPdf.ts
 * (drawFooter / ensureRoom, dynamic jsPDF + jspdf-autotable import).
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_NAME, COMPANY_CITY, COMPANY_FOOTER_THANKS } from './companyInfo';
import { fmtNum } from './applicatorSheetData';
import type { ChemicalSummaryReportData } from './chemicalSummaryReportData';

/** Footer rule + customer-safe company line on every page. */
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

/** Draw the cross-job chemical summary onto the doc. */
function drawSummary(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  data: ChemicalSummaryReportData,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  const jobsSummed = data.included_jobs.length;

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 56, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('Chemical Summary Report', margin, 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(COMPANY_NAME, margin, 40);
  doc.text(COMPANY_CITY, margin, 50);
  doc.setFontSize(9);
  doc.text(`${jobsSummed} job${jobsSummed !== 1 ? 's' : ''} summed`, pageW - margin, 26, { align: 'right' });
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, pageW - margin, 40, { align: 'right' });
  y = 74;

  // ── Grand-total summary line ─────────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Total chemical usage across the selected jobs', margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...GRAY);
  const summaryParts = [
    `Distinct products: ${data.distinct_product_lines}`,
    `Jobs included: ${jobsSummed}`,
    `Total acres: ${fmtNum(data.total_acres) || '0'}`,
  ];
  if (data.excluded_jobs.length > 0) summaryParts.push(`Jobs excluded: ${data.excluded_jobs.length}`);
  doc.text(summaryParts.join('     ·     '), margin, y);
  y += 18;

  // ── Per-product summed totals (the core) ─────────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Chemical Totals', margin, y);
  y += 6;

  if (data.rows.length === 0) {
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...GRAY);
    doc.text('No chemical quantities to total for the included jobs.', margin, y);
    y += 16;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Product', 'Total Applied', 'gal/lb Equiv.', 'Jobs']],
      body: data.rows.map((r) => [
        r.product_name,
        r.total_quantity_display,
        r.gl_lb_display,
        String(r.job_count),
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // ── Jobs included in the totals ──────────────────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text(`Jobs Included (${jobsSummed})`, margin, y);
  y += 6;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Job #', 'Customer(s)']],
    body: data.included_jobs.length > 0
      ? data.included_jobs.map((j) => [j.job_number || j.job_id, j.customer_label || '—'])
      : [['—', 'No jobs included']],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 18;

  // ── Jobs EXCLUDED (never silently dropped) ───────────────────────────────────
  if (data.excluded_jobs.length > 0) {
    y = ensureRoom(doc, y, 70, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Jobs Excluded from the totals (${data.excluded_jobs.length})`, margin, y);
    y += 6;

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Job #', 'Reason not included']],
      body: data.excluded_jobs.map((j) => [j.job_number || j.job_id, j.reason]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
    });
    y = doc.lastAutoTable.finalY + 14;

    y = ensureRoom(doc, y, 30, margin);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    const note = doc.splitTextToSize(
      'These jobs could NOT be added to the totals above. The grand total covers only the included jobs — '
      + 'review the excluded jobs and re-run the report if their chemicals must be counted.',
      pageW - margin * 2,
    );
    doc.text(note, margin, y);
  }
}

/**
 * Generate and download the cross-job Chemical Summary Report PDF.
 *
 * @param data     the aggregated summary payload (from buildChemicalSummaryReportData).
 * @param filename optional download filename.
 */
export async function generateChemicalSummaryReportPdf(
  data: ChemicalSummaryReportData,
  filename?: string,
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;

  drawSummary(doc, autoTable, data);

  // Footer on every page (drawn last so the page count is final).
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40);
  }

  doc.save(filename || `chemical-summary-report-${data.included_jobs.length}-jobs.pdf`);
}
