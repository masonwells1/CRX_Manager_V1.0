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
import { supabase } from './db';
import { computeTotalDiluentGallons, formatGallons } from './fieldAppDiluent';
import { COMPANY_TAGLINE_HEADER, COMPANY_LEGAL_NAME } from './companyInfo';
import { formatCents as fmt } from './money';
import type jsPDF from 'jspdf';
import { CRX_GREEN, CHARCOAL, GRAY, LIGHT_BG, RED, TABLE_HEADER_BG, ALT_ROW_BG, type JsPDFWithAutoTable } from './pdfTheme';
import type { autoTable as autoTableFn } from 'jspdf-autotable';



// ── PDF Data Interfaces ─────────────────────────────────────────────────

export interface InvoicePdfItem {
  order_item_id?: string | null;
  product_id?: string | null;
  return_credit_cogs_cents?: number | null;
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

/**
 * Return-credit accounting keeps one internal line per consumed source-cost lot.
 * Customers should still see one simple product line. Collapse only the
 * unmistakable RPC-authored return-credit rows; ordinary/manual credit memos and
 * the stored ledger rows remain untouched.
 */
interface ReturnCreditDisplayItem {
  order_item_id?: string | null;
  product_id?: string | null;
  return_credit_cogs_cents?: number | null;
  description: string;
  quantity: number;
  unit_size?: string | null;
  unit_price_cents: number;
  extended_cents: number;
  cost_cents?: number;
}

export function groupReturnCreditDisplayItems<T extends ReturnCreditDisplayItem>(
  invoiceType: string | null | undefined,
  items: T[],
): T[] {
  if (invoiceType !== 'credit_memo') return items;

  const grouped: T[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    if (!item.order_item_id || item.return_credit_cogs_cents == null) {
      grouped.push(item);
      continue;
    }
    const key = [
      item.order_item_id,
      item.product_id ?? '',
      item.description,
      item.unit_size ?? '',
      item.unit_price_cents,
    ].join('\u001f');
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, grouped.length);
      grouped.push({ ...item });
      continue;
    }
    const existing = grouped[existingIndex];
    grouped[existingIndex] = {
      ...existing,
      quantity: existing.quantity + item.quantity,
      extended_cents: existing.extended_cents + item.extended_cents,
      // The merged quantity spans source-cost lots, so no single per-unit cost
      // remains meaningful or safe for a future consumer to multiply.
      cost_cents: undefined,
    };
  }
  return grouped;
}

/**
 * The Fuel Surcharge line (field-app parity #32) is stored is_application_fee=true
 * with quantity=1 and unit_price_cents = the FULL flat/percent amount (NOT a
 * per-acre rate): acres/rate_per_acre/total_applied are NULL. Without this the
 * generic is_application_fee branch would mislabel it as a per-acre charge —
 * printing "200.00/AC" and "1.00 AC" on the grower-facing invoice. Detect it so
 * both PDF layouts render Rate/Total-Applied BLANK and Unit Price/Amount as a
 * plain dollar amount (no "/AC"). The Amount + invoice total use extended_cents
 * and are unchanged — this is display only.
 */
export function isFuelSurchargeLine(item: InvoicePdfItem): boolean {
  return Boolean(item.is_application_fee) && item.description === 'Fuel Surcharge';
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
  write_off_cents?: number;
  balance_cents: number;
  // #33: owner-entered early-pay "Discount Earned" (bigint cents). INFORMATIONAL —
  // printed as a labeled line but NEVER subtracted from total/balance (no double-count;
  // the real reduction flows through payments/write-off). Absent/0 = no line printed.
  discount_earned_cents?: number;

  // Field application context
  crop_type?: string;
  field_names?: string[];
  total_acres?: number;
  applicator_name?: string;
  vehicle_name?: string;
  application_date?: string;
  // ChemMan Gap-Closeout #2: diluent / carrier-water RATE per acre (gallons/acre).
  // The TOTAL is derived in the renderer (rate x total_acres) — never persisted —
  // because invoices.total_acres is not reliably written on save. Absent/null = the
  // diluent line is omitted entirely (no spurious 0). A QUANTITY, never money/cents.
  diluent_gpa?: number | null;

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

// ── Shared row → InvoicePdfData builder ───────────────────────────────────
// Used by every list that prints invoices (Chemical Sales batch print, the
// Field-app Unposted list per-row Print + Print All). Fetches the invoice's
// line items (with product detail), shares, and customer billing fields, then
// maps to InvoicePdfData. Centralized here so the ~50-line mapping lives once.

interface InvoiceRowForPdf {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date?: string | null;
  invoice_type?: string | null;
  status?: string | null;
  customer_id: string;
  customer_name: string;
  salesman_name?: string | null;
  // #33: invoice-level billing fields (PO ref / terms / due date / header+footer
  // notes / early-pay Discount Earned). These are OPTIONAL on the row: a caller
  // that already has the live value (the in-editor print) passes it and it WINS;
  // a list caller OMITS them (leaves undefined) and the builder re-fetches them
  // by invoice id below, so the discount line + Terms print from the lists too.
  // (Field-app parity #33 list-print fix: list rows never carried these, so the
  // PDF skipped the discount block and the Terms line.)
  purchase_order_ref?: string | null;
  payment_terms?: string | null;
  discount_earned_cents?: number | null;
  header_notes?: string | null;
  footer_notes?: string | null;
  crop_type?: string | null;
  field_names?: string[] | null;
  total_acres?: number | null;
  applicator_name?: string | null;
  vehicle_name?: string | null;
  application_date?: string | null;
  // #2: diluent rate (gal/acre). OPTIONAL on the row, mirroring total_acres: the
  // in-editor caller passes the live value (wins); a list caller omits it and the
  // builder re-fetches it (with total_acres) from the invoices row below.
  diluent_gpa?: number | null;
  total_amount_cents: number;
  total_cost_cents?: number | null;
  paid_amount_cents?: number | null;
  prepay_applied_cents?: number | null;
  write_off_cents?: number | null;
  balance_cents: number;
}

/**
 * #2: Derive the applied-acres aggregate for a field-application invoice from
 * field_app_locations, group-aware. invoices.total_acres is NOT reliably written
 * by save_field_app_invoice (engine-built invoices leave it NULL), so a PDF that
 * needs the diluent TOTAL (rate x acres) must fall back to summing the locations:
 *   - a SPLIT invoice's locations link by invoice_group_id (invoice_id is NULL)
 *   - an UN-SPLIT invoice's locations link by invoice_id
 * This mirrors the editor's `totalAppliedAcres` so every print path shows the same
 * total. Returns null when no positive acres are found (caller keeps its prior value).
 * Shared by buildInvoicePdfDataFromRow (list/email) and InvoiceDetail's print path
 * so the derivation lives in exactly one place.
 */
export async function deriveFieldAppAppliedAcres(
  invoiceId: string,
  invoiceGroupId: string | null | undefined,
): Promise<number | null> {
  const locQuery = supabase.from('field_app_locations').select('applied_acres');
  const { data: locRows } = invoiceGroupId
    ? await locQuery.eq('invoice_group_id', invoiceGroupId)
    : await locQuery.eq('invoice_id', invoiceId);
  const summed = ((locRows || []) as Array<{ applied_acres: number | null }>)
    .reduce((s, r) => s + (Number(r.applied_acres) || 0), 0);
  return summed > 0 ? summed : null;
}

/**
 * Build a complete InvoicePdfData from a list row by fetching the line items,
 * shares, and customer billing fields. The caller supplies the lightweight row
 * (already loaded in the list); this only touches the DB for the per-invoice
 * detail it doesn't have.
 */
export async function buildInvoicePdfDataFromRow(
  inv: InvoiceRowForPdf,
  options?: InvoicePrintOptions
): Promise<InvoicePdfData> {
  const [{ data: cust }, { data: items }, { data: shares }, { data: billing }] = await Promise.all([
    supabase
      .from('customers')
      .select('billing_address, city, state, zip, account_number, payment_terms')
      .eq('id', inv.customer_id)
      .maybeSingle(),
    supabase
      .from('invoice_items')
      .select('*, product:products(product_name, epa_registration, product_form)')
      .eq('invoice_id', inv.id)
      .order('sort_order'),
    supabase
      .from('invoice_shares')
      .select('*, customer:customers!invoice_shares_customer_id_fkey(farm_name)')
      .eq('invoice_id', inv.id),
    // #33: the invoice's OWN billing fields. A list caller omits these on the row,
    // so without this re-fetch the early-pay Discount Earned line + the Terms / PO /
    // due-date / header+footer notes silently dropped to undefined → 0 → not printed.
    // Re-fetching here covers every caller (lists, email, editor) in one place; the
    // caller-supplied value still WINS (see the `?? ` fallbacks below) so the in-editor
    // print of unsaved live form edits is unchanged.
    supabase
      .from('invoices')
      .select('discount_earned_cents, discount_date, payment_terms, purchase_order_ref, header_notes, footer_notes, due_date, diluent_rate_gpa, total_acres, invoice_group_id')
      .eq('id', inv.id)
      .maybeSingle(),
  ]);

  const custRow = cust as {
    billing_address?: string | null; city?: string | null; state?: string | null;
    zip?: string | null; account_number?: string | null; payment_terms?: string | null;
  } | null;

  // #33: the invoice's persisted billing fields, used ONLY when the caller did not
  // supply the field on `inv` (undefined). A caller that DID supply it — even as
  // null to intentionally clear it — keeps full control (live form wins).
  const billingRow = billing as {
    discount_earned_cents?: number | null; discount_date?: string | null;
    payment_terms?: string | null; purchase_order_ref?: string | null;
    header_notes?: string | null; footer_notes?: string | null; due_date?: string | null;
    diluent_rate_gpa?: number | null; total_acres?: number | null; invoice_group_id?: string | null;
  } | null;
  const pickPo = inv.purchase_order_ref !== undefined ? inv.purchase_order_ref : billingRow?.purchase_order_ref;
  const pickTerms = inv.payment_terms !== undefined ? inv.payment_terms : billingRow?.payment_terms;
  const pickDue = inv.due_date !== undefined ? inv.due_date : billingRow?.due_date;
  const pickHeader = inv.header_notes !== undefined ? inv.header_notes : billingRow?.header_notes;
  const pickFooter = inv.footer_notes !== undefined ? inv.footer_notes : billingRow?.footer_notes;
  const pickDiscount = inv.discount_earned_cents !== undefined ? inv.discount_earned_cents : billingRow?.discount_earned_cents;
  // #2: diluent rate. Caller-supplied (in-editor live form) wins; a list caller omits
  // it and we fall back to the persisted column.
  const pickDiluent = inv.diluent_gpa !== undefined ? inv.diluent_gpa : billingRow?.diluent_rate_gpa;

  // #2: acres for the diluent TOTAL. The in-editor Print passes the live applied-acres
  // aggregate (wins). A LIST / email caller omits it, and invoices.total_acres is NOT
  // reliably written by save_field_app_invoice (engine-built invoices leave it NULL),
  // so falling back to that column alone would print the diluent rate with NO total on
  // a saved list-print (Codex r2 P2). When we have a diluent rate but still no acres,
  // DERIVE the applied-acres aggregate from field_app_locations the same way the editor
  // does — group-aware: a split invoice's locations link by invoice_group_id (invoice_id
  // NULL); an un-split invoice's locations link by invoice_id. This mirrors the editor's
  // totalAppliedAcres so the list-print total matches the in-editor total.
  let pickAcres = inv.total_acres != null ? inv.total_acres : billingRow?.total_acres;
  if (pickDiluent != null && (pickAcres == null || pickAcres <= 0)) {
    const derived = await deriveFieldAppAppliedAcres(inv.id, billingRow?.invoice_group_id ?? null);
    if (derived != null) pickAcres = derived;
  }

  const pdfItems = groupReturnCreditDisplayItems(
    inv.invoice_type,
    ((items || []) as Array<Record<string, unknown> & { product?: { product_name?: string; epa_registration?: string | null; product_form?: string | null } }>).map((it) => ({
      order_item_id: (it.order_item_id as string) || null,
      product_id: (it.product_id as string) || null,
      return_credit_cogs_cents: it.return_credit_cogs_cents != null ? Number(it.return_credit_cogs_cents) : null,
      description: String(it.description ?? ''),
      product_name: it.product?.product_name || String(it.description ?? ''),
      quantity: Number(it.quantity),
      unit_size: (it.unit_size as string) || undefined,
      unit_price_cents: Number(it.unit_price_cents) || 0,
      extended_cents: Number(it.extended_cents) || 0,
      cost_cents: Number(it.cost_cents) || 0,
      rate_per_acre: it.rate_per_acre != null ? Number(it.rate_per_acre) : null,
      rate_unit: (it.rate_unit as string) || null,
      acres: it.acres != null ? Number(it.acres) : null,
      total_applied: it.total_applied != null ? Number(it.total_applied) : null,
      total_applied_unit: (it.total_applied_unit as string) || null,
      total_applied_gl_lb: it.total_applied_gl_lb != null ? Number(it.total_applied_gl_lb) : null,
      gl_lb_unit: (it.gl_lb_unit as string) || null,
      epa_registration: (it.epa_registration as string) || it.product?.epa_registration || null,
      is_application_fee: Boolean(it.is_application_fee),
      product_form: (it.product_form as string) || it.product?.product_form || null,
    })) as InvoicePdfItem[],
  );

  return {
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    due_date: pickDue || undefined,
    invoice_type: inv.invoice_type || 'field_application',
    status: inv.status || 'draft',
    customer_name: inv.customer_name,
    customer_address: custRow?.billing_address || undefined,
    customer_city: custRow?.city || undefined,
    customer_state: custRow?.state || undefined,
    customer_zip: custRow?.zip || undefined,
    account_number: custRow?.account_number || undefined,
    // #33: invoice-level payment terms override the customer default when present.
    payment_terms: pickTerms || custRow?.payment_terms || undefined,
    salesman_name: inv.salesman_name || undefined,
    purchase_order_ref: pickPo || undefined,
    header_notes: pickHeader || undefined,
    footer_notes: pickFooter || undefined,
    crop_type: inv.crop_type || undefined,
    field_names: inv.field_names || undefined,
    total_acres: pickAcres || undefined,
    applicator_name: inv.applicator_name || undefined,
    vehicle_name: inv.vehicle_name || undefined,
    application_date: inv.application_date || undefined,
    // #2: diluent rate (gal/acre); the renderer derives the total from total_acres.
    diluent_gpa: pickDiluent ?? undefined,
    shares: ((shares || []) as Array<{ customer?: { farm_name?: string } | null; split_percentage: number; acres: number | null; amount_cents: number; price_per_acre_cents?: number | null; pricing_note?: string | null }>).length > 0
      ? (shares as Array<{ customer?: { farm_name?: string } | null; split_percentage: number; acres: number | null; amount_cents: number; price_per_acre_cents?: number | null; pricing_note?: string | null }>).map((s) => ({
          customer_name: s.customer?.farm_name || 'Unknown',
          split_percentage: s.split_percentage,
          acres: s.acres,
          amount_cents: s.amount_cents,
          price_per_acre_cents: s.price_per_acre_cents ?? null,
          pricing_note: s.pricing_note ?? null,
        }))
      : undefined,
    items: pdfItems,
    total_amount_cents: inv.total_amount_cents || 0,
    total_cost_cents: inv.total_cost_cents || 0,
    paid_amount_cents: inv.paid_amount_cents || 0,
    prepay_applied_cents: inv.prepay_applied_cents || 0,
    write_off_cents: inv.write_off_cents || 0,
    balance_cents: inv.balance_cents || 0,
    // #33: informational Discount Earned line (does NOT change total/balance).
    discount_earned_cents: pickDiscount || 0,
    options,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const fmtNum = (n: number, decimals = 4) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

// #2: one-line "Diluent / Carrier Water" string for the field-app PDF — the rate
// per acre plus the derived total (rate x applied acres) when acres are known.
// Returns '' to signal "render nothing" (caller skips the line) when there is no
// recorded rate, so the printout never shows a phantom 0 / a rate with no total.
//   "Diluent / Carrier Water: 15 gal/ac · 1,500 gal total (91.90 ac)"
//   "Diluent / Carrier Water: 15 gal/ac"   (acres unknown — rate only)
function buildDiluentLine(
  rateGpa: number | null | undefined,
  acres: number | null | undefined,
): string {
  if (rateGpa == null || !Number.isFinite(rateGpa) || rateGpa < 0) return '';
  const rateStr = formatGallons(rateGpa);
  const total = computeTotalDiluentGallons(rateGpa, acres);
  if (total == null) {
    return `Diluent / Carrier Water: ${rateStr} gal/ac`;
  }
  const totalStr = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(total);
  return `Diluent / Carrier Water: ${rateStr} gal/ac · ${totalStr} gal total (${fmtNum(acres as number, 2)} ac)`;
}

// ── Main Generator ──────────────────────────────────────────────────────

export async function generateInvoicePdf(data: InvoicePdfData) {
  // Field-app parity #30: route to the legacy ("Old Print") layout when asked.
  // Both formats consume the SAME InvoicePdfData, so the money lines are
  // identical — no recompute, Total/Payments/Prepay/Balance Due reconcile.
  if (data.options?.format === 'legacy') {
    return generateLegacyInvoicePdf(data);
  }

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const opts = data.options ?? { show_shares: true, show_price_per_acre: true, show_epa_registration: true };

  let y = 0;

  // ── Page footer callback ───────────────────────────────────────────
  const drawPageFooter = () => {
    try {
      const footerY = pageH - 20;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 6, pageW - margin, footerY - 6);
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `${COMPANY_LEGAL_NAME}  •  Generated ${new Date().toLocaleDateString()}`,
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('invoicePdf: drawPageFooter failed', e);
    }
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
  doc.text(COMPANY_TAGLINE_HEADER, margin, 53);

  // Invoice badge (right)
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', pageW - margin, 28, { align: 'right' });
  doc.setFontSize(12);
  doc.text(data.invoice_number, pageW - margin, 44, { align: 'right' });

  // Status badge
  if (data.status) {
    const statusLabel = data.status.toUpperCase();
    const statusColors: Record<string, [number, number, number]> = {
      draft: [156, 163, 175],     // gray
      unposted: [234, 179, 8],    // amber
      posted: [59, 130, 246],     // blue
      paid: CRX_GREEN,            // brand crx-green (#28A26A)
      overdue: [239, 68, 68],     // red
      voided: [107, 114, 128],    // slate
      cancelled: [107, 114, 128], // slate
    };
    const color = statusColors[data.status] || [107, 114, 128];
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...color);
    doc.text(statusLabel, pageW - margin, 57, { align: 'right' });
    doc.setTextColor(255, 255, 255); // reset for header area
  }

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
  // Wrap long customer names within the left half of the info box
  const maxNameWidth = (pageW - margin * 2) / 2 - 24;
  const nameLines = doc.splitTextToSize(data.customer_name.toUpperCase(), maxNameWidth);
  doc.text(nameLines.slice(0, 2).join('\n'), margin + 12, y + 33);
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
  // #33: PO Reference in the current (default) format too — previously it only
  // printed on the legacy "Old Print" layout, so a PO set in the editor was invisible
  // on the default print. Placed beside TERMS on the same info row.
  if (data.purchase_order_ref) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...GRAY);
    doc.text('PO REF', rightX - 50, ry);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...CHARCOAL);
    doc.text(data.purchase_order_ref, rightX - 50, ry + 12);
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
  // #33: reserve an extra row for the informational Discount Earned line below the
  // balance (only when an amount is recorded). It is NOT a deduction.
  const hasDiscount = (data.discount_earned_cents ?? 0) > 0;
  const totalsH = 110 + (data.paid_amount_cents > 0 ? 16 : 0) + (data.prepay_applied_cents > 0 ? 16 : 0) + ((data.write_off_cents ?? 0) > 0 ? 16 : 0) + (hasDiscount ? 16 : 0);
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

  if ((data.write_off_cents ?? 0) > 0) {
    doc.text('Write-off', tLX, ty);
    doc.setTextColor(...CRX_GREEN);
    doc.text(`-${fmt(data.write_off_cents ?? 0)}`, tRX, ty, { align: 'right' });
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

  // #33: informational Discount Earned line BELOW the balance — it is recorded and
  // shown (early-pay discount) but is deliberately NOT deducted from the balance,
  // so the printed Balance Due still reconciles to total − payments − prepay − write-off.
  if (hasDiscount) {
    ty += 16;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text('Discount Earned (if paid early)', tLX, ty);
    doc.text(fmt(data.discount_earned_cents ?? 0), tRX, ty, { align: 'right' });
  }

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

// ── Legacy "Old Print" generator (field-app parity #30) ──────────────────────
// ChemMan offers a second print layout ("Old Print" / "Old Print All") that
// some growers still expect: a denser, monochrome, typewriter-style sheet with
// a plain text header (no green band), a compact line table, a grower-share
// block, and the same money totals. It is deliberately PLAIN — no brand colors,
// no rounded info boxes — so it photocopies / faxes cleanly like the old system.
//
// Money discipline: this consumes the SAME InvoicePdfData as the current format.
// It NEVER recomputes a total; the printed Total, line extended, Payments,
// Prepay, and Balance Due all come straight from the data object, so a legacy
// print of a posted invoice WITH a payment reconciles exactly (Total − Payments
// − Prepay = Balance Due), and a split's per-customer rows sum to the whole.
async function generateLegacyInvoicePdf(data: InvoicePdfData) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const { deriveSplitRef } = await import('../components/field-app/customerSplit');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const opts = data.options ?? { show_shares: true, show_price_per_acre: true, show_epa_registration: true };
  const isFieldApp = data.invoice_type === 'field_application';

  const black: [number, number, number] = [0, 0, 0];

  const drawLegacyFooter = () => {
    try {
      const footerY = pageH - 24;
      doc.setFontSize(7);
      doc.setFont('courier', 'normal');
      doc.setTextColor(120, 120, 120);
      doc.text(
        `${COMPANY_LEGAL_NAME}   (Old Print format)   Generated ${new Date().toLocaleDateString()}`,
        pageW / 2,
        footerY,
        { align: 'center' },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('invoicePdf: drawLegacyFooter failed', e);
    }
  };

  let y = margin;

  // ── Plain text header (no color band) ──────────────────────────────
  doc.setFont('courier', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...black);
  doc.text('CROP RX SOLUTIONS', margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  doc.text(COMPANY_TAGLINE_HEADER, margin, y + 13);

  doc.setFont('courier', 'bold');
  doc.setFontSize(11);
  doc.text('INVOICE', pageW - margin, y, { align: 'right' });
  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  doc.text(`No. ${data.invoice_number}`, pageW - margin, y + 13, { align: 'right' });
  doc.text(`Date: ${fmtDate(data.invoice_date)}`, pageW - margin, y + 25, { align: 'right' });
  if (data.status) {
    doc.text(`Status: ${data.status.toUpperCase()}`, pageW - margin, y + 37, { align: 'right' });
  }

  y += 30;
  // Rule under the header
  doc.setDrawColor(...black);
  doc.setLineWidth(0.8);
  doc.line(margin, y, pageW - margin, y);
  y += 16;

  // ── Bill-to + meta (two columns, plain text) ───────────────────────
  doc.setFont('courier', 'bold');
  doc.setFontSize(8);
  doc.text('BILL TO:', margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  let billY = y + 12;
  doc.text(data.customer_name.toUpperCase(), margin, billY);
  billY += 11;
  if (data.customer_address) { doc.text(data.customer_address, margin, billY); billY += 11; }
  const cityLine = [data.customer_city, data.customer_state, data.customer_zip].filter(Boolean).join(', ');
  if (cityLine) { doc.text(cityLine, margin, billY); billY += 11; }

  // Right meta column
  const metaX = pageW - margin - 170;
  let metaY = y;
  doc.setFontSize(8);
  const metaLine = (label: string, value: string) => {
    doc.setFont('courier', 'bold');
    doc.text(label, metaX, metaY);
    doc.setFont('courier', 'normal');
    doc.text(value, metaX + 70, metaY);
    metaY += 11;
  };
  if (data.account_number) metaLine('Account:', data.account_number);
  if (data.salesman_name) metaLine('Salesman:', data.salesman_name);
  if (data.purchase_order_ref) metaLine('PO Ref:', data.purchase_order_ref);
  metaLine('Due Date:', data.due_date ? fmtDate(data.due_date) : 'On receipt');
  if (data.payment_terms) metaLine('Terms:', data.payment_terms);

  y = Math.max(billY, metaY) + 8;

  // ── Field-application context line ─────────────────────────────────
  if (isFieldApp && (data.crop_type || data.total_acres || data.field_names?.length)) {
    doc.setFont('courier', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...black);
    const descParts = [
      data.crop_type,
      data.total_acres ? `${fmtNum(data.total_acres, 2)} ac` : null,
      data.field_names?.join(', '),
    ].filter(Boolean);
    const descLines = doc.splitTextToSize(descParts.join(' - '), pageW - margin * 2);
    doc.text(descLines, margin, y);
    y += descLines.length * 11 + 2;
  }

  // ── Diluent / carrier-water line (#2) ──────────────────────────────
  // Rate per acre + computed total (rate x applied acres). Omitted entirely when
  // no rate is recorded — never a phantom 0. A QUANTITY (gallons), never money.
  if (isFieldApp && data.diluent_gpa != null) {
    const diluentLine = buildDiluentLine(data.diluent_gpa, data.total_acres);
    if (diluentLine) {
      doc.setFont('courier', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...black);
      doc.text(diluentLine, margin, y);
      y += 11 + 2;
    }
  }

  // Header notes
  if (data.header_notes) {
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    const noteLines = doc.splitTextToSize(data.header_notes, pageW - margin * 2);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 10 + 4;
  }

  // ── Line-item table (compact monochrome grid) ──────────────────────
  const showEpa = opts.show_epa_registration;
  let head: string[][];
  let body: string[][];

  if (isFieldApp) {
    head = showEpa
      ? [['Product', 'EPA Reg', 'Rate/Ac', 'Total Applied', 'Unit Price', 'Amount']]
      : [['Product', 'Rate/Ac', 'Total Applied', 'Unit Price', 'Amount']];
    body = data.items.map((item) => {
      const isFuel = isFuelSurchargeLine(item);
      const rateStr = isFuel
        ? ''
        : item.rate_per_acre != null
          ? `${fmtNum(item.rate_per_acre, 4)} ${item.rate_unit || item.unit_size || ''}`.trim()
          : '';
      const totalApplied = isFuel
        ? ''
        : item.total_applied != null
          ? `${fmtNum(item.total_applied, item.total_applied === Math.round(item.total_applied) ? 2 : 4)} ${item.total_applied_unit || ''}`.trim()
          : item.is_application_fee
            ? `${fmtNum(item.quantity, 2)} AC`
            : '';
      const unitPrice = isFuel
        ? fmtNum(item.unit_price_cents / 100, 2)
        : item.is_application_fee
          ? `${fmtNum(item.unit_price_cents / 100, 2)}/AC`
          : `${fmtNum(item.unit_price_cents / 100, 2)} ${item.gl_lb_unit || item.unit_size || ''}`.trim();
      return showEpa
        ? [item.product_name || item.description, item.epa_registration || '', rateStr, totalApplied, unitPrice, fmt(item.extended_cents)]
        : [item.product_name || item.description, rateStr, totalApplied, unitPrice, fmt(item.extended_cents)];
    });
  } else {
    // Chemical-sale / misc legacy: Qty | Description | Unit | Amount
    head = [['Qty', 'Description', 'Unit Price', 'Amount']];
    body = data.items.map((item) => [
      fmtNum(item.quantity, 2),
      item.product_name || item.description,
      fmt(item.unit_price_cents),
      fmt(item.extended_cents),
    ]);
  }

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head,
    body,
    theme: 'grid',
    styles: { font: 'courier', fontSize: 8, cellPadding: 3, textColor: black, lineColor: [120, 120, 120], lineWidth: 0.4 },
    headStyles: { fillColor: [255, 255, 255], textColor: black, fontStyle: 'bold', fontSize: 8, lineColor: black, lineWidth: 0.6 },
    columnStyles: isFieldApp
      ? (showEpa
        ? { 0: { cellWidth: 'auto' }, 1: { cellWidth: 56 }, 2: { halign: 'right', cellWidth: 58 }, 3: { halign: 'right', cellWidth: 78 }, 4: { halign: 'right', cellWidth: 62 }, 5: { halign: 'right', cellWidth: 62, fontStyle: 'bold' } }
        : { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 64 }, 2: { halign: 'right', cellWidth: 84 }, 3: { halign: 'right', cellWidth: 66 }, 4: { halign: 'right', cellWidth: 66, fontStyle: 'bold' } })
      : { 0: { cellWidth: 50, halign: 'right' }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 80 }, 3: { halign: 'right', cellWidth: 80, fontStyle: 'bold' } },
    didDrawPage: drawLegacyFooter,
  });

  y = doc.lastAutoTable.finalY + 8;

  // ── Price per acre (field-app, plain) ──────────────────────────────
  if (isFieldApp && opts.show_price_per_acre && data.total_acres && data.total_acres > 0) {
    const pricePerAcre = data.total_amount_cents / 100 / data.total_acres;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...black);
    doc.text(`Price per acre: ${fmtNum(pricePerAcre, 2)}`, margin, y);
    y += 14;
  }

  // ── Grower shares block (uses deriveSplitRef for the <base>-NNN label) ──
  if (opts.show_shares && data.shares && data.shares.length > 1) {
    const base = data.job_number || data.invoice_number;
    const hasPerAcre = data.shares.some((s) => s.price_per_acre_cents != null);
    const shareHead = hasPerAcre
      ? [['Ref', 'Grower', '$/Acre', 'Share', 'Acres', 'Amount']]
      : [['Ref', 'Grower', 'Share', 'Acres', 'Amount']];
    const shareBody = data.shares.map((s, idx) => {
      const ref = deriveSplitRef(base, idx, true);
      const name = s.pricing_note ? `${s.customer_name} (${s.pricing_note})` : s.customer_name;
      return hasPerAcre
        ? [ref, name, s.price_per_acre_cents != null ? fmt(s.price_per_acre_cents) : '', `${fmtNum(s.split_percentage, 2)}%`, s.acres != null ? fmtNum(s.acres, 2) : '', fmt(s.amount_cents)]
        : [ref, name, `${fmtNum(s.split_percentage, 2)}%`, s.acres != null ? fmtNum(s.acres, 2) : '', fmt(s.amount_cents)];
    });
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: shareHead,
      body: shareBody,
      theme: 'grid',
      styles: { font: 'courier', fontSize: 7.5, cellPadding: 2.5, textColor: black, lineColor: [150, 150, 150], lineWidth: 0.4 },
      headStyles: { fillColor: [255, 255, 255], textColor: black, fontStyle: 'bold', fontSize: 7.5, lineColor: black, lineWidth: 0.6 },
      columnStyles: hasPerAcre
        ? { 0: { cellWidth: 62 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 52 }, 3: { halign: 'right', cellWidth: 46 }, 4: { halign: 'right', cellWidth: 46 }, 5: { halign: 'right', cellWidth: 60, fontStyle: 'bold' } }
        : { 0: { cellWidth: 62 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 52 }, 3: { halign: 'right', cellWidth: 52 }, 4: { halign: 'right', cellWidth: 62, fontStyle: 'bold' } },
      didDrawPage: drawLegacyFooter,
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── Totals block (right-aligned, plain) ────────────────────────────
  if (y + 90 > pageH - 48) { doc.addPage(); y = margin; }

  const labelX = pageW - margin - 150;
  const valX = pageW - margin;
  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...black);

  const totalRow = (label: string, value: string, bold = false) => {
    doc.setFont('courier', bold ? 'bold' : 'normal');
    doc.text(label, labelX, y);
    doc.text(value, valX, y, { align: 'right' });
    y += 13;
  };

  totalRow('Subtotal:', fmt(data.total_amount_cents));
  if (data.paid_amount_cents > 0) totalRow('Payments:', `-${fmt(data.paid_amount_cents)}`);
  if (data.prepay_applied_cents > 0) totalRow('Prepay Applied:', `-${fmt(data.prepay_applied_cents)}`);
  if ((data.write_off_cents ?? 0) > 0) totalRow('Write-off:', `-${fmt(data.write_off_cents ?? 0)}`);
  if (data.finance_charge_cents && data.finance_charge_cents > 0) totalRow('Finance Charges:', fmt(data.finance_charge_cents));

  doc.setDrawColor(...black);
  doc.setLineWidth(0.6);
  doc.line(labelX, y - 4, valX, y - 4);
  y += 4;
  totalRow('BALANCE DUE:', fmt(data.balance_cents), true);
  // #33: informational Discount Earned line — recorded/printed, NOT deducted from the
  // balance (so Balance Due still reconciles to total − payments − prepay − write-off).
  if ((data.discount_earned_cents ?? 0) > 0) {
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    totalRow('Discount Earned (if paid early):', fmt(data.discount_earned_cents ?? 0));
    doc.setTextColor(...black);
    doc.setFontSize(9);
  }

  // ── Footer notes ───────────────────────────────────────────────────
  if (data.footer_notes) {
    y += 6;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    const lines = doc.splitTextToSize(data.footer_notes, pageW - margin * 2);
    doc.text(lines, margin, y);
  }

  drawLegacyFooter();
  return doc;
}

// ── Layout 1: Field Application ──────────────────────────────────────────

function drawFieldApplicationLayout(
  doc: JsPDFWithAutoTable, data: InvoicePdfData, startY: number, margin: number, pageW: number,
  opts: InvoicePrintOptions, autoTable: typeof autoTableFn, drawPageFooter: () => void,
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

  // ── Diluent / carrier-water line (#2) ──────────────────────────────
  // Rate per acre + computed total (rate x applied acres), in the standard
  // (current) field-app layout. Omitted entirely when no rate is recorded —
  // never a phantom 0. A QUANTITY (gallons), never money.
  if (data.diluent_gpa != null) {
    const diluentLine = buildDiluentLine(data.diluent_gpa, data.total_acres);
    if (diluentLine) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...CHARCOAL);
      doc.text(diluentLine, margin, y);
      y += 14;
    }
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
    const isFuel = isFuelSurchargeLine(item);
    const rateStr = isFuel
      ? ''
      : item.rate_per_acre != null
        ? `${fmtNum(item.rate_per_acre, 4)} ${item.rate_unit || item.unit_size || ''}`
        : item.is_application_fee ? '' : '';

    const totalApplied = isFuel
      ? ''
      : item.total_applied != null
        ? `${fmtNum(item.total_applied, item.total_applied === Math.round(item.total_applied) ? 2 : 4)} ${item.total_applied_unit || ''}`
        : item.is_application_fee
          ? `${fmtNum(item.quantity, 2)} AC`
          : '';

    const glLb = item.total_applied_gl_lb != null
      ? `${fmtNum(item.total_applied_gl_lb, 4)} ${item.gl_lb_unit || ''}`
      : item.is_application_fee
        ? ''
        : '';

    const unitPrice = isFuel
      ? `${fmtNum(item.unit_price_cents / 100, 2)}`
      : item.is_application_fee
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

  y = doc.lastAutoTable.finalY + 6;

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
    y = doc.lastAutoTable.finalY + 6;
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
  doc: JsPDFWithAutoTable, data: InvoicePdfData, startY: number, margin: number, pageW: number,
  opts: InvoicePrintOptions, autoTable: typeof autoTableFn, drawPageFooter: () => void,
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

  y = doc.lastAutoTable.finalY + 6;

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
    y = doc.lastAutoTable.finalY + 6;
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
  doc: JsPDFWithAutoTable, data: InvoicePdfData, startY: number, margin: number, pageW: number,
  autoTable: typeof autoTableFn, drawPageFooter: () => void,
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

  return doc.lastAutoTable.finalY + 20;
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
  // Use allSettled so one bad invoice doesn't crash the entire batch
  const results = await Promise.allSettled(dataList.map((d) => generateInvoicePdf(d)));

  const docs: { doc: jsPDF; name: string }[] = [];
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      docs.push({ doc: r.value, name: dataList[i].invoice_number });
    } else {
      failures.push(dataList[i].invoice_number);
    }
  });

  if (docs.length === 0) {
    throw new Error(`All ${failures.length} invoice PDFs failed to generate`);
  }

  // Save first immediately (always allowed by browser)
  docs[0].doc.save(`${docs[0].name}.pdf`);

  // Queue remaining downloads spaced out via rAF to avoid popup blockers.
  // Most browsers allow sequential downloads from user-initiated actions.
  for (let i = 1; i < docs.length; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        docs[i].doc.save(`${docs[i].name}.pdf`);
        resolve();
      });
    });
  }

  if (failures.length > 0) {
    console.warn(`Batch PDF: ${failures.length} invoice(s) failed:`, failures);
  }

  return docs[docs.length - 1].doc;
}

