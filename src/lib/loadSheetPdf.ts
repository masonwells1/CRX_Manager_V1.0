/**
 * Load Sheet / Pick List PDF generator.
 *
 * Produces a printable PDF with:
 *   1. Product Summary — all products aggregated across stops
 *   2. Per-Stop Breakdown — items for each delivery/customer
 *
 * Follows the same dynamic-import + color-scheme pattern as deliveryPdf.ts.
 */

export interface LoadSheetItem {
  product_name: string;
  quantity: number;
  unit_size: string;
  tote_number?: string | null;
  notes?: string | null;
}

export interface LoadSheetStop {
  delivery_number: string;
  customer_name: string;
  customer_address?: string;
  driver_name: string;
  scheduled_date: string;
  priority?: string;
  items: LoadSheetItem[];
}

// CRX brand colors (RGB)
const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];

export async function generateLoadSheetPdf(
  stops: LoadSheetStop[],
  filename?: string,
): Promise<void> {
  if (stops.length === 0) throw new Error('No stops provided for load sheet');

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header ──
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

  // ── Section 1: Product Summary ──
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

  y = (doc as unknown as Record<string, unknown> & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;

  // ── Section 2: Per-Stop Breakdown ──
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Per-Stop Breakdown', margin, y);
  y += 5;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];

    // Check if we need a new page (if < 120pt remaining)
    if (y > doc.internal.pageSize.getHeight() - 120) {
      doc.addPage();
      y = margin;
    }

    // Stop header
    y += 12;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Stop ${i + 1}: ${stop.customer_name}`, margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const meta = [
      stop.delivery_number,
      stop.customer_address,
      stop.priority && stop.priority !== 'normal' ? `Priority: ${stop.priority.toUpperCase()}` : null,
    ].filter(Boolean).join('  |  ');
    doc.text(meta, margin, y);
    y += 4;

    // Items table for this stop
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
      margin: { left: margin + 10, right: margin },
      head: [headRow],
      body: bodyRows,
      theme: 'striped',
      headStyles: {
        fillColor: [220, 220, 220],
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 9,
      },
      bodyStyles: { fontSize: 9, textColor: CHARCOAL },
      columnStyles: {
        1: { halign: 'right', cellWidth: 50 },
        2: { cellWidth: 70 },
        ...(hasTotes ? { 3: { cellWidth: 70 } } : {}),
      },
    });

    y = (doc as unknown as Record<string, unknown> & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  }

  // ── Footer ──
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageWidth - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  doc.text(
    `Generated ${new Date().toLocaleString()} — Crop Rx Solutions`,
    margin,
    footerY + 12,
  );

  const outFilename = filename || `load_sheet_${dateStr.replace(/\//g, '-')}.pdf`;
  doc.save(outFilename);
}
