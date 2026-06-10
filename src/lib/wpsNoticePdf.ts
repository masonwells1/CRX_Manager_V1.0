/**
 * WPS Pre-Application Notice PDF (deep-dive H1 B3).
 *
 * 40 CFR 170 requires a commercial applicator's employer to provide the farm
 * operator, before or at application, with: location/description of the treated
 * area, date and time of application, product name, EPA registration number,
 * active ingredients, REI, and whether posting/oral notification is required.
 * This generates that notice from a CRX job. Fields CRX doesn't store (active
 * ingredients) print as "see product label". REI prints from products.rei_hours
 * when entered, otherwise "see product label".
 *
 * Follows the dynamic-import + pdfTheme pattern of loadSheetPdf.ts.
 */
import { CRX_GREEN, CHARCOAL, GRAY, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_NAME, COMPANY_FOOTER_THANKS } from './companyInfo';

/** Footer rule + company line (drawn on every page at the end). */
function drawFooter(doc: JsPDFWithAutoTable, margin: number) {
  const pageW = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(COMPANY_FOOTER_THANKS, pageW / 2, footerY + 12, { align: 'center' });
}

export interface WpsNoticeField {
  field_name: string;
  county: string | null;
  state: string | null;
  acres: number;
}

export interface WpsNoticeProduct {
  product_name: string;
  epa_registration: string | null;
  signal_word: string | null;
  rei_hours: number | null;
  rate_per_acre: number | null;
  rate_unit: string | null;
}

export interface WpsNoticeData {
  job_number: string;
  customer_name: string;
  application_date: string; // YYYY-MM-DD
  scheduled_time: string | null;
  applicator_name: string | null;
  fields: WpsNoticeField[];
  products: WpsNoticeProduct[];
}

export async function generateWpsNoticePdf(data: WpsNoticeData, filename?: string): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header band ────────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 50, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text('WPS PRE-APPLICATION NOTICE', margin, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Worker Protection Standard — 40 CFR Part 170', pageW - margin, 32, { align: 'right' });
  y = 70;

  // ── Operator / application info ────────────────────────────────────────────
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`To the agricultural employer / operator: ${data.customer_name}`, margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...GRAY);
  const dateStr = new Date(data.application_date + 'T00:00:00').toLocaleDateString();
  doc.text(`From: ${COMPANY_NAME} (commercial applicator)`, margin, y);
  y += 14;
  doc.text(
    `Application date: ${dateStr}${data.scheduled_time ? `   ·   Scheduled time: ${data.scheduled_time}` : ''}${data.applicator_name ? `   ·   Applicator: ${data.applicator_name}` : ''}   ·   Job: ${data.job_number}`,
    margin,
    y,
  );
  y += 22;

  // Keep a heading and the first row of what follows it on the same page.
  const ensureRoom = (needed: number) => {
    if (y + needed > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage();
      y = margin;
    }
  };

  // ── Treated areas ──────────────────────────────────────────────────────────
  ensureRoom(60);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Treated Area(s)', margin, y);
  y += 8;
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Field', 'County', 'State', 'Acres']],
    body: data.fields.map((f) => [
      f.field_name,
      f.county || '—',
      f.state || '—',
      f.acres ? f.acres.toLocaleString() : '—',
    ]),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 20;

  // ── Products ───────────────────────────────────────────────────────────────
  ensureRoom(60);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Product(s) Applied', margin, y);
  y += 8;
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Product', 'EPA Reg. No.', 'Signal Word', 'Rate', 'REI', 'Active Ingredients']],
    body: data.products.map((p) => [
      p.product_name,
      p.epa_registration || 'see label',
      p.signal_word || '—',
      p.rate_per_acre ? `${p.rate_per_acre} ${p.rate_unit || ''}/ac`.trim() : '—',
      p.rei_hours != null ? `${p.rei_hours} hours` : 'see product label',
      'see product label',
    ]),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: CRX_GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
  });
  y = doc.lastAutoTable.finalY + 22;

  // ── Required notices ───────────────────────────────────────────────────────
  const notices = [
    'Keep workers and other persons OUT of the treated area during application and until the restricted-entry interval (REI) for each product has expired.',
    'Oral notification and/or posting of the treated area is required as specified on each product label (40 CFR 170.409). Where the label requires both, do both.',
    'Display this information at your central posting location and retain it for at least 30 days after the end of the last REI (40 CFR 170.311).',
    'Refer to each product label for the full list of active ingredients, first-aid measures, and personal protective equipment requirements.',
  ];
  ensureRoom(60);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Required Notices', margin, y);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  for (const n of notices) {
    const lines = doc.splitTextToSize(`•  ${n}`, pageW - margin * 2);
    // Page-break guard: keep each bullet whole
    if (y + lines.length * 11 > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage();
      y = margin;
    }
    doc.text(lines, margin, y);
    y += lines.length * 11 + 4;
  }

  // ── Footer on every page ───────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(doc, margin);
  }

  doc.save(filename || `wps-notice-${data.job_number}.pdf`);
}
