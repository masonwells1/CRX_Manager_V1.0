/**
 * projectedUseReportPdf — the print-ready, cross-job Projected Use Report PDF
 * (field-app parity #13).
 *
 * This is the office's PURCHASING/INVENTORY-planning view: how much of each chemical
 * the company will STILL need for the upcoming and in-flight jobs, so product can be
 * ordered ahead. It is product-centric and FORECAST (not already-applied):
 *
 *   • Header band — title, company letterhead, generated date, # jobs projected.
 *   • Basis subtitle — states EXACTLY what the number means: "Projected = planned rate ×
 *       not-yet-applied (remaining) acres, for scheduled/in-progress jobs as of <date>",
 *       plus the date range of the included jobs. Honesty drives purchasing.
 *   • Projected totals — one row per product+unit: projected quantity (summed across the
 *       included jobs' NOT-YET-APPLIED portion) in its measure unit PLUS the gallon/lb-
 *       equivalent re-derived from the SUMMED projected quantity, and how many jobs
 *       contributed.
 *   • Grand-total line — distinct product lines + total not-yet-applied (projected) acres.
 *   • Jobs included — the scheduled/in-progress jobs the projection covers (job #,
 *       customer, status, remaining / total acres — so the forecast basis is transparent).
 *   • Jobs EXCLUDED — any selected job NOT projected (already-applied / completed /
 *       cancelled / invoiced / 0-remaining / unresolved), with a reason, so the number is
 *       genuinely a forecast of what is still to come (criterion 4) and never silently wrong.
 *
 * The numbers come from the pure `buildProjectedUseReportData` aggregator (planned rate ×
 * remaining acres, keyed by product name + unit, gal/lb re-derived from the projected sum),
 * which reuses the #12 form-conflict guard + gal/lb re-derivation EXACTLY so this and the
 * Chemical Summary Report never disagree on a shared figure.
 *
 * Customer/office-facing, so it uses COMPANY_FOOTER_THANKS. Follows the shared dynamic-
 * import + helper pattern of applicatorSheetPdf.ts (drawFooter / ensureRoom, dynamic
 * jsPDF + jspdf-autotable import).
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_NAME, COMPANY_CITY, COMPANY_FOOTER_THANKS } from './companyInfo';
import { fmtNum } from './applicatorSheetData';
import type { ProjectedUseReportData } from './projectedUseReportData';

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

/** Human-readable date range of the included jobs, or 'n/a' when none. */
function dateRangeLabel(data: ProjectedUseReportData): string {
  if (!data.date_from && !data.date_to) return 'n/a';
  if (data.date_from === data.date_to) return data.date_from ?? 'n/a';
  return `${data.date_from ?? '?'} → ${data.date_to ?? '?'}`;
}

/** Draw the cross-job projected-use forecast onto the doc. */
function drawReport(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  data: ProjectedUseReportData,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  const jobsProjected = data.included_jobs.length;

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 56, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('Projected Use Report', margin, 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(COMPANY_NAME, margin, 40);
  doc.text(COMPANY_CITY, margin, 50);
  doc.setFontSize(9);
  doc.text(`${jobsProjected} job${jobsProjected !== 1 ? 's' : ''} projected`, pageW - margin, 26, { align: 'right' });
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, pageW - margin, 40, { align: 'right' });
  y = 72;

  // ── Basis subtitle (criterion 3/4: state exactly what the number means) ──────
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(...GRAY);
  const basis = doc.splitTextToSize(
    `Projected = planned rate × not-yet-applied (remaining) acres, for scheduled / in-progress jobs `
    + `as of ${new Date().toLocaleDateString()}. Already-applied, completed, invoiced, cancelled and `
    + `zero-remaining jobs are excluded (listed below) so this is a forecast of product still to apply — `
    + `not a record of what has already been sprayed.`,
    pageW - margin * 2,
  );
  doc.text(basis, margin, y);
  y += basis.length * 11 + 6;

  // ── Grand-total summary line ─────────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Projected chemical usage for the upcoming jobs', margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...GRAY);
  const summaryParts = [
    `Distinct products: ${data.distinct_product_lines}`,
    `Jobs projected: ${jobsProjected}`,
    `Projected (remaining) acres: ${fmtNum(data.projected_acres) || '0'}`,
    `Date range: ${dateRangeLabel(data)}`,
  ];
  if (data.excluded_jobs.length > 0) summaryParts.push(`Jobs excluded: ${data.excluded_jobs.length}`);
  const summaryLines = doc.splitTextToSize(summaryParts.join('     ·     '), pageW - margin * 2);
  doc.text(summaryLines, margin, y);
  y += summaryLines.length * 12 + 6;

  // ── Per-product projected totals (the core) ──────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Projected Chemical Totals', margin, y);
  y += 6;

  if (data.rows.length === 0) {
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...GRAY);
    doc.text('No projected chemical usage for the included jobs.', margin, y);
    y += 16;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Product', 'Projected Use', 'gal/lb Equiv.', 'Jobs']],
      body: data.rows.map((r) => [
        r.product_name,
        r.projected_quantity_display,
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

  // ── Jobs included in the projection (with the remaining/total acres basis) ────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text(`Jobs Projected (${jobsProjected})`, margin, y);
  y += 6;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Job #', 'Customer(s)', 'Status', 'Remaining ac', 'Total ac']],
    body: data.included_jobs.length > 0
      ? data.included_jobs.map((j) => [
          j.job_number || j.job_id,
          j.customer_label || '—',
          j.status,
          fmtNum(j.remaining_acres) || '0',
          fmtNum(j.total_acres) || '0',
        ])
      : [['—', 'No jobs included', '—', '—', '—']],
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    columnStyles: {
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
  });
  y = doc.lastAutoTable.finalY + 18;

  // ── Jobs EXCLUDED (criterion 4: distinguish already-applied; never silently wrong) ──
  if (data.excluded_jobs.length > 0) {
    y = ensureRoom(doc, y, 70, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Jobs Excluded from the projection (${data.excluded_jobs.length})`, margin, y);
    y += 6;

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Job #', 'Reason not projected']],
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
      'These jobs were NOT projected — their product is already applied or they are no longer scheduled, so '
      + 'they have nothing left to forecast. The projection above covers only the included (scheduled / in-progress) jobs.',
      pageW - margin * 2,
    );
    doc.text(note, margin, y);
  }
}

/**
 * Generate and download the cross-job Projected Use Report PDF.
 *
 * @param data     the aggregated projection payload (from buildProjectedUseReportData).
 * @param filename optional download filename.
 */
export async function generateProjectedUseReportPdf(
  data: ProjectedUseReportData,
  filename?: string,
): Promise<void> {
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

  doc.save(filename || `projected-use-report-${data.included_jobs.length}-jobs.pdf`);
}
