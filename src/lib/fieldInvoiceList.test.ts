import { describe, it, expect } from 'vitest';
import {
  isUnpostedFieldInvoice,
  mapFieldInvoiceRow,
  applyFieldInvoiceFilters,
  computeFieldInvoiceTotals,
  emptyFieldInvoiceFilters,
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
  balance_cents: 12345,
  posted_by: null,
  posted_at: null,
  voided_by: null,
  voided_at: null,
  void_reason: null,
  pricing_pending: false,
  invoice_date: '2026-06-10',
  due_date: null,
  purchase_order_ref: null,
  header_notes: null,
  footer_notes: null,
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
