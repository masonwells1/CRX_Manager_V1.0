/**
 * Load Sheet / Pick List PDF generator.
 *
 * Produces a printable PDF with:
 *   1. Product Summary (page 1) — all products aggregated across stops
 *   2. Per-Stop Pages — one page per delivery with full detail + signature line
 *
 * Follows the same dynamic-import + color-scheme pattern as deliveryPdf.ts.
 */
import type { JsPDFWithAutoTable } from './pdfTheme';
import { COMPANY_FOOTER_THANKS } from './companyInfo';

export interface LoadSheetItem {
  product_name: string;
  quantity: number;
  unit_size: string;
  tote_number?: string | null;
  notes?: string | null;
}

export interface LoadSheetStop {
  delivery_number: string;
  order_number?: string;
  customer_name: string;
  customer_address?: string;
  contact_name?: string | null;
  phone?: string | null;
  driver_name: string;
  scheduled_date: string;
  priority?: string;
  delivery_notes?: string | null;
  items: LoadSheetItem[];
}

// CRX brand colors (RGB)
const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];


/** Draw the footer on any page */
function drawFooter(doc: JsPDFWithAutoTable, margin: number) {
  const pageW = doc.internal.pageSize.getWidth();
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(
    COMPANY_FOOTER_THANKS,
    pageW / 2,
    footerY + 12,
    { align: 'center' },
  );
}

export async function generateLoadSheetPdf(
  stops: LoadSheetStop[],
  filename?: string,
): Promise<void> {
  if (stops.length === 0) throw new Error('No stops provided for load sheet');

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Page 1: Product Summary ──────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageWidth, 50, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text('LOAD SHEET', margin, 33);

  // Date + driver info on right
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const dateStr = stops[0].scheduled_date
    ? new Date(stops[0].scheduled_date + 'T00:00:00').toLocaleDateString()
    : 'N/A';
  const drivers = [...new Set(stops.map((s) => s.driver_name).filter(Boolean))];
  const driverStr = drivers.length > 0 ? drivers.join(', ') : 'Unassigned';
  doc.text(`Date: ${dateStr}  |  Driver: ${driverStr}`, pageWidth - margin, 25, { align: 'right' });
  doc.text(`${stops.length} stop(s)`, pageWidth - margin, 40, { align: 'right' });

  y = 70;

  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Product Summary — Total to Load', margin, y);
  y += 8;

  // Aggregate products across all stops
  const productMap = new Map<string, { quantity: number; unit_size: string }>();
  for (const stop of stops) {
    for (const item of stop.items) {
      const existing = productMap.get(item.product_name);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        productMap.set(item.product_name, { quantity: item.quantity, unit_size: item.unit_size });
      }
    }
  }

  const summaryBody = [...productMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, data]) => [name, String(data.quantity), data.unit_size]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Product', 'Total Qty', 'Unit']],
    body: summaryBody,
    theme: 'grid',
    headStyles: {
      fillColor: CRX_GREEN,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 10,
    },
    bodyStyles: { fontSize: 10, textColor: CHARCOAL },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 60 },
      2: { cellWidth: 80 },
    },
  });

  // Stop list summary below the product table
  y = doc.lastAutoTable.finalY + 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('Delivery Route', margin, y);
  y += 14;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const routeLine = `Stop ${i + 1}: ${stop.customer_name} — ${stop.delivery_number}${stop.customer_address ? ` — ${stop.customer_address}` : ''}`;
    doc.text(routeLine, margin + 10, y);
    y += 13;
  }

  drawFooter(doc, margin);

  // ── Per-Stop Pages ──────────────────────────────────────────────
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    doc.addPage();
    y = margin;

    // Green header bar
    doc.setFillColor(...CRX_GREEN);
    doc.rect(0, 0, pageWidth, 65, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(255, 255, 255);
    doc.text('CROP RX SOLUTIONS', margin, 32);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`LOAD SHEET — Stop ${i + 1} of ${stops.length}`, margin, 50);
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(stop.delivery_number, pageWidth - margin, 35, { align: 'right' });
    if (stop.order_number) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`Order: ${stop.order_number}`, pageWidth - margin, 50, { align: 'right' });
    }

    // Priority badge
    if (stop.priority && stop.priority !== 'normal') {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      const badgeColor: [number, number, number] =
        stop.priority === 'urgent' ? [220, 38, 38] :
        stop.priority === 'high' ? [217, 119, 6] : [107, 114, 128];
      doc.setTextColor(...badgeColor);
      doc.text(`PRIORITY: ${stop.priority.toUpperCase()}`, pageWidth - margin, 65, { align: 'right' });
    }

    y = 85;

    // Info grid — left and right columns
    const colW = (pageWidth - margin * 2) / 2;
    const infoLeft = [
      ['Customer', stop.customer_name],
      ['Address', stop.customer_address || '-'],
      ['Driver', stop.driver_name || 'Unassigned'],
    ];
    const stopDateStr = stop.scheduled_date
      ? new Date(stop.scheduled_date + 'T00:00:00').toLocaleDateString()
      : 'N/A';
    const infoRight = [
      ['Scheduled', stopDateStr],
      ['Contact', stop.contact_name || '-'],
      ['Phone', stop.phone || '-'],
    ];

    doc.setFontSize(9);
    for (let r = 0; r < infoLeft.length; r++) {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...CHARCOAL);
      doc.text(infoLeft[r][0].toUpperCase(), margin, y);
      doc.text(infoRight[r][0].toUpperCase(), margin + colW, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY);
      doc.text(infoLeft[r][1], margin, y + 14);
      doc.text(infoRight[r][1], margin + colW, y + 14);
      y += 30;
    }

    y += 10;

    // Delivery notes
    if (stop.delivery_notes) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...CHARCOAL);
      doc.text('DELIVERY NOTES', margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY);
      const noteLines = doc.splitTextToSize(stop.delivery_notes, pageWidth - margin * 2);
      doc.text(noteLines, margin, y + 14);
      y += noteLines.length * 12 + 20;
    }

    // Items table
    const hasTotes = stop.items.some((it) => it.tote_number);
    const hasNotes = stop.items.some((it) => it.notes);
    const headRow = [
      'Product', 'Qty', 'Unit',
      ...(hasTotes ? ['Tote #'] : []),
      ...(hasNotes ? ['Notes'] : []),
    ];
    const bodyRows = stop.items.map((it) => [
      it.product_name, String(it.quantity), it.unit_size,
      ...(hasTotes ? [it.tote_number || '-'] : []),
      ...(hasNotes ? [it.notes || '-'] : []),
    ]);

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [headRow],
      body: bodyRows,
      theme: 'grid',
      headStyles: {
        fillColor: CRX_GREEN,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 10,
      },
      bodyStyles: { fontSize: 10, textColor: CHARCOAL },
      alternateRowStyles: { fillColor: [245, 250, 247] },
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { halign: 'right', cellWidth: 50 },
        2: { cellWidth: 70 },
        ...(hasTotes ? { 3: { cellWidth: 70 } } : {}),
      },
    });

    y = doc.lastAutoTable.finalY + 30;

    // Check if signature block fits on this page (need ~70pt for lines + labels)
    const pageHeight = doc.internal.pageSize.getHeight();
    if (y + 70 > pageHeight - 40) {
      doc.addPage();
      drawFooter(doc, margin);
      y = margin;
    }

    // ── Signature line ──
    doc.setDrawColor(180, 180, 180);
    doc.line(margin, y, margin + 250, y);
    doc.setFontSize(8);
    doc.setTextColor(160, 160, 160);
    doc.text('Customer Signature', margin, y + 14);

    doc.line(pageWidth - margin - 150, y, pageWidth - margin, y);
    doc.text('Date', pageWidth - margin - 150, y + 14);

    y += 30;

    // Printed name line
    doc.line(margin, y, margin + 250, y);
    doc.text('Printed Name', margin, y + 14);

    // Footer
    drawFooter(doc, margin);
  }

  const outFilename = filename || `load_sheet_${dateStr.replace(/\//g, '-')}.pdf`;
  doc.save(outFilename);
}
