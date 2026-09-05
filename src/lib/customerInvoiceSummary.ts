/**
 * customerInvoiceSummary.ts — pure, tested helpers for the Customer Invoice
 * Summary (field-app parity #34).
 *
 * ChemMan's "Customer Invoice Summary" (/reportCondensedUnpostedInvoice.php) is a
 * consolidated, customer-facing statement that combines a customer's UNPOSTED
 * chemical-sales invoices AND UNPOSTED field-application invoices into ONE
 * document, with a per-type subtotal and a single combined total + balance.
 *
 * This module owns the data-shaping + the cents math so it can be unit-tested in
 * isolation, away from React and PostgREST. It is a READ-ONLY summary — nothing
 * here mutates an invoice.
 *
 * Money rule (CRX Hard Rule): every *_cents value is an INTEGER number of
 * cents. The reducers here sum cents as integers and NEVER touch floats; the UI
 * and PDF divide by 100 only at the display edge via formatCents. A per-type
 * subtotal is the integer sum of that type's rows, and the combined total is the
 * integer sum of the two subtotals — so the printed combined Balance equals the
 * sum of both types' balances exactly (no rounding drift).
 */

import type { InvoiceType, InvoiceStatus } from '../types';

/**
 * The "unposted" statuses that belong on this summary. ChemMan's summary is
 * explicitly the UNPOSTED working set (not the posted AR ledger — that is the
 * separate AR Aging / Customer Statement artifact). A field invoice can sit at
 * 'draft' (engine-built, not yet finalized) or 'unposted' (ready to post); a
 * chemical-sale invoice likewise. Both belong here; nothing posted does.
 */
export const SUMMARY_UNPOSTED_STATUSES: ReadonlyArray<InvoiceStatus> = ['draft', 'unposted'];

/** True when an invoice status belongs on the unposted Customer Invoice Summary. */
export function isSummaryUnposted(status: InvoiceStatus): boolean {
  return SUMMARY_UNPOSTED_STATUSES.includes(status);
}

/**
 * The money + identity fields the summary needs from one invoice. Both invoice
 * types share these columns on the `invoices` table, so a single row shape
 * covers chemical sales and field applications alike.
 */
export interface SummaryInvoiceRow {
  id: string;
  invoice_number: string;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  invoice_date: string;
  /** Invoice grand total (integer cents). */
  total_amount_cents: number;
  /** Cents already paid against this invoice (integer cents). */
  paid_amount_cents: number;
  /** Cents of prepay applied (integer cents). */
  prepay_applied_cents: number;
  /** Cents written off (integer cents). */
  write_off_cents: number;
  /** Owner-entered early-pay Discount Earned (integer cents) — INFORMATIONAL. */
  discount_earned_cents: number;
  /** Remaining balance (integer cents) — single source of truth for AR. */
  balance_cents: number;
}

/** The money totals for one section (a per-type subtotal OR the combined total). */
export interface SummaryTotals {
  count: number;
  totalAmountCents: number;
  paidAmountCents: number;
  prepayAppliedCents: number;
  writeOffCents: number;
  /** Informational early-pay discount, summed for display only (NOT deducted). */
  discountEarnedCents: number;
  balanceCents: number;
}

/** A zero totals object. */
export const ZERO_SUMMARY_TOTALS: SummaryTotals = {
  count: 0,
  totalAmountCents: 0,
  paidAmountCents: 0,
  prepayAppliedCents: 0,
  writeOffCents: 0,
  discountEarnedCents: 0,
  balanceCents: 0,
};

/**
 * Sum a set of invoice rows into integer-cents totals. Pure: the same reducer
 * drives the on-screen subtotals AND the PDF, so they can never disagree.
 */
export function sumSummaryTotals(rows: ReadonlyArray<SummaryInvoiceRow>): SummaryTotals {
  const t: SummaryTotals = { ...ZERO_SUMMARY_TOTALS };
  for (const r of rows) {
    t.count += 1;
    t.totalAmountCents += r.total_amount_cents;
    t.paidAmountCents += r.paid_amount_cents;
    t.prepayAppliedCents += r.prepay_applied_cents;
    t.writeOffCents += r.write_off_cents;
    t.discountEarnedCents += r.discount_earned_cents;
    t.balanceCents += r.balance_cents;
  }
  return t;
}

/** Add two totals together (used to combine the per-type subtotals). */
export function addSummaryTotals(a: SummaryTotals, b: SummaryTotals): SummaryTotals {
  return {
    count: a.count + b.count,
    totalAmountCents: a.totalAmountCents + b.totalAmountCents,
    paidAmountCents: a.paidAmountCents + b.paidAmountCents,
    prepayAppliedCents: a.prepayAppliedCents + b.prepayAppliedCents,
    writeOffCents: a.writeOffCents + b.writeOffCents,
    discountEarnedCents: a.discountEarnedCents + b.discountEarnedCents,
    balanceCents: a.balanceCents + b.balanceCents,
  };
}

/** The fully-assembled combined summary for one customer. */
export interface CustomerInvoiceSummary {
  /** Chemical-sales invoices (invoice_type='chemical_sale'), date-ascending. */
  chemicalRows: SummaryInvoiceRow[];
  /** Field-application invoices (invoice_type='field_application'), date-ascending. */
  fieldRows: SummaryInvoiceRow[];
  /** Subtotal across the chemical-sales rows. */
  chemicalSubtotal: SummaryTotals;
  /** Subtotal across the field-application rows. */
  fieldSubtotal: SummaryTotals;
  /** Combined total = chemicalSubtotal + fieldSubtotal (integer cents). */
  combinedTotal: SummaryTotals;
}

/**
 * Build the combined Customer Invoice Summary from a flat list of the customer's
 * unposted invoices (both types). Partitions by invoice_type, sorts each section
 * by invoice_date then invoice_number, and computes the per-type subtotals and
 * the combined total.
 *
 * The caller is responsible for already having filtered to ONE customer and to
 * the unposted statuses (the query does this server-side); this function does
 * not re-filter status so a test can feed an exact set, but it DOES partition by
 * type and ignores any type that is neither chemical_sale nor field_application
 * (e.g. a stray misc_charge/credit_memo is left out of both sections so the
 * combined total only ever reflects the two summarized types).
 */
export function buildCustomerInvoiceSummary(
  rows: ReadonlyArray<SummaryInvoiceRow>
): CustomerInvoiceSummary {
  const byDate = (a: SummaryInvoiceRow, b: SummaryInvoiceRow): number => {
    if (a.invoice_date !== b.invoice_date) return a.invoice_date < b.invoice_date ? -1 : 1;
    return a.invoice_number < b.invoice_number ? -1 : a.invoice_number > b.invoice_number ? 1 : 0;
  };

  const chemicalRows = rows.filter((r) => r.invoice_type === 'chemical_sale').slice().sort(byDate);
  const fieldRows = rows.filter((r) => r.invoice_type === 'field_application').slice().sort(byDate);

  const chemicalSubtotal = sumSummaryTotals(chemicalRows);
  const fieldSubtotal = sumSummaryTotals(fieldRows);
  const combinedTotal = addSummaryTotals(chemicalSubtotal, fieldSubtotal);

  return { chemicalRows, fieldRows, chemicalSubtotal, fieldSubtotal, combinedTotal };
}

/** A human label for an invoice type, used in the summary section headings. */
export function summaryTypeLabel(type: InvoiceType): string {
  switch (type) {
    case 'chemical_sale':
      return 'Chemical Sales';
    case 'field_application':
      return 'Field Application';
    case 'misc_charge':
      return 'Misc Charges';
    case 'credit_memo':
      return 'Credit Memos';
    default:
      return type;
  }
}
