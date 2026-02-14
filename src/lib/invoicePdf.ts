/**
 * invoicePdf.ts — generates a professional CRX-branded Invoice PDF
 * Uses jsPDF + jspdf-autotable (dynamically imported to keep out of main bundle)
 *
 * Sprint 10: Invoice PDF Generator
 */

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];
const LIGHT_BG: [number, number, number] = [245, 250, 247];

export interface InvoicePdfItem {
  description: string;
  product_name?: string;
  quantity: number;
  unit_size?: string;
  unit_price_cents: number;
  extended_cents: number;
  rate_per_acre?: number | null;
  acres?: number | null;
}

export interface InvoicePdfData {
  invoice_number: string;
  invoice_date: string;
  due_date?: string;
  invoice_type: string;
  status: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_city?: string;
  customer_state?: string;
  customer_zip?: string;
  salesman_name?: string;
  purchase_order_ref?: string;
  header_notes?: string;
  footer_notes?: string;
  items: InvoicePdfItem[];
  total_amount_cents: number;
  total_cost_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  balance_cents: number;
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export async function generateInvoicePdf(data: InvoicePdfData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 40;

  // Header bar
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 35);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Agricultural Input Solutions  •  Robinson, IL', margin, 53);

  // Invoice number badge on right
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', pageW - margin, 28, { align: 'right' });
  doc.setFontSize(12);
  doc.text(data.invoice_number, pageW - margin, 48, { align: 'right' });

  y = 90;

  // Customer + Invoice details box
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, 85, 4, 4, 'F');

  // Left: Bill To
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('BILL TO', margin + 12, y + 16);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(data.customer_name, margin + 12, y + 33);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  let addrY = y + 46;
  if (data.customer_address) {
    doc.text(data.customer_address, margin + 12, addrY);
    addrY += 12;
  }
  if (data.customer_city || data.customer_state) {
    const cityLine = [data.customer_city, data.customer_state, data.customer_zip].filter(Boolean).join(', ');
    doc.text(cityLine, margin + 12, addrY);
    addrY += 12;
  }
  if (data.customer_phone) {
    doc.text(data.customer_phone, margin + 12, addrY);
  }

  // Right: Invoice details
  const rightX = pageW - margin - 12;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('INVOICE DATE', rightX - 100, y + 16);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...CHARCOAL);
  doc.text(new Date(data.invoice_date + 'T00:00:00').toLocaleDateString(), rightX - 100, y + 30);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('DUE DATE', rightX, y + 16, { align: 'right' });
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...CHARCOAL);
  doc.text(
    data.due_date ? new Date(data.due_date + 'T00:00:00').toLocaleDateString() : 'Due on receipt',
    rightX,
    y + 30,
    { align: 'right' },
  );

  if (data.salesman_name) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text('SALESMAN', rightX - 100, y + 48);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(data.salesman_name, rightX - 100, y + 60);
  }

  if (data.purchase_order_ref) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text('PO REF', rightX, y + 48, { align: 'right' });
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(data.purchase_order_ref, rightX, y + 60, { align: 'right' });
  }

  y += 100;

  // Header notes
  if (data.header_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'italic');
    const lines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 8;
  }

  // Line items table
  const rows = data.items.map((item) => [
    item.product_name || item.description,
    item.unit_size || '',
    item.quantity.toString(),
    fmt(item.unit_price_cents),
    fmt(item.extended_cents),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Product', 'Unit', 'Qty', 'Unit Price', 'Amount']],
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
      2: { halign: 'center' },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' },
    },
    alternateRowStyles: { fillColor: [252, 252, 252] },
    didDrawPage: () => {
      const footerY = doc.internal.pageSize.getHeight() - 20;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `Crop RX Solutions  •  Generated ${new Date().toLocaleDateString()}`,
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    },
  });

  y = (doc as any).lastAutoTable.finalY + 20;

  // Totals section (right-aligned)
  const totalsX = pageW - margin - 200;
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(totalsX, y, 200, 100, 4, 4, 'F');

  const totalsLeftX = totalsX + 12;
  const totalsRightX = totalsX + 188;
  let ty = y + 18;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...CHARCOAL);
  doc.text('Subtotal', totalsLeftX, ty);
  doc.text(fmt(data.total_amount_cents), totalsRightX, ty, { align: 'right' });
  ty += 16;

  if (data.paid_amount_cents > 0) {
    doc.text('Payments', totalsLeftX, ty);
    doc.setTextColor(...CRX_GREEN);
    doc.text(`-${fmt(data.paid_amount_cents)}`, totalsRightX, ty, { align: 'right' });
    doc.setTextColor(...CHARCOAL);
    ty += 16;
  }

  if (data.prepay_applied_cents > 0) {
    doc.text('Prepay Applied', totalsLeftX, ty);
    doc.setTextColor(...CRX_GREEN);
    doc.text(`-${fmt(data.prepay_applied_cents)}`, totalsRightX, ty, { align: 'right' });
    doc.setTextColor(...CHARCOAL);
    ty += 16;
  }

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(totalsLeftX, ty - 4, totalsRightX, ty - 4);
  ty += 4;

  // Balance due
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('BALANCE DUE', totalsLeftX, ty);
  const balanceColor = data.balance_cents > 0 ? [220, 38, 38] as [number, number, number] : CRX_GREEN;
  doc.setTextColor(...balanceColor);
  doc.text(fmt(data.balance_cents), totalsRightX, ty, { align: 'right' });

  y += 115;

  // Footer notes
  if (data.footer_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(data.footer_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
  }

  return doc;
}

export async function downloadInvoicePdf(data: InvoicePdfData) {
  const doc = await generateInvoicePdf(data);
  doc.save(`${data.invoice_number}.pdf`);
}
