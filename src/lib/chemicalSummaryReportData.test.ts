import { describe, it, expect } from 'vitest';
import {
  buildApplicatorSheetData,
  type BuildSheetInput,
  type RawSheetField,
  type RawSheetProduct,
} from './applicatorSheetData';
import {
  buildChemicalSummaryReportData,
  chemicalSummaryCsvRows,
  type ChemicalSummaryJobInput,
} from './chemicalSummaryReportData';

const field = (over: Partial<RawSheetField>): RawSheetField => ({
  field_id: 'f',
  field_name: 'Field',
  county: null,
  state: null,
  acres: 0,
  crop: null,
  pest: null,
  sort_order: 0,
  ...over,
});

const product = (over: Partial<RawSheetProduct>): RawSheetProduct => ({
  product_name: 'Product',
  rate_per_acre: null,
  rate_unit: null,
  unit: null,
  total_quantity: null,
  product_form: null,
  rei_hours: null,
  phi_days: null,
  epa_registration: null,
  ...over,
});

const sheet = (over: Partial<BuildSheetInput>) =>
  buildApplicatorSheetData({
    job_number: 'JOB',
    customers: [{ customer_name: 'Acme', account_number: 'A1' }],
    scheduled_date: '2026-06-25',
    scheduled_time: null,
    applicator_name: null,
    vehicle_name: null,
    fields: [],
    products: [],
    loader_comment: null,
    ...over,
  });

/** A job input from a built sheet. */
const job = (id: string, over: Partial<BuildSheetInput>): ChemicalSummaryJobInput => ({
  job_id: id,
  data: sheet(over),
});

describe('buildChemicalSummaryReportData — single job (criterion 4)', () => {
  it('a single job produces that job’s chemical totals verbatim', () => {
    // 2 pt/ac × 100 ac = 200 pt; 200 pt → 25 gal (8 pt per gal).
    const j = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ field_name: 'A', acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildChemicalSummaryReportData([j]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      product_name: 'Roundup',
      unit: 'pt',
      total_quantity: 200,
      total_quantity_display: '200 pt',
      gl_lb_display: '25 gal',
      job_count: 1,
    });
    expect(out.included_jobs.map((r) => r.job_number)).toEqual(['JOB-1']);
    expect(out.excluded_jobs).toEqual([]);
    expect(out.distinct_product_lines).toBe(1);
  });
});

describe('buildChemicalSummaryReportData — cross-job summing (criterion 2 + 4)', () => {
  it('sums a shared product across two jobs (same product+unit) and re-derives gal/lb from the SUM', () => {
    // Job 1: 2 pt/ac × 100 ac = 200 pt. Job 2: 3 pt/ac × 80 ac = 240 pt. Sum = 440 pt.
    // 440 pt → 55 gal (8 pt per gal) — re-derived from the summed 440, not 25+30.
    const j1 = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ field_name: 'A', acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const j2 = job('j2', {
      job_number: 'JOB-2',
      fields: [field({ field_name: 'B', acres: 80, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 3, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup');
    expect(roundup).toBeDefined();
    expect(roundup!.total_quantity).toBe(440);
    expect(roundup!.total_quantity_display).toBe('440 pt');
    expect(roundup!.gl_lb_display).toBe('55 gal');
    expect(roundup!.job_count).toBe(2);
    // Hand-verify: the combined figure equals the manual sum of the two jobs.
    expect(roundup!.total_quantity).toBe(200 + 240);
  });

  it('re-derives a DRY product’s lb-equivalent from the summed quantity', () => {
    // Job1: 5 lb/ac × 40 = 200 lb. Job2: 2 lb/ac × 60 = 120 lb. Sum = 320 lb → 320 lb.
    const j1 = job('j1', {
      fields: [field({ acres: 40, sort_order: 0 })],
      products: [product({ product_name: 'AMS', rate_per_acre: 5, rate_unit: 'lb', unit: 'lb', product_form: 'dry' })],
    });
    const j2 = job('j2', {
      fields: [field({ acres: 60, sort_order: 0 })],
      products: [product({ product_name: 'AMS', rate_per_acre: 2, rate_unit: 'lb', unit: 'lb', product_form: 'dry' })],
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    const ams = out.rows.find((r) => r.product_name === 'AMS')!;
    expect(ams.total_quantity).toBe(320);
    expect(ams.gl_lb_display).toBe('320 lb');
  });
});

describe('buildChemicalSummaryReportData — unit-keyed aggregation (criterion 2)', () => {
  it('keeps the SAME product in DIFFERENT units as separate lines (never mixes units)', () => {
    // Same product name "Atrazine" but one job dosed in qt, the other in gal — must NOT sum.
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 1, rate_unit: 'qt', unit: 'qt', product_form: 'liquid' })], // 100 qt
    });
    const j2 = job('j2', {
      fields: [field({ acres: 10, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 2, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })], // 20 gal
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    const lines = out.rows.filter((r) => r.product_name === 'Atrazine');
    expect(lines).toHaveLength(2);
    const qt = lines.find((r) => r.unit === 'qt')!;
    const gal = lines.find((r) => r.unit === 'gal')!;
    expect(qt.total_quantity).toBe(100);
    expect(qt.gl_lb_display).toBe('25 gal'); // 100 qt = 25 gal
    expect(gal.total_quantity).toBe(20);
    expect(gal.gl_lb_display).toBe('20 gal');
  });

  it('folds different unit CASING (PT vs pt) into one line', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 50, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'PT', unit: 'PT', product_form: 'liquid' })], // 100 PT
    });
    const j2 = job('j2', {
      fields: [field({ acres: 50, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })], // 100 pt
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    const lines = out.rows.filter((r) => r.product_name === 'Roundup');
    expect(lines).toHaveLength(1);
    expect(lines[0].total_quantity).toBe(200);
    expect(lines[0].job_count).toBe(2);
  });
});

describe('buildChemicalSummaryReportData — included/excluded accounting (never undercount)', () => {
  it('lists excluded jobs separately and never folds them into the totals', () => {
    const j1 = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildChemicalSummaryReportData(
      [j1],
      [{ job_id: 'jX', job_number: 'JOB-9', reason: 'Could not resolve billed customers' }],
    );
    expect(out.included_jobs.map((r) => r.job_number)).toEqual(['JOB-1']);
    expect(out.excluded_jobs).toHaveLength(1);
    expect(out.excluded_jobs[0]).toMatchObject({ job_number: 'JOB-9', reason: 'Could not resolve billed customers' });
    // The excluded job's chemicals are NOT in the totals.
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.job_count).toBe(1);
  });

  it('carries customer labels and summed acres for the included-jobs list', () => {
    const j1 = job('j1', {
      job_number: 'JOB-1',
      customers: [{ customer_name: 'Green Acres', account_number: 'G1' }],
      fields: [field({ acres: 30, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const j2 = job('j2', {
      job_number: 'JOB-2',
      customers: [{ customer_name: 'Sunrise', account_number: 'S1' }],
      fields: [field({ acres: 70, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    expect(out.total_acres).toBe(100);
    expect(out.included_jobs.map((r) => r.customer_label)).toEqual(['Green Acres', 'Sunrise']);
  });
});

describe('buildChemicalSummaryReportData — guards & edge cases', () => {
  it('empty selection yields no rows and no totals (criterion 5 guard is the caller’s job)', () => {
    const out = buildChemicalSummaryReportData([]);
    expect(out.rows).toEqual([]);
    expect(out.included_jobs).toEqual([]);
    expect(out.distinct_product_lines).toBe(0);
    expect(out.total_acres).toBe(0);
  });

  it('omits gal/lb (—) when product_form conflicts for the same product+unit across jobs', () => {
    // Same product+unit but one job says liquid, the other dry — a data anomaly. Sum the
    // raw quantity but refuse to pick a gal-vs-lb branch.
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Mystery', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: 'liquid' })],
    });
    const j2 = job('j2', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Mystery', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: 'dry' })],
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    const m = out.rows.find((r) => r.product_name === 'Mystery')!;
    expect(m.total_quantity).toBe(200);
    expect(m.gl_lb_display).toBe('—');
  });

  it('treats NULL form as DISTINCT from a known form → conflict → — (MED1 regression)', () => {
    // products has NO unique-name constraint, so same-name rows can hold divergent
    // forms — here one row is liquid, the other null. The null row's own #11 report
    // converts 'oz' on the DRY (legacy lb) branch (1600 oz → 100 lb), so adopting it
    // into the liquid line and re-converting on the gallon branch would print a WRONG
    // gallon figure. The guard must flag the conflict and emit '—' while still summing.
    const liquidJob = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Mystery', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: 'liquid' })], // 100 oz
    });
    const nullJob = job('j2', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Mystery', rate_per_acre: 16, rate_unit: 'oz', unit: 'oz', product_form: null })], // 1600 oz
    });
    const out = buildChemicalSummaryReportData([liquidJob, nullJob]);
    const m = out.rows.find((r) => r.product_name === 'Mystery')!;
    // Raw total still sums: 100 + 1600 = 1700 oz.
    expect(m.total_quantity).toBe(1700);
    expect(m.total_quantity_display).toBe('1,700 oz');
    // gal/lb is NOT guessed on either branch — conflict → dash.
    expect(m.gl_lb_display).toBe('—');
    // Order-independence: the null row first must conflict the same way.
    const flipped = buildChemicalSummaryReportData([nullJob, liquidJob]);
    expect(flipped.rows.find((r) => r.product_name === 'Mystery')!.gl_lb_display).toBe('—');
  });

  it('ALL-null form lines convert exactly as each job’s own #11 report does (no conflict)', () => {
    // Two null-form jobs in 'oz' — no known form anywhere, so NOT a conflict. The
    // legacy (product_form omitted) path infers from the unit text: 'oz' → POUNDS
    // (1/16). 1600 oz → 100 lb on each job's #11; summed 1700 oz → 106.25 lb here,
    // matching what #11 would show for the same total. (Proves the all-null case is
    // not regressed into a dash.)
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'NullProd', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: null })], // 100 oz
    });
    const j2 = job('j2', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'NullProd', rate_per_acre: 16, rate_unit: 'oz', unit: 'oz', product_form: null })], // 1600 oz
    });
    const out = buildChemicalSummaryReportData([j1, j2]);
    const m = out.rows.find((r) => r.product_name === 'NullProd')!;
    expect(m.total_quantity).toBe(1700);
    // 1700 oz × 1/16 = 106.25 lb — the same branch #11 used (legacy unit-inferred lb).
    expect(m.gl_lb_display).toBe('106.25 lb');
  });

  it('ALL same KNOWN form lines are unchanged (no false conflict)', () => {
    // Three liquid 'pt' jobs — all the same known form → NOT a conflict; gal/lb is
    // computed normally from the SUM (200+200+200 = 600 pt → 75 gal at 8 pt/gal).
    const mk = (id: string) => job(id, {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Same', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildChemicalSummaryReportData([mk('a'), mk('b'), mk('c')]);
    const m = out.rows.find((r) => r.product_name === 'Same')!;
    expect(m.total_quantity).toBe(600);
    expect(m.gl_lb_display).toBe('75 gal');
    expect(m.job_count).toBe(3);
  });

  it('skips a flat/quantity-less product line (nothing to sum) without erroring', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 0, sort_order: 0 })], // no acres → no derived total
      products: [product({ product_name: 'Bare' })],
    });
    const out = buildChemicalSummaryReportData([j1]);
    expect(out.rows).toEqual([]);
    expect(out.included_jobs).toHaveLength(1); // the job is still counted as included
  });
});

describe('chemicalSummaryCsvRows', () => {
  it('flattens product+unit lines to CSV records', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [
        product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' }),
        product({ product_name: 'AMS', rate_per_acre: 5, rate_unit: 'lb', unit: 'lb', product_form: 'dry' }),
      ],
    });
    const out = buildChemicalSummaryReportData([j1]);
    const csv = chemicalSummaryCsvRows(out);
    expect(csv).toEqual([
      { product_name: 'AMS', unit: 'lb', total_quantity: '500', gl_lb_equiv: '500 lb', job_count: 1 },
      { product_name: 'Roundup', unit: 'pt', total_quantity: '200', gl_lb_equiv: '25 gal', job_count: 1 },
    ]);
  });
});
