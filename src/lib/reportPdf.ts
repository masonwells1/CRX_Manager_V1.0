/**
 * reportPdf.ts — generates CRX-branded PDF reports (tabular data)
 * Uses jsPDF + jspdf-autotable (dynamically imported to keep out of main bundle)
 *
 * Sprint 9: Generic Report PDF Generator
 */

import { CRX_GREEN, CHARCOAL, GRAY, type JsPDFWithAutoTable } from './pdfTheme';
import { localToday } from './dateUtils';
import { COMPANY_TAGLINE_HEADER_NO_PHONE } from './companyInfo';
import { formatUSD as fmtCurrency } from './money';



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
  /**
   * Optional aggregated TOTALS row rendered as a bold final row in the table
   * (autotable `foot`). One cell per column, in the same order as `columns`;
   * a null/undefined/'' cell renders blank. Use this for a summed footer like
   * the job-list acre totals (criterion #3) so the printout's totals match the
   * on-screen bottom totals. Additive — existing callers that omit it are
   * unaffected.
   */
  totalsRow?: (string | number | null | undefined)[];
}

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
  doc.text(COMPANY_TAGLINE_HEADER_NO_PHONE, margin, 44);

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

  // Optional aggregated TOTALS row -> autotable `foot` (bold, shaded). One cell
  // per column; a null/undefined cell renders blank. This keeps a printed totals
  // row aligned under its column (e.g. acre totals under the acre columns).
  const foot =
    options.totalsRow && options.totalsRow.length > 0
      ? [
          options.columns.map((_, i) => {
            const v = options.totalsRow?.[i];
            return v === null || v === undefined ? '' : String(v);
          }),
        ]
      : undefined;

  // Column-fit safety for WIDE column sets (criterion #4): wrap long cells onto
  // multiple lines and let autotable auto-size columns to the printable width so
  // no column is truncated off the page. Shrink the body font a touch when many
  // columns are present so a wide set still fits landscape letter.
  const wideColumns = options.columns.length > 8;
  const bodyFontSize = wideColumns ? 7 : 8;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: heads,
    body,
    foot,
    // A grand-totals foot must appear ONCE on the last page, not repeated at the
    // bottom of every page (autotable defaults showFoot to 'everyPage'). Only set
    // it when a foot exists so non-totals reports are unaffected (Codex P2).
    ...(foot ? { showFoot: 'lastPage' as const } : {}),
    theme: 'plain',
    tableWidth: 'auto',
    styles: { fontSize: bodyFontSize, cellPadding: 4, textColor: CHARCOAL, overflow: 'linebreak' },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: wideColumns ? 6.5 : 7,
    },
    footStyles: {
      fillColor: [232, 245, 238],
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: bodyFontSize,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    columnStyles: colStyles as any,
    alternateRowStyles: { fillColor: [252, 252, 252] },
    didDrawPage: () => {
      try {
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
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('reportPdf: didDrawPage failed', e);
      }
    },
  });

  // Summary footer note
  if (options.footerNote) {
    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 14;
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text(options.footerNote, margin, y);
  }

  return doc;
}

export async function downloadReportPdf(options: ReportPdfOptions) {
  const doc = await generateReportPdf(options);
  const filename = options.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  doc.save(`${filename}_${localToday()}.pdf`);
}

export { fmtCurrency };
