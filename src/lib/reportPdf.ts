/**
 * reportPdf.ts — generates CRX-branded PDF reports (tabular data)
 * Uses jsPDF + jspdf-autotable (dynamically imported to keep out of main bundle)
 *
 * Sprint 9: Generic Report PDF Generator
 */

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];

export interface ReportPdfColumn {
  header: string;
  key: string;
  align?: 'left' | 'center' | 'right';
  format?: (value: unknown) => string;
  width?: number;
}

export interface ReportPdfOptions {
  title: string;
  subtitle?: string;
  dateRange?: { start: string; end: string };
  columns: ReportPdfColumn[];
  data: Record<string, unknown>[];
  orientation?: 'portrait' | 'landscape';
  footerNote?: string;
}

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export async function generateReportPdf(options: ReportPdfOptions) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({
    orientation: options.orientation || 'landscape',
    unit: 'pt',
    format: 'letter',
  });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 36;
  let y = 36;

  // Header bar
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 60, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 28);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('Agricultural Input Solutions  •  Robinson, IL', margin, 44);

  // Report title on right
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(options.title, pageW - margin, 28, { align: 'right' });
  if (options.dateRange?.start) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(
      `${options.dateRange.start} — ${options.dateRange.end}`,
      pageW - margin,
      44,
      { align: 'right' }
    );
  }

  y = 74;

  // Subtitle
  if (options.subtitle) {
    doc.setFontSize(10);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'italic');
    doc.text(options.subtitle, margin, y);
    y += 16;
  }

  // Table
  const heads = [options.columns.map((c) => c.header)];
  const body = options.data.map((row) =>
    options.columns.map((col) => {
      const val = row[col.key];
      if (col.format) return col.format(val);
      if (val === null || val === undefined) return '';
      return String(val);
    })
  );

  const colStyles: Record<number, { halign?: string }> = {};
  options.columns.forEach((col, i) => {
    if (col.align) {
      colStyles[i] = { halign: col.align };
    }
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: heads,
    body,
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 4, textColor: CHARCOAL },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: 7,
    },
    columnStyles: colStyles as any,
    alternateRowStyles: { fillColor: [252, 252, 252] },
    didDrawPage: () => {
      // Footer on every page
      const footerY = doc.internal.pageSize.getHeight() - 20;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `Crop RX Solutions  •  Generated ${new Date().toLocaleDateString()}`,
        pageW / 2,
        footerY,
        { align: 'center' }
      );
    },
  });

  // Summary footer note
  if (options.footerNote) {
    y = (doc as any).lastAutoTable.finalY + 14;
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text(options.footerNote, margin, y);
  }

  return doc;
}

export async function downloadReportPdf(options: ReportPdfOptions) {
  const doc = await generateReportPdf(options);
  const filename = options.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  doc.save(`${filename}_${new Date().toISOString().split('T')[0]}.pdf`);
}

export { fmtCurrency };
