/**
 * orderSummaryPdf.ts — Customer-facing order summary PDF
 *
 * Shows order details, customer info, items with pricing — excludes
 * internal financials (cost, margin, profit).
 *
 * Follows the same dynamic-import + color-scheme pattern as deliveryPdf.ts.
 */
import { CRX_GREEN, CHARCOAL, GRAY, type JsPDFWithAutoTable } from './pdfTheme';
import type { autoTable as autoTableFn } from 'jspdf-autotable';
import { COMPANY_FOOTER_THANKS } from './companyInfo';
import { formatUSD as fmtMoney } from './money';
import { stripBelowCostApprovalNote } from './belowCostApproval';



export interface OrderSummaryItem {
  product_name: string;
  quantity: number;
  unit_size: string | null;
  price_per_unit: number;
  extended_price: number;
}

export interface OrderSummaryData {
  order_number: string;
  order_name: string | null;
  order_date: string;
  status: string;
  customer_po_number: string | null;
  farm_name: string;
  contact_name: string | null;
  phone: string | null;
  billing_address: string | null;
  items: OrderSummaryItem[];
  total_price: number;
  notes: string | null;
}

const fmtQty = (n: number) => n.toLocaleString();

function renderOrderSummaryPage(
  doc: JsPDFWithAutoTable,
  data: OrderSummaryData,
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
  doc.text('ORDER SUMMARY', margin, 50);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(data.order_number, pageW - margin, 35, { align: 'right' });
  if (data.order_name) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(data.order_name, pageW - margin, 50, { align: 'right' });
  }

  y = 85;

  // Info grid
  const colW = (pageW - margin * 2) / 2;
  const orderDateStr = data.order_date
    ? new Date(data.order_date + 'T00:00:00').toLocaleDateString()
    : 'N/A';

  const infoLeft = [
    ['Customer', data.farm_name],
    ['Contact', data.contact_name || '-'],
    ['Phone', data.phone || '-'],
  ];
  const infoRight = [
    ['Order Date', orderDateStr],
    ['Status', data.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())],
    ['Customer PO#', data.customer_po_number || '-'],
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

  // Billing address (separate row, full width)
  if (data.billing_address) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('BILLING ADDRESS', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    const addrLines = doc.splitTextToSize(data.billing_address, pageW - margin * 2);
    doc.text(addrLines, margin, y + 14);
    y += addrLines.length * 12 + 20;
  } else {
    y += 10;
  }

  // Items table — NO cost, margin, or profit columns
  const head = [['Product', 'Qty', 'Unit', 'Unit Price', 'Extended']];
  const rows = data.items.map((item) => [
    item.product_name,
    fmtQty(item.quantity),
    item.unit_size || '-',
    fmtMoney(item.price_per_unit),
    fmtMoney(item.extended_price),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 6, textColor: CHARCOAL },
    headStyles: { fillColor: [240, 240, 240], textColor: CHARCOAL, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 50 },
      2: { cellWidth: 60 },
      3: { halign: 'right', cellWidth: 80 },
      4: { halign: 'right', cellWidth: 80 },
    } as Record<number, object>,
  });

  y = doc.lastAutoTable.finalY + 10;

  // Total row
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...CHARCOAL);
  doc.text('TOTAL', pageW - margin - 170, y);
  doc.text(fmtMoney(data.total_price), pageW - margin, y, { align: 'right' });
  y += 20;

  // Notes
  const visibleNotes = stripBelowCostApprovalNote(data.notes);
  if (visibleNotes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...CHARCOAL);
    doc.text('NOTES', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    const lines = doc.splitTextToSize(visibleNotes, pageW - margin * 2);
    doc.text(lines, margin, y + 14);
    y += lines.length * 12 + 24;
  }

  // Footer
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 10, pageW - margin, footerY - 10);
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(
    COMPANY_FOOTER_THANKS,
    pageW / 2,
    footerY,
    { align: 'center' },
  );
}

export async function generateOrderSummaryPdf(data: OrderSummaryData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  renderOrderSummaryPage(doc, data, autoTable);
  return doc;
}

export async function downloadOrderSummaryPdf(data: OrderSummaryData) {
  const doc = await generateOrderSummaryPdf(data);
  doc.save(`${data.order_number}_summary.pdf`);
}

export async function downloadBatchOrderSummaryPdf(dataList: OrderSummaryData[]) {
  if (dataList.length === 0) {
    throw new Error('No orders to generate');
  }

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  if (dataList.length === 1) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
    renderOrderSummaryPage(doc, dataList[0], autoTable);
    doc.save(`${dataList[0].order_number}_summary.pdf`);
    return;
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  for (let i = 0; i < dataList.length; i++) {
    if (i > 0) doc.addPage();
    renderOrderSummaryPage(doc, dataList[i], autoTable);
  }
  doc.save(`order_summaries_batch_${dataList.length}.pdf`);
}
