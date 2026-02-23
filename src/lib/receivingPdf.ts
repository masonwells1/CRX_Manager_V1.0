/**
 * receivingPdf.ts — generates professional Crop RX receiving receipt PDFs
 * Sprint 19: Receiving System Enhancement
 */
// jsPDF and autoTable are dynamically imported inside each function
// to keep them out of the main bundle (~500KB each)
import type jsPDF from 'jspdf';
import type { autoTable as autoTableFn } from 'jspdf-autotable';
import type { CellHookData } from 'jspdf-autotable';

type JsPDFWithAutoTable = InstanceType<typeof jsPDF> & {
  lastAutoTable: { finalY: number };
};

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];
const RED: [number, number, number] = [220, 38, 38];
const AMBER: [number, number, number] = [217, 119, 6];

export interface PdfReceivingItem {
  product_name: string;
  quantity_received: number;
  condition: string;
  lot_number?: string;
  unit_size?: string;
  notes?: string;
}

export interface PdfReceivingData {
  po_number: string;
  vendor: string;
  received_at: string;
  received_by_name: string;
  storage_location: string;
  items: PdfReceivingItem[];
}

const fmt = (n: number) => n.toLocaleString();

const conditionLabel = (c: string) =>
  c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

const conditionColor = (c: string): [number, number, number] => {
  if (c === 'good') return CRX_GREEN;
  if (c === 'damaged' || c === 'wrong_product') return RED;
  return AMBER;
};

function renderReceivingPage(
  doc: JsPDFWithAutoTable,
  data: PdfReceivingData,
  autoTable: typeof autoTableFn
) {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 40;

  // Header
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 65, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 32);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('RECEIVING RECEIPT', margin, 50);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(data.po_number, pageW - margin, 35, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Vendor: ${data.vendor}`, pageW - margin, 50, { align: 'right' });

  y = 85;

  // Info grid
  const colW = (pageW - margin * 2) / 2;
  const infoLeft = [
    ['Vendor', data.vendor],
    ['Received By', data.received_by_name],
    ['Storage Location', data.storage_location],
  ];
  const infoRight = [
    ['PO Number', data.po_number],
    ['Date Received', new Date(data.received_at + (data.received_at.includes('T') ? '' : 'T00:00:00')).toLocaleDateString()],
    ['Time', new Date(data.received_at + (data.received_at.includes('T') ? '' : 'T00:00:00')).toLocaleTimeString()],
  ];

  doc.setFontSize(9);
  for (let i = 0; i < infoLeft.length; i++) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text(infoLeft[i][0].toUpperCase(), margin, y);
    doc.text(infoRight[i][0].toUpperCase(), margin + colW, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text(infoLeft[i][1], margin, y + 14);
    doc.text(infoRight[i][1], margin + colW, y + 14);
    y += 30;
  }

  y += 10;

  // Items table
  const head = [['Product', 'Qty Received', 'Condition', 'Lot #', 'Unit Size']];
  const rows = data.items.map((item) => [
    item.product_name,
    fmt(item.quantity_received),
    conditionLabel(item.condition),
    item.lot_number || '-',
    item.unit_size || '-',
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 6, textColor: CHARCOAL },
    headStyles: { fillColor: [240, 240, 240], textColor: CHARCOAL, fontStyle: 'bold' },
    didParseCell: (hookData: CellHookData) => {
      // Color the condition column
      if (hookData.section === 'body' && hookData.column.index === 2) {
        const condition = data.items[hookData.row.index]?.condition ?? 'good';
        hookData.cell.styles.textColor = conditionColor(condition);
        hookData.cell.styles.fontStyle = 'bold';
      }
    },
  });

  y = doc.lastAutoTable.finalY + 20;

  // Item notes section
  const itemsWithNotes = data.items.filter((item) => item.notes);
  if (itemsWithNotes.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...CHARCOAL);
    doc.text('ITEM NOTES', margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    for (const item of itemsWithNotes) {
      doc.setFont('helvetica', 'bold');
      doc.text(`${item.product_name}:`, margin, y);
      doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(item.notes!, pageW - margin * 2 - 10);
      doc.text(lines, margin + 10, y + 12);
      y += lines.length * 12 + 18;
    }
    y += 10;
  }

  // Condition summary
  const conditionCounts: Record<string, number> = {};
  for (const item of data.items) {
    conditionCounts[item.condition] = (conditionCounts[item.condition] || 0) + 1;
  }
  const totalQty = data.items.reduce((sum, item) => sum + item.quantity_received, 0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...CHARCOAL);
  doc.text('SUMMARY', margin, y);
  y += 16;

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text(`Total Items: ${data.items.length}`, margin, y);
  doc.text(`Total Quantity: ${fmt(totalQty)}`, margin + 150, y);
  y += 14;

  for (const [cond, count] of Object.entries(conditionCounts)) {
    doc.setTextColor(...conditionColor(cond));
    doc.text(`${conditionLabel(cond)}: ${count} item${count !== 1 ? 's' : ''}`, margin, y);
    y += 12;
  }

  // Signature line
  y += 30;
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y, margin + 250, y);
  doc.setFontSize(8);
  doc.setTextColor(160, 160, 160);
  doc.text('Received By Signature', margin, y + 14);

  doc.line(pageW - margin - 150, y, pageW - margin, y);
  doc.text('Date', pageW - margin - 150, y + 14);

  // Footer
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 10, pageW - margin, footerY - 10);
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text('Crop RX Solutions  •  Robinson, IL  •  Thank you for your business!', pageW / 2, footerY, { align: 'center' });
}

export async function generateReceivingPdf(data: PdfReceivingData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  renderReceivingPage(doc, data, autoTable);
  return doc;
}

export async function downloadReceivingPdf(data: PdfReceivingData) {
  const doc = await generateReceivingPdf(data);
  doc.save(`${data.po_number}_receiving_receipt.pdf`);
}

/**
 * Generate a combined multi-page PDF for multiple receiving receipts.
 * Each receipt gets its own page.
 */
export async function generateBatchReceivingPdf(dataList: PdfReceivingData[]) {
  if (dataList.length === 0) {
    throw new Error('No receiving receipts to generate');
  }

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  if (dataList.length === 1) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    renderReceivingPage(doc, dataList[0], autoTable);
    doc.save(`${dataList[0].po_number}_receiving_receipt.pdf`);
    return;
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  for (let i = 0; i < dataList.length; i++) {
    if (i > 0) doc.addPage();
    renderReceivingPage(doc, dataList[i], autoTable);
  }

  doc.save(`receiving_receipts_batch_${dataList.length}.pdf`);
}
