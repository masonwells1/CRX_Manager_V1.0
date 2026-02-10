/**
 * deliveryPdf.ts — generates a professional Crop RX delivery receipt PDF
 * GAP FIX #12: Delivery Receipt PDF
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];

interface PdfDeliveryItem {
  product_name: string;
  quantity: number;
  unit_size: string;
}

interface PdfDeliveryData {
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
  items: PdfDeliveryItem[];
}

const fmt = (n: number) => n.toLocaleString();

export function generateDeliveryPdf(data: PdfDeliveryData): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
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

  // Info grid
  const colW = (pageW - margin * 2) / 2;
  const infoLeft = [
    ['Customer', data.customer_name],
    ['Address', data.customer_address || '-'],
    ['Driver', data.driver_name],
  ];
  const infoRight = [
    ['Scheduled', new Date(data.scheduled_date).toLocaleDateString()],
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

  // Items table
  const rows = data.items.map((item) => [
    item.product_name,
    fmt(item.quantity),
    item.unit_size || '-',
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Product', 'Quantity', 'Unit Size']],
    body: rows,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 6, textColor: CHARCOAL },
    headStyles: { fillColor: [240, 240, 240], textColor: CHARCOAL, fontStyle: 'bold' },
  });

  y = (doc as any).lastAutoTable.finalY + 20;

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

  return doc;
}

export function downloadDeliveryPdf(data: PdfDeliveryData) {
  const doc = generateDeliveryPdf(data);
  doc.save(`${data.delivery_number}_receipt.pdf`);
}
