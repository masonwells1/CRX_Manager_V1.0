import { describe, expect, it } from 'vitest';
import type { QuoteVersion } from '../types';
import { sentLineState, sentItemsOf, unsentQuoteChange } from './quotePriceLock';

type SentItem = QuoteVersion['snapshot_data']['sections'][number]['items'][number];

function sentItem(overrides: Partial<SentItem>): SentItem {
  return {
    product_id: 'p1', product_name: 'P', sku: null, sort_order: 0, notes: null, price_per_unit: 10,
    current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null,
    price_per_acre: null, acres: null, total_units_needed: 2, unit_size: 'gal', profit: 8, total_price: 20,
    net_margin: 40, calc_mode: 'units_direct', price_unit: null,
    ...overrides,
  };
}

function version(items: SentItem[], number = 1, customerId = 'c1'): QuoteVersion {
  return {
    id: `v${number}`, quote_id: 'q1', version_number: number, sent_by: 'u1', sent_at: '2026-10-25T00:00:00Z',
    sent_method: 'presented', pdf_url: null, notes: null,
    snapshot_data: {
      quote: {
        quote_number: 'Q', customer_id: customerId, tier: 1, status: 'sent', total_price: 20, valid_days: 15,
        expires_at: null, header_notes: null, footer_notes: null, is_planned: false, commission_split: null,
      },
      sections: [{ section_name: 'S', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, items }],
    },
  };
}

describe('quote price lock (mirrors _assert_quote_prices_as_sent)', () => {
  const withIds = [sentItem({ quote_item_id: 'i1' })];

  it('matches a line by its id, product and price when the version records ids', () => {
    expect(sentLineState(withIds, { id: 'i1', product_id: 'p1', price_per_unit: 10 })).toBeNull();
    expect(sentLineState(withIds, { id: 'i1', product_id: 'p1', price_per_unit: 12 })).toEqual({ kind: 'price', sentCents: 1000 });
    // A new line of a product that was sent, at the same price, is still a line the customer was not sent.
    expect(sentLineState(withIds, { product_id: 'p1', price_per_unit: 10 })).toEqual({ kind: 'new' });
    expect(sentLineState(withIds, { id: 'i1', product_id: 'p2', price_per_unit: 10 })).toEqual({ kind: 'new' });
  });

  it('matches by product for a version written before line ids', () => {
    const legacy = [sentItem({})];
    expect(sentLineState(legacy, { product_id: 'p1', price_per_unit: 10 })).toBeNull();
    expect(sentLineState(legacy, { product_id: 'p1', price_per_unit: 11 })).toEqual({ kind: 'price', sentCents: 1000 });
    expect(sentLineState(legacy, { product_id: 'p2', price_per_unit: 10 })).toEqual({ kind: 'new' });
  });

  it('needs a re-send for a changed customer, a changed line, or an unreadable newer version', () => {
    const v1 = version(withIds);
    const lines = [{ id: 'i1', product_id: 'p1', price_per_unit: 10 }];
    expect(unsentQuoteChange({ lastSent: v1, newestVersionNumber: 1, customerId: 'c1', lines })).toBeNull();
    expect(unsentQuoteChange({ lastSent: v1, newestVersionNumber: 1, customerId: 'c2', lines })).toBe('customer');
    expect(unsentQuoteChange({ lastSent: v1, newestVersionNumber: 1, customerId: 'c1',
      lines: [...lines, { product_id: 'p1', price_per_unit: 10 }] })).toBe('prices');
    expect(unsentQuoteChange({ lastSent: v1, newestVersionNumber: 2, customerId: 'c1', lines })).toBe('unreadable');
    expect(unsentQuoteChange({ lastSent: null, newestVersionNumber: 0, customerId: 'c1', lines })).toBeNull();
  });

  // Item 10b (Mason 2026-10-27, 20261029120000): a saved line's price may change straight away; the
  // database records it, so only a new line, a changed customer, or a version without line ids
  // still needs a re-send.
  it('a changed price on a line the customer was sent needs no re-send', () => {
    const v1 = version(withIds);
    expect(unsentQuoteChange({ lastSent: v1, newestVersionNumber: 1, customerId: 'c1',
      lines: [{ id: 'i1', product_id: 'p1', price_per_unit: 12 }] })).toBeNull();
    // Still shown on the line, so the rep sees what the customer was sent.
    expect(sentLineState(withIds, { id: 'i1', product_id: 'p1', price_per_unit: 12 })).toEqual({ kind: 'price', sentCents: 1000 });
    // A version written before line ids cannot tell the lines apart: still a re-send.
    expect(unsentQuoteChange({ lastSent: version([sentItem({})]), newestVersionNumber: 1, customerId: 'c1',
      lines: [{ id: 'i1', product_id: 'p1', price_per_unit: 12 }] })).toBe('prices');
  });

  it('allows a removed line when the version records ids, but not when lines pair by product', () => {
    const twoWithIds = version([sentItem({ quote_item_id: 'i1' }), sentItem({ quote_item_id: 'i2', product_id: 'p2' })]);
    const oneLine = [{ id: 'i1', product_id: 'p1', price_per_unit: 10 }];
    expect(unsentQuoteChange({ lastSent: twoWithIds, newestVersionNumber: 1, customerId: 'c1', lines: oneLine })).toBeNull();
    const twoLegacy = version([sentItem({}), sentItem({ product_id: 'p2' })]);
    expect(unsentQuoteChange({ lastSent: twoLegacy, newestVersionNumber: 1, customerId: 'c1', lines: oneLine })).toBe('prices');
    expect(sentItemsOf(twoLegacy)).toHaveLength(2);
  });
});
