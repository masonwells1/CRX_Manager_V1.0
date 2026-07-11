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
  /** Whether to draw the standard or custom company header band. */
  showBanner: boolean;
}

/** Packet-level options selected in the shared print-options dialog. */
export interface ApplicatorSheetPdfOptions {
  includeBillingSplits?: boolean;
  blankSections?: number;
  includePreviousApplications?: boolean;
  showBanner?: boolean;
}

/**
 * Draw one applicator sheet with the given theme. Shared by all three formats so
 * the body layout is identical and only the header/columns differ.
 */
function drawSheet(
  doc: JsPDFWithAutoTable,
  autoTable: typeof import('jspdf-autotable').default,
  data: ApplicatorSheetData,
  theme: SheetTheme,
  options: Required<ApplicatorSheetPdfOptions>,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header band ────────────────────────────────────────────────────────────
  if (theme.showBanner) {
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
  } else {
    // Without the banner, retain the job-specific identifier so same-day crew
    // sheets remain distinguishable at a glance.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Job ${data.job_number} — ${theme.title}`, margin, y);
    doc.text(fmtDate(data.scheduled_date), pageW - margin, y, { align: 'right' });
    y += 16;
  }

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

  // ── Billing splits ─────────────────────────────────────────────────────────
  if (options.includeBillingSplits && data.billingSplits && data.billingSplits.length > 0) {
    y = ensureRoom(doc, y, 70, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text('Billing Splits', margin, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Customer', 'Acres', '% of Job', 'Phone']],
      body: data.billingSplits.map((split) => [
        split.customerName,
        split.acres != null ? fmtNum(split.acres) : '—',
        split.percentOfJob != null ? `${fmtNum(split.percentOfJob)}%` : '—',
        split.phone || '—',
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
    });
    y = doc.lastAutoTable.finalY + 16;
  }

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
        // Label the Total Applied magnitude with its OWN measure unit (total_unit),
        // not the per-acre rate_unit — matches the in-page preview / loader worksheet.
        row.push(p.total_applied != null ? `${fmtNum(p.total_applied)} ${p.total_unit || ''}`.trim() : '—');
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

  // ── Previous applications by field ─────────────────────────────────────────
  if (options.includePreviousApplications && data.previousApplications) {
    data.previousApplications.forEach((fieldHistory) => {
      if (fieldHistory.records.length === 0) return;
      y = ensureRoom(doc, y, Math.min(300, 42 + 30 + fieldHistory.records.length * 24), margin);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...CHARCOAL);
      doc.text(`Previous applications — ${fieldHistory.fieldName}`, margin, y);
      y += 6;
      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Date', 'Products + rates', 'Applicator']],
        body: fieldHistory.records.map((record) => [
          fmtDate(record.date),
          record.summary,
          record.applicator || '—',
        ]),
        styles: { fontSize: 8.5, cellPadding: 4 },
        headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: ALT_ROW_BG },
      });
      y = doc.lastAutoTable.finalY + 14;
    });
  }

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
  const sectionCount = 1 + Math.min(5, Math.max(0, Math.round(options.blankSections)));
  for (let section = 0; section < sectionCount; section += 1) {
    y = ensureRoom(doc, y, 180, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(section === 0 ? 'Record As-Applied (fill in the field)' : `Additional Application Record ${section}`, margin, y);
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

    // Signature + actual-acres lines accompany every extra hand-fill block.
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
    y += 42;
  }
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
      showBanner: true,
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
    showBanner: true,
  };
}

function customerLine(data: ApplicatorSheetData): string {
  return data.customers.length > 0
    ? data.customers.map((customer) => customer.customer_name).join(', ')
    : 'Customer';
}

function formatCoordinate(value: number | null): string | null {
  return value != null && Number.isFinite(value) ? value.toFixed(6) : null;
}

/** Add a single satellite-map page. Invalid image data leaves no blank PDF page. */
function appendMapPage(
  doc: JsPDFWithAutoTable,
  data: ApplicatorSheetData,
  title: string,
  details: string,
  dataUrl: string,
): void {
  const existingPageCount = doc.getNumberOfPages();
  try {
    doc.addPage();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;
    const detailLineHeight = 10.5;
    const allDetailLines = doc.splitTextToSize(details, pageW - margin * 2) as string[];
    const detailLines = allDetailLines.length <= 3
      ? allDetailLines
      : [...allDetailLines.slice(0, 2), `${allDetailLines[2].trim().replace(/…+$/, '')}…`];
    // One or two header-detail lines retain the original 68pt band/88pt image
    // position. Each allowed extra line grows the band before its text is drawn.
    const bandHeight = 68 + Math.max(0, detailLines.length - 2) * detailLineHeight;
    const imageY = bandHeight + 20;

    doc.setFillColor(...CRX_GREEN);
    doc.rect(0, 0, pageW, bandHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(255, 255, 255);
    doc.text(title, margin, 27);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Job ${data.job_number}`, pageW - margin, 27, { align: 'right' });
    doc.text(detailLines, margin, 47);

    let imageWidth = pageW - margin * 2;
    let imageHeight = imageWidth * 0.7;
    const properties = doc.getImageProperties(dataUrl);
    if (properties.width > 0 && properties.height > 0) {
      imageHeight = imageWidth * (properties.height / properties.width);
    }
    const maxImageHeight = pageH - imageY - 70;
    if (imageHeight > maxImageHeight) {
      imageHeight = maxImageHeight;
      imageWidth = imageHeight * (properties.width / properties.height);
    }
    doc.addImage(dataUrl, 'PNG', (pageW - imageWidth) / 2, imageY, imageWidth, imageHeight);
  } catch {
    // Map images are strictly optional. Remove the just-added page so a malformed
    // response cannot leave a blank page in an otherwise usable field sheet.
    doc.deletePage(existingPageCount + 1);
  }
}

/** Append optional overview and per-field satellite map pages after the crew sheet. */
function appendMapPages(doc: JsPDFWithAutoTable, data: ApplicatorSheetData): void {
  if (!data.maps) return;
  const jobCustomer = customerLine(data);
  if (data.maps.overview) {
    appendMapPage(
      doc,
      data,
      'Job Field Map — Overview',
      `Job ${data.job_number} · ${jobCustomer}`,
      data.maps.overview,
    );
  }
  data.maps.perField.forEach((field) => {
    const lat = formatCoordinate(field.centroidLat);
    const lng = formatCoordinate(field.centroidLng);
    const location = lat && lng ? `Lat: ${lat}, Lng: ${lng}` : null;
    const details = [
      field.fieldName,
      field.customerName,
      `${fmtNum(field.acres) || '—'} acres`,
      location,
    ].filter((part): part is string => part !== null).join(' · ');
    appendMapPage(doc, data, 'Job Field Map', details, field.dataUrl);
  });
}

/**
 * Generate and download an applicator field sheet in the requested format.
 *
 * @param data    the shared sheet payload (route order already applied)
 * @param format  'original' | 'custom' | 'enhanced'
 * @param custom  the parsed Custom config (only used for the 'custom' format;
 *                pass null for Original/Enhanced)
 * @param options packet-level inclusion and layout toggles from the print dialog
 */
export async function generateApplicatorSheetPdf(
  data: ApplicatorSheetData,
  format: ApplicatorSheetFormat,
  custom: ApplicatorSheetCustomConfig | null,
  options: ApplicatorSheetPdfOptions = {},
  filename?: string,
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const theme = { ...themeFor(format, custom), showBanner: options.showBanner !== false };
  const resolvedOptions: Required<ApplicatorSheetPdfOptions> = {
    includeBillingSplits: options.includeBillingSplits !== false,
    blankSections: options.blankSections ?? 0,
    includePreviousApplications: options.includePreviousApplications !== false,
    showBanner: options.showBanner !== false,
  };

  drawSheet(doc, autoTable, data, theme, resolvedOptions);
  appendMapPages(doc, data);

  // Footer on every page (drawn last so page count is final).
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, 40, theme.footerText);
  }

  doc.save(filename || `applicator-sheet-${format}-${data.job_number}.pdf`);
}
