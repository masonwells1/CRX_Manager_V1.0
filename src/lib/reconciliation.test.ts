import { describe, it, expect } from 'vitest';
import {
  checkOrderTotals,
  checkInventoryLedger,
  checkInvoicePayments,
  checkInvoiceBalances,
  checkCommissionSplits,
  type OrderRow,
  type OrderItemRow,
  type InventoryRow,
  type InventoryTransactionRow,
  type InvoiceRow,
  type PaymentAllocationRow,
  type CommissionRow,
} from './reconciliation';

// ── Check 1: Order Totals ───────────────────────────────────────

describe('checkOrderTotals', () => {
  it('returns empty when totals match', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_amount: 150 },
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', quantity: 10, price_per_unit: 10 },
      { order_id: 'o1', quantity: 5, price_per_unit: 10 },
    ];

    expect(checkOrderTotals(orders, items)).toEqual([]);
  });

  it('detects mismatch when stored total differs from line items', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_amount: 200 },
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', quantity: 10, price_per_unit: 10 }, // = 100
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
      { id: 'o1', order_number: 'ORD-001', total_amount: 33.34 },
    ];
    const items: OrderItemRow[] = [
      // 3 × 11.1133... = 33.34  — might round to 3334 or 3333 cents
      { order_id: 'o1', quantity: 3, price_per_unit: 11.11 },
    ];

    // 3 * 11.11 = 33.33, stored = 33.34, delta = 1 cent → within tolerance
    const result = checkOrderTotals(orders, items);
    expect(result).toEqual([]);
  });

  it('handles orders with no items', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_amount: 100 },
    ];
    const items: OrderItemRow[] = [];

    const result = checkOrderTotals(orders, items);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(0); // no items → computed = 0
    expect(result[0].actual).toBe(10000); // stored = 100 * 100
  });

  it('checks multiple orders independently', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_amount: 100 },
      { id: 'o2', order_number: 'ORD-002', total_amount: 500 }, // mismatch
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', quantity: 10, price_per_unit: 10 },
      { order_id: 'o2', quantity: 10, price_per_unit: 10 }, // = 100, not 500
    ];

    const result = checkOrderTotals(orders, items);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe('o2');
  });

  it('handles fractional quantities correctly', () => {
    const orders: OrderRow[] = [
      { id: 'o1', order_number: 'ORD-001', total_amount: 125.50 },
    ];
    const items: OrderItemRow[] = [
      { order_id: 'o1', quantity: 2.5, price_per_unit: 50.20 },
    ];

    // 2.5 * 50.20 = 125.50 → should match
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

  it('handles booked as subtraction', () => {
    const inventory: InventoryRow[] = [
      { id: 'inv1', product_id: 'p1', product_name: 'Product A', quantity_available: 80 },
    ];
    const transactions: InventoryTransactionRow[] = [
      { product_id: 'p1', transaction_type: 'received', quantity: 100 },
      { product_id: 'p1', transaction_type: 'booked', quantity: 20 },
    ];

    // 100 - 20 = 80
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
  it('returns empty when paid amounts match allocations', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', paid_amount_cents: 5000, prepay_applied_cents: 0, total_amount_cents: 10000, balance_cents: 5000 },
    ];
    const allocations: PaymentAllocationRow[] = [
      { invoice_id: 'i1', amount_cents: 3000 },
      { invoice_id: 'i1', amount_cents: 2000 },
    ];

    expect(checkInvoicePayments(invoices, allocations)).toEqual([]);
  });

  it('detects over-counted paid amount', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', paid_amount_cents: 8000, prepay_applied_cents: 0, total_amount_cents: 10000, balance_cents: 2000 },
    ];
    const allocations: PaymentAllocationRow[] = [
      { invoice_id: 'i1', amount_cents: 5000 },
    ];

    const result = checkInvoicePayments(invoices, allocations);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(5000); // allocations sum
    expect(result[0].actual).toBe(8000);   // paid_amount_cents
  });

  it('handles invoices with no allocations', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', paid_amount_cents: 0, prepay_applied_cents: 0, total_amount_cents: 10000, balance_cents: 10000 },
    ];
    const allocations: PaymentAllocationRow[] = [];

    // paid = 0, allocations = 0 → match
    expect(checkInvoicePayments(invoices, allocations)).toEqual([]);
  });

  it('handles invoice with paid amount but no allocations', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', paid_amount_cents: 3000, prepay_applied_cents: 0, total_amount_cents: 10000, balance_cents: 7000 },
    ];
    const allocations: PaymentAllocationRow[] = [];

    const result = checkInvoicePayments(invoices, allocations);
    expect(result).toHaveLength(1);
    expect(result[0].delta).toBe(3000);
  });

  it('tolerates ±1 cent rounding', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', paid_amount_cents: 5001, prepay_applied_cents: 0, total_amount_cents: 10000, balance_cents: 4999 },
    ];
    const allocations: PaymentAllocationRow[] = [
      { invoice_id: 'i1', amount_cents: 5000 },
    ];

    // Delta = 1 cent → within tolerance
    expect(checkInvoicePayments(invoices, allocations)).toEqual([]);
  });
});

// ── Check 4: Invoice Balance Formula ────────────────────────────

describe('checkInvoiceBalances', () => {
  it('returns empty when balance = total - paid - prepay', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', total_amount_cents: 10000, paid_amount_cents: 3000, prepay_applied_cents: 2000, balance_cents: 5000 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('detects corrupted balance column', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', total_amount_cents: 10000, paid_amount_cents: 3000, prepay_applied_cents: 2000, balance_cents: 9999 },
    ];

    const result = checkInvoiceBalances(invoices);
    expect(result).toHaveLength(1);
    expect(result[0].expected).toBe(5000); // 10000 - 3000 - 2000
    expect(result[0].actual).toBe(9999);
  });

  it('handles fully paid invoices', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', total_amount_cents: 5000, paid_amount_cents: 5000, prepay_applied_cents: 0, balance_cents: 0 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('handles invoices with only prepay', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', total_amount_cents: 10000, paid_amount_cents: 0, prepay_applied_cents: 10000, balance_cents: 0 },
    ];

    expect(checkInvoiceBalances(invoices)).toEqual([]);
  });

  it('checks multiple invoices independently', () => {
    const invoices: InvoiceRow[] = [
      { id: 'i1', invoice_number: 'INV-001', total_amount_cents: 10000, paid_amount_cents: 5000, prepay_applied_cents: 0, balance_cents: 5000 }, // OK
      { id: 'i2', invoice_number: 'INV-002', total_amount_cents: 20000, paid_amount_cents: 10000, prepay_applied_cents: 5000, balance_cents: 999 }, // BAD: should be 5000
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
