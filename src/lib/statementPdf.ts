/**
 * statementPdf.ts — generates CRX-branded Customer Statement PDF
 * Shows transaction list with running balance, aging summary.
 *
 * Sprint 10: Customer Statement PDF Generator
 */

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];
const LIGHT_BG: [number, number, number] = [245, 250, 247];

export interface StatementTransaction {
  invoice_number: string;
  invoice_date: string;
  due_date?: string;
  total_amount_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  balance_cents: number;
  status: string;
  invoice_type: string;
}

export interface StatementData {
  customer_name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  as_of_date: string;
  outstanding_balance_cents: number;
  transactions: StatementTransaction[];
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export async function generateStatementPdf(data: StatementData) {
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

  // Statement label on right
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('STATEMENT', pageW - margin, 28, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`As of ${new Date(data.as_of_date + 'T00:00:00').toLocaleDateString()}`, pageW - margin, 48, { align: 'right' });

  y = 90;

  // Customer info box
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, 70, 4, 4, 'F');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('CUSTOMER', margin + 12, y + 16);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(data.customer_name, margin + 12, y + 33);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  let addrY = y + 46;
  if (data.address) {
    doc.text(data.address, margin + 12, addrY);
    addrY += 12;
  }
  if (data.city || data.state) {
    doc.text([data.city, data.state, data.zip].filter(Boolean).join(', '), margin + 12, addrY);
  }

  // Balance due on right
  const rightX = pageW - margin - 12;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('BALANCE DUE', rightX, y + 16, { align: 'right' });
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  const balColor = data.outstanding_balance_cents > 0 ? [220, 38, 38] as [number, number, number] : CRX_GREEN;
  doc.setTextColor(...balColor);
  doc.text(fmt(data.outstanding_balance_cents), rightX, y + 38, { align: 'right' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text(`${data.transactions.length} open invoice(s)`, rightX, y + 54, { align: 'right' });

  y += 85;

  // Aging summary
  const now = new Date(data.as_of_date + 'T00:00:00');
  let current = 0, over30 = 0, over60 = 0, over90 = 0;
  for (const tx of data.transactions) {
    if (tx.balance_cents <= 0) continue;
    const invDate = new Date(tx.invoice_date + 'T00:00:00');
    const days = Math.floor((now.getTime() - invDate.getTime()) / 86400000);
    if (days > 90) over90 += tx.balance_cents;
    else if (days > 60) over60 += tx.balance_cents;
    else if (days > 30) over30 += tx.balance_cents;
    else current += tx.balance_cents;
  }

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('AGING SUMMARY', margin, y);
  y += 14;

  const agingData = [
    ['Current', fmt(current)],
    ['31-60 Days', fmt(over30)],
    ['61-90 Days', fmt(over60)],
    ['Over 90 Days', fmt(over90)],
    ['Total', fmt(data.outstanding_balance_cents)],
  ];

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: pageW - margin - 280 },
    body: agingData,
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 3, textColor: CHARCOAL },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 100 },
      1: { halign: 'right' },
    },
    didParseCell: (hookData: any) => {
      if (hookData.row.index === agingData.length - 1) {
        hookData.cell.styles.fontStyle = 'bold';
        hookData.cell.styles.fillColor = [240, 240, 240];
      }
    },
  });

  y = (doc as any).lastAutoTable.finalY + 20;

  // Transaction table
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('TRANSACTION DETAIL', margin, y);
  y += 10;

  const txRows = data.transactions.map((tx) => [
    tx.invoice_number,
    new Date(tx.invoice_date + 'T00:00:00').toLocaleDateString(),
    tx.due_date ? new Date(tx.due_date + 'T00:00:00').toLocaleDateString() : '-',
    tx.invoice_type.replace(/_/g, ' '),
    fmt(tx.total_amount_cents),
    fmt(tx.paid_amount_cents + tx.prepay_applied_cents),
    fmt(tx.balance_cents),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Invoice #', 'Date', 'Due Date', 'Type', 'Amount', 'Paid', 'Balance']],
    body: txRows,
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 4, textColor: CHARCOAL },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: 7,
    },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right', fontStyle: 'bold' },
    },
    alternateRowStyles: { fillColor: [252, 252, 252] },
    didDrawPage: () => {
      const footerY = doc.internal.pageSize.getHeight() - 20;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `Crop RX Solutions  •  Statement generated ${new Date().toLocaleDateString()}`,
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    },
  });

  // Footer total line
  y = (doc as any).lastAutoTable.finalY + 14;
  doc.setFontSize(9);
  doc.setTextColor(...GRAY);
  doc.text('Please remit payment at your earliest convenience. Thank you for your business.', margin, y);

  return doc;
}

export async function downloadStatementPdf(data: StatementData) {
  const doc = await generateStatementPdf(data);
  const filename = `statement_${data.customer_name.replace(/[^a-zA-Z0-9]/g, '_')}_${data.as_of_date}.pdf`;
  doc.save(filename);
}
