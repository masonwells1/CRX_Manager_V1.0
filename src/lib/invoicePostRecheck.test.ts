import { describe, expect, it } from 'vitest';
import { savedInvoiceChangedSinceLoad, type PostRecheckInvoice } from './invoicePostRecheck';

const LOADED: PostRecheckInvoice = {
  customer_id: 'cust-1',
  total_amount_cents: 400000,
  invoice_date: '2026-10-05',
  payment_terms: 'Net 30',
  due_date: null,
  lines: [
    { id: 'item-1', product_id: 'prod-A', quantity: 1, unit_price_cents: 150000, extended_cents: 150000 },
    { id: 'item-2', product_id: 'prod-B', quantity: 2.5, unit_price_cents: 100000, extended_cents: 250000 },
  ],
};

describe('savedInvoiceChangedSinceLoad', () => {
  it('is false when the saved invoice matches, even with lines in another order, a numeric string quantity, or "" for null', () => {
    const saved: PostRecheckInvoice = {
      ...LOADED,
      due_date: '',
      lines: [
        { id: 'item-2', product_id: 'prod-B', quantity: '2.5', unit_price_cents: 100000, extended_cents: 250000 },
        { id: 'item-1', product_id: 'prod-A', quantity: 1, unit_price_cents: 150000, extended_cents: 150000 },
      ],
    };
    expect(savedInvoiceChangedSinceLoad(saved, LOADED)).toBe(false);
  });

  it.each([
    ['customer', { customer_id: 'cust-2' }],
    ['total', { total_amount_cents: 400001 }],
    ['invoice date (posting month)', { invoice_date: '2026-11-01' }],
    ['payment terms', { payment_terms: 'Net 60' }],
    ['due date', { due_date: '2026-12-01' }],
  ])('is true when the %s changed', (_label, change) => {
    expect(savedInvoiceChangedSinceLoad({ ...LOADED, ...change }, LOADED)).toBe(true);
  });

  it('is true when a line product is swapped at the same total', () => {
    const saved = { ...LOADED, lines: [{ ...LOADED.lines[0], product_id: 'prod-C' }, LOADED.lines[1]] };
    expect(savedInvoiceChangedSinceLoad(saved, LOADED)).toBe(true);
  });

  it('is true when quantities and prices move between lines at the same total', () => {
    const saved = {
      ...LOADED,
      lines: [
        { ...LOADED.lines[0], quantity: 2, unit_price_cents: 75000 },
        LOADED.lines[1],
      ],
    };
    expect(savedInvoiceChangedSinceLoad(saved, LOADED)).toBe(true);
  });

  it('is true when a line was added or removed', () => {
    expect(savedInvoiceChangedSinceLoad({ ...LOADED, lines: [LOADED.lines[0]] }, LOADED)).toBe(true);
    expect(savedInvoiceChangedSinceLoad(
      { ...LOADED, lines: [...LOADED.lines, { id: 'item-3', product_id: 'prod-D', quantity: 0, unit_price_cents: 0, extended_cents: 0 }] },
      LOADED,
    )).toBe(true);
  });
});
