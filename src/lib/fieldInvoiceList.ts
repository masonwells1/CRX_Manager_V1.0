/**
 * fieldInvoiceList.ts — pure, tested helpers for the field-application invoice
 * lists (Field-app parity #22 Unposted list; reusable by #23 Posted list).
 *
 * Keeps the data-shaping (which columns a list row shows) and the footer
 * reducers OUT of the React component so they can be unit-tested in isolation.
 *
 * Money rule (CRX Hard Rule): every *_cents value is an INTEGER number of
 * cents. The reducers here sum cents as integers and NEVER touch floats — the
 * UI divides by 100 only at the display edge via formatCents.
 */

import type { Invoice, InvoiceStatus } from '../types';

/**
 * The raw shape PostgREST returns for one field-application invoice row, with
 * the embeds this list needs. The component maps it into FieldInvoiceListRow
 * via mapFieldInvoiceRow().
 */
export type RawFieldInvoiceRow = Omit<Invoice, 'customer'> & {
  customer?: { farm_name?: string | null } | null;
  job?: { job_number?: string | null } | null;
  // Engine-built per-acre invoices store locations/crops/acres on child rows.
  // For UNGROUPED invoices these embed directly via the invoice_id FK. For
  // GROUPED (split, multi-customer) invoices the engine keys locations by
  // invoice_group_id with invoice_id=NULL, so the caller must fetch them by
  // group and inject them here before mapping (see FieldInvoicesUnposted).
  field_app_locations?: Array<{
    crop_type?: string | null;
    total_acres?: number | null;
    applied_acres?: number | null;
    field?: { field_name?: string | null; crop_type?: string | null } | null;
  }> | null;
  // Chemicals applied come from the invoice line items (product per line).
  invoice_items?: Array<{
    is_application_fee?: boolean | null;
    product?: { product_name?: string | null } | null;
    description?: string | null;
  }> | null;
};

/** The flattened row the unposted/posted list table renders. */
export interface FieldInvoiceListRow {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  customer_id: string;
  customer_name: string;
  job_number: string | null;
  /** Field/location names (deduped). */
  locations: string[];
  /** Crop names (deduped). */
  crops: string[];
  /** Applicator name(s). */
  applicators: string[];
  /** Chemical product names from the line items (deduped, excludes app fees). */
  chemicals: string[];
  total_acres: number;
  total_amount_cents: number;
  /** Cents already paid (for an accurate PDF Payments line + Balance Due). */
  paid_amount_cents: number;
  /** Cents of prepay applied (for an accurate PDF Prepay line + Balance Due). */
  prepay_applied_cents: number;
  /** Cents written off (carried through to the PDF). */
  write_off_cents: number;
  /** Total cost cents (carried through to the PDF). */
  total_cost_cents: number;
  balance_cents: number;
  invoice_date: string;
  /** Per-line split billing (flag-gated, additive): server-computed send suppression for
   * a fully-$0 split child. Optional — not selected by today's list query (the column is
   * not live yet); the email-suppression gate keys on it once the migration lands. */
  send_disposition?: 'normal' | 'suppressed_zero_total' | null;
  /** Lowercased haystack for the in-list Search box. */
  search_blob: string;
}

const STATUS_UNPOSTED: ReadonlyArray<InvoiceStatus> = ['draft', 'unposted'];

/**
 * Committed (posted) field-app statuses for the Posted list (#23). A posted
 * invoice ages: post_invoice sets 'posted'; mark_overdue_invoices flips it to
 * 'overdue'; full payment flips it to 'paid'. All three are committed to the
 * ledger and must show on the Posted list (and must NOT show on the Unposted
 * tray). 'voided'/'cancelled' are terminal reversals — excluded from both.
 */
export const STATUS_POSTED: ReadonlyArray<InvoiceStatus> = ['posted', 'overdue', 'paid'];

/** True when an invoice is still in the working tray (not yet posted). */
export function isUnpostedFieldInvoice(status: InvoiceStatus): boolean {
  return STATUS_UNPOSTED.includes(status);
}

/** True when an invoice is committed to the ledger (on the Posted list). */
export function isPostedFieldInvoice(status: InvoiceStatus): boolean {
  return STATUS_POSTED.includes(status);
}

/** De-dupe + drop empty/whitespace strings, preserving first-seen order. */
function uniqNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = (v ?? '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Flatten one raw invoice row into the list shape. Derives Locations / Crops /
 * Acres from the engine-built child rows (field_app_locations) when present,
 * falling back to the invoice-level snapshot columns (field_names / crop_type /
 * total_acres) used by job-built invoices. Chemicals come from the line items.
 */
export function mapFieldInvoiceRow(raw: RawFieldInvoiceRow): FieldInvoiceListRow {
  const locs = raw.field_app_locations ?? [];

  // Locations: prefer child field names, fall back to invoice snapshot.
  const locations = locs.length > 0
    ? uniqNonEmpty(locs.map((l) => l.field?.field_name))
    : uniqNonEmpty(raw.field_names ?? []);

  // Crops: prefer the per-location crop (override or field crop), fall back to
  // the invoice-level snapshot crop_type.
  const crops = locs.length > 0
    ? uniqNonEmpty(locs.map((l) => l.crop_type ?? l.field?.crop_type))
    : uniqNonEmpty([raw.crop_type]);

  // Acres: sum the per-location ACTUAL applied acres for engine-built invoices
  // (this is what gets billed); fall back to the invoice snapshot total_acres.
  // applied_acres can be null on a freshly-created location — treat as 0.
  const acresFromLocs = locs.reduce((sum, l) => sum + (Number(l.applied_acres) || 0), 0);
  const total_acres = locs.length > 0
    ? acresFromLocs
    : (Number(raw.total_acres) || 0);

  // Chemicals: product names from the line items, excluding the application fee
  // line (which is a charge, not a chemical).
  const chemicals = uniqNonEmpty(
    (raw.invoice_items ?? [])
      .filter((it) => !it.is_application_fee)
      .map((it) => it.product?.product_name ?? it.description)
  );

  const applicators = uniqNonEmpty([raw.applicator_name]);
  const customer_name = raw.customer?.farm_name?.trim() || 'Unknown';
  const job_number = raw.job?.job_number?.trim() || null;

  const search_blob = [
    raw.invoice_number,
    customer_name,
    job_number,
    ...locations,
    ...crops,
    ...applicators,
    ...chemicals,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return {
    id: raw.id,
    invoice_number: raw.invoice_number,
    status: raw.status,
    customer_id: raw.customer_id,
    customer_name,
    job_number,
    locations,
    crops,
    applicators,
    chemicals,
    total_acres,
    total_amount_cents: raw.total_amount_cents,
    paid_amount_cents: Number(raw.paid_amount_cents) || 0,
    prepay_applied_cents: Number(raw.prepay_applied_cents) || 0,
    write_off_cents: Number(raw.write_off_cents) || 0,
    total_cost_cents: Number(raw.total_cost_cents) || 0,
    balance_cents: raw.balance_cents,
    invoice_date: raw.invoice_date,
    // Forward the server-computed send suppression flag so the "don't email a $0 split
    // child" gate can actually fire (Codex P2 #10). Undefined before the column is live
    // (LIST_SELECT uses `*`), which the gate reads as "not suppressed" — current behavior.
    send_disposition: raw.send_disposition ?? null,
    search_blob,
  };
}

export interface FieldInvoiceListFilters {
  /** Invoice-number substring (case-insensitive). */
  invoiceNumber: string;
  /** Selected customer ids (OR within the set; empty = all). */
  customerIds: string[];
  /** Transaction (invoice) date inclusive lower bound (YYYY-MM-DD) or ''. */
  dateFrom: string;
  /** Transaction (invoice) date inclusive upper bound (YYYY-MM-DD) or ''. */
  dateTo: string;
  /** Free-text Search box value. */
  search: string;
}

export const emptyFieldInvoiceFilters: FieldInvoiceListFilters = {
  invoiceNumber: '',
  customerIds: [],
  dateFrom: '',
  dateTo: '',
  search: '',
};

/**
 * Apply the ChemMan filter bar to the list (all conditions AND-combined).
 * Pure — drives the visible table AND the footer totals off the same result.
 */
export function applyFieldInvoiceFilters(
  rows: FieldInvoiceListRow[],
  filters: FieldInvoiceListFilters
): FieldInvoiceListRow[] {
  const inv = filters.invoiceNumber.trim().toLowerCase();
  const search = filters.search.trim().toLowerCase();
  const custSet = new Set(filters.customerIds);

  return rows.filter((row) => {
    if (inv && !row.invoice_number.toLowerCase().includes(inv)) return false;
    if (custSet.size > 0 && !custSet.has(row.customer_id)) return false;
    // invoice_date is YYYY-MM-DD; lexical compare is a correct date compare.
    if (filters.dateFrom && row.invoice_date < filters.dateFrom) return false;
    if (filters.dateTo && row.invoice_date > filters.dateTo) return false;
    if (search && !row.search_blob.includes(search)) return false;
    return true;
  });
}

export interface FieldInvoiceTotals {
  /** Sum of acres across the displayed rows. */
  totalAcres: number;
  /** Sum of total_amount_cents (integer cents). */
  totalAmountCents: number;
  /** Number of invoices displayed. */
  count: number;
}

/** Footer totals across the displayed rows. Cents summed as integers. */
export function computeFieldInvoiceTotals(rows: FieldInvoiceListRow[]): FieldInvoiceTotals {
  let totalAcres = 0;
  let totalAmountCents = 0;
  for (const row of rows) {
    totalAcres += Number(row.total_acres) || 0;
    totalAmountCents += row.total_amount_cents;
  }
  return { totalAcres, totalAmountCents, count: rows.length };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Posted-list scope selector (#23) — Season / Month-to-date / monthly batch.
 *
 * A posted field-app invoice has NO accounting_period_id FK; the "batch" it
 * belongs to is the CALENDAR MONTH of its invoice_date (close_accounting_period
 * keys the month-end batch off date_trunc('month', invoice_date)). So a "batch"
 * here is one YYYY-MM month. The Season scope is the whole season already
 * windowed by the query; MTD is the current calendar month; a batch scope picks
 * one specific month. All scope filtering is pure + client-side so the footer
 * totals reflect exactly what's shown.
 * ────────────────────────────────────────────────────────────────────────── */

/** The selected scope: whole season, month-to-date, or one YYYY-MM batch. */
export type PostedScope =
  | { kind: 'season' }
  | { kind: 'mtd' }
  | { kind: 'batch'; month: string }; // month = 'YYYY-MM'

export const defaultPostedScope: PostedScope = { kind: 'season' };

/** The YYYY-MM batch month for an invoice_date (the calendar month it posts into). */
export function batchMonthOf(invoiceDate: string): string {
  // invoice_date is 'YYYY-MM-DD'; the batch is its leading 'YYYY-MM'.
  return invoiceDate.slice(0, 7);
}

/** Current calendar month as 'YYYY-MM' (for the Month-to-date scope). */
export function currentBatchMonth(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export interface MonthBatch {
  /** 'YYYY-MM'. */
  month: string;
  /** Human label e.g. 'June 2026'. */
  label: string;
  /** Number of posted invoices in the batch (within the loaded set). */
  count: number;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Human label for a 'YYYY-MM' month, e.g. '2026-06' -> 'June 2026'. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  const idx = Number(m) - 1;
  const name = MONTH_NAMES[idx] ?? month;
  return `${name} ${y}`;
}

/**
 * Distinct monthly batches present in the rows, newest first, each with its
 * posted-invoice count. Drives the Season/Batch/MTD dropdown options.
 */
export function deriveMonthBatches(rows: FieldInvoiceListRow[]): MonthBatch[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.invoice_date) continue;
    const month = batchMonthOf(r.invoice_date);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([month, count]) => ({ month, label: monthLabel(month), count }))
    // 'YYYY-MM' sorts lexically = chronologically; newest batch first.
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}

/**
 * Narrow rows to the selected scope. Season = no narrowing (already windowed by
 * the query); MTD = only the current calendar month; batch = only that YYYY-MM.
 * Pure — the same result drives the table AND the footer totals.
 */
export function applyPostedScope(
  rows: FieldInvoiceListRow[],
  scope: PostedScope,
  now: Date = new Date()
): FieldInvoiceListRow[] {
  if (scope.kind === 'season') return rows;
  const target = scope.kind === 'mtd' ? currentBatchMonth(now) : scope.month;
  return rows.filter((r) => r.invoice_date && batchMonthOf(r.invoice_date) === target);
}

/**
 * True when the given rows span MORE THAN ONE monthly batch. Drives the dynamic
 * caution that an Unpost All / bulk action would touch multiple month-end batch
 * totals (each must be re-reconciled/reprinted), distinct from the always-on
 * posted-records warning banner.
 */
export function spansMultipleBatches(rows: FieldInvoiceListRow[]): boolean {
  const months = new Set<string>();
  for (const r of rows) {
    if (r.invoice_date) months.add(batchMonthOf(r.invoice_date));
    if (months.size > 1) return true;
  }
  return false;
}
