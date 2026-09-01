import { describe, it, expect } from 'vitest';
import {
  checkOrderTotals,
  checkInventoryLedger,
  checkInvoicePayments,
  checkInvoiceBalances,
  checkCommissionSplits,
  checkQuoteHoldParity,
  checkDeliveryInvoiceQuantityParity,
  checkPrebookedInventory,
  checkReturnCreditLinkage,
  checkCustomerARConsistency,
  type OrderRow,
  type OrderItemRow,
  type InventoryRow,
  type InventoryTransactionRow,
  type InvoiceRow,
  type InvoiceLineAllocationRow,
  type CommissionRow,
  type QuoteHoldRow,
  type HoldRow,
  type DeliveryItemCheckRow,
  type InvoiceItemCheckRow,
  type InventoryPrebookRow,
  type OrderItemRemainingRow,
  type ReturnCheckRow,
  type CustomerARInvoiceRow,
} from './reconciliation';
import {
  checkDeliveryInvoiceQuantityParity as checkGoLiveDeliveryInvoiceQuantityParity,
} from '../../tests/e2e/golive/utils/reconciliation-checks';

// ── Check 1: Order Totals ───────────────────────────────────────

describe('checkOrderTotals', () => {
  it('returns empty when totals match', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_price: 150 },
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', total_price: 100 },
      { order_id: 'o1', total_price: 50 },
    ];

    expect(checkOrderTotals(orders, items)).toEqual([]);
  });

  it('detects mismatch when stored total differs from line items', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_price: 200 },
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', total_price: 100 },
    ];

    const result = checkOrderTotals(orders, items);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('order_totals');
    expect(result[0].entity).toBe('ORD-001');
    expect(result[0].expected).toBe(10000); // computed: 100 * 100 cents
    expect(result[0].actual).toBe(20000);   // stored: 200 * 100 cents
  });

  it('tolerates ±1 cent rounding', () => {
    const orders: OrderRow[] = [
      // 33.34 in dollars — 3334 cents
      { id: 'o1', order_number: 'ORD-001', total_price: 33.34 },
    ];
    const items: OrderItemRow[] = [
      // line total 33.33 → 3333 cents
      { order_id: 'o1', total_price: 33.33 },
    ];

    // line sum = 33.33, stored = 33.34, delta = 1 cent → within tolerance
    const result = checkOrderTotals(orders, items);
    expect(result).toEqual([]);
  });

  it('handles orders with no items', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_price: 100 },
    ];
    const items: OrderItemRow[] = [];

    const result = checkOrderTotals(orders, items);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(0); // no items → computed = 0
    expect(result[0].actual).toBe(10000); // stored = 100 * 100
  });

  it('checks multiple orders independently', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_price: 100 },
      { id: 'o2', order_number: 'ORD-002', total_price: 500 }, // mismatch
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', total_price: 100 },
      { order_id: 'o2', total_price: 100 }, // = 100, not 500
    ];

    const result = checkOrderTotals(orders, items);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe('o2');
  });

  it('handles fractional dollar totals correctly', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_price: 125.50 },
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', total_price: 125.50 },
    ];

    // line total 125.50 = order total → should match
    expect(checkOrderTotals(orders, items)).toEqual([]);
  });
});

// ── Check 2: Inventory Ledger ───────────────────────────────────

describe('checkInventoryLedger', () => {
  it('returns empty when inventory matches transactions', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 50 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'delivered', quantity: 50 },
    ];

    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('detects mismatch between inventory and transactions', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 75 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'delivered', quantity: 50 },
      // Expected: 100 - 50 = 50, but inventory says 75
    ];

    const result = checkInventoryLedger(inventory, transactions);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(50);
    expect(result[0].actual).toBe(75);
    expect(result[0].delta).toBe(25);
  });

  it('handles returned items as additions', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 30 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'delivered', quantity: 80 },
      { product_id: 'p1', transaction_type: 'returned', quantity: 10 },
    ];

    // 100 - 80 + 10 = 30
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('handles signed adjustments', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 85 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'adjusted', quantity: -15 }, // shrinkage
    ];

    // 100 + (-15) = 85
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('skips products with no transactions (initial load only)', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 42 },
    ];
    const transactions: InventoryTransactionRow[] = [];

    // No transactions → can't verify → skip
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('treats booked as no effect on quantity_available (affects prebooked only)', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 100 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'booked', quantity: 20 },
    ];

    // booked affects quantity_prebooked, NOT quantity_available
    // expected = 100 (received only), actual = 100 → match
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('treats prebooked and released as no effect on quantity_available', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 100 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'prebooked', quantity: 30 },
      { product_id: 'p1', transaction_type: 'released', quantity: 10 },
    ];

    // prebooked/released only affect quantity_prebooked
    // expected = 100 (received only), actual = 100 → match
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('handles job_applied as subtraction from quantity_available', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 85 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'job_applied', quantity: 15 },
    ];

    // 100 - 15 = 85
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('handles cancelled_delivery_reversal as addition to quantity_available', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 60 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'delivered', quantity: 50 },
      { product_id: 'p1', transaction_type: 'cancelled_delivery_reversal', quantity: 10 },
    ];

    // 100 - 50 + 10 = 60
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('handles void_delivery_reversal as addition to quantity_available', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 75 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'delivered', quantity: 50 },
      { product_id: 'p1', transaction_type: 'void_delivery_reversal', quantity: 25 },
    ];

    // 100 - 50 + 25 = 75
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('handles all 11 transaction types together', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 78 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'delivered', quantity: 40 },
      { product_id: 'p1', transaction_type: 'returned', quantity: 5 },
      { product_id: 'p1', transaction_type: 'adjusted', quantity: -10 },
      { product_id: 'p1', transaction_type: 'transferred', quantity: 8 },
      { product_id: 'p1', transaction_type: 'job_applied', quantity: 15 },
      { product_id: 'p1', transaction_type: 'cancelled_delivery_reversal', quantity: 20 },
      { product_id: 'p1', transaction_type: 'void_delivery_reversal', quantity: 10 },
      // These 3 should NOT affect quantity_available:
      { product_id: 'p1', transaction_type: 'booked', quantity: 30 },
      { product_id: 'p1', transaction_type: 'prebooked', quantity: 25 },
      { product_id: 'p1', transaction_type: 'released', quantity: 10 },
    ];

    // 100 - 40 + 5 + (-10) + 8 - 15 + 20 + 10 = 78
    // booked/prebooked/released have zero effect
    expect(checkInventoryLedger(inventory, transactions)).toEqual([]);
  });

  it('handles multiple products independently', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 50 },
      { id: 'inv2', product_id: 'p2', product_name: 'Product B', quantity_available: 999 }, // wrong
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 50 },
      { product_id: 'p2', transaction_type: 'received', quantity: 30 },
    ];

    const result = checkInventoryLedger(inventory, transactions);
    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe('Product B');
  });
});

// ── Check 3: Invoice Payments ───────────────────────────────────

describe('checkInvoicePayments', () => {
  // Source of truth is invoice_line_allocations.amount_cents per invoice
  // (written by allocate_payment in Phase 14). The check sums those per
  // invoice_id and compares to invoice.paid_amount_cents.

  it('returns empty when paid amounts match allocations', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'ord1', paid_amount_cents: 5000, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,total_amount_cents: 10000, balance_cents: 5000 },
    ];
    const allocations: InvoiceLineAllocationRow[] = [
      { invoice_id: 'i1', amount_cents: 3000 },
      { invoice_id: 'i1', amount_cents: 2000 },
    ];

    expect(checkInvoicePayments(invoices, allocations)).toEqual([]);
  });

  it('detects over-counted paid amount', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'ord1', paid_amount_cents: 8000, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,total_amount_cents: 10000, balance_cents: 2000 },
    ];
    const allocations: InvoiceLineAllocationRow[] = [
      { invoice_id: 'i1', amount_cents: 5000 },
    ];

    const result = checkInvoicePayments(invoices, allocations);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(5000); // sum of allocations
    expect(result[0].actual).toBe(8000);   // invoice paid_amount_cents
  });

  it('handles invoices with no allocations', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'ord1', paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,total_amount_cents: 10000, balance_cents: 10000 },
    ];
    const allocations: InvoiceLineAllocationRow[] = [];

    expect(checkInvoicePayments(invoices, allocations)).toEqual([]);
  });

  it('handles invoice with paid amount but no allocations', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'ord1', paid_amount_cents: 3000, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,total_amount_cents: 10000, balance_cents: 7000 },
    ];
    const allocations: InvoiceLineAllocationRow[] = [];

    const result = checkInvoicePayments(invoices, allocations);
    expect(result).toHaveLength(1);
    expect(result[0].delta).toBe(3000);
  });

  it('tolerates ±1 cent rounding', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'ord1', paid_amount_cents: 5001, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,total_amount_cents: 10000, balance_cents: 4999 },
    ];
    const allocations: InvoiceLineAllocationRow[] = [
      { invoice_id: 'i1', amount_cents: 5000 },
    ];

    expect(checkInvoicePayments(invoices, allocations)).toEqual([]);
  });
});

// ── Check 4: Invoice Balance Formula ────────────────────────────

describe('checkInvoiceBalances', () => {
  it('returns empty when balance = total - paid - prepay', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'o1', total_amount_cents: 10000, paid_amount_cents: 3000, prepay_applied_cents: 2000, write_off_cents: 0, credit_applied_cents: 0,balance_cents: 5000 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('detects corrupted balance column', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'o1', total_amount_cents: 10000, paid_amount_cents: 3000, prepay_applied_cents: 2000, write_off_cents: 0, credit_applied_cents: 0,balance_cents: 9999 },
    ];

    const result = checkInvoiceBalances(invoices);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(5000); // 10000 - 3000 - 2000
    expect(result[0].actual).toBe(9999);
  });

  it('handles fully paid invoices', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'o1', total_amount_cents: 5000, paid_amount_cents: 5000, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,balance_cents: 0 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('handles invoices with only prepay', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'o1', total_amount_cents: 10000, paid_amount_cents: 0, prepay_applied_cents: 10000, write_off_cents: 0, credit_applied_cents: 0,balance_cents: 0 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('handles invoices with write-offs (PR-09 fix)', () => {
    // Before PR-09, write_off_cents was missing from the formula, causing
    // every written-off invoice to be flagged as a discrepancy.
    const invoices: InvoiceRow[] = [
      // $100 invoice, $30 paid, $20 prepay, $50 write-off → balance $0
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'o1', total_amount_cents: 10000, paid_amount_cents: 3000, prepay_applied_cents: 2000, write_off_cents: 5000, credit_applied_cents: 0,balance_cents: 0 },
      // $200 invoice, $0 paid, $0 prepay, $50 write-off → balance $150
      { id: 'i2', invoice_number: 'INV-002', invoice_type: 'chemical_sale', order_id: 'o2', total_amount_cents: 20000, paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 5000, credit_applied_cents: 0,balance_cents: 15000 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('checks multiple invoices independently', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', invoice_type: 'chemical_sale', order_id: 'o1', total_amount_cents: 10000, paid_amount_cents: 5000, prepay_applied_cents: 0, write_off_cents: 0, credit_applied_cents: 0,balance_cents: 5000 }, // OK
      { id: 'i2', invoice_number: 'INV-002', invoice_type: 'chemical_sale', order_id: 'o2', total_amount_cents: 20000, paid_amount_cents: 10000, prepay_applied_cents: 5000, write_off_cents: 0, credit_applied_cents: 0,balance_cents: 999 }, // BAD: should be 5000
    ];

    const result = checkInvoiceBalances(invoices);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe('i2');
  });
});

// ── Check 5: Commission Splits ──────────────────────────────────

describe('checkCommissionSplits', () => {
  it('returns empty when splits sum to 100', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 60 },
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 40 },
    ];

    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  it('detects splits that sum to less than 100', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 50 },
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 30 },
    ];

    const result = checkCommissionSplits(commissions);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(100);
    expect(result[0].actual).toBe(80);
    expect(result[0].delta).toBe(20);
  });

  it('detects splits that sum to more than 100', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 60 },
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 60 },
    ];

    const result = checkCommissionSplits(commissions);
    expect(result).toHaveLength(1);
    expect(result[0].actual).toBe(120);
  });

  it('handles single-person 100% split', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 100 },
    ];

    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  it('checks multiple orders independently', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 50 },
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 50 },
      { order_id: 'o2', order_number: 'ORD-002', split_percentage: 70 }, // only 70%
    ];

    const result = checkCommissionSplits(commissions);
    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe('ORD-002');
  });

  // U8: job-sourced commissions have order_id NULL — each job must group on its
  // own job_id bucket, never collapse into one shared `null` bucket.
  it('groups job-sourced commissions per job, not into one null bucket', () => {
    const commissions: CommissionRow[] = [
      { order_id: null, job_id: 'j1', order_number: 'Job JOB-001', split_percentage: 60 },
      { order_id: null, job_id: 'j1', order_number: 'Job JOB-001', split_percentage: 40 },
      { order_id: null, job_id: 'j2', order_number: 'Job JOB-002', split_percentage: 100 },
    ];

    // Two valid 100% jobs; a raw order_id key would sum them to 200 and misreport.
    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  it('flags a job whose splits do not sum to 100 without touching other jobs', () => {
    const commissions: CommissionRow[] = [
      { order_id: null, job_id: 'j1', order_number: 'Job JOB-001', split_percentage: 100 },
      { order_id: null, job_id: 'j2', order_number: 'Job JOB-002', split_percentage: 70 },
    ];

    const result = checkCommissionSplits(commissions);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe('job:j2');
    expect(result[0].actual).toBe(70);
  });

  it('keeps order and job buckets separate when both channels are present', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', job_id: null, order_number: 'ORD-001', split_percentage: 100 },
      { order_id: null, job_id: 'j1', order_number: 'Job JOB-001', split_percentage: 100 },
    ];

    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  // Codex R1 P2: a void→re-invoice cycle leaves a cancelled generation beside the
  // live one on the same job — cancelled rows must not inflate the split sum.
  it('excludes cancelled commissions so a re-invoiced job is not a false 200%', () => {
    const commissions: CommissionRow[] = [
      { order_id: null, job_id: 'j1', status: 'cancelled', order_number: 'Job JOB-001', split_percentage: 100 },
      { order_id: null, job_id: 'j1', status: 'pending', order_number: 'Job JOB-001', split_percentage: 100 },
    ];

    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  // Codex R8 P2: a PAID row that survives a void (admin-notified, kept on the
  // ledger) shares job_id with the re-invoice's fresh set but not invoice_id —
  // generations must group separately, each summing to 100.
  it('groups job commissions per invoice generation, not per job', () => {
    const commissions: CommissionRow[] = [
      { order_id: null, job_id: 'j1', invoice_id: 'inv1', status: 'paid', order_number: 'Job JOB-001', split_percentage: 100 },
      { order_id: null, job_id: 'j1', invoice_id: 'inv2', status: 'pending', order_number: 'Job JOB-001', split_percentage: 100 },
    ];

    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  // Codex R9 P2: a partial generation (one recipient paid + siblings cancelled by
  // a void) legitimately totals under 100 — the whole bucket is a reversal
  // artifact and must be excluded, not misreported as split corruption.
  it('excludes a paid-survivor generation whose siblings were cancelled', () => {
    const commissions: CommissionRow[] = [
      { order_id: null, job_id: 'j1', invoice_id: 'inv1', status: 'paid', order_number: 'Job JOB-001', split_percentage: 60 },
      { order_id: null, job_id: 'j1', invoice_id: 'inv1', status: 'cancelled', order_number: 'Job JOB-001', split_percentage: 40 },
    ];

    expect(checkCommissionSplits(commissions)).toEqual([]);
  });

  it('handles empty commissions list', () => {
    expect(checkCommissionSplits([])).toEqual([]);
  });

  it('tolerates tiny floating point noise', () => {
    const commissions: CommissionRow[] = [
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 33.33 },
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 33.33 },
      { order_id: 'o1', order_number: 'ORD-001', split_percentage: 33.34 },
    ];

    // 33.33 + 33.33 + 33.34 = 100.00
    expect(checkCommissionSplits(commissions)).toEqual([]);
  });
});

// ── Check 6: Quote-Hold Parity ──────────────────────────────────

describe('checkQuoteHoldParity', () => {
  it('returns no discrepancies when all planned quotes have holds', () => {
    const quotes: QuoteHoldRow[] = [
      { id: 'q1', quote_number: 'Q-001', is_planned: true, status: 'draft' },
    ];
    const holds: HoldRow[] = [
      { source_id: 'q1', is_active: true },
    ];
    expect(checkQuoteHoldParity(quotes, holds)).toEqual([]);
  });

  it('flags planned quote with no active holds', () => {
    const quotes: QuoteHoldRow[] = [
      { id: 'q1', quote_number: 'Q-001', is_planned: true, status: 'sent' },
    ];
    const holds: HoldRow[] = [];
    const result = checkQuoteHoldParity(quotes, holds);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('quote_hold_parity');
    expect(result[0].entity).toBe('Q-001');
    expect(result[0].expected).toBe(1);
    expect(result[0].actual).toBe(0);
  });

  it('ignores non-planned quotes', () => {
    const quotes: QuoteHoldRow[] = [
      { id: 'q1', quote_number: 'Q-001', is_planned: false, status: 'draft' },
    ];
    const holds: HoldRow[] = [];
    expect(checkQuoteHoldParity(quotes, holds)).toEqual([]);
  });

  it('ignores terminal-status quotes', () => {
    const quotes: QuoteHoldRow[] = [
      { id: 'q1', quote_number: 'Q-001', is_planned: true, status: 'accepted' },
      { id: 'q2', quote_number: 'Q-002', is_planned: true, status: 'declined' },
      { id: 'q3', quote_number: 'Q-003', is_planned: true, status: 'expired' },
    ];
    const holds: HoldRow[] = [];
    expect(checkQuoteHoldParity(quotes, holds)).toEqual([]);
  });

  it('does not flag quote with inactive hold if another hold is active', () => {
    const quotes: QuoteHoldRow[] = [
      { id: 'q1', quote_number: 'Q-001', is_planned: true, status: 'revised' },
    ];
    const holds: HoldRow[] = [
      { source_id: 'q1', is_active: false },
      { source_id: 'q1', is_active: true },
    ];
    expect(checkQuoteHoldParity(quotes, holds)).toEqual([]);
  });

  it('flags quote with only inactive holds', () => {
    const quotes: QuoteHoldRow[] = [
      { id: 'q1', quote_number: 'Q-001', is_planned: true, status: 'draft' },
    ];
    const holds: HoldRow[] = [
      { source_id: 'q1', is_active: false },
    ];
    const result = checkQuoteHoldParity(quotes, holds);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('quote_hold_parity');
  });

  it('handles empty inputs', () => {
    expect(checkQuoteHoldParity([], [])).toEqual([]);
  });
});

// ── Check 7: Delivery-Invoice Quantity Parity ───────────────────

describe('checkDeliveryInvoiceQuantityParity', () => {
  it('returns no discrepancies when quantities match', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 10 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity: 10, invoice_type: 'chemical_sale' },
    ];
    expect(checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems)).toEqual([]);
    expect(checkGoLiveDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems)).toEqual([]);
  });

  it('ignores negative return-credit lines when comparing delivered to billed quantity', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 10 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity: 10, invoice_type: 'chemical_sale' },
      { order_id: 'o1', product_id: 'p1', quantity: -5, invoice_type: 'credit_memo' },
    ];

    expect(checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems)).toEqual([]);
    expect(checkGoLiveDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems)).toEqual([]);
  });

  it('flags mismatch between delivered and invoiced quantities', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 20 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity: 10, invoice_type: 'chemical_sale' },
    ];
    const result = checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('delivery_invoice_qty_parity');
    expect(result[0].expected).toBe(20); // delivered
    expect(result[0].actual).toBe(10);   // invoiced
    expect(result[0].delta).toBe(10);
  });

  it('aggregates multiple deliveries and invoices for same order+product', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 5 },
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 5 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity: 10, invoice_type: 'chemical_sale' },
    ];
    // 5 + 5 delivered = 10 invoiced → match
    expect(checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems)).toEqual([]);
  });

  it('checks different order+product combinations independently', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 10 },
      { order_id: 'o1', product_id: 'p2', quantity_delivered: 20 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity: 10, invoice_type: 'chemical_sale' }, // match
      { order_id: 'o1', product_id: 'p2', quantity: 5, invoice_type: 'chemical_sale' },  // mismatch
    ];
    const result = checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems);
    expect(result).toHaveLength(1);
    expect(result[0].delta).toBe(15);
  });

  it('tolerates tiny quantity differences', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 10.005 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity: 10, invoice_type: 'chemical_sale' },
    ];
    // diff = 0.005 < 0.01 tolerance
    expect(checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems)).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(checkDeliveryInvoiceQuantityParity([], [])).toEqual([]);
  });

  it('flags delivery items with no matching invoice items', () => {
    const deliveryItems: DeliveryItemCheckRow[] = [
      { order_id: 'o1', product_id: 'p1', quantity_delivered: 10 },
    ];
    const invoiceItems: InvoiceItemCheckRow[] = [];
    const result = checkDeliveryInvoiceQuantityParity(deliveryItems, invoiceItems);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(10);
    expect(result[0].actual).toBe(0);
  });
});

// ── Check 8: Pre-booked Inventory ───────────────────────────────

describe('checkPrebookedInventory', () => {
  it('returns no discrepancies when prebooked matches order remaining', () => {
    const inventory: InventoryPrebookRow[] = [
      { id: 'inv1', product_id: 'p1', quantity_prebooked: 25 },
    ];
    const orderItems: OrderItemRemainingRow[] = [
      { product_id: 'p1', quantity_remaining: 15 },
      { product_id: 'p1', quantity_remaining: 10 },
    ];
    expect(checkPrebookedInventory(inventory, orderItems)).toEqual([]);
  });

  it('flags mismatch between prebooked and order remaining', () => {
    const inventory: InventoryPrebookRow[] = [
      { id: 'inv1', product_id: 'p1', quantity_prebooked: 50 },
    ];
    const orderItems: OrderItemRemainingRow[] = [
      { product_id: 'p1', quantity_remaining: 20 },
    ];
    const result = checkPrebookedInventory(inventory, orderItems);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('prebooked_inventory');
    expect(result[0].expected).toBe(20);
    expect(result[0].actual).toBe(50);
    expect(result[0].delta).toBe(30);
  });

  it('handles product with prebooked but no open orders', () => {
    const inventory: InventoryPrebookRow[] = [
      { id: 'inv1', product_id: 'p1', quantity_prebooked: 10 },
    ];
    const orderItems: OrderItemRemainingRow[] = [];
    const result = checkPrebookedInventory(inventory, orderItems);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(0);
    expect(result[0].actual).toBe(10);
  });

  it('handles product with zero prebooked and no orders', () => {
    const inventory: InventoryPrebookRow[] = [
      { id: 'inv1', product_id: 'p1', quantity_prebooked: 0 },
    ];
    const orderItems: OrderItemRemainingRow[] = [];
    expect(checkPrebookedInventory(inventory, orderItems)).toEqual([]);
  });

  it('tolerates tiny differences', () => {
    const inventory: InventoryPrebookRow[] = [
      { id: 'inv1', product_id: 'p1', quantity_prebooked: 10.005 },
    ];
    const orderItems: OrderItemRemainingRow[] = [
      { product_id: 'p1', quantity_remaining: 10 },
    ];
    // diff = 0.005 < 0.01 tolerance
    expect(checkPrebookedInventory(inventory, orderItems)).toEqual([]);
  });

  it('checks multiple products independently', () => {
    const inventory: InventoryPrebookRow[] = [
      { id: 'inv1', product_id: 'p1', quantity_prebooked: 10 },
      { id: 'inv2', product_id: 'p2', quantity_prebooked: 99 }, // mismatch
    ];
    const orderItems: OrderItemRemainingRow[] = [
      { product_id: 'p1', quantity_remaining: 10 },
      { product_id: 'p2', quantity_remaining: 5 },
    ];
    const result = checkPrebookedInventory(inventory, orderItems);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe('inv2');
  });
});

// ── Check 9: Return-Credit Linkage ──────────────────────────────

describe('checkReturnCreditLinkage', () => {
  it('returns no discrepancies when credited returns have credit invoices', () => {
    const returns: ReturnCheckRow[] = [
      { id: 'r1', return_number: 'RMA-001', status: 'credited', credit_invoice_id: 'inv1' },
    ];
    expect(checkReturnCreditLinkage(returns)).toEqual([]);
  });

  it('flags credited return with no credit invoice', () => {
    const returns: ReturnCheckRow[] = [
      { id: 'r1', return_number: 'RMA-001', status: 'credited', credit_invoice_id: null },
    ];
    const result = checkReturnCreditLinkage(returns);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('return_credit_linkage');
    expect(result[0].entity).toBe('RMA-001');
    expect(result[0].expected).toBe(1);
    expect(result[0].actual).toBe(0);
  });

  it('ignores non-credited returns without credit invoices', () => {
    const returns: ReturnCheckRow[] = [
      { id: 'r1', return_number: 'RMA-001', status: 'requested', credit_invoice_id: null },
      { id: 'r2', return_number: 'RMA-002', status: 'approved', credit_invoice_id: null },
      { id: 'r3', return_number: 'RMA-003', status: 'received', credit_invoice_id: null },
      { id: 'r4', return_number: 'RMA-004', status: 'rejected', credit_invoice_id: null },
    ];
    expect(checkReturnCreditLinkage(returns)).toEqual([]);
  });

  it('handles empty returns list', () => {
    expect(checkReturnCreditLinkage([])).toEqual([]);
  });

  it('checks multiple credited returns independently', () => {
    const returns: ReturnCheckRow[] = [
      { id: 'r1', return_number: 'RMA-001', status: 'credited', credit_invoice_id: 'inv1' }, // OK
      { id: 'r2', return_number: 'RMA-002', status: 'credited', credit_invoice_id: null },    // BAD
      { id: 'r3', return_number: 'RMA-003', status: 'credited', credit_invoice_id: 'inv3' }, // OK
    ];
    const result = checkReturnCreditLinkage(returns);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe('r2');
  });
});

// ── Check 10: Customer AR Consistency ───────────────────────────

describe('checkCustomerARConsistency', () => {
  it('returns no discrepancies when all non-voided invoices have balance_cents', () => {
    const invoices: CustomerARInvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', customer_id: 'c1', balance_cents: 5000, status: 'posted' },
      { id: 'i2', invoice_number: 'INV-002', customer_id: 'c1', balance_cents: 0, status: 'posted' },
    ];
    expect(checkCustomerARConsistency(invoices)).toEqual([]);
  });

  it('flags non-voided invoice with null balance_cents', () => {
    const invoices: CustomerARInvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', customer_id: 'c1', balance_cents: null, status: 'posted' },
    ];
    const result = checkCustomerARConsistency(invoices);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('customer_ar_consistency');
    expect(result[0].entity).toBe('INV-001');
    expect(result[0].actual).toBe(-1); // sentinel for NULL
  });

  it('ignores voided invoices with null balance', () => {
    const invoices: CustomerARInvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', customer_id: 'c1', balance_cents: null, status: 'voided' },
    ];
    expect(checkCustomerARConsistency(invoices)).toEqual([]);
  });

  it('does NOT skip rows with the legacy "void" string (status enum is "voided")', () => {
    // Regression for audit P3-5 / Wave A.5: previously both impl and test
    // used 'void', which masked the bug. After fixing impl to 'voided',
    // a row with the wrong literal should NOT be skipped — it should be
    // checked like any other non-voided row.
    const invoices: CustomerARInvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', customer_id: 'c1', balance_cents: null, status: 'void' as unknown as CustomerARInvoiceRow['status'] },
    ];
    const result = checkCustomerARConsistency(invoices);
    expect(result).toHaveLength(1);
  });

  it('handles draft invoices with null balance', () => {
    const invoices: CustomerARInvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', customer_id: 'c1', balance_cents: null, status: 'draft' },
    ];
    const result = checkCustomerARConsistency(invoices);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe('customer_ar_consistency');
  });

  it('handles empty invoices list', () => {
    expect(checkCustomerARConsistency([])).toEqual([]);
  });

  it('checks multiple invoices across customers', () => {
    const invoices: CustomerARInvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', customer_id: 'c1', balance_cents: 5000, status: 'posted' },
      { id: 'i2', invoice_number: 'INV-002', customer_id: 'c2', balance_cents: null, status: 'posted' },
      { id: 'i3', invoice_number: 'INV-003', customer_id: 'c1', balance_cents: null, status: 'draft' },
    ];
    const result = checkCustomerARConsistency(invoices);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.entityId).sort()).toEqual(['i2', 'i3']);
  });
});
