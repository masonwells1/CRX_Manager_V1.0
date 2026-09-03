import { describe, it, expect } from 'vitest';
import {
  isUnpostedFieldInvoice,
  isPostedFieldInvoice,
  STATUS_POSTED,
  mapFieldInvoiceRow,
  applyFieldInvoiceFilters,
  computeFieldInvoiceTotals,
  emptyFieldInvoiceFilters,
  batchMonthOf,
  currentBatchMonth,
  monthLabel,
  deriveMonthBatches,
  applyPostedScope,
  spansMultipleBatches,
  defaultPostedScope,
  type RawFieldInvoiceRow,
  type FieldInvoiceListRow,
} from './fieldInvoiceList';

const baseRaw = (over: Partial<RawFieldInvoiceRow>): RawFieldInvoiceRow => ({
  id: 'inv-1',
  invoice_number: 'FA-1001',
  order_id: null,
  blend_ticket_id: null,
  customer_id: 'cust-1',
  invoice_type: 'field_application',
  status: 'unposted',
  season: 2026,
  salesman_id: null,
  created_by: 'u1',
  total_amount_cents: 12345,
  paid_amount_cents: 0,
  prepay_applied_cents: 0,
  credit_applied_cents: 0,
  balance_cents: 12345,
  posted_by: null,
  posted_at: null,
  voided_by: null,
  voided_at: null,
  void_reason: null,
  pricing_pending: false,
  invoice_date: '2026-06-10',
  due_date: null,
  due_date_source: 'system',
  purchase_order_ref: null,
  header_notes: null,
  footer_notes: null,
  payment_terms: null,
  internal_notes: null,
  discount_earned_cents: 0,
  discount_date: null,
  parent_invoice_id: null,
  crop_type: null,
  field_names: null,
  total_acres: null,
  applicator_name: null,
  wind_direction: null,
  temperature_text: null,
  vehicle_name: null,
  application_date: null,
  job_id: null,
  total_cost_cents: 0,
  write_off_cents: 0,
  invoice_group_id: null,
  application_service_id: null,
  delivery_id: null,
  deleted_at: null,
  created_at: '2026-06-10T00:00:00Z',
  updated_at: '2026-06-10T00:00:00Z',
  ...over,
});

describe('isUnpostedFieldInvoice', () => {
  it('treats draft and unposted as the working tray', () => {
    expect(isUnpostedFieldInvoice('draft')).toBe(true);
    expect(isUnpostedFieldInvoice('unposted')).toBe(true);
  });
  it('excludes posted/paid/overdue/voided/cancelled', () => {
    for (const s of ['posted', 'paid', 'overdue', 'voided', 'cancelled'] as const) {
      expect(isUnpostedFieldInvoice(s)).toBe(false);
    }
  });
});

describe('mapFieldInvoiceRow — engine-built (child locations)', () => {
  it('derives locations, crops and summed applied acres from field_app_locations', () => {
    const row = mapFieldInvoiceRow(baseRaw({
      customer: { farm_name: 'Green Acres' },
      job: { job_number: 'JOB-77' },
      field_app_locations: [
        { applied_acres: 30, crop_type: 'Corn', field: { field_name: 'East 40', crop_type: 'Corn' } },
        { applied_acres: 12.5, crop_type: null, field: { field_name: 'North 80', crop_type: 'Soybeans' } },
        // duplicate field name should be deduped, acres still summed
        { applied_acres: 5, crop_type: 'Corn', field: { field_name: 'East 40', crop_type: 'Corn' } },
      ],
      invoice_items: [
        { is_application_fee: false, product: { product_name: 'Roundup' } },
        { is_application_fee: true, description: 'Application Fee' },
        { is_application_fee: false, product: { product_name: 'Roundup' } }, // dup
        { is_application_fee: false, product: null, description: 'AMS' },
      ],
    }));
    expect(row.locations).toEqual(['East 40', 'North 80']);
    expect(row.crops).toEqual(['Corn', 'Soybeans']);
    expect(row.total_acres).toBe(47.5);
    expect(row.chemicals).toEqual(['Roundup', 'AMS']); // app fee excluded, dup removed
    expect(row.job_number).toBe('JOB-77');
    expect(row.customer_name).toBe('Green Acres');
  });

  it('falls back to invoice snapshot when there are no child locations', () => {
    const row = mapFieldInvoiceRow(baseRaw({
      field_names: ['Home Quarter', 'Back 40'],
      crop_type: 'Wheat',
      total_acres: 160,
      applicator_name: 'Sam Spray',
      field_app_locations: [],
    }));
    expect(row.locations).toEqual(['Home Quarter', 'Back 40']);
    expect(row.crops).toEqual(['Wheat']);
    expect(row.total_acres).toBe(160);
    expect(row.applicators).toEqual(['Sam Spray']);
  });

  it('treats null applied_acres as zero (fresh location)', () => {
    const row = mapFieldInvoiceRow(baseRaw({
      field_app_locations: [
        { applied_acres: null, field: { field_name: 'New Field' } },
        { applied_acres: 10, field: { field_name: 'Other' } },
      ],
    }));
    expect(row.total_acres).toBe(10);
  });

  it('defaults unknown customer name', () => {
    const row = mapFieldInvoiceRow(baseRaw({ customer: null }));
    expect(row.customer_name).toBe('Unknown');
    expect(row.job_number).toBeNull();
  });

  it('carries the money fields through for the PDF (paid/prepay/write-off/cost)', () => {
    const row = mapFieldInvoiceRow(baseRaw({
      total_amount_cents: 50000,
      paid_amount_cents: 20000,
      prepay_applied_cents: 5000,
      write_off_cents: 1000,
      total_cost_cents: 30000,
      balance_cents: 25000,
    }));
    expect(row.total_amount_cents).toBe(50000);
    expect(row.paid_amount_cents).toBe(20000);
    expect(row.prepay_applied_cents).toBe(5000);
    expect(row.write_off_cents).toBe(1000);
    expect(row.total_cost_cents).toBe(30000);
    expect(row.balance_cents).toBe(25000);
  });

  it('does NOT silently default money fields to 0 — a balance<total invoice keeps its payments', () => {
    // Regression for LOW#3: a posted invoice WITH a payment has balance < total.
    // If paid/prepay were dropped, the PDF would print a full Total but a lower
    // Balance Due with no Payments line — they would disagree. Here we prove the
    // row preserves the components so the PDF totals reconcile:
    //   total - payments - prepay === balance.
    const row = mapFieldInvoiceRow(baseRaw({
      total_amount_cents: 100000,
      paid_amount_cents: 30000,
      prepay_applied_cents: 10000,
      balance_cents: 60000,
    }));
    expect(row.balance_cents).toBeLessThan(row.total_amount_cents);
    expect(row.total_amount_cents - row.paid_amount_cents - row.prepay_applied_cents)
      .toBe(row.balance_cents);
  });
});

describe('mapFieldInvoiceRow — grouped (split, multi-customer) invoice', () => {
  // The per-acre engine keys a split invoice's field_app_locations by
  // invoice_group_id with invoice_id=NULL, so the invoice_id-FK embed comes back
  // EMPTY and the invoice-level snapshot columns (field_names/crop_type/
  // total_acres) are NEVER written. The page fetches the locations by group and
  // injects them into field_app_locations before mapping — this proves that,
  // once injected, Locations/Crops/Acres populate and do NOT silently blank.
  it('populates locations/crops/acres from the injected group-keyed locations', () => {
    const grouped = baseRaw({
      invoice_group_id: 'grp-9',
      // snapshot fallback columns are null for grouped invoices (engine never writes them)
      field_names: null,
      crop_type: null,
      total_acres: null,
      // Embedded (invoice_id-keyed) locations come back EMPTY for a grouped invoice…
      field_app_locations: [],
    });
    // …and the page injects the group-matched rows here before mapping:
    grouped.field_app_locations = [
      { applied_acres: 40, crop_type: 'Corn', field: { field_name: 'Pole Field', crop_type: 'Corn' } },
      { applied_acres: 22.5, crop_type: null, field: { field_name: 'Leaming 92', crop_type: 'Soybeans' } },
    ];

    const row = mapFieldInvoiceRow(grouped);
    expect(row.locations).toEqual(['Pole Field', 'Leaming 92']);
    expect(row.crops).toEqual(['Corn', 'Soybeans']);
    expect(row.total_acres).toBe(62.5);
    // and these MUST NOT be blank/zero (the bug this guards against)
    expect(row.locations.length).toBeGreaterThan(0);
    expect(row.crops.length).toBeGreaterThan(0);
    expect(row.total_acres).toBeGreaterThan(0);
  });

  it('a grouped invoice with NO injected locations and null snapshots blanks honestly (not a crash)', () => {
    // If the group fetch returned nothing, the row should degrade to empty —
    // never throw — so the list still renders.
    const row = mapFieldInvoiceRow(baseRaw({
      invoice_group_id: 'grp-empty',
      field_names: null,
      crop_type: null,
      total_acres: null,
      field_app_locations: [],
    }));
    expect(row.locations).toEqual([]);
    expect(row.crops).toEqual([]);
    expect(row.total_acres).toBe(0);
  });
});

describe('applyFieldInvoiceFilters', () => {
  const rows: FieldInvoiceListRow[] = [
    mapFieldInvoiceRow(baseRaw({ id: 'a', invoice_number: 'FA-1001', customer_id: 'c1', invoice_date: '2026-06-01', customer: { farm_name: 'Alpha Farm' } })),
    mapFieldInvoiceRow(baseRaw({ id: 'b', invoice_number: 'FA-1002', customer_id: 'c2', invoice_date: '2026-06-15', customer: { farm_name: 'Beta Farm' } })),
    mapFieldInvoiceRow(baseRaw({ id: 'c', invoice_number: 'FA-2099', customer_id: 'c1', invoice_date: '2026-06-30', customer: { farm_name: 'Alpha Farm' } })),
  ];

  it('returns all rows with empty filters', () => {
    expect(applyFieldInvoiceFilters(rows, emptyFieldInvoiceFilters).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters by invoice number substring (case-insensitive)', () => {
    expect(applyFieldInvoiceFilters(rows, { ...emptyFieldInvoiceFilters, invoiceNumber: 'fa-10' }).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('filters by selected customers (OR within set)', () => {
    expect(applyFieldInvoiceFilters(rows, { ...emptyFieldInvoiceFilters, customerIds: ['c1'] }).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('filters by inclusive transaction date range', () => {
    expect(applyFieldInvoiceFilters(rows, { ...emptyFieldInvoiceFilters, dateFrom: '2026-06-10', dateTo: '2026-06-20' }).map((r) => r.id)).toEqual(['b']);
    // inclusive bounds
    expect(applyFieldInvoiceFilters(rows, { ...emptyFieldInvoiceFilters, dateFrom: '2026-06-15', dateTo: '2026-06-15' }).map((r) => r.id)).toEqual(['b']);
  });

  it('combines customer + date range AND-wise (acceptance criterion #8)', () => {
    const out = applyFieldInvoiceFilters(rows, { ...emptyFieldInvoiceFilters, customerIds: ['c1'], dateFrom: '2026-06-20', dateTo: '2026-06-30' });
    expect(out.map((r) => r.id)).toEqual(['c']);
  });

  it('applies the free-text search over the blob', () => {
    expect(applyFieldInvoiceFilters(rows, { ...emptyFieldInvoiceFilters, search: 'beta' }).map((r) => r.id)).toEqual(['b']);
  });
});

describe('isPostedFieldInvoice / STATUS_POSTED (#23 committed statuses)', () => {
  it('treats posted, overdue and paid as committed (on the Posted list)', () => {
    for (const s of ['posted', 'overdue', 'paid'] as const) {
      expect(isPostedFieldInvoice(s)).toBe(true);
    }
  });
  it('excludes the working tray and terminal reversals', () => {
    for (const s of ['draft', 'unposted', 'voided', 'cancelled'] as const) {
      expect(isPostedFieldInvoice(s)).toBe(false);
    }
  });
  it('posted and unposted status sets are disjoint (a posted invoice never shows on the unposted tray)', () => {
    for (const s of STATUS_POSTED) {
      expect(isUnpostedFieldInvoice(s)).toBe(false);
    }
  });
});

describe('month-batch helpers (#23 scope selector)', () => {
  it('batchMonthOf takes the YYYY-MM of an invoice_date', () => {
    expect(batchMonthOf('2026-06-10')).toBe('2026-06');
    expect(batchMonthOf('2026-01-31')).toBe('2026-01');
  });

  it('currentBatchMonth zero-pads the month', () => {
    expect(currentBatchMonth(new Date('2026-03-05T12:00:00'))).toBe('2026-03');
    expect(currentBatchMonth(new Date('2026-11-20T12:00:00'))).toBe('2026-11');
  });

  it('monthLabel renders a friendly label', () => {
    expect(monthLabel('2026-06')).toBe('June 2026');
    expect(monthLabel('2025-12')).toBe('December 2025');
  });

  it('deriveMonthBatches lists distinct months newest-first with counts', () => {
    const rows: FieldInvoiceListRow[] = [
      mapFieldInvoiceRow(baseRaw({ id: 'a', invoice_date: '2026-06-01', field_app_locations: [] })),
      mapFieldInvoiceRow(baseRaw({ id: 'b', invoice_date: '2026-06-28', field_app_locations: [] })),
      mapFieldInvoiceRow(baseRaw({ id: 'c', invoice_date: '2026-05-15', field_app_locations: [] })),
    ];
    const batches = deriveMonthBatches(rows);
    expect(batches.map((b) => b.month)).toEqual(['2026-06', '2026-05']); // newest first
    expect(batches[0]).toMatchObject({ month: '2026-06', label: 'June 2026', count: 2 });
    expect(batches[1]).toMatchObject({ month: '2026-05', label: 'May 2026', count: 1 });
  });
});

describe('applyPostedScope', () => {
  const rows: FieldInvoiceListRow[] = [
    mapFieldInvoiceRow(baseRaw({ id: 'jun1', invoice_date: '2026-06-03', field_app_locations: [] })),
    mapFieldInvoiceRow(baseRaw({ id: 'jun2', invoice_date: '2026-06-29', field_app_locations: [] })),
    mapFieldInvoiceRow(baseRaw({ id: 'may1', invoice_date: '2026-05-10', field_app_locations: [] })),
  ];

  it('season scope returns every row (already windowed by the query)', () => {
    expect(applyPostedScope(rows, defaultPostedScope).map((r) => r.id)).toEqual(['jun1', 'jun2', 'may1']);
  });

  it('mtd scope keeps only the current calendar month', () => {
    const out = applyPostedScope(rows, { kind: 'mtd' }, new Date('2026-06-15T12:00:00'));
    expect(out.map((r) => r.id)).toEqual(['jun1', 'jun2']);
  });

  it('batch scope keeps only the chosen month', () => {
    expect(applyPostedScope(rows, { kind: 'batch', month: '2026-05' }).map((r) => r.id)).toEqual(['may1']);
    expect(applyPostedScope(rows, { kind: 'batch', month: '2026-06' }).map((r) => r.id)).toEqual(['jun1', 'jun2']);
  });
});

describe('spansMultipleBatches (#23 dynamic month-batch warning)', () => {
  it('is false within a single batch', () => {
    const rows: FieldInvoiceListRow[] = [
      mapFieldInvoiceRow(baseRaw({ id: 'a', invoice_date: '2026-06-01', field_app_locations: [] })),
      mapFieldInvoiceRow(baseRaw({ id: 'b', invoice_date: '2026-06-30', field_app_locations: [] })),
    ];
    expect(spansMultipleBatches(rows)).toBe(false);
  });

  it('is true when rows cross a month boundary', () => {
    const rows: FieldInvoiceListRow[] = [
      mapFieldInvoiceRow(baseRaw({ id: 'a', invoice_date: '2026-05-31', field_app_locations: [] })),
      mapFieldInvoiceRow(baseRaw({ id: 'b', invoice_date: '2026-06-01', field_app_locations: [] })),
    ];
    expect(spansMultipleBatches(rows)).toBe(true);
  });

  it('is false for an empty list', () => {
    expect(spansMultipleBatches([])).toBe(false);
  });
});

describe('computeFieldInvoiceTotals', () => {
  it('sums acres and cents (integer cents) and counts', () => {
    const rows: FieldInvoiceListRow[] = [
      mapFieldInvoiceRow(baseRaw({ id: 'a', total_amount_cents: 10050, total_acres: 40, field_app_locations: [] })),
      mapFieldInvoiceRow(baseRaw({ id: 'b', total_amount_cents: 9999, total_acres: 12.5, field_app_locations: [] })),
    ];
    const t = computeFieldInvoiceTotals(rows);
    expect(t.totalAmountCents).toBe(20049); // 10050 + 9999, no float drift
    expect(t.totalAcres).toBe(52.5);
    expect(t.count).toBe(2);
  });

  it('is zero for an empty list', () => {
    const t = computeFieldInvoiceTotals([]);
    expect(t).toEqual({ totalAcres: 0, totalAmountCents: 0, count: 0 });
  });
});
