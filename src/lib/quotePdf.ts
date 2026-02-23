/**
 * quotePdf.ts — generates a professional Crop RX branded PDF for any quote
 * Uses jsPDF + jspdf-autotable (both already in package.json)
 *
 * GAP FIX #1: Quote PDF Generation
 */
// jsPDF and autoTable are dynamically imported inside each function
// to keep them out of the main bundle (~500KB each)
import type jsPDF from 'jspdf';

type JsPDFWithAutoTable = InstanceType<typeof jsPDF> & {
  lastAutoTable: { finalY: number };
};

// Brand colours
const CRX_GREEN: [number, number, number] = [40, 162, 106]; // #28A26A
const CHARCOAL: [number, number, number] = [46, 46, 46]; // #2E2E2E
const GRAY: [number, number, number] = [78, 78, 78]; // #4E4E4E
const LIGHT_BG: [number, number, number] = [245, 250, 247]; // very light green tint

interface PdfQuoteSection {
  section_name: string;
  section_notes?: string;
  items: PdfQuoteItem[];
}

interface PdfQuoteItem {
  product_name: string;
  actual_rate: number;
  rate_unit: string;
  acres: number;
  total_units_needed: number;
  inventory_unit?: string;
  price_per_unit: number;
  total_price: number;
}

interface PdfQuoteData {
  quote_number: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  sales_rep_name: string;
  created_at: string;
  expires_at?: string;
  valid_days: number;
  tier: number;
  header_notes?: string;
  footer_notes?: string;
  sections: PdfQuoteSection[];
  totals: {
    totalPrice: number;
    totalCost: number;
    totalProfit: number;
    avgMargin: number;
  };
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export async function generateQuotePdf(data: PdfQuoteData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 40;

  // ─── Header bar ───────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 35);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Agricultural Input Solutions  •  Robinson, IL', margin, 53);

  // Quote number badge on right
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(data.quote_number, pageW - margin, 38, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Tier ${data.tier} Pricing`, pageW - margin, 53, { align: 'right' });

  y = 90;

  // ─── Customer + Date info ─────────────────────────────────
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, 70, 4, 4, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('PREPARED FOR', margin + 12, y + 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.text(data.customer_name, margin + 12, y + 35);
  if (data.customer_phone) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.text(data.customer_phone, margin + 12, y + 50);
  }
  if (data.customer_email) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.text(data.customer_email, margin + 12, y + 62);
  }

  // Right side — dates
  const rightX = pageW - margin - 12;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('QUOTE DATE', rightX, y + 18, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(new Date(data.created_at).toLocaleDateString(), rightX, y + 32, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.text('VALID UNTIL', rightX, y + 48, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  const expiresStr = data.expires_at
    ? new Date(data.expires_at).toLocaleDateString()
    : `${data.valid_days} days`;
  doc.text(expiresStr, rightX, y + 62, { align: 'right' });

  y += 85;

  // ─── Sales rep ────────────────────────────────────────────
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  doc.text(`Prepared by: ${data.sales_rep_name}`, margin, y);
  y += 18;

  // ─── Header notes ─────────────────────────────────────────
  if (data.header_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 8;
  }

  // ─── Sections with tables ─────────────────────────────────
  for (const section of data.sections) {
    // Section header
    doc.setFillColor(...CRX_GREEN);
    doc.rect(margin, y, pageW - margin * 2, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(255, 255, 255);
    doc.text(section.section_name.toUpperCase(), margin + 8, y + 15);
    y += 26;

    const rows = section.items.map((item) => [
      item.product_name,
      `${item.actual_rate} ${item.rate_unit}`,
      item.acres.toLocaleString(),
      `${item.total_units_needed.toLocaleString()}${item.inventory_unit ? ' ' + item.inventory_unit : ''}`,
      fmt(item.price_per_unit),
      fmt(item.total_price),
    ]);

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Product', 'Rate', 'Acres', 'Qty', 'Price/Unit', 'Total']],
      body: rows,
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 5, textColor: CHARCOAL },
      headStyles: {
        fillColor: [240, 240, 240],
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 8,
      },
      columnStyles: {
        0: { cellWidth: 'auto' },
        4: { halign: 'right' },
        5: { halign: 'right', fontStyle: 'bold' },
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
    });

    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 6;

    if (section.section_notes) {
      doc.setFontSize(8);
      doc.setTextColor(...GRAY);
      doc.setFont('helvetica', 'italic');
      doc.text(section.section_notes, margin + 4, y + 4);
      y += 14;
    }

    y += 10;

    // Check for page break
    if (y > 700) {
      doc.addPage();
      y = 40;
    }
  }

  // ─── Totals box ───────────────────────────────────────────
  y += 10;
  if (y > 660) {
    doc.addPage();
    y = 40;
  }

  const totalsX = pageW - margin - 200;
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(totalsX, y, 200, 50, 4, 4, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...CHARCOAL);
  doc.text('QUOTE TOTAL', totalsX + 12, y + 20);
  doc.setFontSize(18);
  doc.setTextColor(...CRX_GREEN);
  doc.text(fmt(data.totals.totalPrice), totalsX + 188, y + 20, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  doc.text(`Estimated profit: ${fmt(data.totals.totalProfit)}  •  Margin: ${data.totals.avgMargin.toFixed(1)}%`, totalsX + 12, y + 40);

  y += 70;

  // ─── Footer notes ─────────────────────────────────────────
  if (data.footer_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(data.footer_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 10;
  }

  // ─── Footer bar ───────────────────────────────────────────
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 10, pageW - margin, footerY - 10);
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(
    'Crop RX Solutions  •  Robinson, IL  •  Prices valid for the period shown above. Subject to product availability.',
    pageW / 2,
    footerY,
    { align: 'center' }
  );

  return doc;
}

/** Convenience: generate + immediately download */
export async function downloadQuotePdf(data: PdfQuoteData) {
  const doc = await generateQuotePdf(data);
  doc.save(`${data.quote_number}.pdf`);
}

/** Convenience: generate + return as Blob for email attachment etc. */
export async function getQuotePdfBlob(data: PdfQuoteData): Promise<Blob> {
  const doc = await generateQuotePdf(data);
  return doc.output('blob');
}
