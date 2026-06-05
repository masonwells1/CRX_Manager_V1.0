/**
 * statementPdf.ts — generates CRX-branded Customer Statement PDFs
 *
 * Two modes:
 *   1. Summary — compact transaction list with aging (one line per invoice)
 *   2. Detailed — full product tables, shares, finance charges per invoice (Chem-Man style)
 *
 * Both modes include a tear-off remittance stub on the final page.
 *
 * Sprint 12: Invoice & Statement PDF Redesign
 */

import type {
  DetailedStatementData,
  DetailedStatementTransaction,
  StatementOptions,
  InvoiceShare,
} from '../types';
import { CRX_GREEN, CHARCOAL, GRAY, LIGHT_BG, RED, TABLE_HEADER_BG, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import type { autoTable as autoTableFn } from 'jspdf-autotable';
import { COMPANY_TAGLINE_HEADER as COMPANY_TAGLINE, COMPANY_REMIT_ADDRESS } from './companyInfo';
import { formatCents as fmt } from './money';



// ── Helpers ──────────────────────────────────────────────────────────────


const fmtNum = (n: number, decimals = 4) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

const COMPANY_NAME = 'CROP RX SOLUTIONS';
// COMPANY_TAGLINE + COMPANY_REMIT_ADDRESS now come from src/lib/companyInfo.ts (single source).

// ── Main Generator ──────────────────────────────────────────────────────

export async function generateStatementPdf(
  data: DetailedStatementData,
  options?: StatementOptions,
) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const mode = options?.mode ?? data.mode ?? 'summary';
  const showShares = options?.show_shares ?? true;
  const asOfDate = options?.as_of_date ?? data.as_of_date;

  let y = 0;
  let pageNum = 0;

  // ── Page footer callback ───────────────────────────────────────────
  const drawPageFooter = () => {
    try {
      pageNum++;
      const footerY = pageH - 20;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `Crop RX Solutions, Inc.  •  Statement generated ${new Date().toLocaleDateString()}  •  Page ${pageNum}`,
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('statementPdf: drawPageFooter failed', e);
    }
  };

  // ── Header Bar ─────────────────────────────────────────────────────
  const drawHeader = () => {
    doc.setFillColor(...CRX_GREEN);
    doc.rect(0, 0, pageW, 70, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(255, 255, 255);
    doc.text(COMPANY_NAME, margin, 35);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(COMPANY_TAGLINE, margin, 53);

    // Statement label (right)
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    const label = mode === 'detailed' ? 'DETAILED STATEMENT' : 'STATEMENT OF ACCOUNT';
    doc.text(label, pageW - margin, 28, { align: 'right' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`As of ${fmtDate(asOfDate)}`, pageW - margin, 48, { align: 'right' });
  };

  drawHeader();
  y = 90;

  // ── Customer Info + Balance Box ────────────────────────────────────
  const c = data.customer;
  const boxH = 90;
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, boxH, 4, 4, 'F');

  // Left: Customer address
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('CUSTOMER', margin + 12, y + 16);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(c.farm_name.toUpperCase(), margin + 12, y + 33);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);

  let addrY = y + 46;
  if (c.contact_name) {
    doc.text(`Attn: ${c.contact_name}`, margin + 12, addrY);
    addrY += 12;
  }
  if (c.billing_address) {
    doc.text(c.billing_address, margin + 12, addrY);
    addrY += 12;
  }
  const cityLine = [c.city, c.state, c.zip].filter(Boolean).join(', ');
  if (cityLine) {
    doc.text(cityLine, margin + 12, addrY);
  }

  // Right side: Account info + Balance
  const rightX = pageW - margin - 12;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  if (c.account_number) {
    doc.text(`ACCT #: ${c.account_number}`, rightX, y + 16, { align: 'right' });
  }
  if (c.payment_terms) {
    doc.text(`TERMS: ${c.payment_terms}`, rightX, y + 28, { align: 'right' });
  }

  // Balance amount
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('BALANCE DUE', rightX, y + 46, { align: 'right' });
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  const balColor = data.outstanding_balance_cents > 0 ? RED : CRX_GREEN;
  doc.setTextColor(...balColor);
  doc.text(fmt(data.outstanding_balance_cents), rightX, y + 66, { align: 'right' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text(`${data.transactions.length} open invoice(s)`, rightX, y + 80, { align: 'right' });

  y += boxH + 15;

  // ── Aging Summary Bar ──────────────────────────────────────────────
  const aging = data.aging;
  const agingW = (pageW - margin * 2) / 5;
  const agingH = 36;

  doc.setFillColor(...TABLE_HEADER_BG);
  doc.rect(margin, y, pageW - margin * 2, agingH, 'F');

  const agingBuckets = [
    { label: 'Current', cents: aging.current_cents },
    { label: '30 Days', cents: aging.days_30_cents },
    { label: '60 Days', cents: aging.days_60_cents },
    { label: '90 Days', cents: aging.days_90_cents },
    { label: 'Over 120', cents: aging.over_120_cents },
  ];

  agingBuckets.forEach((bucket, i) => {
    const cx = margin + agingW * i + agingW / 2;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text(bucket.label, cx, y + 13, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    const bucketColor = bucket.cents > 0 ? CHARCOAL : GRAY;
    doc.setTextColor(...bucketColor);
    doc.text(fmt(bucket.cents), cx, y + 27, { align: 'center' });

    // Vertical separator (except last)
    if (i < agingBuckets.length - 1) {
      doc.setDrawColor(210, 210, 210);
      doc.line(margin + agingW * (i + 1), y + 6, margin + agingW * (i + 1), y + agingH - 6);
    }
  });

  y += agingH + 15;

  // ── Transaction Section ────────────────────────────────────────────
  if (mode === 'summary') {
    y = drawSummaryTransactions(doc, data, y, margin, pageW, pageH, autoTable, drawPageFooter);
  } else {
    y = drawDetailedTransactions(doc, data, y, margin, pageW, pageH, showShares, autoTable, drawPageFooter);
  }

  // ── Remittance Stub (on last page) ─────────────────────────────────
  drawRemittanceStub(doc, data, margin, pageW, pageH, asOfDate, y);

  // Final page footer
  drawPageFooter();

  return doc;
}

// ── Summary Mode ─────────────────────────────────────────────────────────

function drawSummaryTransactions(
  doc: JsPDFWithAutoTable,
  data: DetailedStatementData,
  startY: number,
  margin: number,
  pageW: number,
  pageH: number,
  autoTable: typeof autoTableFn,
  drawPageFooter: () => void,
): number {
  let y = startY;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('TRANSACTION SUMMARY', margin, y);
  y += 12;

  const rows = data.transactions.map((tx) => {
    // Short description: "Corn - 91.90 ac - Pole Field"
    const desc = buildShortDescription(tx);
    return [
      tx.invoice_number,
      fmtDate(tx.invoice_date),
      desc,
      `${tx.days_aged}`,
      fmt(tx.balance_cents),
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Transaction #', 'Date', 'Description', 'Days', 'Amount']],
    body: rows,
    theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: 5, textColor: CHARCOAL },
    headStyles: {
      fillColor: TABLE_HEADER_BG,
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: 8,
    },
    columnStyles: {
      0: { cellWidth: 85, fontStyle: 'bold' },
      1: { cellWidth: 70 },
      2: { cellWidth: 'auto' },
      3: { halign: 'center', cellWidth: 40 },
      4: { halign: 'right', fontStyle: 'bold', cellWidth: 80 },
    },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    didDrawPage: drawPageFooter,
  });

  y = doc.lastAutoTable.finalY + 10;

  // Total line
  doc.setDrawColor(200, 200, 200);
  doc.line(pageW - margin - 200, y, pageW - margin, y);
  y += 14;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('Total Outstanding:', pageW - margin - 200, y);
  doc.text(fmt(data.outstanding_balance_cents), pageW - margin, y, { align: 'right' });

  return y + 20;
}

// ── Detailed Mode ────────────────────────────────────────────────────────

function drawDetailedTransactions(
  doc: JsPDFWithAutoTable,
  data: DetailedStatementData,
  startY: number,
  margin: number,
  pageW: number,
  pageH: number,
  showShares: boolean,
  autoTable: typeof autoTableFn,
  drawPageFooter: () => void,
): number {
  let y = startY;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('DETAILED TRANSACTIONS', margin, y);
  y += 14;

  for (let i = 0; i < data.transactions.length; i++) {
    const tx = data.transactions[i];

    // Check page space — need at least ~180pt for a transaction header + small table
    if (y + 180 > pageH - 100) {
      drawPageFooter();
      doc.addPage();
      y = margin;
    }

    // ── Transaction header row ────────────────────────────────────
    doc.setFillColor(...TABLE_HEADER_BG);
    doc.rect(margin, y, pageW - margin * 2, 20, 'F');

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text(tx.invoice_number, margin + 6, y + 14);
    doc.setFont('helvetica', 'normal');
    doc.text(fmtDate(tx.invoice_date), margin + 100, y + 14);

    // Description
    const desc = buildShortDescription(tx);
    doc.text(desc, margin + 180, y + 14);

    // Days aged + amount (right side)
    doc.setFont('helvetica', 'normal');
    doc.text(`${tx.days_aged} days`, pageW - margin - 100, y + 14, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    doc.text(fmt(tx.balance_cents), pageW - margin - 6, y + 14, { align: 'right' });

    y += 26;

    // ── Grower line ───────────────────────────────────────────────
    if (tx.grower_names && tx.grower_names.length > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY);
      const growerLine = tx.grower_names.map(n => `Grower: ${n}`).join('    ');
      doc.text(growerLine, margin + 10, y);
      y += 12;
    }

    // ── Product detail table (based on invoice type) ─────────────
    if (tx.items && tx.items.length > 0) {
      if (tx.invoice_type === 'field_application') {
        y = drawFieldApplicationItems(doc, tx, y, margin, pageW, autoTable, drawPageFooter);
      } else if (tx.invoice_type === 'chemical_sale') {
        y = drawChemicalSaleItems(doc, tx, y, margin, pageW, autoTable, drawPageFooter);
      } else {
        y = drawMiscItems(doc, tx, y, margin, pageW, autoTable, drawPageFooter);
      }
    }

    // ── Price per acre ────────────────────────────────────────────
    if (tx.price_per_acre && tx.price_per_acre > 0 && tx.invoice_type === 'field_application') {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY);
      doc.text(`Price per acre: $${fmtNum(tx.price_per_acre, 2)}`, margin + 10, y);
      y += 12;
    }

    // ── Shares table ──────────────────────────────────────────────
    if (showShares && tx.shares && tx.shares.length > 1) {
      if (y + 60 > pageH - 100) {
        drawPageFooter();
        doc.addPage();
        y = margin;
      }

      const hasPerAcrePricing = tx.shares.some((s: InvoiceShare) => s.price_per_acre_cents != null);
      autoTable(doc, {
        startY: y,
        margin: { left: margin + (hasPerAcrePricing ? 120 : 180), right: margin },
        head: [hasPerAcrePricing
          ? ['', '$/Acre', 'Shares', 'Acres', 'Total']
          : ['', 'Shares', 'Acres', 'Total']],
        body: tx.shares.map((s: InvoiceShare) => {
          const name = s.pricing_note
            ? `${s.customer_name}\n${s.pricing_note}`
            : s.customer_name;
          return hasPerAcrePricing
            ? [
                name,
                s.price_per_acre_cents != null ? fmt(s.price_per_acre_cents) : '',
                `${fmtNum(s.split_percentage, 2)}%`,
                s.acres != null ? fmtNum(s.acres, 2) : '',
                fmt(s.amount_cents),
              ]
            : [
                name,
                `${fmtNum(s.split_percentage, 2)}%`,
                s.acres != null ? fmtNum(s.acres, 2) : '',
                fmt(s.amount_cents),
              ];
        }),
        theme: 'plain',
        styles: { fontSize: 7.5, cellPadding: 2, textColor: CHARCOAL },
        headStyles: { fillColor: [248, 248, 248], textColor: GRAY, fontStyle: 'bold', fontSize: 7 },
        columnStyles: hasPerAcrePricing
          ? {
              0: { cellWidth: 'auto' },
              1: { halign: 'right', cellWidth: 40 },
              2: { halign: 'right', cellWidth: 40 },
              3: { halign: 'right', cellWidth: 40 },
              4: { halign: 'right', fontStyle: 'bold', cellWidth: 55 },
            }
          : {
              0: { cellWidth: 'auto' },
              1: { halign: 'right', cellWidth: 50 },
              2: { halign: 'right', cellWidth: 50 },
              3: { halign: 'right', fontStyle: 'bold', cellWidth: 60 },
            },
        didDrawPage: drawPageFooter,
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    // ── Finance charges ───────────────────────────────────────────
    if (tx.finance_charge_cents > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...CHARCOAL);
      doc.text('FIN', margin + 10, y);
      doc.text('Finance Charges', margin + 50, y);
      doc.text(fmt(tx.finance_charge_cents), pageW - margin - 10, y, { align: 'right' });
      y += 12;
    }

    // ── Net Due line ──────────────────────────────────────────────
    if (tx.net_due_cents > 0 && (tx.finance_charge_cents > 0 || (tx.shares && tx.shares.length > 1))) {
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...CHARCOAL);
      doc.text(`Net Due (${tx.invoice_number}):`, margin + 50, y);
      doc.text(fmt(tx.net_due_cents), pageW - margin - 10, y, { align: 'right' });
      y += 14;
    }

    // ── Separator between transactions ────────────────────────────
    if (i < data.transactions.length - 1) {
      y += 4;
      doc.setDrawColor(220, 220, 220);
      doc.setLineDashPattern([3, 2], 0);
      doc.line(margin, y, pageW - margin, y);
      doc.setLineDashPattern([], 0);
      y += 10;
    }
  }

  // ── Total Outstanding ──────────────────────────────────────────
  y += 10;
  doc.setDrawColor(200, 200, 200);
  doc.line(pageW - margin - 220, y, pageW - margin, y);
  y += 16;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('Total Outstanding:', pageW - margin - 220, y);
  const totalColor = data.outstanding_balance_cents > 0 ? RED : CRX_GREEN;
  doc.setTextColor(...totalColor);
  doc.text(fmt(data.outstanding_balance_cents), pageW - margin, y, { align: 'right' });

  return y + 20;
}

// ── Embedded Product Tables for Detailed Mode ────────────────────────────

function drawFieldApplicationItems(
  doc: JsPDFWithAutoTable,
  tx: DetailedStatementTransaction,
  startY: number,
  margin: number,
  pageW: number,
  autoTable: typeof autoTableFn,
  drawPageFooter: () => void,
): number {
  const indent = margin + 10;

  const head = [['Product', 'EPA Reg', 'Rate/Acre', 'Total Applied', 'GL/LB', 'Unit Price', 'Total']];

  const rows = tx.items.map((item) => {
    const rateStr = item.rate_per_acre != null
      ? `${fmtNum(item.rate_per_acre, 4)} ${item.rate_unit || ''}`
      : '';

    const totalApplied = item.total_applied != null
      ? `${fmtNum(item.total_applied, item.total_applied === Math.round(item.total_applied) ? 2 : 4)} ${item.total_applied_unit || ''}`
      : item.is_application_fee
        ? `${fmtNum(item.quantity, 2)} AC`
        : '';

    const glLb = item.total_applied_gl_lb != null
      ? `${fmtNum(item.total_applied_gl_lb, 4)} ${item.gl_lb_unit || ''}`
      : '';

    const unitPrice = item.is_application_fee
      ? `${fmtNum(item.unit_price_cents / 100, 2)} /AC`
      : `${fmtNum(item.unit_price_cents / 100, 2)} /${item.gl_lb_unit || item.unit_size || ''}`;

    return [
      item.product_name,
      item.epa_registration || '',
      rateStr,
      totalApplied,
      glLb,
      unitPrice,
      fmt(item.total_cost_cents),
    ];
  });

  autoTable(doc, {
    startY: startY,
    margin: { left: indent, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 7.5, cellPadding: 3, textColor: CHARCOAL },
    headStyles: {
      fillColor: [248, 248, 248],
      textColor: GRAY,
      fontStyle: 'bold',
      fontSize: 7,
    },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 50, fontSize: 7 },
      2: { halign: 'right', cellWidth: 60 },
      3: { halign: 'right', cellWidth: 62 },
      4: { halign: 'right', cellWidth: 58 },
      5: { halign: 'right', cellWidth: 55 },
      6: { halign: 'right', fontStyle: 'bold', cellWidth: 55 },
    },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    didDrawPage: drawPageFooter,
  });

  return doc.lastAutoTable.finalY + 4;
}

function drawChemicalSaleItems(
  doc: JsPDFWithAutoTable,
  tx: DetailedStatementTransaction,
  startY: number,
  margin: number,
  pageW: number,
  autoTable: typeof autoTableFn,
  drawPageFooter: () => void,
): number {
  const indent = margin + 10;

  const head = [['Chemical', 'EPA Reg', 'Quantity', 'Cost', 'Total']];

  const rows = tx.items.map((item) => {
    const qtyStr = `${fmtNum(item.quantity, 2)} ${item.unit_size || item.rate_unit || ''}`;
    const costStr = fmt(item.unit_price_cents);

    return [
      item.product_name,
      item.epa_registration || '',
      qtyStr,
      costStr,
      fmt(item.total_cost_cents),
    ];
  });

  autoTable(doc, {
    startY: startY,
    margin: { left: indent, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 7.5, cellPadding: 3, textColor: CHARCOAL },
    headStyles: {
      fillColor: [248, 248, 248],
      textColor: GRAY,
      fontStyle: 'bold',
      fontSize: 7,
    },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 55, fontSize: 7 },
      2: { halign: 'right', cellWidth: 70 },
      3: { halign: 'right', cellWidth: 70 },
      4: { halign: 'right', fontStyle: 'bold', cellWidth: 65 },
    },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    didDrawPage: drawPageFooter,
  });

  return doc.lastAutoTable.finalY + 4;
}

function drawMiscItems(
  doc: JsPDFWithAutoTable,
  tx: DetailedStatementTransaction,
  startY: number,
  margin: number,
  pageW: number,
  autoTable: typeof autoTableFn,
  drawPageFooter: () => void,
): number {
  const indent = margin + 10;

  autoTable(doc, {
    startY: startY,
    margin: { left: indent, right: margin },
    head: [['Description', 'Amount']],
    body: tx.items.map(item => [
      item.product_name,
      fmt(item.total_cost_cents),
    ]),
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 3, textColor: CHARCOAL },
    headStyles: { fillColor: [248, 248, 248], textColor: GRAY, fontStyle: 'bold', fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', fontStyle: 'bold', cellWidth: 80 },
    },
    didDrawPage: drawPageFooter,
  });

  return doc.lastAutoTable.finalY + 4;
}

// ── Remittance Stub ──────────────────────────────────────────────────────

function drawRemittanceStub(
  doc: JsPDFWithAutoTable,
  data: DetailedStatementData,
  margin: number,
  pageW: number,
  pageH: number,
  asOfDate: string,
  currentY: number,
) {
  try {
  const c = data.customer;
  const aging = data.aging;
  const stubH = 140;
  let stubY = pageH - stubH - 15;

  // Check if we need space — the stub needs ~140pt from the bottom. If the
  // transaction content (currentY) would reach the fixed stub zone, push the
  // stub onto a fresh page so the tear-off block never overprints the last
  // rows. stubY recomputes to the same bottom-of-page position on the new
  // (empty) page. (Audit M2 + P2-B/C, 2026-05-30.)
  if (currentY > stubY - 15) {
    doc.addPage();
    stubY = pageH - stubH - 15;
  }

  // Dotted tear-off line
  doc.setDrawColor(150, 150, 150);
  doc.setLineDashPattern([4, 3], 0);
  doc.line(margin, stubY, pageW - margin, stubY);
  doc.setLineDashPattern([], 0);

  // Scissors icon (text)
  doc.setFontSize(10);
  doc.setTextColor(150, 150, 150);
  doc.text('\u2702', margin - 2, stubY + 4);

  const sy = stubY + 16;

  // Left: Remit-to address
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('PLEASE MAIL WITH PAYMENT TO:', margin, sy);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...CHARCOAL);
  const remitLines = COMPANY_REMIT_ADDRESS.split('\n');
  remitLines.forEach((line, i) => {
    doc.text(line, margin, sy + 14 + i * 12);
  });

  // Center: Aging boxes
  const agingStartX = margin + 200;
  const boxW = 68;
  const boxH2 = 40;

  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('AGING SUMMARY', agingStartX, sy);

  const agingItems = [
    { label: '30 Days', cents: aging.days_30_cents },
    { label: '60 Days', cents: aging.days_60_cents },
    { label: '90 Days', cents: aging.days_90_cents },
    { label: 'Over 120', cents: aging.over_120_cents },
  ];

  agingItems.forEach((item, i) => {
    const bx = agingStartX + i * (boxW + 4);
    doc.setDrawColor(200, 200, 200);
    doc.rect(bx, sy + 8, boxW, boxH2);

    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text(item.label, bx + boxW / 2, sy + 20, { align: 'center' });

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(fmt(item.cents), bx + boxW / 2, sy + 35, { align: 'center' });
  });

  // Right: Account info + Amount Paid line
  const rxStart = pageW - margin - 140;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Acct Name:', rxStart, sy + 10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(c.farm_name, rxStart + 60, sy + 10);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Acct Nbr:', rxStart, sy + 22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(c.account_number || '', rxStart + 60, sy + 22);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Balance:', rxStart, sy + 34);
  doc.setFont('helvetica', 'bold');
  const balColor = data.outstanding_balance_cents > 0 ? RED : CRX_GREEN;
  doc.setTextColor(...balColor);
  doc.text(fmt(data.outstanding_balance_cents), rxStart + 60, sy + 34);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text('Stmt Date:', rxStart, sy + 46);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(fmtDate(asOfDate), rxStart + 60, sy + 46);

  // Amount Paid line
  const payY = sy + 70;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text('Amount Paid  $', rxStart, payY);
  doc.setDrawColor(...CHARCOAL);
  doc.line(rxStart + 80, payY, pageW - margin, payY);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('statementPdf: drawRemittanceStub failed', e);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildShortDescription(tx: DetailedStatementTransaction): string {
  if (tx.invoice_type === 'field_application') {
    const parts = [
      tx.crop_type,
      tx.total_acres ? `${fmtNum(tx.total_acres, 2)} ac` : null,
      tx.field_names?.join(', '),
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' - ') : tx.description || '';
  }
  if (tx.invoice_type === 'chemical_sale') {
    return tx.description || 'Chemical Sale';
  }
  return tx.description || 'Misc Charge';
}

// ── Download ─────────────────────────────────────────────────────────────

export async function downloadStatementPdf(
  data: DetailedStatementData,
  options?: StatementOptions,
) {
  const doc = await generateStatementPdf(data, options);
  const filename = `statement_${data.customer.farm_name.replace(/[^a-zA-Z0-9]/g, '_')}_${data.as_of_date}.pdf`;
  doc.save(filename);
}

// ── Batch Statements ─────────────────────────────────────────────────────

export async function generateBatchStatementsPdf(
  statements: DetailedStatementData[],
  options?: StatementOptions,
) {
  if (statements.length === 0) return null;

  // Generate first statement
  const doc = await generateStatementPdf(statements[0], options);

  // Append remaining statements on new pages
  // Note: jsPDF doesn't support easy merging, so we generate them individually
  // and rely on the caller to handle batch (print-all or zip)

  return doc;
}

export async function downloadBatchStatements(
  statements: DetailedStatementData[],
  options?: StatementOptions,
) {
  // Generate each statement as a separate PDF download
  for (const stmt of statements) {
    await downloadStatementPdf(stmt, options);
    // Small delay between downloads to prevent browser blocking
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
