/**
 * customerSplit.test.ts — section #26 pure split helpers.
 *
 * The split engine (save_field_app_invoice / preview_field_app_invoice_split)
 * computes each customer's invoice INDEPENDENTLY, so the grand total is the SUM
 * of the per-customer totals. These tests pin:
 *   - deriveSplitRef:  the "<jobnumber>-<NNN>" / "<invoice>-<NNN>" convention.
 *   - reconcileSplit:  penny-exactness (sum of per-customer cents === grand
 *     total, to the CENT) AND acre conservation — INCLUDING the awkward case of
 *     a total that does not divide evenly (e.g. $1000.01 split 1/3 - 2/3, which
 *     must still sum to exactly 100001 cents).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveSplitRef,
  reconcileSplit,
  customerShareAcres,
  customerSharePct,
  CUSTOMER_SHARES_BASIS_OPTIONS,
} from './customerSplit';
import type { PreviewFieldAppSplitResult } from '../../types';

describe('deriveSplitRef', () => {
  it('appends a zero-padded 3-digit sequence for split invoices', () => {
    expect(deriveSplitRef('230568', 0, true)).toBe('230568-001');
    expect(deriveSplitRef('230568', 1, true)).toBe('230568-002');
    expect(deriveSplitRef('230568', 9, true)).toBe('230568-010');
    expect(deriveSplitRef('230568', 99, true)).toBe('230568-100');
  });

  it('returns the base unchanged for a non-split (single-customer) invoice', () => {
    expect(deriveSplitRef('INV-2026-0042', 0, false)).toBe('INV-2026-0042');
  });

  it('falls back to the invoice number as base when there is no job number', () => {
    expect(deriveSplitRef('INV-2026-0042', 1, true)).toBe('INV-2026-0042-002');
  });

  it('trims whitespace and tolerates an empty base', () => {
    expect(deriveSplitRef('  230568  ', 0, true)).toBe('230568-001');
    expect(deriveSplitRef('', 2, true)).toBe('003');
  });
});

describe('CUSTOMER_SHARES_BASIS_OPTIONS', () => {
  it('offers the two ChemMan bases: Locations and Share %', () => {
    expect(CUSTOMER_SHARES_BASIS_OPTIONS.map((o) => o.value)).toEqual(['location', 'share']);
  });
});

/** Build a preview whose per-customer totals sum to grandTotalCents and whose
 *  share rows sum (per customer) to the given acres. */
function makePreview(
  customers: { id: string; name: string; cents: number; acres: number; pct: number; primary?: boolean }[],
  grandTotalCents: number,
  totalAppliedAcres: number,
): PreviewFieldAppSplitResult {
  return {
    per_customer: customers.map((c) => ({
      customer_id: c.id,
      customer_name: c.name,
      is_primary: !!c.primary,
      tier: 1,
      total_cents: c.cents,
      lines: [
        { kind: 'chemical', description: 'Roundup', quantity: c.acres, unit_price_cents: 100, extended_cents: c.cents },
      ],
    })),
    grand_total_cents: grandTotalCents,
    customer_count: customers.length,
    shares_detail: {
      rows: customers.map((c) => ({
        field_id: `f-${c.id}`,
        field_name: `Field ${c.id}`,
        customer_id: c.id,
        customer_name: c.name,
        is_primary: !!c.primary,
        split_pct: c.pct,
        share_acres: c.acres,
        price_override_cents: null,
        pricing_note: null,
        tier: 1,
        field_total_acres: c.acres,
        field_applied_acres: c.acres,
        used_fallback: false,
      })),
      customers: customers.map((c) => ({
        customer_id: c.id,
        customer_name: c.name,
        is_primary: !!c.primary,
        total_share_acres: c.acres,
        overall_split_pct: c.pct,
        tier: 1,
        has_override: false,
      })),
      total_applied_acres: totalAppliedAcres,
      field_count: customers.length,
      fallback_used_field_ids: [],
    },
  };
}

describe('reconcileSplit — penny-exactness', () => {
  it('balances a clean 60/40 split', () => {
    // $1200.00 → $720 / $480
    const p = makePreview(
      [
        { id: 'c1', name: 'A', cents: 72000, acres: 60, pct: 60, primary: true },
        { id: 'c2', name: 'B', cents: 48000, acres: 40, pct: 40 },
      ],
      120000,
      100,
    );
    const r = reconcileSplit(p);
    expect(r.sumCustomerCents).toBe(120000);
    expect(r.grandTotalCents).toBe(120000);
    expect(r.centDifference).toBe(0);
    expect(r.sumCustomerAcres).toBe(100);
    expect(r.totalAppliedAcres).toBe(100);
    expect(r.balanced).toBe(true);
  });

  it('the indivisible case: $1000.01 split 1/3 - 2/3 still sums to EXACTLY 100001 cents', () => {
    // The server rounds each customer independently. 100001 / 3 = 33333.67 →
    // a faithful split is 33334 (1/3, rounded up) + 66667 (2/3) = 100001.
    // The engine never divides the grand total, so the sum is exact by
    // construction — reconcileSplit must confirm 0 cent difference.
    const oneThird = 33334;
    const twoThirds = 66667;
    expect(oneThird + twoThirds).toBe(100001); // sanity: the pieces sum exactly
    const p = makePreview(
      [
        { id: 'c1', name: 'A', cents: twoThirds, acres: 66.67, pct: 66.6667, primary: true },
        { id: 'c2', name: 'B', cents: oneThird, acres: 33.33, pct: 33.3333 },
      ],
      100001,
      100,
    );
    const r = reconcileSplit(p);
    expect(r.sumCustomerCents).toBe(100001);
    expect(r.grandTotalCents).toBe(100001);
    expect(r.centDifference).toBe(0);
    expect(r.balanced).toBe(true);
  });

  it('flags a mismatch when the per-customer cents do NOT sum to the grand total', () => {
    // Corrupt fixture: grand total claims 100001 but pieces sum to 100000.
    const p = makePreview(
      [
        { id: 'c1', name: 'A', cents: 66667, acres: 66.67, pct: 66.6667, primary: true },
        { id: 'c2', name: 'B', cents: 33333, acres: 33.33, pct: 33.3333 },
      ],
      100001,
      100,
    );
    const r = reconcileSplit(p);
    expect(r.sumCustomerCents).toBe(100000);
    expect(r.grandTotalCents).toBe(100001);
    expect(r.centDifference).toBe(-1);
    expect(r.balanced).toBe(false);
  });

  it('flags a GENUINE acre drift (present customer rows do NOT sum to that customer own rollup) even when dollars tie out', () => {
    // A real drift: customer c2 own rollup says 40 acres, but its per-field share
    // rows only sum to 35 — the split lost 5 acres for a PRESENT customer. That
    // must stay RED. (The badge compares each present customer row sum vs their
    // own total_share_acres rollup, NOT the gross total_applied_acres.)
    const p = makePreview(
      [
        { id: 'c1', name: 'A', cents: 60000, acres: 60, pct: 60, primary: true },
        { id: 'c2', name: 'B', cents: 40000, acres: 40, pct: 40 },
      ],
      100000,
      100,
    );
    // Corrupt only c2's per-field row acres (35), leaving its rollup at 40.
    p.shares_detail.rows = p.shares_detail.rows.map((row) =>
      row.customer_id === 'c2' ? { ...row, share_acres: 35 } : row,
    );
    const r = reconcileSplit(p);
    expect(r.centDifference).toBe(0);
    expect(r.sumCustomerAcres).toBe(95); // 60 + 35 (rows)
    expect(r.totalAppliedAcres).toBe(100); // 60 + 40 (rollups)
    expect(r.acreDifference).toBeCloseTo(-5, 2);
    expect(r.balanced).toBe(false);
  });

  it('reconciles GREEN after a split member is soft-deleted (per_customer excludes them, gross total_applied_acres still includes them, dollars tie)', () => {
    // Regression for the soft-delete false "Mismatch": the user removed customer
    // c3 from the split and re-previewed. The preview RPC CONTINUE-skips c3 from
    // per_customer, but shares_detail (rows, customers, total_applied_acres) is
    // the GROSS derive output that still carries c3's 25 acres. Dollars tie over
    // the present two customers; acres must reconcile over the present set only.
    const p = makePreview(
      [
        { id: 'c1', name: 'A', cents: 60000, acres: 60, pct: 48, primary: true },
        { id: 'c2', name: 'B', cents: 40000, acres: 40, pct: 32 },
      ],
      100000,
      125, // GROSS total_applied_acres = 60 + 40 + 25 (the removed c3 still counted)
    );
    // shares_detail still carries the soft-deleted c3 (a row + a customers rollup)
    // — exactly what derive_customer_shares_from_fields returns; per_customer omits it.
    p.shares_detail.rows.push({
      field_id: 'f-c3', field_name: 'Field c3', customer_id: 'c3', customer_name: 'C (removed)',
      is_primary: false, split_pct: 20, share_acres: 25, price_override_cents: null,
      pricing_note: null, tier: 1, field_total_acres: 25, field_applied_acres: 25, used_fallback: false,
    });
    p.shares_detail.customers.push({
      customer_id: 'c3', customer_name: 'C (removed)', is_primary: false,
      total_share_acres: 25, overall_split_pct: 20, tier: 1, has_override: false,
    });
    const r = reconcileSplit(p);
    expect(r.centDifference).toBe(0);
    expect(r.sumCustomerAcres).toBe(100); // present c1+c2 rows, NOT the gross 125
    expect(r.totalAppliedAcres).toBe(100); // present c1+c2 rollups, NOT the gross 125
    expect(r.acreDifference).toBe(0);
    expect(r.balanced).toBe(true); // GREEN — was falsely RED before the fix
  });

  it('handles a single-customer (100%) split', () => {
    const p = makePreview(
      [{ id: 'c1', name: 'A', cents: 51973, acres: 148.5, pct: 100, primary: true }],
      51973,
      148.5,
    );
    const r = reconcileSplit(p);
    expect(r.centDifference).toBe(0);
    expect(r.sumCustomerAcres).toBe(148.5);
    expect(r.balanced).toBe(true);
  });

  it('reproduces the ChemMan job 230568 example (148.50 + 96.90 = 245.40 ac)', () => {
    // invoice 230568-001 ($519.73, 148.50 ac) + 230568-002 ($339.14, 96.90 ac)
    const p = makePreview(
      [
        { id: 'c1', name: 'A17-Mcammon 40', cents: 51973, acres: 148.5, pct: 60.51, primary: true },
        { id: 'c2', name: 'L10-N Robinson East', cents: 33914, acres: 96.9, pct: 39.49 },
      ],
      85887,
      245.4,
    );
    const r = reconcileSplit(p);
    expect(r.sumCustomerCents).toBe(85887); // $858.87 total
    expect(r.centDifference).toBe(0);
    expect(r.sumCustomerAcres).toBe(245.4);
    expect(r.totalAppliedAcres).toBe(245.4);
    expect(r.balanced).toBe(true);
  });
});

describe('customerShareAcres / customerSharePct', () => {
  const p = makePreview(
    [
      { id: 'c1', name: 'A', cents: 72000, acres: 60, pct: 60, primary: true },
      { id: 'c2', name: 'B', cents: 48000, acres: 40, pct: 40 },
    ],
    120000,
    100,
  );

  it('sums a customer share acres from the share rows', () => {
    expect(customerShareAcres(p, 'c1')).toBe(60);
    expect(customerShareAcres(p, 'c2')).toBe(40);
    expect(customerShareAcres(p, 'missing')).toBe(0);
  });

  it('reads a customer overall split percentage', () => {
    expect(customerSharePct(p, 'c1')).toBe(60);
    expect(customerSharePct(p, 'c2')).toBe(40);
    expect(customerSharePct(p, 'missing')).toBe(0);
  });
});
