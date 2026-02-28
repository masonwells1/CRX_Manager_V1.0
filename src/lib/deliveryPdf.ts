/**
 * deliveryPdf.ts — generates professional Crop RX delivery receipt PDFs
 * GAP FIX #12: Delivery Receipt PDF
 * Sprint 18: Added batch generation + delivered vs planned quantities + issue display
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
const AMBER: [number, number, number] = [217, 119, 6];

interface PdfDeliveryItem {
  product_name: string;
  quantity: number;
  unit_size: string;
  quantity_delivered?: number;
  tote_number?: string | null;
}

export interface PdfDeliveryData {
  delivery_number: string;
  order_number: string;
  customer_name: string;
  customer_address?: string;
  driver_name: string;
  scheduled_date: string;
  completed_at?: string;
  status: string;
  signed_by?: string;
  delivery_notes?: string;
  priority?: string;
  issue_type?: string;
  issue_notes?: string;
  items: PdfDeliveryItem[];
}

const fmt = (n: number) => n.toLocaleString();

function renderDeliveryPage(
  doc: JsPDFWithAutoTable,
  data: PdfDeliveryData,
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
  doc.text('DELIVERY RECEIPT', margin, 50);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(data.delivery_number, pageW - margin, 35, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Order: ${data.order_number}`, pageW - margin, 50, { align: 'right' });

  y = 85;

  // Priority badge (if not normal)
  if (data.priority && data.priority !== 'normal') {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    const priorityLabel = data.priority.toUpperCase();
    const badgeColor: [number, number, number] =
      data.priority === 'urgent' ? [220, 38, 38] :
      data.priority === 'high' ? [217, 119, 6] : [107, 114, 128];
    doc.setTextColor(...badgeColor);
    doc.text(`PRIORITY: ${priorityLabel}`, pageW - margin, 65, { align: 'right' });
  }

  // Info grid
  const colW = (pageW - margin * 2) / 2;
  const infoLeft = [
    ['Customer', data.customer_name],
    ['Address', data.customer_address || '-'],
    ['Driver', data.driver_name],
  ];
  const infoRight = [
    ['Scheduled', new Date(data.scheduled_date + 'T00:00:00').toLocaleDateString()],
    ['Completed', data.completed_at ? new Date(data.completed_at).toLocaleDateString() : 'Pending'],
    ['Signed By', data.signed_by || '-'],
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

  // Items table — show delivered vs planned for completed deliveries
  const isCompleted = data.status === 'completed';
  const hasDelivered = isCompleted && data.items.some((it) => it.quantity_delivered != null);
  const hasTote = data.items.some((it) => it.tote_number);

  const head = (() => {
    const cols = ['Product'];
    if (hasDelivered) {
      cols.push('Planned', 'Delivered');
    } else {
      cols.push('Quantity');
    }
    cols.push('Unit Size');
    if (hasTote) cols.push('Tote #');
    return [cols];
  })();

  const rows = data.items.map((item) => {
    const cols = [item.product_name];
    if (hasDelivered) {
      cols.push(fmt(item.quantity), fmt(item.quantity_delivered ?? item.quantity));
    } else {
      cols.push(fmt(item.quantity));
    }
    cols.push(item.unit_size || '-');
    if (hasTote) cols.push(item.tote_number || '-');
    return cols;
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 6, textColor: CHARCOAL },
    headStyles: { fillColor: [240, 240, 240], textColor: CHARCOAL, fontStyle: 'bold' },
    didParseCell: (hookData: CellHookData) => {
      // Highlight partial deliveries in amber
      if (hasDelivered && hookData.section === 'body' && hookData.column.index === 2) {
        const planned = data.items[hookData.row.index]?.quantity ?? 0;
        const delivered = data.items[hookData.row.index]?.quantity_delivered ?? 0;
        if (delivered < planned) {
          hookData.cell.styles.textColor = AMBER;
          hookData.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });

  y = doc.lastAutoTable.finalY + 20;

  // Issue reporting section
  if (data.issue_type && data.issue_type !== 'none') {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(220, 38, 38);
    doc.text('ISSUE REPORTED', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text(data.issue_type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()), margin + 100, y);
    y += 14;
    if (data.issue_notes) {
      const lines = doc.splitTextToSize(data.issue_notes, pageW - margin * 2);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 10;
    }
    y += 10;
  }

  // Notes
  if (data.delivery_notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...CHARCOAL);
    doc.text('NOTES', margin, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(data.delivery_notes, pageW - margin * 2);
    doc.text(lines, margin, y + 14);
    y += lines.length * 12 + 24;
  }

  // Signature line
  y += 20;
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y, margin + 250, y);
  doc.setFontSize(8);
  doc.setTextColor(160, 160, 160);
  doc.text('Customer Signature', margin, y + 14);

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

export async function generateDeliveryPdf(data: PdfDeliveryData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  renderDeliveryPage(doc, data, autoTable);
  return doc;
}

export async function downloadDeliveryPdf(data: PdfDeliveryData) {
  const doc = await generateDeliveryPdf(data);
  doc.save(`${data.delivery_number}_receipt.pdf`);
}

/**
 * Generate a combined multi-page PDF for multiple delivery receipts.
 * Each delivery gets its own page.
 */
export async function generateBatchDeliveryPdf(dataList: PdfDeliveryData[]) {
  if (dataList.length === 0) {
    throw new Error('No deliveries to generate');
  }

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  // For a single delivery, just download directly
  if (dataList.length === 1) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
    renderDeliveryPage(doc, dataList[0], autoTable);
    doc.save(`${dataList[0].delivery_number}_receipt.pdf`);
    return;
  }

  // Multiple deliveries — one page each
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;

  for (let i = 0; i < dataList.length; i++) {
    if (i > 0) doc.addPage();
    renderDeliveryPage(doc, dataList[i], autoTable);
  }

  doc.save(`delivery_receipts_batch_${dataList.length}.pdf`);
}
