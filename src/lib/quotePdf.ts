/**
 * quotePdf.ts — generates a professional Crop RX branded PDF for any quote
 * Uses jsPDF + jspdf-autotable (both already in package.json)
 *
 * GAP FIX #1: Quote PDF Generation
 */
// jsPDF and autoTable are dynamically imported inside each function
// to keep them out of the main bundle (~500KB each)
import { CRX_GREEN, CHARCOAL, GRAY, LIGHT_BG, type JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_TAGLINE_HEADER_NO_PHONE } from './companyInfo';
import { formatUSD as fmt } from './money';
import { stripInternalNotes } from './internalNotes';


type AutoTableColumnStyle = {
  cellWidth?: 'auto' | 'wrap' | number;
  halign?: 'left' | 'center' | 'right' | 'justify';
  fontStyle?: 'normal' | 'bold' | 'italic' | 'bolditalic';
};


interface PdfQuoteSection {
  section_name: string;
  section_notes?: string;
  section_header_notes?: string;
  items: PdfQuoteItem[];
}

interface PdfQuoteItem {
  product_name: string;
  category?: string;
  notes?: string;
  suggested_rate?: string;
  actual_rate: number;
  rate_unit: string;
  acres: number;
  total_units_needed: number;
  inventory_unit?: string;
  unit_size?: string;
  price_unit?: string;
  price_per_unit: number;
  price_per_acre?: number;
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

// Column definitions for the dynamic PDF column system
const PDF_COLUMN_DEFS: Record<string, { label: string; getValue: (item: PdfQuoteItem) => string; align?: 'right' }> = {
  product: { label: 'Product', getValue: (item) => item.product_name },
  category: { label: 'Category', getValue: (item) => item.category || '' },
  // Customer-facing: an internal below-cost approval reason must never print here.
  notes: { label: 'Notes', getValue: (item) => stripInternalNotes(item.notes) || '' },
  sug_rate: { label: 'Sug. Rate', getValue: (item) => item.suggested_rate || '-' },
  actual_rate: { label: 'Rate', getValue: (item) => `${item.actual_rate} ${item.rate_unit}` },
  rate_unit: { label: 'Unit', getValue: (item) => item.rate_unit || '' },
  acres: { label: 'Acres', getValue: (item) => item.acres?.toLocaleString() || '0' },
  qty: { label: 'Qty', getValue: (item) => `${item.total_units_needed?.toLocaleString() || '0'}${item.inventory_unit ? ' ' + item.inventory_unit : ''}` },
  unit_size: { label: 'Container', getValue: (item) => item.unit_size || '' },
  price_unit: { label: 'Price/Unit', getValue: (item) => `${fmt(item.price_per_unit)}${item.price_unit || item.inventory_unit ? '/' + (item.price_unit || item.inventory_unit) : ''}`, align: 'right' },
  price_per_acre: { label: '$/Acre', getValue: (item) => item.price_per_acre ? fmt(item.price_per_acre) : '-', align: 'right' },
  total_price: { label: 'Total', getValue: (item) => fmt(item.total_price), align: 'right' },
};

// Default columns when none specified (matches legacy behavior)
const DEFAULT_PDF_COLUMNS = ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'total_price'];

export async function generateQuotePdf(data: PdfQuoteData, columns?: string[]) {
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
  doc.text(COMPANY_TAGLINE_HEADER_NO_PHONE, margin, 53);

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
  const customerHeaderNotes = stripInternalNotes(data.header_notes);
  if (customerHeaderNotes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(customerHeaderNotes, pageW - margin * 2);
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

    // Section header notes (above items table)
    const customerSectionHeaderNotes = stripInternalNotes(section.section_header_notes);
    if (customerSectionHeaderNotes) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(...GRAY);
      const headerNoteLines = doc.splitTextToSize(customerSectionHeaderNotes, pageW - margin * 2 - 8);
      doc.text(headerNoteLines, margin + 4, y + 4);
      y += headerNoteLines.length * 4 + 8;
    }

    const activeCols = (columns || DEFAULT_PDF_COLUMNS).filter((c) => PDF_COLUMN_DEFS[c]);
    const headerRow = activeCols.map((c) => PDF_COLUMN_DEFS[c].label);
    const rows = section.items.map((item) =>
      activeCols.map((c) => PDF_COLUMN_DEFS[c].getValue(item))
    );

    // Build column styles: right-align columns that need it, last col bold
    const colStyles: Record<number, AutoTableColumnStyle> = { 0: { cellWidth: 'auto' } };
    activeCols.forEach((c, i) => {
      if (PDF_COLUMN_DEFS[c].align === 'right') {
        colStyles[i] = { ...(colStyles[i] || {}), halign: 'right' };
      }
      // Bold the last column (usually total)
      if (i === activeCols.length - 1 && PDF_COLUMN_DEFS[c].align === 'right') {
        colStyles[i] = { ...(colStyles[i] || {}), fontStyle: 'bold' };
      }
    });

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [headerRow],
      body: rows,
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 5, textColor: CHARCOAL },
      headStyles: {
        fillColor: [240, 240, 240],
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 8,
      },
      columnStyles: colStyles,
      alternateRowStyles: { fillColor: [252, 252, 252] },
    });

    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 6;

    const customerSectionNotes = stripInternalNotes(section.section_notes);
    if (customerSectionNotes) {
      doc.setFontSize(8);
      doc.setTextColor(...GRAY);
      doc.setFont('helvetica', 'italic');
      doc.text(customerSectionNotes, margin + 4, y + 4);
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

  y += 50;

  // ─── Footer notes ─────────────────────────────────────────
  const customerFooterNotes = stripInternalNotes(data.footer_notes);
  if (customerFooterNotes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(customerFooterNotes, pageW - margin * 2);
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
    'Crop RX Solutions  •  www.croprxsolutions.com  •  Prices valid for the period shown above. Subject to product availability.',
    pageW / 2,
    footerY,
    { align: 'center' }
  );

  return doc;
}

/** Convenience: generate + immediately download */
export async function downloadQuotePdf(data: PdfQuoteData, columns?: string[]) {
  const doc = await generateQuotePdf(data, columns);
  doc.save(`${data.quote_number}.pdf`);
}

/** Convenience: generate + return as Blob for email attachment etc. */
export async function getQuotePdfBlob(data: PdfQuoteData): Promise<Blob> {
  const doc = await generateQuotePdf(data);
  return doc.output('blob');
}

/**
 * Batch quote PDF: generates one multi-page PDF with all quotes.
 * Single quote → saves as quote_number.pdf
 * Multiple quotes → saves as quotes_batch_{date}.pdf
 */
export async function generateBatchQuotePdf(quotes: PdfQuoteData[]): Promise<void> {
  if (quotes.length === 0) throw new Error('No quotes to generate');
  if (quotes.length === 1) {
    await downloadQuotePdf(quotes[0]);
    return;
  }

  // Generate each quote as a separate doc, then download sequentially
  // (jsPDF doesn't support merging docs, so we use the rAF sequential pattern
  // from generateBatchInvoicePdf)
  const docs = await Promise.all(quotes.map((q) => generateQuotePdf(q)));
  docs[0].save(`${quotes[0].quote_number}.pdf`);

  for (let i = 1; i < docs.length; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        docs[i].save(`${quotes[i].quote_number}.pdf`);
        resolve();
      });
    });
  }
}
