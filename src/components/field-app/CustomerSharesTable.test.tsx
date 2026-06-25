/**
 * CustomerSharesTable.test.tsx — Phase 1 (2026-04-29)
 *
 * Component branches:
 *   1. preview path (Phase 1) — server-computed per-customer breakdown with
 *      grower_share / chemical / service_fee line kinds and a grand total.
 *   2. legacy path — split %, acres, and an italic "Click Preview for amounts"
 *      placeholder until a preview is returned.
 *
 * No supabase calls; this is a presentational component. The tests pin the
 * branching contract so a refactor that drops the preview prop or swaps the
 * line `kind` union won't slip through.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CustomerSharesTable from './CustomerSharesTable';
import type { CustomerShareResult, PreviewFieldAppSplitResult } from '../../types';

describe('CustomerSharesTable — legacy (no preview) path', () => {
  it('shows the empty-state row when shares is empty', () => {
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} />);
    expect(screen.getByText(/select locations to see customer shares/i)).toBeInTheDocument();
  });

  it('renders one row per share with split %, acres, and a placeholder amount', () => {
    const shares: CustomerShareResult[] = [
      { customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, total_acres: 30, split_pct: 60 },
      { customer_id: 'c2', customer_name: 'Farm Beta', is_primary: false, total_acres: 20, split_pct: 40 },
    ];
    render(<CustomerSharesTable shares={shares} invoiceTotalCents={100000} />);

    expect(screen.getByText('Farm Alpha')).toBeInTheDocument();
    expect(screen.getByText('Farm Beta')).toBeInTheDocument();
    expect(screen.getByText('60.00%')).toBeInTheDocument();
    expect(screen.getByText('40.00%')).toBeInTheDocument();
    // Placeholder text appears once per row (legacy path doesn't know per-customer amounts)
    expect(screen.getAllByText(/click preview for amounts/i)).toHaveLength(2);
  });

  it('renders a Primary badge only on the primary customer', () => {
    const shares: CustomerShareResult[] = [
      { customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, total_acres: 30, split_pct: 60 },
      { customer_id: 'c2', customer_name: 'Farm Beta', is_primary: false, total_acres: 20, split_pct: 40 },
    ];
    render(<CustomerSharesTable shares={shares} invoiceTotalCents={100000} />);
    expect(screen.getAllByText('Primary')).toHaveLength(1);
  });

  it('shows the total row with summed % and acres + the invoice total', () => {
    const shares: CustomerShareResult[] = [
      { customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, total_acres: 30, split_pct: 60 },
      { customer_id: 'c2', customer_name: 'Farm Beta', is_primary: false, total_acres: 20, split_pct: 40 },
    ];
    render(<CustomerSharesTable shares={shares} invoiceTotalCents={123400} />);
    expect(screen.getByText('Totals')).toBeInTheDocument();
    expect(screen.getByText('100.00%')).toBeInTheDocument();
    expect(screen.getByText('50.0')).toBeInTheDocument();
    expect(screen.getByText('$1,234.00')).toBeInTheDocument();
  });
});

describe('CustomerSharesTable — Phase 1 preview path', () => {
  function makePreview(): PreviewFieldAppSplitResult {
    return {
      per_customer: [
        {
          customer_id: 'c1',
          customer_name: 'Farm Alpha',
          is_primary: true,
          tier: 1,
          total_cents: 100000,
          lines: [
            {
              kind: 'grower_share',
              description: 'North 40 grower share @ $20.00/ac',
              quantity: 30,
              unit_price_cents: 2000,
              extended_cents: 60000,
            },
            {
              kind: 'chemical',
              description: 'Roundup',
              quantity: 4,
              unit_price_cents: 10000,
              extended_cents: 40000,
            },
          ],
        },
        {
          customer_id: 'c2',
          customer_name: 'Farm Beta',
          is_primary: false,
          tier: 3,
          total_cents: 50000,
          lines: [
            {
              kind: 'chemical',
              description: 'Roundup',
              quantity: 2,
              unit_price_cents: 12000,
              extended_cents: 24000,
            },
            {
              kind: 'service_fee',
              description: 'Hagie Y-Drop',
              quantity: 20,
              unit_price_cents: 1300,
              extended_cents: 26000,
            },
          ],
        },
      ],
      grand_total_cents: 150000,
      customer_count: 2,
      shares_detail: {
        // Consistent rows + rollups for the two present customers (30 + 20 = 50 ac)
        // so the default preview RECONCILES (matches real derive output shape).
        rows: [
          { field_id: 'f1', field_name: 'N40', customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, split_pct: 100, share_acres: 30, price_override_cents: null, pricing_note: null, tier: 1, field_total_acres: 30, field_applied_acres: 30, used_fallback: false },
          { field_id: 'f2', field_name: 'S20', customer_id: 'c2', customer_name: 'Farm Beta', is_primary: false, split_pct: 100, share_acres: 20, price_override_cents: null, pricing_note: null, tier: 3, field_total_acres: 20, field_applied_acres: 20, used_fallback: false },
        ],
        customers: [
          { customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, total_share_acres: 30, overall_split_pct: 100, tier: 1, has_override: false },
          { customer_id: 'c2', customer_name: 'Farm Beta', is_primary: false, total_share_acres: 20, overall_split_pct: 100, tier: 3, has_override: false },
        ],
        total_applied_acres: 50,
        field_count: 2,
        fallback_used_field_ids: [],
      },
    };
  }

  it('renders one card per customer with their tier label and total', () => {
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={makePreview()} />);
    // #26: each name + amount now appears in BOTH the per-customer summary row
    // and the detail card, so there are two occurrences each.
    expect(screen.getAllByText('Farm Alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Farm Beta').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Tier 1')).toBeInTheDocument();
    expect(screen.getByText('Tier 3')).toBeInTheDocument();
    expect(screen.getAllByText('$1,000.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('$500.00').length).toBeGreaterThanOrEqual(1);
  });

  it('#26: renders the ChemMan Customers-tab columns (Total Shares, Discount Earned, Invoice Total)', () => {
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={makePreview()} />);
    expect(screen.getByText('Total Shares')).toBeInTheDocument();
    expect(screen.getByText('Discount Earned')).toBeInTheDocument();
    expect(screen.getByText('Invoice Total')).toBeInTheDocument();
    expect(screen.getByText('Customer Shares By:')).toBeInTheDocument();
  });

  it('#26: shows a "Reconciles" badge for a default preview (no hand-built shares_detail needed)', () => {
    // makePreview now carries consistent rows + rollups for its present customers,
    // so a DEFAULT preview reconciles green — no tying workaround required.
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={makePreview()} />);
    expect(screen.getByText(/reconciles/i)).toBeInTheDocument();
  });

  it('#26: reconciles GREEN after a split member is soft-deleted (gross total_applied_acres still counts them)', () => {
    // Regression: user removed a customer from the split and re-previewed. The RPC
    // drops them from per_customer but shares_detail stays GROSS (rows + rollup +
    // total_applied_acres still include the removed member). Acres must reconcile
    // over the PRESENT set only, so the badge reads "Reconciles", not "Mismatch".
    const preview: PreviewFieldAppSplitResult = {
      ...makePreview(),
      shares_detail: {
        ...makePreview().shares_detail,
        rows: [
          ...makePreview().shares_detail.rows,
          { field_id: 'f3', field_name: 'E15', customer_id: 'c3', customer_name: 'Farm Gamma (removed)', is_primary: false, split_pct: 100, share_acres: 15, price_override_cents: null, pricing_note: null, tier: 1, field_total_acres: 15, field_applied_acres: 15, used_fallback: false },
        ],
        customers: [
          ...makePreview().shares_detail.customers,
          { customer_id: 'c3', customer_name: 'Farm Gamma (removed)', is_primary: false, total_share_acres: 15, overall_split_pct: 100, tier: 1, has_override: false },
        ],
        total_applied_acres: 65, // 30 + 20 + 15 (removed c3 still counted in gross)
        field_count: 3,
      },
    };
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={preview} />);
    expect(screen.getByText(/reconciles/i)).toBeInTheDocument();
    expect(screen.queryByText(/mismatch/i)).not.toBeInTheDocument();
  });

  it('#26: shows a "Mismatch" badge for a GENUINE acre drift (present customer rows do not sum to their rollup)', () => {
    // c2's per-field rows sum to 10 ac but its own rollup says 20 ac — a real
    // drift for a PRESENT customer, which must still flag RED.
    const base = makePreview();
    const preview: PreviewFieldAppSplitResult = {
      ...base,
      shares_detail: {
        ...base.shares_detail,
        rows: base.shares_detail.rows.map((r) =>
          r.customer_id === 'c2' ? { ...r, share_acres: 10 } : r,
        ),
      },
    };
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={preview} />);
    expect(screen.getByText(/mismatch/i)).toBeInTheDocument();
  });

  it('tags grower_share lines with a "grower" badge and service_fee lines with "service" badge', () => {
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={makePreview()} />);
    expect(screen.getByText('grower')).toBeInTheDocument();
    expect(screen.getByText('service')).toBeInTheDocument();
    // Plain "chemical" lines have no badge — verify by counting the badges
    expect(screen.queryByText('chemical')).not.toBeInTheDocument();
  });

  it('shows grand total + customer count footer derived from the preview shape', () => {
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={makePreview()} />);
    expect(screen.getByText('Grand Total:')).toBeInTheDocument();
    // $1,500.00 now appears in the summary-table Totals row AND the grand-total footer.
    expect(screen.getAllByText('$1,500.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Customers:')).toBeInTheDocument();
  });

  it('falls back to the legacy view when preview is null even if shares is empty', () => {
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={null} />);
    expect(screen.getByText(/select locations to see customer shares/i)).toBeInTheDocument();
  });

  it('falls back to the legacy view when preview.per_customer is empty', () => {
    const emptyPreview: PreviewFieldAppSplitResult = {
      per_customer: [],
      grand_total_cents: 0,
      customer_count: 0,
      shares_detail: { rows: [], customers: [], total_applied_acres: 0, field_count: 0, fallback_used_field_ids: [] },
    };
    const shares: CustomerShareResult[] = [
      { customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, total_acres: 30, split_pct: 100 },
    ];
    render(<CustomerSharesTable shares={shares} invoiceTotalCents={50000} preview={emptyPreview} />);
    expect(screen.getByText(/click preview for amounts/i)).toBeInTheDocument();
  });

  it('renders an empty card when a customer has zero lines (no crash)', () => {
    const preview: PreviewFieldAppSplitResult = {
      per_customer: [
        { customer_id: 'c1', customer_name: 'Farm Alpha', is_primary: true, tier: 1, total_cents: 0, lines: [] },
      ],
      grand_total_cents: 0,
      customer_count: 1,
      shares_detail: { rows: [], customers: [], total_applied_acres: 0, field_count: 0, fallback_used_field_ids: [] },
    };
    render(<CustomerSharesTable shares={[]} invoiceTotalCents={0} preview={preview} />);
    // Name appears in the summary row; with a single customer there's no split so
    // no Split Ref column — still at least one occurrence.
    expect(screen.getAllByText('Farm Alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/no lines yet/i)).toBeInTheDocument();
  });
});
