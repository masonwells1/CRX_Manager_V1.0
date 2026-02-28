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
  total_amount: number; // dollars
}

export interface OrderItemRow {
  order_id: string;
  quantity: number;
  price_per_unit: number; // dollars
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
      (sum, i) => sum + Math.round(i.quantity * i.price_per_unit * 100),
      0,
    );
    const storedCents = Math.round(order.total_amount * 100);

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
  transaction_type: 'received' | 'booked' | 'delivered' | 'returned' | 'adjusted' | 'transferred';
  quantity: number; // signed: positive = add, negative = subtract (for adjustments)
}

export function checkInventoryLedger(
  inventory: InventoryRow[],
  transactions: InventoryTransactionRow[],
): Discrepancy[] {
  // Build expected quantity from transactions
  // Convention: received/returned add, delivered subtracts, adjusted is signed
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
        // adjusted quantity is signed: positive = add, negative = subtract
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
  paid_amount_cents: number;
  prepay_applied_cents: number;
  total_amount_cents: number;
  balance_cents: number;
}

export interface PaymentAllocationRow {
  invoice_id: string;
  amount_cents: number;
}

export function checkInvoicePayments(
  invoices: InvoiceRow[],
  allocations: PaymentAllocationRow[],
): Discrepancy[] {
  // Sum allocations per invoice
  const allocByInvoice = new Map<string, number>();
  for (const alloc of allocations) {
    const current = allocByInvoice.get(alloc.invoice_id) ?? 0;
    allocByInvoice.set(alloc.invoice_id, current + alloc.amount_cents);
  }

  const issues: Discrepancy[] = [];

  for (const inv of invoices) {
    const allocTotal = allocByInvoice.get(inv.id) ?? 0;
    // paid_amount_cents should equal sum of allocations
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

/**
 * Check 4: Generated balance column integrity
 *
 * For each invoice, balance_cents should equal:
 *   total_amount_cents - paid_amount_cents - prepay_applied_cents
 *
 * Since this is a GENERATED ALWAYS column in Postgres, a mismatch
 * would indicate a catastrophic DB issue. This is a sanity check.
 */
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

/**
 * Check 5: Commission splits sum to 100%
 *
 * For each order with commissions, the split percentages should
 * sum to exactly 100. Detects corruption from manual edits.
 */
export interface CommissionRow {
  order_id: string;
  order_number: string;
  split_percentage: number;
}

export function checkCommissionSplits(commissions: CommissionRow[]): Discrepancy[] {
  // Group by order
  const byOrder = new Map<string, { orderNumber: string; totalPct: number }>();

  for (const c of commissions) {
    const entry = byOrder.get(c.order_id) ?? { orderNumber: c.order_number, totalPct: 0 };
    entry.totalPct += c.split_percentage;
    byOrder.set(c.order_id, entry);
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
        .select('id, order_number, total_amount')
        .not('total_amount', 'is', null),
      supabase
        .from('order_items')
        .select('order_id, quantity, price_per_unit'),
    ]);

    const orders = (ordersRes.data ?? []) as OrderRow[];
    const items = (itemsRes.data ?? []) as OrderItemRow[];
    const disc = checkOrderTotals(orders, items);

    checks.push({
      name: 'Order Totals',
      description: 'Order total matches SUM(qty × price) of line items',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: orders.length,
    });
  } catch {
    checks.push({
      name: 'Order Totals',
      description: 'Order total matches SUM(qty × price) of line items',
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
  } catch {
    checks.push({
      name: 'Inventory Ledger',
      description: 'Inventory quantity matches transaction history running total',
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
        .select('id, invoice_number, paid_amount_cents, prepay_applied_cents, total_amount_cents, balance_cents')
        .eq('status', 'posted')
        .is('deleted_at', null),
      supabase
        .from('payment_allocations')
        .select('invoice_id, amount_cents'),
    ]);

    const invoices = (invoiceRes.data ?? []) as InvoiceRow[];
    const allocations = (allocRes.data ?? []) as PaymentAllocationRow[];

    const payDisc = checkInvoicePayments(invoices, allocations);
    checks.push({
      name: 'Invoice Payments',
      description: 'Invoice paid_amount_cents matches SUM of payment allocations',
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
  } catch {
    checks.push({
      name: 'Invoice Payments',
      description: 'Invoice paid_amount_cents matches SUM of payment allocations',
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
    checks.push({
      name: 'Invoice Balance Formula',
      description: 'balance_cents = total - paid - prepay (GENERATED ALWAYS sanity check)',
      passed: false,
      discrepancies: [],
      entitiesChecked: 0,
    });
  }

  // ── Check 5: Commission splits ─────────────────────────────────
  try {
    const { data } = await supabase
      .from('commissions')
      .select('order_id, order_number, split_percentage');

    const commissions = (data ?? []) as CommissionRow[];
    const disc = checkCommissionSplits(commissions);

    checks.push({
      name: 'Commission Splits',
      description: 'Commission split percentages sum to 100% per order',
      passed: disc.length === 0,
      discrepancies: disc,
      entitiesChecked: new Set(commissions.map((c) => c.order_id)).size,
    });
  } catch {
    checks.push({
      name: 'Commission Splits',
      description: 'Commission split percentages sum to 100% per order',
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
