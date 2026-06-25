/**
 * loaderWorksheetPdf — the print-ready Loader Worksheet PDF for a FIELD JOB
 * (field-app parity #10).
 *
 * The loader worksheet is the paper the tank loader uses to mix each tank. It
 * shows, for one job: the job number, applicator, vehicle, tank capacity, carrier
 * rate, total acres, total spray volume, the number of loads (with a partial-last-
 * load note), a PER-LOAD table (one column per load, one row per product, showing
 * how much of each chemical goes into that tank), the per-product totals, and the
 * job's free-text Loader Comment verbatim.
 *
 * The loads + per-load split are computed by the pure `computeLoaderWorksheet`
 * (loaderWorksheet.ts) so the printed numbers match the in-page preview exactly
 * (sum of a product's per-load amounts === its job total; partial last load
 * handled). This is calculation + layout only — no pricing/billing.
 *
 * Follows the shared dynamic-import + helper pattern of applicatorSheetPdf.ts
 * (drawFooter / ensureRoom / fmtDate, dynamic jsPDF + autotable import).
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_NAME, COMPANY_CITY, COMPANY_FOOTER_INTERNAL } from './companyInfo';
import { fmtNum, type ApplicatorSheetCustomer } from './applicatorSheetData';
import {
  computeLoaderWorksheet,
  type LoaderProductInput,
  type LoaderWorksheet,
} from './loaderWorksheet';

/** Format a YYYY-MM-DD as a local date string (no timezone shift). */
function fmtDate(d: string): string {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString();
}

/** Footer rule + company line on every page (mirrors applicatorSheetPdf.drawFooter). */
function drawFooter(doc: JsPDFWithAutoTable, margin: number): void {
  const pageW = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(COMPANY_FOOTER_INTERNAL, pageW / 2, footerY + 12, { align: 'center' });
}

/** Page-break guard: add a page when the next block won't fit. Returns new y. */
function ensureRoom(doc: JsPDFWithAutoTable, y: number, needed: number, margin: number): number {
  if (y + needed > doc.internal.pageSize.getHeight() - 60) {
    doc.addPage();
    return margin;
  }
  return y;
}

/** Everything the loader worksheet PDF needs about the job (split is computed here). */
export interface LoaderWorksheetPdfData {
  job_number: string;
  customers: ApplicatorSheetCustomer[];
  scheduled_date: string; // YYYY-MM-DD
  scheduled_time: string | null;
  applicator_name: string | null;
  vehicle_name: string | null;
  total_acres: number;
  carrier_rate_gpa: number | null;
  /** Tank capacity (the per-job override if set, else the vehicle's). */
  tank_capacity: number | null;
  /** Unit label for the capacity (e.g. "gal"). Display only. */
  capacity_unit: string | null;
  products: LoaderProductInput[];
  loader_comment: string | null;
}

/**
 * Generate and download the Loader Worksheet PDF for a field job. The loads and
 * per-load split are computed from the data; an INVALID worksheet (no capacity /
 * carrier rate / acres) still produces a clear PDF stating what is missing rather
 * than a wrong loads number — matching the on-screen guard.
 */
export async function generateLoaderWorksheetPdf(
  data: LoaderWorksheetPdfData,
  filename?: string,
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  drawLoaderWorksheet(doc, autoTable, data);

  // Footer on every page (drawn last so page count is final).
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40);
  }

  doc.save(filename || `loader-worksheet-${data.job_number}.pdf`);
}

/**
 * Generate ONE combined Loader Worksheet PDF with a page per job — the Jobs-list
 * bulk "Loader Worksheet" action over the checkbox-selected jobs. Each job's split
 * is computed independently from the same pure function. Empty input is a no-op.
 */
export async function generateLoaderWorksheetBatchPdf(
  jobs: LoaderWorksheetPdfData[],
  filename?: string,
): Promise<void> {
  if (jobs.length === 0) return;
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  jobs.forEach((data, i) => {
    if (i > 0) doc.addPage();
    drawLoaderWorksheet(doc, autoTable, data);
  });

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40);
  }

  doc.save(filename || `loader-worksheets-${jobs.length}-jobs.pdf`);
}

/**
 * Draw ONE job's loader worksheet onto the current page of `doc`. Shared by the
 * single-job download and the bulk batch (one page per job) so the layout and the
 * per-load split are identical. Computes the split internally from the data.
 */
function drawLoaderWorksheet(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  data: LoaderWorksheetPdfData,
): void {
  const ws: LoaderWorksheet = computeLoaderWorksheet({
    total_acres: data.total_acres,
    carrier_rate_gpa: data.carrier_rate_gpa,
    tank_capacity: data.tank_capacity,
    products: data.products,
  });

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 56, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('Loader Worksheet', margin, 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(COMPANY_NAME, margin, 40);
  doc.text(COMPANY_CITY, margin, 50);
  doc.setFontSize(9);
  doc.text(`Job ${data.job_number}`, pageW - margin, 26, { align: 'right' });
  doc.text(`Scheduled: ${fmtDate(data.scheduled_date)}${data.scheduled_time ? ` ${data.scheduled_time}` : ''}`, pageW - margin, 40, { align: 'right' });
  y = 74;

  // ── Customer(s) line ───────────────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const custLine = data.customers.length > 0
    ? data.customers.map((c) => (c.account_number ? `${c.customer_name} (${c.account_number})` : c.customer_name)).join(',  ')
    : 'Customer';
  const custLines = doc.splitTextToSize(`Customer(s): ${custLine}`, pageW - margin * 2);
  doc.text(custLines, margin, y);
  y += custLines.length * 13 + 6;

  // ── Worksheet summary (applicator / vehicle / capacity / rate / loads) ───────
  const cap = data.tank_capacity != null && data.tank_capacity > 0
    ? `${fmtNum(data.tank_capacity)} ${data.capacity_unit || 'gal'}`
    : '________';
  const carrier = data.carrier_rate_gpa != null && data.carrier_rate_gpa > 0
    ? `${fmtNum(data.carrier_rate_gpa)} gal/ac`
    : '________';
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    body: [
      ['Applicator', data.applicator_name || '________________', 'Vehicle', data.vehicle_name || '________________'],
      ['Tank Capacity', cap, 'Carrier Rate', carrier],
      ['Total Acres', fmtNum(data.total_acres) || '0', 'Spray Volume', ws.valid ? `${fmtNum(ws.spray_volume)} gal` : '—'],
      [
        'Loads Needed',
        ws.valid ? String(ws.loads_count) : 'Invalid — enter capacity & carrier rate',
        'Partial Last Load',
        ws.valid && ws.partial_load_volume > 0 ? `${fmtNum(ws.partial_load_volume)} gal` : (ws.valid ? 'None (loads divide evenly)' : '—'),
      ],
    ],
    styles: { fontSize: 9.5, cellPadding: 5 },
    columnStyles: {
      0: { fontStyle: 'bold', textColor: CHARCOAL, cellWidth: 110 },
      2: { fontStyle: 'bold', textColor: CHARCOAL, cellWidth: 110 },
    },
    theme: 'grid',
  });
  y = doc.lastAutoTable.finalY + 16;

  // ── Per-load mix table OR the invalid-state message ──────────────────────────
  if (!ws.valid) {
    y = ensureRoom(doc, y, 60, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text('Loads cannot be calculated', margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...GRAY);
    const reason = ws.invalid_reason || 'Enter the tank capacity and carrier rate on the job to plan loads.';
    const reasonLines = doc.splitTextToSize(reason, pageW - margin * 2);
    doc.text(reasonLines, margin, y);
    y += reasonLines.length * 12 + 10;
  } else {
    y = ensureRoom(doc, y, 90, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text('Per-Load Mix (how much of each product goes in one tank)', margin, y);
    y += 6;

    // Columns: Product | Load 1 | Load 2 | … | Total. Each load header notes its
    // volume (and "(partial)" for the last partial load).
    const head: string[] = ['Product'];
    ws.loads.forEach((l) => {
      head.push(`Load ${l.load_number}\n${fmtNum(l.volume)} gal${l.is_partial ? ' (partial)' : ''}`);
    });
    head.push('Total');

    // Index-align with computeLoaderWorksheet: it pushes one entry per input
    // product, IN ORDER, onto every load — so load.products[pi] is THIS product
    // line, even when a job carries the same product on two lines (a name lookup
    // would collapse the duplicates onto the first line's amount). Total = the sum
    // across loads at the same index (independently per duplicate row).
    const body: string[][] = data.products.map((p, pi) => {
      const row: string[] = [p.unit ? `${p.product_name} (${p.unit})` : p.product_name];
      let rowTotal = 0;
      ws.loads.forEach((l) => {
        const lp = l.products[pi];
        if (lp) {
          rowTotal = Math.round((rowTotal + lp.amount) * 10000) / 10000;
          row.push(fmtNum(lp.amount));
        } else {
          row.push('—');
        }
      });
      row.push(fmtNum(rowTotal));
      return row;
    });

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [head],
      body,
      styles: { fontSize: 9, cellPadding: 4, halign: 'right' },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold', halign: 'center', fontSize: 8 },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      columnStyles: { 0: { halign: 'left', fontStyle: 'bold', textColor: CHARCOAL } },
    });
    y = doc.lastAutoTable.finalY + 16;
  }

  // ── Loader Comment (verbatim) ────────────────────────────────────────────────
  if (data.loader_comment && data.loader_comment.trim()) {
    y = ensureRoom(doc, y, 50, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...CHARCOAL);
    doc.text('Loader Comment', margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(data.loader_comment.trim(), pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 12;
  }
}
