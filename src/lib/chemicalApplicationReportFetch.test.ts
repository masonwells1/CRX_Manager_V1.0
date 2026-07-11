/**
 * chemicalApplicationReportFetch.test.ts — the Jobs-list row-action data path for
 * the Chemical Application Report (#11), closing the prior test gap.
 *
 * The critical behaviour under test is the #11 split-bill COMPLIANCE fix: billed
 * customers are resolved via the SECURITY DEFINER RPC (resolveBilledCustomers), so a
 * co-billed customer that an applicator's customers_select RLS would hide is INCLUDED
 * (not dropped), AND an incomplete resolution ABORTS the fetch (throws) so the caller
 * never prints a silently-partial PDF / stamps printed_at. The DB precedence
 * (job_field_shares → field_billing_defaults → primary) is proven in the resolver's
 * RPC smoke; here we pin that this fetch path delegates to the resolver and honours
 * its `complete` flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockResolveBilledCustomers } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockResolveBilledCustomers: vi.fn(),
}));

vi.mock('./db', () => ({ supabase: { from: mockFrom } }));
vi.mock('./billedCustomersResolver', () => ({ resolveBilledCustomers: mockResolveBilledCustomers }));

import { fetchApplicatorSheetData, fetchChemicalApplicationReportData } from './chemicalApplicationReportFetch';

// A minimal saved-job row (one field, one chemical) — the customer billing comes from
// the mocked resolver, NOT this row.
const JOB_ROW = {
  id: 'job-1',
  job_number: 'SPLITBILL-1',
  job_date: '2026-06-25',
  scheduled_time: null,
  applicator_id: null,
  loader_comment: 'Load the north tank first.',
  customer: { farm_name: 'Parity Test Farm', account_number: 'PTF-11' },
  vehicle: { vehicle_name: 'Hagie STS-16' },
  job_fields: [
    {
      field_id: 'f1',
      acres_to_treat: 40,
      crop: 'Corn',
      pests: 'Weeds',
      sort_order: 0,
      field: { field_name: 'East 40', county: 'Story', state: 'IA', crop_type: 'Corn' },
    },
  ],
  job_chemicals: [
    {
      product_id: 'p1',
      quantity: 80,
      unit: 'pt',
      rate_per_acre: 2,
      rate_unit: 'pt/ac',
      rei_hours: null,
      phi_days: null,
      sort_order: 0,
      product: { product_name: 'Herbicide X' },
    },
  ],
};

const PRODUCT_LABEL_ROWS = [
  { id: 'p1', rei_hours: 12, phi_days: 30, epa_registration: '123-45', product_form: 'liquid' },
];

/**
 * Wire mockFrom to answer the three reads the fetch makes:
 *  - jobs:     .select(...).eq('id', jobId).maybeSingle()  -> { data: jobRow }
 *  - products: .select(...).in('id', pids)                 -> { data: labelRows }
 *  - profile_public_view: only hit when applicator_id is set (not in these tests)
 */
function wireSupabase(jobRow: unknown, labelRows: unknown) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: jobRow, error: null }) }),
        }),
      };
    }
    if (table === 'products') {
      return { select: () => ({ in: () => Promise.resolve({ data: labelRows, error: null }) }) };
    }
    if (table === 'profile_public_view') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => vi.clearAllMocks());

describe('fetchChemicalApplicationReportData — billed-customer resolution', () => {
  it('INCLUDES every co-billed customer the resolver returns (split-bill fix)', async () => {
    wireSupabase(JOB_ROW, PRODUCT_LABEL_ROWS);
    mockResolveBilledCustomers.mockResolvedValue({
      complete: true,
      customers: [
        { customer_name: 'Parity Test Farm', account_number: 'PTF-11' },
        { customer_name: 'Sunrise Ag LLC', account_number: 'CUST-1002' },
        { customer_name: 'Green Acres Farm', account_number: 'CUST-1001' },
      ],
    });

    const data = await fetchChemicalApplicationReportData('job-1');

    expect(mockResolveBilledCustomers).toHaveBeenCalledWith('job-1');
    expect(data).not.toBeNull();
    // All three billed customers reach the sheet data — the co-billed ones are NOT dropped.
    expect(data!.customers).toEqual([
      { customer_name: 'Parity Test Farm', account_number: 'PTF-11' },
      { customer_name: 'Sunrise Ag LLC', account_number: 'CUST-1002' },
      { customer_name: 'Green Acres Farm', account_number: 'CUST-1001' },
    ]);
  });

  it('uses the field_billing_defaults customer when the resolver supplies it', async () => {
    wireSupabase(JOB_ROW, PRODUCT_LABEL_ROWS);
    mockResolveBilledCustomers.mockResolvedValue({
      complete: true,
      customers: [{ customer_name: 'Filter Farm Alpha', account_number: 'FFA-1' }],
    });

    const data = await fetchChemicalApplicationReportData('job-1');
    expect(data!.customers).toEqual([{ customer_name: 'Filter Farm Alpha', account_number: 'FFA-1' }]);
  });

  it('uses the primary-only customer when that is all the resolver returns', async () => {
    wireSupabase(JOB_ROW, PRODUCT_LABEL_ROWS);
    mockResolveBilledCustomers.mockResolvedValue({
      complete: true,
      customers: [{ customer_name: 'Parity Test Farm', account_number: 'PTF-11' }],
    });

    const data = await fetchChemicalApplicationReportData('job-1');
    expect(data!.customers).toEqual([{ customer_name: 'Parity Test Farm', account_number: 'PTF-11' }]);
  });

  it('ABORTS (throws) when billed-customer resolution is INCOMPLETE — no silent partial PDF', async () => {
    wireSupabase(JOB_ROW, PRODUCT_LABEL_ROWS);
    mockResolveBilledCustomers.mockResolvedValue({
      complete: false,
      customers: [{ customer_name: 'Parity Test Farm', account_number: 'PTF-11' }],
    });

    await expect(fetchChemicalApplicationReportData('job-1')).rejects.toThrow(
      /billed customers .* could not be resolved/i
    );
  });

  it('keeps the applicator sheet lenient for incomplete billing and includes job-only sheet details', async () => {
    wireSupabase(JOB_ROW, PRODUCT_LABEL_ROWS);
    mockResolveBilledCustomers.mockResolvedValue({ complete: false, customers: [] });

    const data = await fetchApplicatorSheetData('job-1');

    expect(data).not.toBeNull();
    expect(data!.customers).toEqual([{ customer_name: 'Parity Test Farm', account_number: 'PTF-11' }]);
    expect(data!.vehicle_name).toBe('Hagie STS-16');
    expect(data!.loader_comment).toBe('Load the north tank first.');
  });

  it('propagates a resolver throw (e.g. caller not authorized to view the job)', async () => {
    wireSupabase(JOB_ROW, PRODUCT_LABEL_ROWS);
    mockResolveBilledCustomers.mockRejectedValue(new Error('Not authorized to view this job\'s billed customers'));
    await expect(fetchChemicalApplicationReportData('job-1')).rejects.toThrow('Not authorized');
  });

  it('returns null when the job no longer exists (does not call the resolver)', async () => {
    wireSupabase(null, PRODUCT_LABEL_ROWS);
    const data = await fetchChemicalApplicationReportData('job-1');
    expect(data).toBeNull();
    expect(mockResolveBilledCustomers).not.toHaveBeenCalled();
  });
});
