/**
 * invoiceSummaryPdf.ts — generates the CRX-branded "Customer Invoice Summary"
 * PDF (field-app parity #34).
 *
 * This is the consolidated, customer-facing statement that lists a customer's
 * UNPOSTED chemical-sales invoices AND UNPOSTED field-application invoices in one
 * document, with a per-type subtotal and a single combined total + balance.
 *
 * It deliberately reuses the same jsPDF + jspdf-autotable + pdfTheme stack and
 * the green header band used by invoicePdf.ts / reportPdf.ts, so the look matches
 * the rest of the app's printed output.
 *
 * Money discipline: the totals come straight from buildCustomerInvoiceSummary()
 * (integer cents). This generator NEVER recomputes a total from displayed dollar
 * strings — it formats the already-summed integer cents via formatCents, so the
 * printed per-type subtotals sum to the combined total exactly.
 */

import type jsPDF from 'jspdf';
import type { CellHookData } from 'jspdf-autotable';
import { CRX_GREEN, CHARCOAL, GRAY, LIGHT_BG, RED, TABLE_HEADER_BG, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_TAGLINE_HEADER, COMPANY_LEGAL_NAME } from './companyInfo';
import { formatCents as fmt } from './money';
import { localToday } from './dateUtils';
import type { CustomerInvoiceSummary, SummaryInvoiceRow, SummaryTotals } from './customerInvoiceSummary';

export interface CustomerInvoiceSummaryPdfData {
  customer_name: string;
  customer_account_number?: string;
  customer_address?: string;
  customer_city?: string;
  customer_state?: string;
  customer_zip?: string;
  /** Report inputs (NOT persisted) — ChemMan's Heading Date / Discount Date / Terms / Invoice Comment. */
  heading_date: string;     // YYYY-MM-DD
  discount_date?: string;   // YYYY-MM-DD
  terms?: string;
  invoice_comment?: string;
  /** The combined summary (per-type rows + subtotals + combined total). */
  summary: CustomerInvoiceSummary;
}

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

/** Build the row body for one section's invoice table. */
function sectionBody(rows: ReadonlyArray<SummaryInvoiceRow>): string[][] {
  return rows.map((r) => [
    fmtDate(r.invoice_date),
    r.invoice_number,
    fmt(r.total_amount_cents),
    fmt(r.paid_amount_cents),
    fmt(r.prepay_applied_cents),
    fmt(r.balance_cents),
  ]);
}

/** The subtotal row appended under a section table. */
function subtotalRow(label: string, t: SummaryTotals): string[] {
  return [
    '',
    label,
    fmt(t.totalAmountCents),
    fmt(t.paidAmountCents),
    fmt(t.prepayAppliedCents),
    fmt(t.balanceCents),
  ];
}

const SECTION_HEAD = [['Date', 'Invoice #', 'Total', 'Paid', 'Prepay', 'Balance']];

const SECTION_COL_STYLES = {
  0: { cellWidth: 80 },
  1: { cellWidth: 'auto' as const },
  2: { halign: 'right' as const, cellWidth: 80 },
  3: { halign: 'right' as const, cellWidth: 80 },
  4: { halign: 'right' as const, cellWidth: 80 },
  5: { halign: 'right' as const, cellWidth: 84, fontStyle: 'bold' as const },
};

export async function generateCustomerInvoiceSummaryPdf(data: CustomerInvoiceSummaryPdfData) {
  const { default: JsPDFCtor } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDFCtor({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;

  const drawFooter = () => {
    try {
      const footerY = pageH - 20;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `${COMPANY_LEGAL_NAME}  •  Includes unposted chemical sales and unposted field application invoices  •  Generated ${new Date().toLocaleDateString()}`,
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('invoiceSummaryPdf: drawFooter failed', e);
    }
  };

  // ── Header band ───────────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 35);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(COMPANY_TAGLINE_HEADER, margin, 53);

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('CUSTOMER INVOICE SUMMARY', pageW - margin, 30, { align: 'right' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('Unposted chemical sales + field application', pageW - margin, 46, { align: 'right' });

  let y = 90;

  // ── Customer + report-input box ───────────────────────────────────────────
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, 92, 4, 4, 'F');

  // Left: customer block
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('CUSTOMER', margin + 12, y + 16);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  const maxNameWidth = (pageW - margin * 2) / 2 - 24;
  const nameLines = doc.splitTextToSize(data.customer_name.toUpperCase(), maxNameWidth);
  doc.text(nameLines.slice(0, 2).join('\n'), margin + 12, y + 33);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  let addrY = y + 46;
  if (data.customer_address) { doc.text(data.customer_address, margin + 12, addrY); addrY += 12; }
  const cityLine = [data.customer_city, data.customer_state, data.customer_zip].filter(Boolean).join(', ');
  if (cityLine) { doc.text(cityLine, margin + 12, addrY); addrY += 12; }
  if (data.customer_account_number) { doc.text(`Acct #: ${data.customer_account_number}`, margin + 12, addrY); }

  // Right: report inputs (heading/discount date, terms)
  const rightX = pageW - margin - 12;
  const labelX = rightX - 150;
  let ry = y + 16;
  const drawField = (label: string, value: string) => {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text(label, labelX, ry);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(value, labelX, ry + 12);
    ry += 28;
  };
  drawField('HEADING DATE', fmtDate(data.heading_date));
  if (data.discount_date) drawField('DISCOUNT DATE', fmtDate(data.discount_date));
  if (data.terms) drawField('TERMS', data.terms);

  y += 92 + 14;

  // ── Invoice Comment ───────────────────────────────────────────────────────
  if (data.invoice_comment && data.invoice_comment.trim()) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(data.invoice_comment.trim(), pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 8;
  }

  // ── Section renderer ──────────────────────────────────────────────────────
  const renderSection = (title: string, rows: ReadonlyArray<SummaryInvoiceRow>, subtotal: SummaryTotals) => {
    if (rows.length === 0) return;
    if (y + 80 > pageH - 50) { doc.addPage(); y = margin; }

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text(title, margin, y);
    y += 6;

    autoTable(doc, {
      startY: y + 4,
      margin: { left: margin, right: margin },
      head: SECTION_HEAD,
      body: [...sectionBody(rows), subtotalRow(`Subtotal — ${title} (${subtotal.count})`, subtotal)],
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 4, textColor: CHARCOAL },
      headStyles: { fillColor: TABLE_HEADER_BG, textColor: CHARCOAL, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      columnStyles: SECTION_COL_STYLES,
      // Bold + tinted subtotal (the last body row, appended after the invoices).
      didParseCell: (hook: CellHookData) => {
        try {
          if (hook.section === 'body' && hook.row.index === rows.length) {
            hook.cell.styles.fontStyle = 'bold';
            hook.cell.styles.fillColor = LIGHT_BG;
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('invoiceSummaryPdf: didParseCell failed', e);
        }
      },
      didDrawPage: drawFooter,
    });

    y = doc.lastAutoTable.finalY + 18;
  };

  renderSection('Chemical Sales', data.summary.chemicalRows, data.summary.chemicalSubtotal);
  renderSection('Field Application', data.summary.fieldRows, data.summary.fieldSubtotal);

  // Empty-state line if the customer has neither.
  if (data.summary.combinedTotal.count === 0) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...GRAY);
    doc.text('No unposted chemical sales or field application invoices for this customer.', margin, y);
    y += 18;
  }

  // ── Combined total box ────────────────────────────────────────────────────
  if (y + 120 > pageH - 50) { doc.addPage(); y = margin; }

  const ct = data.summary.combinedTotal;
  const boxW = 260;
  const boxX = pageW - margin - boxW;
  const hasPaid = ct.paidAmountCents > 0;
  const hasPrepay = ct.prepayAppliedCents > 0;
  const hasWriteOff = ct.writeOffCents > 0;
  const hasDiscount = ct.discountEarnedCents > 0;
  const boxH = 70 + (hasPaid ? 16 : 0) + (hasPrepay ? 16 : 0) + (hasWriteOff ? 16 : 0) + (hasDiscount ? 16 : 0);
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(boxX, y, boxW, boxH, 4, 4, 'F');

  const lX = boxX + 12;
  const rX = boxX + boxW - 12;
  let ty = y + 20;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...CHARCOAL);

  const totalRow = (label: string, value: string, color?: [number, number, number]) => {
    doc.setTextColor(...CHARCOAL);
    doc.text(label, lX, ty);
    if (color) doc.setTextColor(...color);
    doc.text(value, rX, ty, { align: 'right' });
    doc.setTextColor(...CHARCOAL);
    ty += 16;
  };

  totalRow(`Combined Total (${ct.count} invoice${ct.count === 1 ? '' : 's'})`, fmt(ct.totalAmountCents));
  if (hasPaid) totalRow('Payments', `-${fmt(ct.paidAmountCents)}`, CRX_GREEN);
  if (hasPrepay) totalRow('Prepay Applied', `-${fmt(ct.prepayAppliedCents)}`, CRX_GREEN);
  if (hasWriteOff) totalRow('Write-off', `-${fmt(ct.writeOffCents)}`, CRX_GREEN);

  doc.setDrawColor(200, 200, 200);
  doc.line(lX, ty - 4, rX, ty - 4);
  ty += 8;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('COMBINED BALANCE', lX, ty);
  doc.setTextColor(...(ct.balanceCents > 0 ? RED : CRX_GREEN));
  doc.text(fmt(ct.balanceCents), rX, ty, { align: 'right' });
  doc.setTextColor(...CHARCOAL);

  if (hasDiscount) {
    ty += 16;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text('Discount Earned (if paid early)', lX, ty);
    doc.text(fmt(ct.discountEarnedCents), rX, ty, { align: 'right' });
  }

  drawFooter();
  return doc as unknown as jsPDF;
}

export async function downloadCustomerInvoiceSummaryPdf(data: CustomerInvoiceSummaryPdfData) {
  const doc = await generateCustomerInvoiceSummaryPdf(data);
  const safeName = data.customer_name.replace(/[^a-zA-Z0-9]/g, '_');
  doc.save(`Customer_Invoice_Summary_${safeName}_${localToday()}.pdf`);
}
