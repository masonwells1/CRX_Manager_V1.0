import { describe, it, expect } from 'vitest';
import {
  isSummaryUnposted,
  sumSummaryTotals,
  addSummaryTotals,
  buildCustomerInvoiceSummary,
  summaryTypeLabel,
  ZERO_SUMMARY_TOTALS,
  type SummaryInvoiceRow,
} from './customerInvoiceSummary';

const row = (over: Partial<SummaryInvoiceRow>): SummaryInvoiceRow => ({
  id: 'inv-1',
  invoice_number: 'CS-1001',
  invoice_type: 'chemical_sale',
  status: 'unposted',
  invoice_date: '2026-06-01',
  total_amount_cents: 10000,
  paid_amount_cents: 0,
  prepay_applied_cents: 0,
  write_off_cents: 0,
  discount_earned_cents: 0,
  balance_cents: 10000,
  ...over,
});

describe('isSummaryUnposted', () => {
  it('accepts draft + unposted only', () => {
    expect(isSummaryUnposted('draft')).toBe(true);
    expect(isSummaryUnposted('unposted')).toBe(true);
    expect(isSummaryUnposted('posted')).toBe(false);
    expect(isSummaryUnposted('paid')).toBe(false);
    expect(isSummaryUnposted('overdue')).toBe(false);
    expect(isSummaryUnposted('voided')).toBe(false);
    expect(isSummaryUnposted('cancelled')).toBe(false);
  });
});

describe('sumSummaryTotals', () => {
  it('returns zero totals for an empty list', () => {
    expect(sumSummaryTotals([])).toEqual(ZERO_SUMMARY_TOTALS);
  });

  it('sums every cents field as integers', () => {
    const t = sumSummaryTotals([
      row({ total_amount_cents: 10000, paid_amount_cents: 2500, prepay_applied_cents: 500, write_off_cents: 100, discount_earned_cents: 50, balance_cents: 6900 }),
      row({ id: 'inv-2', invoice_number: 'CS-1002', total_amount_cents: 30000, paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 0, discount_earned_cents: 0, balance_cents: 30000 }),
    ]);
    expect(t.count).toBe(2);
    expect(t.totalAmountCents).toBe(40000);
    expect(t.paidAmountCents).toBe(2500);
    expect(t.prepayAppliedCents).toBe(500);
    expect(t.writeOffCents).toBe(100);
    expect(t.discountEarnedCents).toBe(50);
    expect(t.balanceCents).toBe(36900);
  });

  it('keeps subtotal balance = total - paid - prepay - write-off per row (money reconciliation)', () => {
    // Each row's balance is total − paid − prepay − write-off; the subtotal must
    // preserve that identity (it is just the integer sum of consistent rows).
    const rows = [
      row({ total_amount_cents: 50000, paid_amount_cents: 10000, prepay_applied_cents: 5000, write_off_cents: 0, balance_cents: 35000 }),
      row({ id: 'i2', invoice_number: 'CS-2', total_amount_cents: 20000, paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 2000, balance_cents: 18000 }),
    ];
    const t = sumSummaryTotals(rows);
    expect(t.balanceCents).toBe(t.totalAmountCents - t.paidAmountCents - t.prepayAppliedCents - t.writeOffCents);
    expect(t.balanceCents).toBe(53000);
  });
});

describe('addSummaryTotals', () => {
  it('adds two totals field-by-field', () => {
    const a = sumSummaryTotals([row({ total_amount_cents: 10000, balance_cents: 10000 })]);
    const b = sumSummaryTotals([row({ id: 'i2', invoice_number: 'FA-1', invoice_type: 'field_application', total_amount_cents: 25000, balance_cents: 25000 })]);
    const c = addSummaryTotals(a, b);
    expect(c.count).toBe(2);
    expect(c.totalAmountCents).toBe(35000);
    expect(c.balanceCents).toBe(35000);
  });
});

describe('buildCustomerInvoiceSummary', () => {
  it('partitions by type, computes per-type subtotals and a combined total', () => {
    const rows: SummaryInvoiceRow[] = [
      row({ id: 'c1', invoice_number: 'CS-1001', invoice_type: 'chemical_sale', invoice_date: '2026-06-03', total_amount_cents: 15000, paid_amount_cents: 5000, balance_cents: 10000 }),
      row({ id: 'c2', invoice_number: 'CS-1000', invoice_type: 'chemical_sale', invoice_date: '2026-06-01', total_amount_cents: 8000, balance_cents: 8000 }),
      row({ id: 'f1', invoice_number: 'FA-2001', invoice_type: 'field_application', invoice_date: '2026-06-02', total_amount_cents: 120000, prepay_applied_cents: 20000, balance_cents: 100000 }),
    ];
    const s = buildCustomerInvoiceSummary(rows);

    // Chemical section sorted by date ascending: CS-1000 (06-01) before CS-1001 (06-03)
    expect(s.chemicalRows.map((r) => r.invoice_number)).toEqual(['CS-1000', 'CS-1001']);
    expect(s.fieldRows.map((r) => r.invoice_number)).toEqual(['FA-2001']);

    // Per-type subtotals
    expect(s.chemicalSubtotal.totalAmountCents).toBe(23000);
    expect(s.chemicalSubtotal.balanceCents).toBe(18000);
    expect(s.fieldSubtotal.totalAmountCents).toBe(120000);
    expect(s.fieldSubtotal.balanceCents).toBe(100000);

    // Combined total = chem + field, and the combined balance = sum of both balances
    expect(s.combinedTotal.count).toBe(3);
    expect(s.combinedTotal.totalAmountCents).toBe(143000);
    expect(s.combinedTotal.paidAmountCents).toBe(5000);
    expect(s.combinedTotal.prepayAppliedCents).toBe(20000);
    expect(s.combinedTotal.balanceCents).toBe(118000);
    expect(s.combinedTotal.balanceCents).toBe(s.chemicalSubtotal.balanceCents + s.fieldSubtotal.balanceCents);
  });

  it('combined balance equals the integer sum of both types — no float drift on odd cents', () => {
    // Odd, prime-ish cents that would round-trip badly through floats/dollars.
    const rows: SummaryInvoiceRow[] = [
      row({ id: 'c1', invoice_number: 'CS-1', invoice_type: 'chemical_sale', total_amount_cents: 333, balance_cents: 333 }),
      row({ id: 'c2', invoice_number: 'CS-2', invoice_type: 'chemical_sale', total_amount_cents: 1, balance_cents: 1 }),
      row({ id: 'f1', invoice_number: 'FA-1', invoice_type: 'field_application', total_amount_cents: 1501, balance_cents: 1501 }),
      row({ id: 'f2', invoice_number: 'FA-2', invoice_type: 'field_application', total_amount_cents: 7, balance_cents: 7 }),
    ];
    const s = buildCustomerInvoiceSummary(rows);
    expect(s.chemicalSubtotal.balanceCents).toBe(334);
    expect(s.fieldSubtotal.balanceCents).toBe(1508);
    expect(s.combinedTotal.balanceCents).toBe(1842);
    // Integer-exact: the combined total is the sum of the two subtotals, full stop.
    expect(s.combinedTotal.balanceCents).toBe(s.chemicalSubtotal.balanceCents + s.fieldSubtotal.balanceCents);
    expect(s.combinedTotal.totalAmountCents).toBe(1842);
  });

  it('excludes invoice types other than chemical_sale / field_application from both sections and the combined total', () => {
    const rows: SummaryInvoiceRow[] = [
      row({ id: 'c1', invoice_number: 'CS-1', invoice_type: 'chemical_sale', total_amount_cents: 1000, balance_cents: 1000 }),
      row({ id: 'm1', invoice_number: 'MC-1', invoice_type: 'misc_charge', total_amount_cents: 999999, balance_cents: 999999 }),
      row({ id: 'cm1', invoice_number: 'CM-1', invoice_type: 'credit_memo', total_amount_cents: -500, balance_cents: -500 }),
    ];
    const s = buildCustomerInvoiceSummary(rows);
    expect(s.chemicalRows).toHaveLength(1);
    expect(s.fieldRows).toHaveLength(0);
    expect(s.combinedTotal.count).toBe(1);
    expect(s.combinedTotal.totalAmountCents).toBe(1000);
    expect(s.combinedTotal.balanceCents).toBe(1000);
  });

  it('returns empty sections and zero totals for a customer with no unposted invoices', () => {
    const s = buildCustomerInvoiceSummary([]);
    expect(s.chemicalRows).toHaveLength(0);
    expect(s.fieldRows).toHaveLength(0);
    expect(s.combinedTotal).toEqual(ZERO_SUMMARY_TOTALS);
  });
});

describe('summaryTypeLabel', () => {
  it('labels both summarized types', () => {
    expect(summaryTypeLabel('chemical_sale')).toBe('Chemical Sales');
    expect(summaryTypeLabel('field_application')).toBe('Field Application');
  });
});
