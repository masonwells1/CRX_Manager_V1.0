/**
 * yearEndSummaryPdf.ts — generates CRX-branded Year-End Customer Summary PDFs
 *
 * Sections:
 *   1. Green header bar with company info + "SEASON SUMMARY" badge
 *   2. Customer info box (light green)
 *   3. Financial summary (4 metric boxes)
 *   4. Year-over-Year comparison (if prior season data exists)
 *   5. Product usage by category (autoTable per category)
 *   6. Acreage summary
 *   7. Invoice history (autoTable)
 *   8. Grower shares (autoTable, if applicable)
 *   9. Footer
 *
 * Sprint 17: Year-End Customer Summary
 */

import type { YearEndSummaryData, YearEndProductUsage } from '../types';
import type jsPDF from 'jspdf';
import type { CellHookData } from 'jspdf-autotable';
import { COMPANY_TAGLINE_HEADER as COMPANY_TAGLINE } from './companyInfo';

type JsPDFWithAutoTable = InstanceType<typeof jsPDF> & {
  lastAutoTable: { finalY: number };
};

// ── Color palette (matches invoice/statement PDFs) ───────────────────────

const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];
const LIGHT_BG: [number, number, number] = [245, 250, 247];
const RED: [number, number, number] = [220, 38, 38];
const TABLE_HEADER_BG: [number, number, number] = [240, 240, 240];
const ALT_ROW_BG: [number, number, number] = [252, 252, 252];
const BLUE: [number, number, number] = [37, 99, 235];

const COMPANY_NAME = 'CROP RX SOLUTIONS';
// COMPANY_TAGLINE now comes from src/lib/companyInfo.ts (single source).

// ── Options ──────────────────────────────────────────────────────────────

export interface YearEndSummaryOptions {
  show_product_detail?: boolean;
  show_shares?: boolean;
  show_yoy_comparison?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

const fmtMonth = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const fmtAcres = (n: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);

const fmtPct = (n: number) =>
  (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

const fmtQty = (n: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);

// ── Main Generator ──────────────────────────────────────────────────────

export async function generateYearEndSummaryPdf(
  data: YearEndSummaryData,
  options?: YearEndSummaryOptions,
) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const showProductDetail = options?.show_product_detail ?? true;
  const showShares = options?.show_shares ?? true;
  const showYoY = options?.show_yoy_comparison ?? true;

  let y = 0;
  let pageNum = 0;

  // ── Page footer callback ───────────────────────────────────────────
  const drawPageFooter = () => {
    pageNum++;
    const footerY = pageH - 20;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 160);
    doc.text(
      `Crop RX Solutions, Inc.  •  Season Summary generated ${new Date().toLocaleDateString()}  •  Page ${pageNum}`,
      pageW / 2,
      footerY,
      { align: 'center' },
    );
  };

  // ── Check page space & add new page if needed ──────────────────────
  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - 50) {
      drawPageFooter();
      doc.addPage();
      y = margin;
    }
  };

  // ── 1. Header Bar ──────────────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text(COMPANY_NAME, margin, 35);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(COMPANY_TAGLINE, margin, 53);

  // Season badge (right)
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`SEASON SUMMARY ${data.season}`, pageW - margin, 28, { align: 'right' });
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `${fmtMonth(data.season_start)} – ${fmtMonth(data.season_end)}`,
    pageW - margin, 48,
    { align: 'right' },
  );

  y = 90;

  // ── 2. Customer Info Box ───────────────────────────────────────────
  const c = data.customer;
  const boxH = 90;
  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, pageW - margin * 2, boxH, 4, 4, 'F');

  // Left: Customer name + address
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

  // Right side: Account info
  const rightX = pageW - margin - 12;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...GRAY);
  if (c.account_number) {
    doc.text(`ACCT #: ${c.account_number}`, rightX, y + 16, { align: 'right' });
  }
  if (c.assigned_tier) {
    doc.text(`TIER: ${c.assigned_tier}`, rightX, y + 28, { align: 'right' });
  }
  if (c.payment_terms) {
    doc.text(`TERMS: ${c.payment_terms}`, rightX, y + 40, { align: 'right' });
  }
  if (c.phone) {
    doc.setFont('helvetica', 'normal');
    doc.text(c.phone, rightX, y + 54, { align: 'right' });
  }
  if (c.email) {
    doc.setFont('helvetica', 'normal');
    doc.text(c.email, rightX, y + 66, { align: 'right' });
  }

  y += boxH + 15;

  // ── 3. Financial Summary (4 boxes) ─────────────────────────────────
  const fin = data.financial;
  const boxCount = 4;
  const boxGap = 8;
  const boxW = (pageW - margin * 2 - boxGap * (boxCount - 1)) / boxCount;
  const finBoxH = 56;

  const financialBoxes = [
    { label: 'Total Invoiced', value: fmt(fin.total_invoiced_cents), color: CHARCOAL },
    { label: 'Total Paid', value: fmt(fin.total_paid_cents), color: CRX_GREEN },
    { label: 'Prepay Applied', value: fmt(fin.prepay_applied_cents), color: BLUE },
    {
      label: 'Balance Due',
      value: fmt(fin.outstanding_balance_cents),
      color: fin.outstanding_balance_cents > 0 ? RED : CRX_GREEN,
    },
  ];

  financialBoxes.forEach((box, i) => {
    const bx = margin + i * (boxW + boxGap);
    doc.setFillColor(...TABLE_HEADER_BG);
    doc.roundedRect(bx, y, boxW, finBoxH, 3, 3, 'F');
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text(box.label.toUpperCase(), bx + boxW / 2, y + 18, { align: 'center' });
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...box.color);
    doc.text(box.value, bx + boxW / 2, y + 40, { align: 'center' });
  });

  // Invoice count label below
  y += finBoxH + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  doc.text(`${fin.invoice_count} invoice(s) this season`, margin, y + 8);
  y += 20;

  // ── 4. Year-over-Year Comparison ───────────────────────────────────
  if (showYoY && data.prior_season) {
    ensureSpace(100);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('YEAR-OVER-YEAR COMPARISON', margin, y);
    y += 12;

    const prior = data.prior_season;

    const calcPct = (curr: number, prev: number) =>
      prev > 0 ? ((curr - prev) / prev) * 100 : null;

    const yoyRows = [
      [
        'Total Invoiced',
        fmt(fin.total_invoiced_cents),
        fmt(prior.total_invoiced_cents),
        calcPct(fin.total_invoiced_cents, prior.total_invoiced_cents),
      ],
      [
        'Total Paid',
        fmt(fin.total_paid_cents),
        fmt(prior.total_paid_cents),
        calcPct(fin.total_paid_cents, prior.total_paid_cents),
      ],
      [
        'Invoice Count',
        `${fin.invoice_count}`,
        `${prior.invoice_count}`,
        calcPct(fin.invoice_count, prior.invoice_count),
      ],
      [
        'Total Acres',
        fmtAcres(data.acreage.total_acres),
        fmtAcres(prior.total_acres),
        calcPct(data.acreage.total_acres, prior.total_acres),
      ],
    ];

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['', `Season ${data.season}`, `Season ${data.season - 1}`, 'Change']],
      body: yoyRows.map((row) => [
        row[0],
        row[1],
        row[2],
        row[3] !== null ? fmtPct(row[3] as number) : '—',
      ]),
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: 5, textColor: CHARCOAL },
      headStyles: {
        fillColor: TABLE_HEADER_BG,
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 8,
      },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 120 },
        1: { halign: 'right', cellWidth: 120 },
        2: { halign: 'right', cellWidth: 120 },
        3: { halign: 'right', cellWidth: 'auto' },
      },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      didDrawCell: (hookData: CellHookData) => {
        // Color the Change column green/red
        if (hookData.section === 'body' && hookData.column.index === 3) {
          const pctVal = yoyRows[hookData.row.index]?.[3];
          if (pctVal !== null && pctVal !== undefined) {
            const color = (pctVal as number) >= 0 ? CRX_GREEN : RED;
            doc.setTextColor(...color);
          }
        }
      },
      didDrawPage: drawPageFooter,
    });

    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 15;
  }

  // ── 5. Product Usage by Category ───────────────────────────────────
  if (showProductDetail && data.product_usage.length > 0) {
    ensureSpace(60);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('PRODUCT USAGE BY CATEGORY', margin, y);
    y += 14;

    // Group products by category
    const categories = new Map<string, YearEndProductUsage[]>();
    for (const p of data.product_usage) {
      const cat = p.category || 'Uncategorized';
      if (!categories.has(cat)) categories.set(cat, []);
      categories.get(cat)!.push(p);
    }

    for (const [category, products] of categories) {
      ensureSpace(80);

      // Separate application fees from products
      const productItems = products.filter((p) => !p.is_application_fee);
      const feeItems = products.filter((p) => p.is_application_fee);

      const categoryTotal = products.reduce((s, p) => s + p.total_cost_cents, 0);

      // Category header
      doc.setFillColor(...LIGHT_BG);
      doc.rect(margin, y, pageW - margin * 2, 18, 'F');
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...CHARCOAL);
      doc.text(category.toUpperCase(), margin + 8, y + 12);
      doc.text(`Total: ${fmt(categoryTotal)}`, pageW - margin - 8, y + 12, { align: 'right' });
      y += 22;

      if (productItems.length > 0) {
        const rows = productItems.map((p) => [
          p.product_name,
          p.epa_registration || '',
          p.avg_rate_per_acre ? `${fmtQty(p.avg_rate_per_acre)} ${p.rate_unit || ''}` : '',
          p.total_applied > 0 ? `${fmtQty(p.total_applied)} ${p.total_applied_unit || ''}` : '',
          p.total_acres_treated > 0 ? `${fmtAcres(p.total_acres_treated)} ac` : '',
          fmt(p.total_cost_cents),
        ]);

        autoTable(doc, {
          startY: y,
          margin: { left: margin, right: margin },
          head: [['Product', 'EPA Reg.', 'Rate/Ac', 'Applied', 'Acres', 'Cost']],
          body: rows,
          theme: 'plain',
          styles: { fontSize: 8, cellPadding: 4, textColor: CHARCOAL },
          headStyles: {
            fillColor: TABLE_HEADER_BG,
            textColor: GRAY,
            fontStyle: 'bold',
            fontSize: 7.5,
          },
          columnStyles: {
            0: { cellWidth: 'auto' },
            1: { cellWidth: 65, fontSize: 7 },
            2: { cellWidth: 75, halign: 'right' },
            3: { cellWidth: 72, halign: 'right' },
            4: { cellWidth: 60, halign: 'right' },
            5: { cellWidth: 70, halign: 'right', fontStyle: 'bold' },
          },
          alternateRowStyles: { fillColor: ALT_ROW_BG },
          didDrawPage: drawPageFooter,
        });

        y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 6;
      }

      // Application fees inline
      if (feeItems.length > 0) {
        for (const fee of feeItems) {
          ensureSpace(20);
          doc.setFontSize(8);
          doc.setFont('helvetica', 'italic');
          doc.setTextColor(...GRAY);
          doc.text(
            `Application Fee: ${fee.total_acres_treated > 0 ? fmtAcres(fee.total_acres_treated) + ' ac' : ''} — ${fmt(fee.total_cost_cents)}`,
            margin + 8,
            y + 4,
          );
          y += 14;
        }
      }

      y += 6;
    }
  }

  // ── 6. Acreage Summary ─────────────────────────────────────────────
  if (data.acreage.total_acres > 0) {
    ensureSpace(60);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('ACREAGE SUMMARY', margin, y);
    y += 14;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text(`Total: ${fmtAcres(data.acreage.total_acres)} acres`, margin, y);
    y += 14;

    if (data.acreage.by_crop.length > 0) {
      const cropParts = data.acreage.by_crop.map(
        (crop) => `${crop.crop_type}: ${fmtAcres(crop.acres)} ac`,
      );
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY);

      // Wrap crops into lines of ~3 each
      const lineWidth = pageW - margin * 2;
      let currentLine = '';
      let lineY = y;
      for (let i = 0; i < cropParts.length; i++) {
        const sep = currentLine ? '  |  ' : '';
        const test = currentLine + sep + cropParts[i];
        if (doc.getTextWidth(test) > lineWidth && currentLine) {
          doc.text(currentLine, margin + 8, lineY);
          lineY += 13;
          currentLine = cropParts[i];
        } else {
          currentLine = test;
        }
      }
      if (currentLine) {
        doc.text(currentLine, margin + 8, lineY);
        lineY += 13;
      }
      y = lineY + 6;
    } else {
      y += 6;
    }
  }

  // ── 7. Invoice History ─────────────────────────────────────────────
  if (data.invoices.length > 0) {
    ensureSpace(60);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('INVOICE HISTORY', margin, y);
    y += 12;

    const typeLabel = (t: string) => {
      if (t === 'field_application') return 'Application';
      if (t === 'chemical_sale') return 'Chem Sale';
      if (t === 'misc_charge') return 'Misc';
      return t;
    };

    const invRows = data.invoices.map((inv) => [
      inv.invoice_number,
      fmtDate(inv.invoice_date),
      typeLabel(inv.invoice_type),
      inv.field_names?.join(', ') || '—',
      inv.total_acres ? `${fmtAcres(inv.total_acres)} ac` : '',
      fmt(inv.total_amount_cents),
      fmt(inv.balance_cents),
      inv.status === 'voided' ? 'VOIDED' : '',
    ]);

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Invoice #', 'Date', 'Type', 'Fields', 'Acres', 'Amount', 'Balance', '']],
      body: invRows,
      theme: 'plain',
      styles: { fontSize: 7.5, cellPadding: 4, textColor: CHARCOAL },
      headStyles: {
        fillColor: TABLE_HEADER_BG,
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 7,
      },
      columnStyles: {
        0: { cellWidth: 80, fontStyle: 'bold' },
        1: { cellWidth: 60 },
        2: { cellWidth: 58 },
        3: { cellWidth: 'auto' },
        4: { cellWidth: 50, halign: 'right' },
        5: { cellWidth: 65, halign: 'right' },
        6: { cellWidth: 65, halign: 'right' },
        7: { cellWidth: 40, halign: 'center', textColor: RED, fontStyle: 'bold', fontSize: 7 },
      },
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      didDrawPage: drawPageFooter,
    });

    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 10;

    // Totals row
    doc.setDrawColor(200, 200, 200);
    doc.line(pageW - margin - 200, y, pageW - margin, y);
    y += 14;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('Total Invoiced:', pageW - margin - 200, y);
    doc.text(fmt(fin.total_invoiced_cents), pageW - margin - 70, y, { align: 'right' });
    doc.text('Balance:', pageW - margin - 55, y);
    const balColor = fin.outstanding_balance_cents > 0 ? RED : CRX_GREEN;
    doc.setTextColor(...balColor);
    doc.text(fmt(fin.outstanding_balance_cents), pageW - margin, y, { align: 'right' });

    y += 20;
  }

  // ── 8. Grower Shares ───────────────────────────────────────────────
  if (showShares && data.shares.length > 0) {
    ensureSpace(60);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('GROWER SHARES', margin, y);
    y += 12;

    const hasOverrides = data.shares.some((s) => s.price_per_acre_cents);

    const shareHead = hasOverrides
      ? [['Invoice #', 'Fields', 'Grower', '$/Acre', 'Share %', 'Acres', 'Amount']]
      : [['Invoice #', 'Fields', 'Grower', 'Share %', 'Acres', 'Amount']];

    const shareRows = data.shares.map((s) => {
      const name = s.pricing_note ? `${s.share_customer_name}\n${s.pricing_note}` : s.share_customer_name;
      const base = [
        s.invoice_number,
        s.field_names?.join(', ') || '—',
        name,
      ];
      if (hasOverrides) {
        base.push(s.price_per_acre_cents ? fmt(s.price_per_acre_cents) : '—');
      }
      base.push(
        `${s.split_percentage}%`,
        s.acres ? fmtAcres(s.acres) : '—',
        fmt(s.amount_cents),
      );
      return base;
    });

    const shareColStyles: Record<number, Record<string, unknown>> = hasOverrides
      ? {
          0: { cellWidth: 75, fontStyle: 'bold' },
          1: { cellWidth: 'auto' },
          2: { cellWidth: 95 },
          3: { cellWidth: 55, halign: 'right' },
          4: { cellWidth: 50, halign: 'right' },
          5: { cellWidth: 50, halign: 'right' },
          6: { cellWidth: 65, halign: 'right', fontStyle: 'bold' },
        }
      : {
          0: { cellWidth: 80, fontStyle: 'bold' },
          1: { cellWidth: 'auto' },
          2: { cellWidth: 100 },
          3: { cellWidth: 55, halign: 'right' },
          4: { cellWidth: 55, halign: 'right' },
          5: { cellWidth: 70, halign: 'right', fontStyle: 'bold' },
        };

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: shareHead,
      body: shareRows,
      theme: 'plain',
      styles: { fontSize: 7.5, cellPadding: 4, textColor: CHARCOAL },
      headStyles: {
        fillColor: TABLE_HEADER_BG,
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 7,
      },
      columnStyles: shareColStyles,
      alternateRowStyles: { fillColor: ALT_ROW_BG },
      didDrawPage: drawPageFooter,
    });

    y = (doc as JsPDFWithAutoTable).lastAutoTable.finalY + 15;
  }

  // ── Final page footer ──────────────────────────────────────────────
  drawPageFooter();

  return doc;
}

// ── Download Helpers ─────────────────────────────────────────────────────

export async function downloadYearEndSummaryPdf(
  data: YearEndSummaryData,
  options?: YearEndSummaryOptions,
) {
  const doc = await generateYearEndSummaryPdf(data, options);
  const filename = `season_summary_${data.customer.farm_name.replace(/[^a-zA-Z0-9]/g, '_')}_${data.season}.pdf`;
  doc.save(filename);
}

export async function downloadBatchYearEndSummaries(
  dataList: YearEndSummaryData[],
  options?: YearEndSummaryOptions,
) {
  for (let i = 0; i < dataList.length; i++) {
    await downloadYearEndSummaryPdf(dataList[i], options);
    // Small delay between downloads to prevent browser blocking
    if (i < dataList.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
