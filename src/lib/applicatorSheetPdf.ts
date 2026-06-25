/**
 * applicatorSheetPdf — the three ChemMan applicator field-sheet PDF layouts
 * (Original / Custom / Enhanced) — field-app parity #9.
 *
 * The applicator field sheet is the paper the crew physically carries to the
 * field. All three formats read the SAME shared `ApplicatorSheetData` (built by
 * applicatorSheetData.ts) so every chemical, rate, acre figure and total matches
 * the job's saved data exactly and the formats never disagree.
 *
 *   • Original  — compact single-job sheet: job #, customer(s)+ID(s), each
 *                 field/location with acres + crop + pest (route order), and the
 *                 chemical list with rate/acre + unit.
 *   • Enhanced  — adds total applied per product with the gallon/lb-equivalent
 *                 conversion, applicator, vehicle, scheduled date, and per-product
 *                 REI (re-entry hours) and PHI (pre-harvest days).
 *   • Custom    — identical data to Enhanced but uses the admin-configured header
 *                 (company name/address/logo), footer text and optional-column
 *                 toggles from app_settings 'applicator_sheet_custom'. Falls back
 *                 to the standard CRX header when nothing is configured.
 *
 * EVERY format ends with blank field-fillable areas for the crew to hand-write
 * as-applied acres and start/end weather (wind dir, wind mph, temp, humidity).
 * No aerial content (no Flights/Starts/airport strips). No pricing/billing — this
 * is a layout-only field document.
 *
 * Follows the dynamic-import + pdfTheme pattern of wpsNoticePdf.ts / reportPdf.ts.
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_NAME, COMPANY_CITY, COMPANY_FOOTER_INTERNAL } from './companyInfo';
import {
  type ApplicatorSheetData,
  type ApplicatorSheetFormat,
  type ApplicatorSheetCustomConfig,
  type ApplicatorSheetColumns,
  DEFAULT_SHEET_COLUMNS,
  SHEET_FORMAT_LABELS,
  fmtNum,
} from './applicatorSheetData';

/** Format a YYYY-MM-DD as a local date string (no timezone shift). */
function fmtDate(d: string): string {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString();
}

/** Footer rule + company / format line on every page, plus optional custom footer. */
function drawFooter(doc: JsPDFWithAutoTable, margin: number, customFooter: string | null) {
  const pageW = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(COMPANY_FOOTER_INTERNAL, pageW / 2, footerY + 12, { align: 'center' });
  if (customFooter && customFooter.trim()) {
    doc.text(customFooter.trim(), pageW / 2, footerY + 22, { align: 'center' });
  }
}

/** Page-break guard: add a page when the next block won't fit. Returns new y. */
function ensureRoom(doc: JsPDFWithAutoTable, y: number, needed: number, margin: number): number {
  if (y + needed > doc.internal.pageSize.getHeight() - 60) {
    doc.addPage();
    return margin;
  }
  return y;
}

interface SheetTheme {
  /** Header band title line. */
  title: string;
  /** Company name shown in the header. */
  companyName: string;
  /** Company location/address shown under the title. */
  companyAddress: string;
  /** Optional logo data: URL drawn in the header. */
  logoDataUrl: string | null;
  /** Optional footer line. */
  footerText: string | null;
  /** Which OPTIONAL columns to render (Custom only restricts these). */
  columns: ApplicatorSheetColumns;
  /** Enhanced/Custom show totals, conversions, REI/PHI, applicator/vehicle. */
  enhanced: boolean;
}

/**
 * Draw one applicator sheet with the given theme. Shared by all three formats so
 * the body layout is identical and only the header/columns differ.
 */
function drawSheet(doc: JsPDFWithAutoTable, autoTable: typeof import('jspdf-autotable').default, data: ApplicatorSheetData, theme: SheetTheme): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 56, 'F');
  let titleX = margin;
  if (theme.logoDataUrl) {
    // Best-effort: a bad/oversized data URL must never break the sheet.
    try {
      doc.addImage(theme.logoDataUrl, 'PNG', margin, 10, 36, 36);
      titleX = margin + 46;
    } catch { /* skip logo, keep generating */ }
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text(theme.title, titleX, 26);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(theme.companyName, titleX, 40);
  if (theme.companyAddress) doc.text(theme.companyAddress, titleX, 50);
  doc.setFontSize(9);
  doc.text(`Job ${data.job_number}`, pageW - margin, 26, { align: 'right' });
  doc.text(`Scheduled: ${fmtDate(data.scheduled_date)}${data.scheduled_time ? ` ${data.scheduled_time}` : ''}`, pageW - margin, 40, { align: 'right' });
  y = 74;

  // ── Job / applicator info line ──────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const custLine = data.customers.length > 0
    ? data.customers.map((c) => c.account_number ? `${c.customer_name} (${c.account_number})` : c.customer_name).join(',  ')
    : 'Customer';
  const custLines = doc.splitTextToSize(`Customer(s): ${custLine}`, pageW - margin * 2);
  doc.text(custLines, margin, y);
  y += custLines.length * 13 + 4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...GRAY);
  const infoParts: string[] = [`Total acres: ${fmtNum(data.total_acres) || '0'}`];
  if (theme.enhanced) {
    infoParts.push(`Applicator: ${data.applicator_name || '________________'}`);
    infoParts.push(`Vehicle: ${data.vehicle_name || '________________'}`);
  }
  doc.text(infoParts.join('     ·     '), margin, y);
  y += 18;

  // ── Fields / locations IN ROUTE ORDER ───────────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Fields / Locations (route order)', margin, y);
  y += 6;

  const fieldHead: string[] = ['Stop', 'Field / Location', 'County', 'State'];
  if (theme.columns.crop) fieldHead.push('Crop');
  if (theme.columns.pest) fieldHead.push('Pest');
  fieldHead.push('Acres');
  // Blank hand-fill column for the crew to write actual applied acres in the field.
  fieldHead.push('As-Applied');

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [fieldHead],
    body: data.fields.map((f) => {
      const row: string[] = [String(f.stop), f.field_name, f.county || '—', f.state || '—'];
      if (theme.columns.crop) row.push(f.crop || '—');
      if (theme.columns.pest) row.push(f.pest || '—');
      row.push(fmtNum(f.acres) || '—');
      row.push(''); // blank as-applied hand-fill
      return row;
    }),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 18;

  // ── Tank mix / chemical list ────────────────────────────────────────────────
  y = ensureRoom(doc, y, 70, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Tank Mix / Chemicals', margin, y);
  y += 6;

  const chemHead: string[] = ['Product', 'Rate / Acre'];
  if (theme.enhanced && theme.columns.total_applied) chemHead.push('Total Applied');
  if (theme.enhanced && theme.columns.gl_lb) chemHead.push('gal/lb Equiv.');
  if (theme.enhanced && theme.columns.rei) chemHead.push('REI');
  if (theme.enhanced && theme.columns.phi) chemHead.push('PHI');

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [chemHead],
    body: data.products.map((p) => {
      const rate = p.rate_per_acre != null ? `${fmtNum(p.rate_per_acre)} ${p.rate_unit || ''}/ac`.trim() : '—';
      const row: string[] = [p.product_name, rate];
      if (theme.enhanced && theme.columns.total_applied) {
        row.push(p.total_applied != null ? `${fmtNum(p.total_applied)} ${p.rate_unit || ''}`.trim() : '—');
      }
      if (theme.enhanced && theme.columns.gl_lb) row.push(p.total_gl_lb || '—');
      if (theme.enhanced && theme.columns.rei) row.push(p.rei_hours != null ? `${p.rei_hours} hr` : '—');
      if (theme.enhanced && theme.columns.phi) row.push(p.phi_days != null ? `${p.phi_days} d` : '—');
      return row;
    }),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 16;

  // ── Loader comment ──────────────────────────────────────────────────────────
  if (data.loader_comment && data.loader_comment.trim()) {
    y = ensureRoom(doc, y, 44, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...CHARCOAL);
    doc.text('Loader Comment', margin, y);
    y += 13;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(data.loader_comment.trim(), pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 11 + 12;
  }

  // ── Blank as-applied / start-end weather hand-fill area (EVERY format) ───────
  y = ensureRoom(doc, y, 130, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Record As-Applied (fill in the field)', margin, y);
  y += 6;

  // A blank weather grid: START and END rows × wind dir / wind mph / temp / humidity.
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['', 'Wind Dir.', 'Wind (mph)', 'Temp (F)', 'Humidity (%)', 'Time']],
    body: [
      ['Start', '', '', '', '', ''],
      ['End', '', '', '', '', ''],
    ],
    styles: { fontSize: 9, cellPadding: 6, minCellHeight: 22 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    columnStyles: { 0: { fontStyle: 'bold' } },
  });
  y = doc.lastAutoTable.finalY + 14;

  // Signature + actual-acres lines.
  y = ensureRoom(doc, y, 50, margin);
  doc.setDrawColor(160, 160, 160);
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  doc.setFont('helvetica', 'normal');
  const half = (pageW - margin * 2 - 20) / 2;
  doc.line(margin, y + 16, margin + half, y + 16);
  doc.text('Total acres actually applied', margin, y + 26);
  doc.line(margin + half + 20, y + 16, pageW - margin, y + 16);
  doc.text('Applicator signature / date', margin + half + 20, y + 26);
}

/** Build the per-format theme. */
function themeFor(format: ApplicatorSheetFormat, custom: ApplicatorSheetCustomConfig | null): SheetTheme {
  const title = SHEET_FORMAT_LABELS[format];
  if (format === 'custom') {
    const cfg = custom;
    return {
      title,
      companyName: (cfg?.company_name?.trim()) || COMPANY_NAME,
      companyAddress: (cfg?.company_address?.trim()) || COMPANY_CITY,
      logoDataUrl: (cfg?.logo_data_url?.trim()) || null,
      footerText: (cfg?.footer_text?.trim()) || null,
      columns: cfg?.columns || { ...DEFAULT_SHEET_COLUMNS },
      enhanced: true, // Custom carries the SAME data as Enhanced
    };
  }
  return {
    title,
    companyName: COMPANY_NAME,
    companyAddress: COMPANY_CITY,
    logoDataUrl: null,
    footerText: null,
    columns: { ...DEFAULT_SHEET_COLUMNS },
    enhanced: format === 'enhanced',
  };
}

/**
 * Generate and download an applicator field sheet in the requested format.
 *
 * @param data    the shared sheet payload (route order already applied)
 * @param format  'original' | 'custom' | 'enhanced'
 * @param custom  the parsed Custom config (only used for the 'custom' format;
 *                pass null for Original/Enhanced)
 */
export async function generateApplicatorSheetPdf(
  data: ApplicatorSheetData,
  format: ApplicatorSheetFormat,
  custom: ApplicatorSheetCustomConfig | null,
  filename?: string,
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const theme = themeFor(format, custom);

  drawSheet(doc, autoTable, data, theme);

  // Footer on every page (drawn last so page count is final).
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40, theme.footerText);
  }

  doc.save(filename || `applicator-sheet-${format}-${data.job_number}.pdf`);
}
