/**
 * invoicePdf.ts — generates CRX-branded Invoice PDFs with type-aware layouts
 * Uses jsPDF + jspdf-autotable (dynamically imported to keep out of main bundle)
 *
 * Three layouts based on invoice_type:
 *   1. field_application — full product detail, EPA, rates, GL/LB, shares
 *   2. chemical_sale — simpler counter/pickup sale format
 *   3. misc_charge — minimal line items
 *
 * Sprint 12: Invoice & Statement PDF Redesign
 */

import type { InvoicePrintOptions } from '../types';

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];
const LIGHT_BG: [number, number, number] = [245, 250, 247];
const RED: [number, number, number] = [220, 38, 38];
const BLACK: [number, number, number] = [0, 0, 0];
const TABLE_HEADER_BG: [number, number, number] = [240, 240, 240];
const ALT_ROW_BG: [number, number, number] = [252, 252, 252];

// ── PDF Data Interfaces ─────────────────────────────────────────────────

export interface InvoicePdfItem {
  description: string;
  product_name?: string;
  quantity: number;
  unit_size?: string;
  unit_price_cents: number;
  extended_cents: number;
  cost_cents?: number;
  rate_per_acre?: number | null;
  rate_unit?: string | null;
  acres?: number | null;
  total_applied?: number | null;
  total_applied_unit?: string | null;
  total_applied_gl_lb?: number | null;
  gl_lb_unit?: string | null;
  epa_registration?: string | null;
  is_application_fee?: boolean;
  product_form?: string | null;
}

export interface InvoicePdfShare {
  customer_name: string;
  split_percentage: number;
  acres: number | null;
  amount_cents: number;
  price_per_acre_cents?: number | null;
  pricing_note?: string | null;
}

export interface InvoicePdfData {
  invoice_number: string;
  invoice_date: string;
  due_date?: string;
  invoice_type: string;
  status: string;
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_city?: string;
  customer_state?: string;
  customer_zip?: string;
  account_number?: string;
  salesman_name?: string;
  purchase_order_ref?: string;
  payment_terms?: string;
  header_notes?: string;
  footer_notes?: string;
  items: InvoicePdfItem[];
  total_amount_cents: number;
  total_cost_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  balance_cents: number;

  // Field application context
  crop_type?: string;
  field_names?: string[];
  total_acres?: number;
  applicator_name?: string;
  vehicle_name?: string;
  application_date?: string;

  // Shares/Splits
  shares?: InvoicePdfShare[];

  // Finance charges on this invoice
  finance_charge_cents?: number;

  // Source reference
  job_number?: string;
  order_number?: string;

  // Print options
  options?: InvoicePrintOptions;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const fmtNum = (n: number, decimals = 4) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

// ── Main Generator ──────────────────────────────────────────────────────

export async function generateInvoicePdf(data: InvoicePdfData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const opts = data.options ?? { show_shares: true, show_price_per_acre: true, show_epa_registration: true };

  let y = 0;

  // ── Page footer callback ───────────────────────────────────────────
  const drawPageFooter = () => {
    const footerY = pageH - 20;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 160);
    doc.text(
      `Crop RX Solutions, Inc.  •  Generated ${new Date().toLocaleDateString()}`,
      pageW / 2,
      footerY,
      { align: 'center' },
    );
  };

  // ── Header Bar ─────────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 35);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Agricultural Input Solutions  •  Martinsville, IL  •  618-843-0413', margin, 53);

  // Invoice badge (right)
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', pageW - margin, 28, { align: 'right' });
  doc.setFontSize(12);
  doc.text(data.invoice_number, pageW - margin, 48, { align: 'right' });

  y = 90;

  // ── Customer + Invoice Details Box ─────────────────────────────────
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, 90, 4, 4, 'F');

  // Left: Bill To
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  doc.text('BILL TO', margin + 12, y + 16);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(data.customer_name.toUpperCase(), margin + 12, y + 33);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  let addrY = y + 46;
  if (data.customer_address) {
    doc.text(data.customer_address, margin + 12, addrY);
    addrY += 12;
  }
  if (data.customer_city || data.customer_state) {
    const cityLine = [data.customer_city, data.customer_state, data.customer_zip].filter(Boolean).join(', ');
    doc.text(cityLine, margin + 12, addrY);
    addrY += 12;
  }
  if (data.customer_phone) {
    doc.text(data.customer_phone, margin + 12, addrY);
  }

  // Right: Invoice details grid
  const rightX = pageW - margin - 12;
  const labelX = rightX - 130;
  let ry = y + 16;

  const drawInfoField = (label: string, value: string, x: number, fy: number) => {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text(label, x, fy);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(value, x, fy + 12);
  };

  drawInfoField('DATE', fmtDate(data.invoice_date), labelX, ry);
  drawInfoField('DUE DATE', data.due_date ? fmtDate(data.due_date) : 'On receipt', rightX - 50, ry);
  ry += 30;
  if (data.account_number) {
    drawInfoField('ACCT #', data.account_number, labelX, ry);
  }
  if (data.salesman_name) {
    drawInfoField('SALESMAN', data.salesman_name, rightX - 50, ry);
  }
  ry += 30;
  if (data.payment_terms) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text('TERMS', labelX, ry);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(data.payment_terms, labelX, ry + 12);
  }

  y += 105;

  // ── Route to type-specific layout ──────────────────────────────────
  if (data.invoice_type === 'field_application') {
    y = drawFieldApplicationLayout(doc, data, y, margin, pageW, opts, autoTable, drawPageFooter);
  } else if (data.invoice_type === 'chemical_sale') {
    y = drawChemicalSaleLayout(doc, data, y, margin, pageW, opts, autoTable, drawPageFooter);
  } else {
    y = drawMiscChargeLayout(doc, data, y, margin, pageW, autoTable, drawPageFooter);
  }

  // ── Totals Section ─────────────────────────────────────────────────
  // Check if we need a new page
  if (y + 130 > pageH - 40) {
    doc.addPage();
    y = margin;
  }

  const totalsW = 220;
  const totalsX = pageW - margin - totalsW;
  const totalsH = 110 + (data.paid_amount_cents > 0 ? 16 : 0) + (data.prepay_applied_cents > 0 ? 16 : 0);
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(totalsX, y, totalsW, totalsH, 4, 4, 'F');

  const tLX = totalsX + 12;
  const tRX = totalsX + totalsW - 12;
  let ty = y + 20;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...CHARCOAL);
  doc.text('Subtotal', tLX, ty);
  doc.text(fmt(data.total_amount_cents), tRX, ty, { align: 'right' });
  ty += 16;

  if (data.paid_amount_cents > 0) {
    doc.text('Payments', tLX, ty);
    doc.setTextColor(...CRX_GREEN);
    doc.text(`-${fmt(data.paid_amount_cents)}`, tRX, ty, { align: 'right' });
    doc.setTextColor(...CHARCOAL);
    ty += 16;
  }

  if (data.prepay_applied_cents > 0) {
    doc.text('Prepay Applied', tLX, ty);
    doc.setTextColor(...CRX_GREEN);
    doc.text(`-${fmt(data.prepay_applied_cents)}`, tRX, ty, { align: 'right' });
    doc.setTextColor(...CHARCOAL);
    ty += 16;
  }

  if (data.finance_charge_cents && data.finance_charge_cents > 0) {
    doc.text('Finance Charges', tLX, ty);
    doc.text(fmt(data.finance_charge_cents), tRX, ty, { align: 'right' });
    ty += 16;
  }

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(tLX, ty - 4, tRX, ty - 4);
  ty += 8;

  // Balance due
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('BALANCE DUE', tLX, ty);
  const balanceColor = data.balance_cents > 0 ? RED : CRX_GREEN;
  doc.setTextColor(...balanceColor);
  doc.text(fmt(data.balance_cents), tRX, ty, { align: 'right' });

  y += totalsH + 15;

  // Footer notes
  if (data.footer_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(data.footer_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
  }

  // Final page footer
  drawPageFooter();

  return doc;
}

// ── Layout 1: Field Application ──────────────────────────────────────────

function drawFieldApplicationLayout(
  doc: any, data: InvoicePdfData, startY: number, margin: number, pageW: number,
  opts: InvoicePrintOptions, autoTable: any, drawPageFooter: () => void,
): number {
  let y = startY;

  // Description line: "Corn - 91.90 - Pole Field, Leaming 92"
  if (data.crop_type || data.total_acres || data.field_names?.length) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    const descParts = [
      data.crop_type,
      data.total_acres ? `${fmtNum(data.total_acres, 2)}` : null,
      data.field_names?.join(', '),
    ].filter(Boolean);
    doc.text(descParts.join(' - '), margin, y);
    y += 14;
  }

  // Grower line
  if (data.shares && data.shares.length > 1) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    const growerLine = data.shares.map(s => `Grower: ${s.customer_name}`).join('  ');
    doc.text(growerLine, margin, y);
    y += 14;
  }

  // Header notes
  if (data.header_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'italic');
    const lines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 4;
  }

  y += 4;

  // Product detail table
  const showEpa = opts.show_epa_registration;

  const head = showEpa
    ? [['Product', 'EPA Reg', 'Rate / Acre', 'Total Applied', 'Total Applied GL/LB', 'Unit Price', 'Total Cost']]
    : [['Product', 'Rate / Acre', 'Total Applied', 'Total Applied GL/LB', 'Unit Price', 'Total Cost']];

  const rows = data.items.map((item) => {
    const rateStr = item.rate_per_acre != null
      ? `${fmtNum(item.rate_per_acre, 4)} ${item.rate_unit || item.unit_size || ''}`
      : item.is_application_fee ? '' : '';

    const totalApplied = item.total_applied != null
      ? `${fmtNum(item.total_applied, item.total_applied === Math.round(item.total_applied) ? 2 : 4)} ${item.total_applied_unit || ''}`
      : item.is_application_fee
        ? `${fmtNum(item.quantity, 2)} AC`
        : '';

    const glLb = item.total_applied_gl_lb != null
      ? `${fmtNum(item.total_applied_gl_lb, 4)} ${item.gl_lb_unit || ''}`
      : item.is_application_fee
        ? ''
        : '';

    const unitPrice = item.is_application_fee
      ? `${fmtNum(item.unit_price_cents / 100, 2)} AC`
      : `${fmtNum(item.unit_price_cents / 100, 2)} ${item.gl_lb_unit || item.unit_size || ''}`;

    const row = showEpa
      ? [
        item.product_name || item.description,
        item.epa_registration || '',
        rateStr,
        totalApplied,
        glLb,
        unitPrice,
        fmt(item.extended_cents),
      ]
      : [
        item.product_name || item.description,
        rateStr,
        totalApplied,
        glLb,
        unitPrice,
        fmt(item.extended_cents),
      ];

    return row;
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 4, textColor: CHARCOAL },
    headStyles: {
      fillColor: TABLE_HEADER_BG,
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    columnStyles: showEpa ? {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 55 },
      2: { halign: 'right', cellWidth: 65 },
      3: { halign: 'right', cellWidth: 72 },
      4: { halign: 'right', cellWidth: 72 },
      5: { halign: 'right', cellWidth: 55 },
      6: { halign: 'right', fontStyle: 'bold', cellWidth: 60 },
    } : {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 70 },
      2: { halign: 'right', cellWidth: 80 },
      3: { halign: 'right', cellWidth: 80 },
      4: { halign: 'right', cellWidth: 60 },
      5: { halign: 'right', fontStyle: 'bold', cellWidth: 65 },
    },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    didDrawPage: drawPageFooter,
  });

  y = (doc as any).lastAutoTable.finalY + 6;

  // Price per acre
  if (opts.show_price_per_acre && data.total_acres && data.total_acres > 0) {
    const pricePerAcre = data.total_amount_cents / 100 / data.total_acres;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text(`Price per acre: ${fmtNum(pricePerAcre, 2)}`, margin + 8, y + 4);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text(`Total ${fmt(data.total_amount_cents)}`, pageW - margin, y + 4, { align: 'right' });
    y += 18;
  }

  // Shares table
  if (opts.show_shares && data.shares && data.shares.length > 1) {
    y += 6;
    const hasPerAcrePricing = data.shares.some(s => s.price_per_acre_cents != null);
    autoTable(doc, {
      startY: y,
      margin: { left: margin + (hasPerAcrePricing ? 140 : 200), right: margin },
      head: [hasPerAcrePricing
        ? ['', '$/Acre', 'Shares', 'Acres', 'Total']
        : ['', 'Shares', 'Acres', 'Total']],
      body: data.shares.map(s => {
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
      styles: { fontSize: 8.5, cellPadding: 3, textColor: CHARCOAL },
      headStyles: {
        fillColor: TABLE_HEADER_BG,
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 8,
      },
      columnStyles: hasPerAcrePricing
        ? {
            0: { cellWidth: 'auto' },
            1: { halign: 'right', cellWidth: 50 },
            2: { halign: 'right', cellWidth: 45 },
            3: { halign: 'right', cellWidth: 45 },
            4: { halign: 'right', fontStyle: 'bold', cellWidth: 60 },
          }
        : {
            0: { cellWidth: 'auto' },
            1: { halign: 'right', cellWidth: 55 },
            2: { halign: 'right', cellWidth: 55 },
            3: { halign: 'right', fontStyle: 'bold', cellWidth: 65 },
          },
      didDrawPage: drawPageFooter,
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // Finance charges
  if (data.finance_charge_cents && data.finance_charge_cents > 0) {
    y += 4;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageW - margin, y);
    y += 12;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text('FIN', margin, y);
    doc.text('Finance Charges', margin + 60, y);
    doc.text(fmt(data.finance_charge_cents), pageW - margin, y, { align: 'right' });
    y += 16;
    doc.setFont('helvetica', 'bold');
    doc.text(`Net Due (${data.invoice_number}):`, margin + 60, y);
    doc.text(fmt(data.balance_cents + (data.finance_charge_cents || 0)), pageW - margin, y, { align: 'right' });
    y += 16;
  }

  return y + 10;
}

// ── Layout 2: Chemical Sale ──────────────────────────────────────────────

function drawChemicalSaleLayout(
  doc: any, data: InvoicePdfData, startY: number, margin: number, pageW: number,
  opts: InvoicePrintOptions, autoTable: any, drawPageFooter: () => void,
): number {
  let y = startY;

  // Description line
  if (data.header_notes) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    const lines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 13 + 8;
  }

  // Chemical sale table: Date | Chemical | EPA Reg | Quantity | Cost | Total
  const showEpa = opts.show_epa_registration;

  const head = showEpa
    ? [['Date', 'Chemical', 'EPA Reg', 'Quantity', 'Cost', 'Total']]
    : [['Date', 'Chemical', 'Quantity', 'Cost', 'Total']];

  const rows = data.items.map((item) => {
    const qtyStr = `${fmtNum(item.quantity, 2)} ${item.unit_size || item.rate_unit || ''}`;
    const costStr = `${fmt(item.unit_price_cents)} ${item.gl_lb_unit || item.unit_size || ''}`;

    return showEpa
      ? [fmtDate(data.invoice_date), item.product_name || item.description, item.epa_registration || '', qtyStr, costStr, fmt(item.extended_cents)]
      : [fmtDate(data.invoice_date), item.product_name || item.description, qtyStr, costStr, fmt(item.extended_cents)];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body: rows,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 5, textColor: CHARCOAL },
    headStyles: {
      fillColor: TABLE_HEADER_BG,
      textColor: CHARCOAL,
      fontStyle: 'bold',
      fontSize: 8,
    },
    columnStyles: showEpa ? {
      0: { cellWidth: 72 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 65 },
      3: { halign: 'right', cellWidth: 70 },
      4: { halign: 'right', cellWidth: 80 },
      5: { halign: 'right', fontStyle: 'bold', cellWidth: 70 },
    } : {
      0: { cellWidth: 72 },
      1: { cellWidth: 'auto' },
      2: { halign: 'right', cellWidth: 80 },
      3: { halign: 'right', cellWidth: 90 },
      4: { halign: 'right', fontStyle: 'bold', cellWidth: 80 },
    },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    didDrawPage: drawPageFooter,
  });

  y = (doc as any).lastAutoTable.finalY + 6;

  // Total line
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...CHARCOAL);
  doc.text(`Total: ${fmt(data.total_amount_cents)}`, pageW - margin, y + 4, { align: 'right' });
  y += 18;

  // Shares table (chemical sales can also have splits)
  if (opts.show_shares && data.shares && data.shares.length > 1) {
    y += 4;
    const hasPerAcrePricing = data.shares.some(s => s.price_per_acre_cents != null);
    autoTable(doc, {
      startY: y,
      margin: { left: margin + (hasPerAcrePricing ? 140 : 200), right: margin },
      head: [hasPerAcrePricing
        ? ['Customer', '$/Acre', 'Shares', 'Total']
        : ['Customer', 'Shares', 'Total']],
      body: data.shares.map(s => {
        const name = s.pricing_note
          ? `${s.customer_name}\n${s.pricing_note}`
          : s.customer_name;
        return hasPerAcrePricing
          ? [
              name,
              s.price_per_acre_cents != null ? fmt(s.price_per_acre_cents) : '',
              `${fmtNum(s.split_percentage, 4)}%`,
              fmt(s.amount_cents),
            ]
          : [
              name,
              `${fmtNum(s.split_percentage, 4)}%`,
              fmt(s.amount_cents),
            ];
      }),
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: 3, textColor: CHARCOAL },
      headStyles: { fillColor: TABLE_HEADER_BG, textColor: CHARCOAL, fontStyle: 'bold', fontSize: 8 },
      columnStyles: hasPerAcrePricing
        ? {
            0: { cellWidth: 'auto' },
            1: { halign: 'right', cellWidth: 50 },
            2: { halign: 'right', cellWidth: 55 },
            3: { halign: 'right', fontStyle: 'bold', cellWidth: 65 },
          }
        : {
            0: { cellWidth: 'auto' },
            1: { halign: 'right', cellWidth: 65 },
            2: { halign: 'right', fontStyle: 'bold', cellWidth: 70 },
          },
      didDrawPage: drawPageFooter,
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // Finance charges
  if (data.finance_charge_cents && data.finance_charge_cents > 0) {
    y += 4;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageW - margin, y);
    y += 12;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text('FIN', margin, y);
    doc.text('Finance Charges', margin + 60, y);
    doc.text(fmt(data.finance_charge_cents), pageW - margin, y, { align: 'right' });
    y += 16;
    doc.setFont('helvetica', 'bold');
    doc.text(`Net Due (${data.invoice_number}):`, margin + 60, y);
    doc.text(fmt(data.balance_cents + (data.finance_charge_cents || 0)), pageW - margin, y, { align: 'right' });
    y += 16;
  }

  return y + 10;
}

// ── Layout 3: Misc Charge ────────────────────────────────────────────────

function drawMiscChargeLayout(
  doc: any, data: InvoicePdfData, startY: number, margin: number, pageW: number,
  autoTable: any, drawPageFooter: () => void,
): number {
  let y = startY;

  // Header notes
  if (data.header_notes) {
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'italic');
    const lines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 12 + 8;
  }

  // Simple table: Description | Amount
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Description', 'Amount']],
    body: data.items.map(item => [
      item.product_name || item.description,
      fmt(item.extended_cents),
    ]),
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 5, textColor: CHARCOAL },
    headStyles: { fillColor: TABLE_HEADER_BG, textColor: CHARCOAL, fontStyle: 'bold', fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', fontStyle: 'bold', cellWidth: 100 },
    },
    alternateRowStyles: { fillColor: ALT_ROW_BG },
    didDrawPage: drawPageFooter,
  });

  return (doc as any).lastAutoTable.finalY + 20;
}

// ── Download ─────────────────────────────────────────────────────────────

export async function downloadInvoicePdf(data: InvoicePdfData) {
  const doc = await generateInvoicePdf(data);
  doc.save(`${data.invoice_number}.pdf`);
}

// ── Batch PDF Generator ──────────────────────────────────────────────────
// Generates each invoice as a separate PDF and downloads them sequentially.
// jsPDF doesn't support page-level merging between documents, so each
// invoice becomes its own file (same approach as batch statements).

export async function generateBatchInvoicePdf(dataList: InvoicePdfData[]) {
  if (dataList.length === 0) {
    throw new Error('No invoices to generate');
  }

  // For a single invoice, just return its doc directly
  if (dataList.length === 1) {
    return generateInvoicePdf(dataList[0]);
  }

  // Generate each invoice as a separate Blob, then combine into a single
  // download link using a zip-like concatenation of individual PDF saves.
  // Since each invoice can span multiple pages (autoTable paginates), we
  // can't simply addPage() across invoices. Instead, download sequentially
  // but only trigger ONE browser download using the first doc, and append
  // remaining as individual saves with requestAnimationFrame to avoid
  // popup blockers.
  const docs = await Promise.all(dataList.map((d) => generateInvoicePdf(d)));

  // Save first immediately (always allowed by browser)
  docs[0].save(`${dataList[0].invoice_number}.pdf`);

  // Queue remaining downloads spaced out via rAF to avoid popup blockers.
  // Most browsers allow sequential downloads from user-initiated actions.
  for (let i = 1; i < docs.length; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        docs[i].save(`${dataList[i].invoice_number}.pdf`);
        resolve();
      });
    });
  }

  return docs[docs.length - 1];
}

