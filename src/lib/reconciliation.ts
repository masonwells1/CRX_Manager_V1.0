/**
 * reconciliation.ts — Cross-entity data integrity checks
 *
 * Pure computation functions that detect drift between related tables.
 * Each check takes pre-fetched data and returns a list of discrepancies.
 *
 * Usage:
 *   const report = await runReconciliationChecks();
 *   if (report.totalDiscrepancies > 0) { ... }
 *
 * Design:
 *   - Pure functions are testable without DB mocks
 *   - DB wrappers are thin and only fetch + delegate
 *   - All money values are in cents (bigint-safe integers)
 *   - Tolerance of ±1 cent for floating-point rounding
 */

import { supabase } from './db';

// ─── Types ────────────────────────────────────────────────────────

export interface Discrepancy {
  /** Which check found the issue */
  check: string;
  /** Human-readable entity identifier (order number, product name, etc.) */
  entity: string;
  /** Entity UUID for linking */
  entityId: string;
  /** What was expected */
  expected: number;
  /** What was found */
  actual: number;
  /** Absolute difference */
  delta: number;
}

export interface ReconciliationReport {
  /** When the checks were run */
  timestamp: string;
  /** Per-check results */
  checks: CheckResult[];
  /** Total across all checks */
  totalDiscrepancies: number;
}

export interface CheckResult {
  name: string;
  description: string;
  passed: boolean;
  discrepancies: Discrepancy[];
  /** How many entities were checked */
  entitiesChecked: number;
}

// ─── Constants ────────────────────────────────────────────────────

/** Tolerate ±1 cent for floating-point rounding in dollar→cents conversions */
const TOLERANCE_CENTS = 1;

// ─── Pure Check Functions ─────────────────────────────────────────

/**
 * Check 1: Order totals vs line-item sums
 *
 * For each order, SUM(quantity × price_per_unit) across order_items
 * should equal the order total. Detects truncation bugs and manual edits.
 */
export interface OrderRow {
  id: string;
  order_number: string;
  total_price: number; // dollars
}

export interface OrderItemRow {
  order_id: string;
  total_price: number; // dollars — per-line extended total
}

export function checkOrderTotals(
  orders: OrderRow[],
  items: OrderItemRow[],
): Discrepancy[] {
  // Group items by order_id
  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const issues: Discrepancy[] = [];

  for (const order of orders) {
    const orderItems = itemsByOrder.get(order.id) ?? [];
    const computedCents = orderItems.reduce(
      (sum, i) => sum + Math.round(i.total_price * 100),
      0,
    );
    const storedCents = Math.round(order.total_price * 100);

    if (Math.abs(storedCents - computedCents) > TOLERANCE_CENTS) {
      issues.push({
        check: 'order_totals',
        entity: order.order_number,
        entityId: order.id,
        expected: computedCents,
        actual: storedCents,
        delta: Math.abs(storedCents - computedCents),
      });
    }
  }

  return issues;
}

/**
 * Check 2: Inventory ledger balance
 *
 * For each product, the current quantity_available should equal:
 *   SUM(received) - SUM(delivered) + SUM(returned) ± adjustments
 *
 * NOTE: This is an approximation because the initial inventory
 * load is also an "adjustment". We compare against the transaction
 * ledger running total.
 */
export interface InventoryRow {
  id: string;
  product_id: string;
  product_name: string;
  quantity_available: number;
}

export interface InventoryTransactionRow {
  product_id: string;
  transaction_type:
    | 'received'
    | 'booked'
    | 'delivered'
    | 'returned'
    | 'adjusted'
    | 'transferred'
    | 'job_applied'
    | 'cancelled_delivery_reversal'
    | 'void_delivery_reversal'
    | 'prebooked'
    | 'released'
    | 'prebook_reconciliation';
  quantity: number; // signed: positive = add, negative = subtract (for adjustments)
}

export function checkInventoryLedger(
  inventory: InventoryRow[],
  transactions: InventoryTransactionRow[],
): Discrepancy[] {
  // Build expected quantity_available from transactions.
  //
  // Only transactions that affect quantity_available are counted.
  // Transactions that affect quantity_prebooked (booked, prebooked,
  // released) are excluded — they don't change the available count.
  const expectedByProduct = new Map<string, number>();

  for (const tx of transactions) {
    const current = expectedByProduct.get(tx.product_id) ?? 0;
    let delta: number;

    switch (tx.transaction_type) {
      // ── Add to quantity_available ──
      case 'received':
      case 'returned':
      case 'cancelled_delivery_reversal':
      case 'void_delivery_reversal':
        delta = Math.abs(tx.quantity);
        break;

      // ── Subtract from quantity_available ──
      case 'delivered':
      case 'job_applied':
        delta = -Math.abs(tx.quantity);
        break;

      // ── Signed: positive = add, negative = subtract ──
      case 'adjusted':
      case 'transferred':
        delta = tx.quantity;
        break;

      // ── Affect quantity_prebooked, NOT quantity_available ──
      case 'booked':
      case 'prebooked':
      case 'released':
      case 'prebook_reconciliation':
        delta = 0;
        break;

      default:
        delta = 0;
    }

    expectedByProduct.set(tx.product_id, current + delta);
  }

  const issues: Discrepancy[] = [];

  for (const inv of inventory) {
    const expectedQty = expectedByProduct.get(inv.product_id);
    // If no transactions exist, we can't verify (initial load only)
    if (expectedQty === undefined) continue;

    // Use whole-number comparison (quantities may have decimals for liquid)
    const diff = Math.abs(inv.quantity_available - expectedQty);
    if (diff > 0.01) {
      issues.push({
        check: 'inventory_ledger',
        entity: inv.product_name,
        entityId: inv.id,
        expected: Math.round(expectedQty * 100) / 100,
        actual: inv.quantity_available,
        delta: Math.round(diff * 100) / 100,
      });
    }
  }

  return issues;
}

/**
 * Check 3: Invoice payment integrity
 *
 * For each posted invoice, paid_amount_cents should equal the sum of
 * all payment allocations referencing that invoice.
 */
export interface InvoiceRow {
  id: string;
  invoice_number: string;
  order_id: string;
  invoice_type: string;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  write_off_cents: number;
  credit_applied_cents: number;
  total_amount_cents: number;
  balance_cents: number;
}

/**
 * Source of truth for "how much has been paid against an invoice" is
 * `invoice_line_allocations.amount_cents` (written by allocate_payment in
 * Phase 14). The legacy `payments.amount` is kept for historical and
 * order-level reporting but is not always in sync per-invoice when an
 * order has multiple invoices or grower-share splits.
 */
export interface InvoiceLineAllocationRow {
  invoice_id: string;
  amount_cents: number;
}

export function checkInvoicePayments(
  invoices: InvoiceRow[],
  allocations: InvoiceLineAllocationRow[],
): Discrepancy[] {
  // Sum allocation cents per invoice_id (source of truth from allocate_payment)
  const allocatedByInvoice = new Map<string, number>();
  for (const a of allocations) {
    const current = allocatedByInvoice.get(a.invoice_id) ?? 0;
    allocatedByInvoice.set(a.invoice_id, current + a.amount_cents);
  }

  const issues: Discrepancy[] = [];

  // For each posted invoice, sum of allocations should equal paid_amount_cents
  for (const inv of invoices) {
    const allocatedTotal = allocatedByInvoice.get(inv.id) ?? 0;
    if (Math.abs(inv.paid_amount_cents - allocatedTotal) > TOLERANCE_CENTS) {
      issues.push({
        check: 'invoice_payments',
        entity: inv.invoice_number,
        entityId: inv.id,
        expected: allocatedTotal,
        actual: inv.paid_amount_cents,
        delta: Math.abs(inv.paid_amount_cents - allocatedTotal),
      });
    }
  }

  return issues;
}

/**
 * Check 4: Generated balance column integrity
 *
 * For each invoice, balance_cents should equal (type-aware, 5 levers since mig 20260711020000):
 *   (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)
 *     + (invoice_type === 'credit_memo' ? +credit_applied_cents : -credit_applied_cents)
 *
 * (PR-09 fix: write_off_cents was missing from the formula, causing every
 * written-off invoice to be flagged as a balance discrepancy.)
 * (credit-memo apply: credit_applied_cents is the 5th lever — consumes a memo, reduces an invoice.)
 *
 * Since this is a GENERATED ALWAYS column in Postgres, a mismatch
 * would indicate a catastrophic DB issue. This is a sanity check.
 */
export function checkInvoiceBalances(invoices: InvoiceRow[]): Discrepancy[] {
  const issues: Discrepancy[] = [];

  for (const inv of invoices) {
    const expected = inv.total_amount_cents - inv.paid_amount_cents - inv.prepay_applied_cents - inv.write_off_cents
      + (inv.invoice_type === 'credit_memo' ? inv.credit_applied_cents : -inv.credit_applied_cents);
    if (Math.abs(inv.balance_cents - expected) > TOLERANCE_CENTS) {
      issues.push({
        check: 'invoice_balance_formula',
        entity: inv.invoice_number,
        entityId: inv.id,
        expected,
        actual: inv.balance_cents,
        delta: Math.abs(inv.balance_cents - expected),
      });
    }
  }

  return issues;
}

/**
 * Check 5: Commission splits sum to 100%
 *
 * For each order with commissions, the split percentages should
 * sum to exactly 100. Detects corruption from manual edits.
 */
export interface CommissionRow {
  /** NULL on job-sourced rows (U8) — exactly one of order_id/job_id is set. */
  order_id: string | null;
  /** NULL on order-sourced rows. */
  job_id?: string | null;
  /** U8: the minting invoice — job rows group per GENERATION (a paid row that
   *  survived a void plus the re-invoice's fresh set must not share a bucket). */
  invoice_id?: string | null;
  /** Codex R1 P2: cancelled rows are excluded from split-sum grouping. */
  status?: string | null;
  order_number: string;
  split_percentage: number;
}

export function checkCommissionSplits(commissions: CommissionRow[]): Discrepancy[] {
  // Group by source entity. U8: job-sourced commissions have order_id NULL, so a
  // raw order_id key would collapse EVERY job's rows into one `null` bucket and
  // sum unrelated jobs' percentages — key on the lineage-qualified id instead.
  const byOrder = new Map<string, { orderNumber: string; totalPct: number }>();

  // Codex R8/R9 P2: job rows key on the minting invoice (the GENERATION) — a paid
  // row that survived a void shares job_id with the re-invoice's fresh set but
  // never its invoice_id. And a generation containing ANY cancelled row is a
  // reversal artifact (fully-cancelled, or paid-survivor + cancelled siblings on
  // both channels) — its live remainder legitimately totals less than 100, so the
  // whole bucket is excluded from the 100% identity rather than misreported.
  const keyOf = (c: CommissionRow): string =>
    c.order_id
      ?? (c.invoice_id ? `jobinv:${c.invoice_id}` : c.job_id ? `job:${c.job_id}` : 'unlinked');

  const reversedBuckets = new Set<string>();
  for (const c of commissions) {
    if (c.status === 'cancelled') reversedBuckets.add(keyOf(c));
  }

  for (const c of commissions) {
    const key = keyOf(c);
    if (reversedBuckets.has(key)) continue;
    const entry = byOrder.get(key) ?? { orderNumber: c.order_number, totalPct: 0 };
    entry.totalPct += c.split_percentage;
    byOrder.set(key, entry);
  }

  const issues: Discrepancy[] = [];

  for (const [orderId, entry] of byOrder) {
    if (Math.abs(entry.totalPct - 100) > 0.01) {
      issues.push({
        check: 'commission_splits',
        entity: entry.orderNumber,
        entityId: orderId,
        expected: 100,
        actual: Math.round(entry.totalPct * 100) / 100,
        delta: Math.round(Math.abs(entry.totalPct - 100) * 100) / 100,
      });
    }
  }

  return issues;
}

// ─── Check 6–10: New Cross-Entity Integrity Checks ──────────────

/** Tolerance for quantity comparisons (e.g. liquid measure rounding) */
const TOLERANCE_QTY = 0.01;

/**
 * Check 6: Quote-Hold Parity
 *
 * Every planned quote in an active status (draft/sent/revised) should
 * have at least one active inventory hold. Missing holds mean reserved
 * inventory isn't actually locked.
 */
export interface QuoteHoldRow {
  id: string;
  quote_number: string;
  is_planned: boolean;
  status: string;
}

export interface HoldRow {
  source_id: string;
  is_active: boolean;
}

const ACTIVE_QUOTE_STATUSES = new Set(['draft', 'sent', 'revised']);

export function checkQuoteHoldParity(
  quotes: QuoteHoldRow[],
  holds: HoldRow[],
): Discrepancy[] {
  // Build set of source_ids that have at least one active hold
  const sourceIdsWithActiveHold = new Set<string>();
  for (const h of holds) {
    if (h.is_active) {
      sourceIdsWithActiveHold.add(h.source_id);
    }
  }

  const issues: Discrepancy[] = [];

  for (const q of quotes) {
    // Only check planned quotes in active statuses
    if (!q.is_planned || !ACTIVE_QUOTE_STATUSES.has(q.status)) continue;

    if (!sourceIdsWithActiveHold.has(q.id)) {
      issues.push({
        check: 'quote_hold_parity',
        entity: q.quote_number,
        entityId: q.id,
        expected: 1,
        actual: 0,
        delta: 1,
      });
    }
  }

  return issues;
}

/**
 * Check 7: Delivery-Invoice Quantity Parity
 *
 * For each order+product combination, total delivered quantity should
 * approximately match total invoiced quantity. A large mismatch means
 * product was delivered but not billed (or vice versa).
 */
export interface DeliveryItemCheckRow {
  order_id: string;
  product_id: string;
  quantity_delivered: number;
}

export interface InvoiceItemCheckRow {
  order_id: string;
  product_id: string;
  quantity: number;
  invoice_type: string;
}

export function checkDeliveryInvoiceQuantityParity(
  deliveryItems: DeliveryItemCheckRow[],
  invoiceItems: InvoiceItemCheckRow[],
): Discrepancy[] {
  // Sum delivered quantity per order+product
  const deliveredByKey = new Map<string, number>();
  for (const di of deliveryItems) {
    if (!di.order_id || !di.product_id) continue;
    const key = `${di.order_id}::${di.product_id}`;
    deliveredByKey.set(key, (deliveredByKey.get(key) ?? 0) + di.quantity_delivered);
  }

  // Sum invoiced quantity per order+product
  const invoicedByKey = new Map<string, number>();
  for (const ii of invoiceItems) {
    // Return credits now carry negative invoice_items for revenue/COGS reporting.
    // They are not additional billing against delivered quantity.
    if (ii.invoice_type === 'credit_memo') continue;
    if (!ii.order_id || !ii.product_id) continue;
    const key = `${ii.order_id}::${ii.product_id}`;
    invoicedByKey.set(key, (invoicedByKey.get(key) ?? 0) + ii.quantity);
  }

  const issues: Discrepancy[] = [];

  // Check all keys that appear in either map
  const allKeys = new Set([...deliveredByKey.keys(), ...invoicedByKey.keys()]);

  for (const key of allKeys) {
    const delivered = deliveredByKey.get(key) ?? 0;
    const invoiced = invoicedByKey.get(key) ?? 0;
    const diff = Math.abs(delivered - invoiced);

    if (diff > TOLERANCE_QTY) {
      const [orderId, productId] = key.split('::');
      issues.push({
        check: 'delivery_invoice_qty_parity',
        entity: `Order ${orderId.slice(0, 8)}… / Product ${productId.slice(0, 8)}…`,
        entityId: orderId,
        expected: Math.round(delivered * 100) / 100,
        actual: Math.round(invoiced * 100) / 100,
        delta: Math.round(diff * 100) / 100,
      });
    }
  }

  return issues;
}

/**
 * Check 8: Pre-booked Inventory Consistency
 *
 * Per product, quantity_prebooked on inventory should approximately
 * match the sum of quantity_remaining across open order items.
 */
export interface InventoryPrebookRow {
  id: string;
  product_id: string;
  quantity_prebooked: number;
}

export interface OrderItemRemainingRow {
  product_id: string;
  quantity_remaining: number;
}

export function checkPrebookedInventory(
  inventory: InventoryPrebookRow[],
  orderItems: OrderItemRemainingRow[],
): Discrepancy[] {
  // Sum quantity_remaining per product
  const remainingByProduct = new Map<string, number>();
  for (const oi of orderItems) {
    remainingByProduct.set(
      oi.product_id,
      (remainingByProduct.get(oi.product_id) ?? 0) + oi.quantity_remaining,
    );
  }

  const issues: Discrepancy[] = [];

  for (const inv of inventory) {
    const expectedPrebooked = remainingByProduct.get(inv.product_id) ?? 0;
    const diff = Math.abs(inv.quantity_prebooked - expectedPrebooked);

    if (diff > TOLERANCE_QTY) {
      issues.push({
        check: 'prebooked_inventory',
        entity: `Product ${inv.product_id.slice(0, 8)}…`,
        entityId: inv.id,
        expected: Math.round(expectedPrebooked * 100) / 100,
        actual: Math.round(inv.quantity_prebooked * 100) / 100,
        delta: Math.round(diff * 100) / 100,
      });
    }
  }

  return issues;
}

/**
 * Check 9: Return-Credit Linkage
 *
 * Every return in 'credited' status must have a non-null credit_invoice_id.
 * A credited return without a linked invoice means the credit was never
 * actually issued.
 */
export interface ReturnCheckRow {
  id: string;
  return_number: string;
  status: string;
  credit_invoice_id: string | null;
}

export function checkReturnCreditLinkage(returns: ReturnCheckRow[]): Discrepancy[] {
  const issues: Discrepancy[] = [];

  for (const r of returns) {
    if (r.status !== 'credited') continue;

    if (!r.credit_invoice_id) {
      issues.push({
        check: 'return_credit_linkage',
        entity: r.return_number,
        entityId: r.id,
        expected: 1, // should have a credit invoice
        actual: 0,
        delta: 1,
      });
    }
  }

  return issues;
}

/**
 * Check 10: Customer AR Consistency
 *
 * Verifies no non-voided invoice has a NULL balance_cents, which would
 * indicate a data integrity issue in the AR ledger.
 */
export interface CustomerARInvoiceRow {
  id: string;
  invoice_number: string;
  customer_id: string;
  balance_cents: number | null;
  status: string;
}

export function checkCustomerARConsistency(
  invoices: CustomerARInvoiceRow[],
): Discrepancy[] {
  const issues: Discrepancy[] = [];

  for (const inv of invoices) {
    // Skip voided invoices
    if (inv.status === 'voided') continue;

    if (inv.balance_cents === null || inv.balance_cents === undefined) {
      issues.push({
        check: 'customer_ar_consistency',
        entity: inv.invoice_number,
        entityId: inv.id,
        expected: 0, // should have a numeric balance
        actual: -1,  // sentinel for NULL
        delta: 1,
      });
    }
  }

  return issues;
}

// ─── DB Wrapper ───────────────────────────────────────────────────

/**
 * Runs all reconciliation checks against the live database.
 *
 * Returns a structured report with pass/fail per check and
 * details on every discrepancy found.
 */
export async function runReconciliationChecks(): Promise<ReconciliationReport> {
  const checks: CheckResult[] = [];

  // ── Check 1: Order totals ──────────────────────────────────────
  try {
    const [ordersRes, itemsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('id, order_number, total_price')
        .not('total_price', 'is', null),
      supabase
        .from('order_items')
        .select('order_id, total_price'),
    ]);

    if (ordersRes.error) throw new Error(`Orders query failed: ${ordersRes.error.message}`);
    if (itemsRes.error) throw new Error(`Order items query failed: ${itemsRes.error.message}`);
    const orders = (ordersRes.data ?? []) as OrderRow[];
    const items = (itemsRes.data ?? []) as OrderItemRow[];
    const disc = checkOrderTotals(orders, items);

    checks.push({
      name: 'Order Totals',
      description: 'Order total matches the sum of its line-item totals',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: orders.length,
    });
  } catch (err) {
    checks.push({
      name: 'Order Totals',
      description: `Order total matches the sum of its line-item totals [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 2: Inventory ledger ──────────────────────────────────
  try {
    const [invRes, txRes] = await Promise.all([
      supabase
        .from('inventory')
        .select('id, product_id, quantity_available, products(product_name)')
        .not('quantity_available', 'is', null),
      supabase
        .from('inventory_transactions')
        .select('product_id, transaction_type, quantity'),
    ]);

    if (invRes.error) throw new Error(`Inventory query failed: ${invRes.error.message}`);
    if (txRes.error) throw new Error(`Inventory transactions query failed: ${txRes.error.message}`);
    const inventory = (invRes.data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      product_id: r.product_id as string,
      product_name: (r.products as Record<string, unknown>)?.product_name as string ?? 'Unknown',
      quantity_available: r.quantity_available as number,
    }));
    const transactions = (txRes.data ?? []) as InventoryTransactionRow[];
    const disc = checkInventoryLedger(inventory, transactions);

    checks.push({
      name: 'Inventory Ledger',
      description: 'Inventory quantity matches transaction history running total',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: inventory.length,
    });
  } catch (err) {
    checks.push({
      name: 'Inventory Ledger',
      description: `Inventory quantity matches transaction history running total [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 3 & 4: Invoice payments + balance formula ────────────
  try {
    const [invoiceRes, allocRes] = await Promise.all([
      supabase
        .from('invoices')
        .select('id, invoice_number, order_id, invoice_type, paid_amount_cents, prepay_applied_cents, write_off_cents, credit_applied_cents, total_amount_cents, balance_cents')
        .eq('status', 'posted')
        .is('deleted_at', null),
      supabase
        .from('invoice_line_allocations')
        .select('invoice_id, amount_cents'),
    ]);

    if (invoiceRes.error) throw new Error(`Invoices query failed: ${invoiceRes.error.message}`);
    if (allocRes.error) throw new Error(`Allocations query failed: ${allocRes.error.message}`);
    const invoices = (invoiceRes.data ?? []) as InvoiceRow[];
    const allocations = (allocRes.data ?? []) as InvoiceLineAllocationRow[];

    const payDisc = checkInvoicePayments(invoices, allocations);
    checks.push({
      name: 'Invoice Payments',
      description: 'Invoice paid_amount_cents matches SUM of invoice_line_allocations.amount_cents (source of truth from allocate_payment)',
      passed: payDisc.length === 0,
      discrepancies: payDisc,
      entitiesChecked: invoices.length,
    });

    const balDisc = checkInvoiceBalances(invoices);
    checks.push({
      name: 'Invoice Balance Formula',
      description: 'balance_cents = total - paid - prepay (GENERATED ALWAYS sanity check)',
      passed: balDisc.length === 0,
      discrepancies: balDisc,
      entitiesChecked: invoices.length,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'Invoice Payments',
      description: `Invoice paid_amount_cents matches SUM of payments per order [ERROR: ${errMsg}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
    checks.push({
      name: 'Invoice Balance Formula',
      description: `balance_cents = total - paid - prepay (GENERATED ALWAYS sanity check) [ERROR: ${errMsg}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 5: Commission splits ─────────────────────────────────
  try {
    const { data, error: commErr } = await supabase
      .from('commissions')
      .select('order_id, job_id, invoice_id, status, order_number, split_percentage');
    if (commErr) throw new Error(`Commissions query failed: ${commErr.message}`);

    const commissions = (data ?? []) as CommissionRow[];
    const disc = checkCommissionSplits(commissions);

    checks.push({
      name: 'Commission Splits',
      description: 'Commission split percentages sum to 100% per order/job',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: new Set(commissions.map((c) => c.order_id ?? `job:${c.job_id}`)).size,
    });
  } catch (err) {
    checks.push({
      name: 'Commission Splits',
      description: `Commission split percentages sum to 100% per order [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 6: Quote-Hold Parity ──────────────────────────────────
  try {
    const [quotesRes, holdsRes] = await Promise.all([
      supabase
        .from('quotes')
        .select('id, quote_number, is_planned, status')
        .is('deleted_at', null),
      supabase
        .from('inventory_holds')
        .select('source_id, is_active'),
    ]);

    if (quotesRes.error) throw new Error(`Quotes query failed: ${quotesRes.error.message}`);
    if (holdsRes.error) throw new Error(`Holds query failed: ${holdsRes.error.message}`);
    const quotes = (quotesRes.data ?? []) as QuoteHoldRow[];
    const holds = (holdsRes.data ?? []) as HoldRow[];
    const disc = checkQuoteHoldParity(quotes, holds);

    checks.push({
      name: 'Quote-Hold Parity',
      description: 'Planned quotes in active statuses have at least one active inventory hold',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: quotes.filter((q) => q.is_planned && ACTIVE_QUOTE_STATUSES.has(q.status)).length,
    });
  } catch (err) {
    checks.push({
      name: 'Quote-Hold Parity',
      description: `Planned quotes in active statuses have at least one active inventory hold [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 7: Delivery-Invoice Quantity Parity ───────────────────
  try {
    const [deliveryItemsRes, invoiceItemsRes] = await Promise.all([
      supabase
        .from('delivery_items')
        .select('delivery_id, product_id, quantity_delivered, deliveries(order_id)'),
      supabase
        .from('invoice_items')
        .select('product_id, quantity, invoices(order_id, invoice_type)'),
    ]);

    if (deliveryItemsRes.error) throw new Error(`Delivery items query failed: ${deliveryItemsRes.error.message}`);
    if (invoiceItemsRes.error) throw new Error(`Invoice items query failed: ${invoiceItemsRes.error.message}`);
    const deliveryItems = (deliveryItemsRes.data ?? []).map((r: Record<string, unknown>) => ({
      order_id: (r.deliveries as Record<string, unknown>)?.order_id as string,
      product_id: r.product_id as string,
      quantity_delivered: r.quantity_delivered as number,
    }));
    const invoiceItems = (invoiceItemsRes.data ?? []).map((r: Record<string, unknown>) => ({
      order_id: (r.invoices as Record<string, unknown>)?.order_id as string,
      invoice_type: (r.invoices as Record<string, unknown>)?.invoice_type as string,
      product_id: r.product_id as string,
      quantity: r.quantity as number,
    }));
    const disc = checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems);

    checks.push({
      name: 'Delivery-Invoice Quantity Parity',
      description: 'Total delivered quantity matches total invoiced quantity per order+product',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: new Set([
        ...deliveryItems.map((d) => `${d.order_id}::${d.product_id}`),
        ...invoiceItems.map((i) => `${i.order_id}::${i.product_id}`),
      ]).size,
    });
  } catch (err) {
    checks.push({
      name: 'Delivery-Invoice Quantity Parity',
      description: `Total delivered quantity matches total invoiced quantity per order+product [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 8: Pre-booked Inventory ───────────────────────────────
  try {
    const [invPrebookRes, orderItemsRes] = await Promise.all([
      supabase
        .from('inventory')
        .select('id, product_id, quantity_prebooked'),
      supabase
        .from('order_items')
        .select('product_id, quantity_remaining')
        .gt('quantity_remaining', 0),
    ]);

    if (invPrebookRes.error) throw new Error(`Inventory prebook query failed: ${invPrebookRes.error.message}`);
    if (orderItemsRes.error) throw new Error(`Order items remaining query failed: ${orderItemsRes.error.message}`);
    const inventoryPrebook = (invPrebookRes.data ?? []) as InventoryPrebookRow[];
    const orderItemsRemaining = (orderItemsRes.data ?? []) as OrderItemRemainingRow[];
    const disc = checkPrebookedInventory(inventoryPrebook, orderItemsRemaining);

    checks.push({
      name: 'Pre-booked Inventory',
      description: 'Inventory quantity_prebooked matches SUM of open order quantity_remaining per product',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: inventoryPrebook.length,
    });
  } catch (err) {
    checks.push({
      name: 'Pre-booked Inventory',
      description: `Inventory quantity_prebooked matches SUM of open order quantity_remaining per product [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 9: Return-Credit Linkage ──────────────────────────────
  try {
    const { data: returnsData, error: retErr } = await supabase
      .from('returns')
      .select('id, return_number, status, credit_invoice_id')
      .is('deleted_at', null);
    if (retErr) throw new Error(`Returns query failed: ${retErr.message}`);

    const returns = (returnsData ?? []) as ReturnCheckRow[];
    const disc = checkReturnCreditLinkage(returns);

    checks.push({
      name: 'Return-Credit Linkage',
      description: 'Credited returns have a linked credit invoice',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: returns.filter((r) => r.status === 'credited').length,
    });
  } catch (err) {
    checks.push({
      name: 'Return-Credit Linkage',
      description: `Credited returns have a linked credit invoice [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 10: Customer AR Consistency ───────────────────────────
  try {
    const { data: arInvoiceData, error: arErr } = await supabase
      .from('invoices')
      .select('id, invoice_number, customer_id, balance_cents, status')
      .is('deleted_at', null);
    if (arErr) throw new Error(`AR invoices query failed: ${arErr.message}`);

    const arInvoices = (arInvoiceData ?? []) as CustomerARInvoiceRow[];
    const disc = checkCustomerARConsistency(arInvoices);

    checks.push({
      name: 'Customer AR Consistency',
      description: 'Non-voided invoices have non-null balance_cents',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: arInvoices.filter((i) => i.status !== 'voided').length,
    });
  } catch (err) {
    checks.push({
      name: 'Customer AR Consistency',
      description: `Non-voided invoices have non-null balance_cents [ERROR: ${err instanceof Error ? err.message : String(err)}]`,
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    checks,
    totalDiscrepancies: checks.reduce((sum, c) => sum + c.discrepancies.length, 0),
  };
}
