/**
 * Pure reconciliation check functions — extracted from src/lib/reconciliation.ts
 *
 * These are copies of the PURE functions and types only, avoiding the
 * `import { supabase } from './db'` that would fail in Playwright's
 * Node.js context (import.meta.env is Vite-only).
 */

// ─── Types ────────────────────────────────────────────────────────

export interface Discrepancy {
  check: string;
  entity: string;
  entityId: string;
  expected: number;
  actual: number;
  delta: number;
}

export interface OrderRow {
  id: string;
  order_number: string;
  total_price: number;
}

export interface OrderItemRow {
  order_id: string;
  total_units_needed: number;
  price_per_unit: number;
}

export interface InventoryRow {
  id: string;
  product_id: string;
  product_name: string;
  quantity_available: number;
}

export interface InventoryTransactionRow {
  product_id: string;
  transaction_type: 'received' | 'booked' | 'delivered' | 'returned' | 'adjusted' | 'transferred';
  quantity: number;
}

export interface InvoiceRow {
  id: string;
  invoice_number: string;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  total_amount_cents: number;
  balance_cents: number;
}

export interface PaymentAllocationRow {
  invoice_id: string;
  amount_cents: number;
}

export interface CommissionRow {
  /** NULL on job-sourced rows (U8) — exactly one of order_id/job_id is set. */
  order_id: string | null;
  /** NULL on order-sourced rows. */
  job_id?: string | null;
  /** U8: the minting invoice — job rows group per GENERATION. */
  invoice_id?: string | null;
  /** Cancelled rows are excluded from split-sum grouping (void→re-invoice leaves them). */
  status?: string | null;
  order_number: string;
  split_percentage: number;
}

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

export interface InventoryPrebookRow {
  id: string;
  product_id: string;
  quantity_prebooked: number;
}

export interface OrderItemRemainingRow {
  product_id: string;
  quantity_remaining: number;
}

export interface ReturnCheckRow {
  id: string;
  return_number: string;
  status: string;
  credit_invoice_id: string | null;
}

export interface CustomerARInvoiceRow {
  id: string;
  invoice_number: string;
  customer_id: string;
  balance_cents: number | null;
  status: string;
}

// ─── Constants ────────────────────────────────────────────────────

const TOLERANCE_CENTS = 1;
const TOLERANCE_QTY = 0.01;
const ACTIVE_QUOTE_STATUSES = new Set(['draft', 'sent', 'revised']);

// ─── Pure Check Functions ─────────────────────────────────────────

export function checkOrderTotals(
  orders: OrderRow[],
  items: OrderItemRow[],
): Discrepancy[] {
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
      (sum, i) => sum + Math.round(i.total_units_needed * i.price_per_unit * 100),
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

export function checkInventoryLedger(
  inventory: InventoryRow[],
  transactions: InventoryTransactionRow[],
): Discrepancy[] {
  const expectedByProduct = new Map<string, number>();
  for (const tx of transactions) {
    const current = expectedByProduct.get(tx.product_id) ?? 0;
    let delta: number;
    switch (tx.transaction_type) {
      case 'received':
      case 'returned':
        delta = Math.abs(tx.quantity);
        break;
      case 'delivered':
      case 'booked':
        delta = -Math.abs(tx.quantity);
        break;
      case 'adjusted':
      case 'transferred':
        delta = tx.quantity;
        break;
      default:
        delta = 0;
    }
    expectedByProduct.set(tx.product_id, current + delta);
  }

  const issues: Discrepancy[] = [];
  for (const inv of inventory) {
    const expectedQty = expectedByProduct.get(inv.product_id);
    if (expectedQty === undefined) continue;
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

export function checkInvoicePayments(
  invoices: InvoiceRow[],
  allocations: PaymentAllocationRow[],
): Discrepancy[] {
  const allocByInvoice = new Map<string, number>();
  for (const alloc of allocations) {
    const current = allocByInvoice.get(alloc.invoice_id) ?? 0;
    allocByInvoice.set(alloc.invoice_id, current + alloc.amount_cents);
  }

  const issues: Discrepancy[] = [];
  for (const inv of invoices) {
    const allocTotal = allocByInvoice.get(inv.id) ?? 0;
    if (Math.abs(inv.paid_amount_cents - allocTotal) > TOLERANCE_CENTS) {
      issues.push({
        check: 'invoice_payments',
        entity: inv.invoice_number,
        entityId: inv.id,
        expected: allocTotal,
        actual: inv.paid_amount_cents,
        delta: Math.abs(inv.paid_amount_cents - allocTotal),
      });
    }
  }
  return issues;
}

export function checkInvoiceBalances(invoices: InvoiceRow[]): Discrepancy[] {
  const issues: Discrepancy[] = [];
  for (const inv of invoices) {
    const expected = inv.total_amount_cents - inv.paid_amount_cents - inv.prepay_applied_cents;
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

export function checkCommissionSplits(commissions: CommissionRow[]): Discrepancy[] {
  // U8 (2026-07-06, mirror of src/lib/reconciliation.ts): key on the lineage-
  // qualified id (job rows have order_id NULL — a raw key would collapse every
  // job into one `null` bucket), and skip cancelled generations left behind by
  // a void→re-invoice cycle so a healthy job isn't reported as a 200% split.
  const byOrder = new Map<string, { orderNumber: string; totalPct: number }>();
  // Codex R8/R9 P2 (mirror of src/lib/reconciliation.ts): generation keying + a
  // bucket with ANY cancelled row is a reversal artifact and is excluded whole.
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

export function checkQuoteHoldParity(
  quotes: QuoteHoldRow[],
  holds: HoldRow[],
): Discrepancy[] {
  const sourceIdsWithActiveHold = new Set<string>();
  for (const h of holds) {
    if (h.is_active) sourceIdsWithActiveHold.add(h.source_id);
  }

  const issues: Discrepancy[] = [];
  for (const q of quotes) {
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

export function checkDeliveryInvoiceQuantityParity(
  deliveryItems: DeliveryItemCheckRow[],
  invoiceItems: InvoiceItemCheckRow[],
): Discrepancy[] {
  const deliveredByKey = new Map<string, number>();
  for (const di of deliveryItems) {
    if (!di.order_id || !di.product_id) continue;
    const key = `${di.order_id}::${di.product_id}`;
    deliveredByKey.set(key, (deliveredByKey.get(key) ?? 0) + di.quantity_delivered);
  }

  const invoicedByKey = new Map<string, number>();
  for (const ii of invoiceItems) {
    if (ii.invoice_type === 'credit_memo') continue;
    if (!ii.order_id || !ii.product_id) continue;
    const key = `${ii.order_id}::${ii.product_id}`;
    invoicedByKey.set(key, (invoicedByKey.get(key) ?? 0) + ii.quantity);
  }

  const issues: Discrepancy[] = [];
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

export function checkPrebookedInventory(
  inventory: InventoryPrebookRow[],
  orderItems: OrderItemRemainingRow[],
): Discrepancy[] {
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

export function checkReturnCreditLinkage(returns: ReturnCheckRow[]): Discrepancy[] {
  const issues: Discrepancy[] = [];
  for (const r of returns) {
    if (r.status !== 'credited') continue;
    if (!r.credit_invoice_id) {
      issues.push({
        check: 'return_credit_linkage',
        entity: r.return_number,
        entityId: r.id,
        expected: 1,
        actual: 0,
        delta: 1,
      });
    }
  }
  return issues;
}

export function checkCustomerARConsistency(
  invoices: CustomerARInvoiceRow[],
): Discrepancy[] {
  const issues: Discrepancy[] = [];
  for (const inv of invoices) {
    if (inv.status === 'void') continue;
    if (inv.balance_cents === null || inv.balance_cents === undefined) {
      issues.push({
        check: 'customer_ar_consistency',
        entity: inv.invoice_number,
        entityId: inv.id,
        expected: 0,
        actual: -1,
        delta: 1,
      });
    }
  }
  return issues;
}
