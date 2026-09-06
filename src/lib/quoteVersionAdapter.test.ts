import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptQuoteVersionList, adaptQuoteVersionRow, adaptQuoteVersionRows, type QuoteVersionRow } from './quoteVersionAdapter';

function validRow(): QuoteVersionRow {
  return {
    id: 'version-1',
    quote_id: 'quote-1',
    version_number: 1,
    sent_by: 'profile-1',
    sent_at: '2026-09-05T00:00:00Z',
    sent_method: null,
    snapshot_data: {
      quote: {
        quote_number: 'Q-1',
        customer_id: 'customer-1',
        tier: 1,
        status: 'draft',
        total_price: 100,
        total_cost: 80,
        total_profit: 20,
        total_margin_pct: 20,
        valid_days: 30,
        expires_at: null,
        header_notes: null,
        footer_notes: null,
        is_planned: false,
        commission_split: {
          splits: [{ recipient: 'Rep', recipient_user_id: null, percentage: 100 }],
        },
      },
      sections: [{
        section_name: 'Products',
        sort_order: 1,
        section_notes: null,
        section_header_notes: null,
        needed_by_date: null,
        items: [{
          product_id: 'product-1',
          product_name: 'Product',
          sku: null,
          sort_order: 1,
          notes: null,
          price_per_unit: 100,
          current_cost: 80,
          suggested_rate: null,
          actual_rate: null,
          rate_unit: null,
          oz_per_acre: null,
          price_per_acre: null,
          acres: null,
          total_units_needed: null,
          unit_size: null,
          profit: 20,
          total_price: 100,
          net_margin: 20,
          calc_mode: null,
          price_unit: null,
        }],
      }],
    },
    pdf_url: null,
    notes: null,
    restore_trusted_at: null,
  };
}

describe('quote version row adapter', () => {
  it('preserves a valid structured snapshot and nullable sent method', () => {
    const adapted = adaptQuoteVersionRow(validRow());

    expect(adapted?.sent_method).toBeNull();
    expect(adapted?.snapshot_data.quote.total_margin_pct).toBe(20);
    expect(adapted?.snapshot_data.sections[0].items[0].product_name).toBe('Product');
  });

  it('rejects malformed snapshots before downstream rendering', () => {
    const malformed = validRow();
    malformed.snapshot_data = {
      quote: { total_price: '100' },
      sections: 'not-an-array',
    };

    expect(adaptQuoteVersionRow(malformed)).toBeNull();
    expect(adaptQuoteVersionRows([validRow(), malformed])).toHaveLength(1);
  });

  it('rejects non-finite money and margin values', () => {
    const malformed = validRow();
    if (typeof malformed.snapshot_data !== 'object' || malformed.snapshot_data === null || Array.isArray(malformed.snapshot_data)) {
      throw new Error('test fixture snapshot is malformed');
    }
    const quote = malformed.snapshot_data.quote;
    if (typeof quote !== 'object' || quote === null || Array.isArray(quote)) {
      throw new Error('test fixture quote is malformed');
    }
    quote.total_margin_pct = Number.NaN;

    expect(adaptQuoteVersionRow(malformed)).toBeNull();
  });

  it('keeps legacy snapshots that predate optional section fields', () => {
    const legacy = validRow();
    if (typeof legacy.snapshot_data !== 'object' || legacy.snapshot_data === null || Array.isArray(legacy.snapshot_data)) {
      throw new Error('test fixture snapshot is malformed');
    }
    const sections = legacy.snapshot_data.sections;
    if (!Array.isArray(sections) || typeof sections[0] !== 'object' || sections[0] === null || Array.isArray(sections[0])) {
      throw new Error('test fixture sections are malformed');
    }
    delete sections[0].section_header_notes;
    delete sections[0].needed_by_date;

    const adapted = adaptQuoteVersionRow(legacy);

    expect(adapted?.snapshot_data.sections[0].section_header_notes).toBeNull();
    expect(adapted?.snapshot_data.sections[0].needed_by_date).toBeNull();
  });

  it('guards both QuoteBuilder load sites with the shared adapter', () => {
    const page = readFileSync('src/pages/QuoteBuilder.tsx', 'utf8');

    expect(page.match(/adaptQuoteVersionList\(/g)).toHaveLength(2);
    expect(page).not.toContain('as unknown as QuoteVersion[]');
  });
});

describe('quote version list split', () => {
  function legacyFlatRow(): QuoteVersionRow {
    // The shape the original frontend writer saved: no `quote` key, totals at the top level.
    // Two rows in this shape exist in production.
    const row = validRow();
    row.id = 'version-legacy';
    row.version_number = 1;
    row.snapshot_data = {
      quote_number: 'Q-legacy',
      customer_id: 'customer-1',
      customer_name: 'Customer',
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      commission_split: null,
      totals: { total_price: 100 },
      sections: [],
    };
    return row;
  }

  it('keeps an unreadable snapshot in the list instead of dropping the row', () => {
    const readable = validRow();
    const { versions, unreadable } = adaptQuoteVersionList([readable, legacyFlatRow()]);

    expect(versions.map((v) => v.id)).toEqual(['version-1']);
    expect(unreadable.map((v) => v.id)).toEqual(['version-legacy']);
  });

  it('does not lose a quote whose only saved versions are unreadable', () => {
    const { versions, unreadable } = adaptQuoteVersionList([legacyFlatRow()]);

    // The regression this guards: an all-legacy quote used to come back empty, which hid its
    // version history button entirely.
    expect(versions).toHaveLength(0);
    expect(unreadable).toHaveLength(1);
  });

  it('carries only row columns for an unreadable version, never snapshot values', () => {
    const { unreadable } = adaptQuoteVersionList([legacyFlatRow()]);

    expect(unreadable[0]).toEqual({
      id: 'version-legacy',
      version_number: 1,
      sent_at: '2026-09-05T00:00:00Z',
      server_trusted: false,
    });
  });

  it('marks an unreadable row the server stamped as restorable as an anomaly, not legacy', () => {
    // restore_trusted_at is set only by the current version writer and was never backfilled
    // (20260826220000), so a row carrying it should always parse. One that does not is
    // corruption or writer/validator drift — the caller has to be able to tell the difference.
    const row = legacyFlatRow();
    row.restore_trusted_at = '2026-09-06T00:00:00Z';

    const { unreadable } = adaptQuoteVersionList([row]);

    expect(unreadable[0].server_trusted).toBe(true);
  });

  it('treats a row the server never stamped as expected legacy data', () => {
    const row = legacyFlatRow();
    row.restore_trusted_at = null;

    const { unreadable } = adaptQuoteVersionList([row]);

    expect(unreadable[0].server_trusted).toBe(false);
  });

  it('returns empty lists for no rows', () => {
    expect(adaptQuoteVersionList(null)).toEqual({ versions: [], unreadable: [] });
    expect(adaptQuoteVersionList([])).toEqual({ versions: [], unreadable: [] });
  });

  it('lists unreadable versions in the page without an item count or total', () => {
    const page = readFileSync('src/pages/QuoteBuilder.tsx', 'utf8');

    expect(page).toContain('unreadableQuoteVersions.map');
    expect(page).toContain('Saved in an older format');
    // The anomaly path must stay wired: listing a row the server trusts must not silence it.
    expect(page).toContain('reportUntrustworthyQuoteVersions');
    // The version-count button and the history card must both count them, or an all-legacy
    // quote still shows nothing.
    expect(page.match(/savedVersionCount/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
