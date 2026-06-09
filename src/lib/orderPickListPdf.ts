/**
 * orderPickListPdf.ts — Warehouse pick list PDF for order fulfillment
 *
 * Shows customer info, delivery addresses, items with ordered/delivered/remaining,
 * and inventory warnings for products with shortages.
 *
 * Follows the same dynamic-import + color-scheme pattern as deliveryPdf.ts.
 */
import { CRX_GREEN, CHARCOAL, GRAY, RED, AMBER, type JsPDFWithAutoTable } from './pdfTheme';
import type { autoTable as autoTableFn } from 'jspdf-autotable';
import type { CellHookData } from 'jspdf-autotable';
import { COMPANY_FOOTER_INTERNAL } from './companyInfo';



export interface PickListItem {
  product_name: string;
  unit_size: string | null;
  total_units_needed: number;
  quantity_delivered: number;
  quantity_remaining: number;
  inventory_available: number | null;
  has_shortage: boolean;
}

export interface PickListData {
  order_number: string;
  order_name: string | null;
  order_date: string;
  farm_name: string;
  contact_name: string | null;
  phone: string | null;
  delivery_addresses: string[];
  items: PickListItem[];
  notes: string | null;
  program_notes: string | null;
}

const fmtQty = (n: number) => n.toLocaleString();

function renderPickListPage(
  doc: JsPDFWithAutoTable,
  data: PickListData,
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
  doc.text('PICK LIST', margin, 50);
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
  ];
  const infoRight = [
    ['Order Date', orderDateStr],
    ['Phone', data.phone || '-'],
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

  // Delivery addresses
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('DELIVERY ADDRESS', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  if (data.delivery_addresses.length > 0) {
    for (const addr of data.delivery_addresses) {
      y += 14;
      const addrLines = doc.splitTextToSize(addr, pageW - margin * 2);
      doc.text(addrLines, margin, y);
      y += (addrLines.length - 1) * 12;
    }
  } else {
    y += 14;
    doc.text('No delivery address on file', margin, y);
  }

  y += 20;

  // Items table with fulfillment progress
  const head = [['Product', 'Unit', 'Ordered', 'Delivered', 'Remaining', 'Available', 'Status']];
  const shortageItems: PickListItem[] = [];

  const rows = data.items.map((item) => {
    if (item.has_shortage) shortageItems.push(item);
    const statusLabel = item.inventory_available === null
      ? 'N/A'
      : item.has_shortage ? 'LOW' : 'OK';
    return [
      item.product_name,
      item.unit_size || '-',
      fmtQty(item.total_units_needed),
      fmtQty(item.quantity_delivered),
      fmtQty(item.quantity_remaining),
      item.inventory_available !== null ? fmtQty(item.inventory_available) : 'N/A',
      statusLabel,
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 5, textColor: CHARCOAL },
    headStyles: { fillColor: [240, 240, 240], textColor: CHARCOAL, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 55 },
      2: { halign: 'right', cellWidth: 55 },
      3: { halign: 'right', cellWidth: 60 },
      4: { halign: 'right', cellWidth: 65 },
      5: { halign: 'right', cellWidth: 60 },
      6: { halign: 'center', cellWidth: 45 },
    } as Record<number, object>,
    didParseCell: (hookData: CellHookData) => {
      try {
        // Status column highlighting
        if (hookData.section === 'body' && hookData.column.index === 6) {
          const item = data.items[hookData.row.index];
          if (item?.has_shortage) {
            hookData.cell.styles.textColor = RED;
            hookData.cell.styles.fontStyle = 'bold';
          } else if (item?.inventory_available !== null && !item?.has_shortage) {
            hookData.cell.styles.textColor = CRX_GREEN;
            hookData.cell.styles.fontStyle = 'bold';
          }
        }
        // Highlight remaining column amber if there are items still to pick
        if (hookData.section === 'body' && hookData.column.index === 4) {
          const item = data.items[hookData.row.index];
          if (item?.has_shortage) {
            hookData.cell.styles.textColor = AMBER;
            hookData.cell.styles.fontStyle = 'bold';
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('orderPickListPdf: didParseCell failed', e);
      }
    },
  });

  y = doc.lastAutoTable.finalY + 15;

  // Inventory warnings section
  if (shortageItems.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...RED);
    doc.text('INVENTORY WARNINGS', margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (const item of shortageItems) {
      const avail = item.inventory_available ?? 0;
      const short = item.quantity_remaining - avail;
      doc.setTextColor(...RED);
      const line = `${item.product_name} — Need ${fmtQty(item.quantity_remaining)}, Available ${fmtQty(avail)} (Short ${fmtQty(short)})`;
      doc.text(line, margin + 10, y);
      y += 13;
    }
    y += 10;
  }

  // Notes
  if (data.notes || data.program_notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...CHARCOAL);
    doc.text('NOTES', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    y += 14;
    if (data.notes) {
      const lines = doc.splitTextToSize(data.notes, pageW - margin * 2);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 6;
    }
    if (data.program_notes) {
      doc.setFont('helvetica', 'italic');
      const lines = doc.splitTextToSize(`Program: ${data.program_notes}`, pageW - margin * 2);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 6;
    }
  }

  // Footer
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 10, pageW - margin, footerY - 10);
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(
    COMPANY_FOOTER_INTERNAL,
    pageW / 2,
    footerY,
    { align: 'center' },
  );
}

export async function generatePickListPdf(data: PickListData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  renderPickListPage(doc, data, autoTable);
  return doc;
}

export async function downloadPickListPdf(data: PickListData) {
  const doc = await generatePickListPdf(data);
  doc.save(`${data.order_number}_pick_list.pdf`);
}

export async function downloadBatchPickListPdf(dataList: PickListData[]) {
  if (dataList.length === 0) {
    throw new Error('No orders to generate');
  }

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  if (dataList.length === 1) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
    renderPickListPage(doc, dataList[0], autoTable);
    doc.save(`${dataList[0].order_number}_pick_list.pdf`);
    return;
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  for (let i = 0; i < dataList.length; i++) {
    if (i > 0) doc.addPage();
    renderPickListPage(doc, dataList[i], autoTable);
  }
  doc.save(`pick_lists_batch_${dataList.length}.pdf`);
}
