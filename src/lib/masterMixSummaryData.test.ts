import { describe, it, expect } from 'vitest';
import {
  buildApplicatorSheetData,
  type BuildSheetInput,
  type RawSheetField,
  type RawSheetProduct,
} from './applicatorSheetData';
import {
  buildMasterMixSummaryData,
  type MasterMixJobInput,
} from './masterMixSummaryData';

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

/** A master-mix job input from a built sheet, with optional loads inputs (capacity/rate). */
const job = (
  id: string,
  sheetOver: Partial<BuildSheetInput>,
  loads: Partial<Pick<MasterMixJobInput, 'tank_capacity' | 'capacity_unit' | 'carrier_rate_gpa' | 'capacity_source'>> = {},
): MasterMixJobInput => ({
  job_id: id,
  data: sheet(sheetOver),
  tank_capacity: loads.tank_capacity ?? null,
  capacity_unit: loads.capacity_unit ?? 'gal',
  carrier_rate_gpa: loads.carrier_rate_gpa ?? null,
  capacity_source: loads.capacity_source ?? null,
});

describe('buildMasterMixSummaryData — combined per-product mix (criterion 2 + 5)', () => {
  it('a single job produces that job’s mix totals verbatim', () => {
    // 2 pt/ac × 100 ac = 200 pt; 200 pt → 25 gal (8 pt per gal).
    const j = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ field_name: 'A', acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildMasterMixSummaryData([j]);
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
  });

  it('combined mix total = the SUM of each job’s product quantity (criterion 5)', () => {
    // Job 1: 2 pt/ac × 100 ac = 200 pt. Job 2: 3 pt/ac × 80 ac = 240 pt. Sum = 440 pt.
    // 440 pt → 55 gal — RE-DERIVED from the summed 440, not 25+30.
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
    const out = buildMasterMixSummaryData([j1, j2]);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup')!;
    expect(roundup.total_quantity).toBe(440);
    expect(roundup.total_quantity).toBe(200 + 240); // hand-verified sum
    expect(roundup.total_quantity_display).toBe('440 pt');
    expect(roundup.gl_lb_display).toBe('55 gal'); // re-derived from the combined sum
    expect(roundup.job_count).toBe(2);
  });

  it('keeps the SAME product in DIFFERENT units on separate lines (never mixes units)', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 1, rate_unit: 'qt', unit: 'qt', product_form: 'liquid' })], // 100 qt
    });
    const j2 = job('j2', {
      fields: [field({ acres: 10, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 2, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })], // 20 gal
    });
    const out = buildMasterMixSummaryData([j1, j2]);
    const lines = out.rows.filter((r) => r.product_name === 'Atrazine');
    expect(lines).toHaveLength(2);
    expect(lines.find((r) => r.unit === 'qt')!.total_quantity).toBe(100);
    expect(lines.find((r) => r.unit === 'gal')!.total_quantity).toBe(20);
  });

  it('re-derives a DRY product’s lb-equivalent from the combined sum', () => {
    // 200 lb + 120 lb = 320 lb.
    const j1 = job('j1', { fields: [field({ acres: 40, sort_order: 0 })], products: [product({ product_name: 'AMS', rate_per_acre: 5, rate_unit: 'lb', unit: 'lb', product_form: 'dry' })] });
    const j2 = job('j2', { fields: [field({ acres: 60, sort_order: 0 })], products: [product({ product_name: 'AMS', rate_per_acre: 2, rate_unit: 'lb', unit: 'lb', product_form: 'dry' })] });
    const out = buildMasterMixSummaryData([j1, j2]);
    const ams = out.rows.find((r) => r.product_name === 'AMS')!;
    expect(ams.total_quantity).toBe(320);
    expect(ams.gl_lb_display).toBe('320 lb');
  });

  it('omits gal/lb (—) on a product_form conflict (null treated as distinct) but still sums', () => {
    const liquidJob = job('j1', { fields: [field({ acres: 100, sort_order: 0 })], products: [product({ product_name: 'Mystery', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: 'liquid' })] }); // 100 oz
    const nullJob = job('j2', { fields: [field({ acres: 100, sort_order: 0 })], products: [product({ product_name: 'Mystery', rate_per_acre: 16, rate_unit: 'oz', unit: 'oz', product_form: null })] }); // 1600 oz
    const out = buildMasterMixSummaryData([liquidJob, nullJob]);
    const m = out.rows.find((r) => r.product_name === 'Mystery')!;
    expect(m.total_quantity).toBe(1700);
    expect(m.gl_lb_display).toBe('—');
  });
});

describe('buildMasterMixSummaryData — per-capacity loads grouping (criterion 3 + 6)', () => {
  it('SAME-capacity + same-rate jobs combine into ONE loads block (criterion 3)', () => {
    // Two jobs, both 1000-gal tank @ 10 gal/ac. Job1: 100 ac → 1000 gal spray (1 load).
    // Job2: 100 ac → 1000 gal spray. Combined 200 ac → 2000 gal → 2 loads in ONE group.
    const j1 = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })], // 200 pt
    }, { tank_capacity: 1000, carrier_rate_gpa: 10, capacity_source: 'Sprayer A' });
    const j2 = job('j2', {
      job_number: 'JOB-2',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })], // 200 pt
    }, { tank_capacity: 1000, carrier_rate_gpa: 10, capacity_source: 'Sprayer A' });

    const out = buildMasterMixSummaryData([j1, j2]);
    expect(out.mixed_capacities).toBe(false);
    expect(out.load_groups).toHaveLength(1);
    const g = out.load_groups[0];
    expect(g.tank_capacity).toBe(1000);
    expect(g.carrier_rate_gpa).toBe(10);
    expect(g.total_acres).toBe(200);
    expect(g.worksheet.valid).toBe(true);
    expect(g.worksheet.spray_volume).toBe(2000);
    expect(g.worksheet.loads_count).toBe(2);
    expect(g.job_numbers).toEqual(['JOB-1', 'JOB-2']);
    // The group's combined product total = the sum of both jobs (200 + 200 = 400 pt),
    // and the per-load split sums back to that total.
    const loadSum = g.worksheet.loads.reduce((s, l) => s + (l.products[0]?.amount ?? 0), 0);
    expect(Math.round(loadSum * 10000) / 10000).toBe(400);
  });

  it('DIFFERENT capacities are GROUPED separately and NEVER averaged (criterion 6)', () => {
    const big = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const small = job('j2', {
      job_number: 'JOB-2',
      fields: [field({ acres: 50, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })],
    }, { tank_capacity: 500, carrier_rate_gpa: 10 });

    const out = buildMasterMixSummaryData([big, small]);
    // Combined mix is still ONE sum across both jobs.
    expect(out.rows.find((r) => r.product_name === 'P')!.total_quantity).toBe(150);
    // But loads are TWO groups — one per capacity — never averaged into a fake 750.
    expect(out.mixed_capacities).toBe(true);
    expect(out.load_groups).toHaveLength(2);
    const caps = out.load_groups.map((g) => g.tank_capacity).sort((a, b) => a - b);
    expect(caps).toEqual([500, 1000]);
    // No group's capacity is the average (750) of the two distinct capacities.
    expect(out.load_groups.every((g) => g.tank_capacity !== 750)).toBe(true);
    // Each group covers only its own job.
    const g1000 = out.load_groups.find((g) => g.tank_capacity === 1000)!;
    const g500 = out.load_groups.find((g) => g.tank_capacity === 500)!;
    expect(g1000.job_numbers).toEqual(['JOB-1']);
    expect(g500.job_numbers).toEqual(['JOB-2']);
  });

  it('DIFFERENT carrier rates at the SAME capacity also group separately', () => {
    const a = job('j1', { job_number: 'JOB-1', fields: [field({ acres: 100, sort_order: 0 })], products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })] }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const b = job('j2', { job_number: 'JOB-2', fields: [field({ acres: 100, sort_order: 0 })], products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })] }, { tank_capacity: 1000, carrier_rate_gpa: 20 });
    const out = buildMasterMixSummaryData([a, b]);
    expect(out.load_groups).toHaveLength(2);
    expect(out.mixed_capacities).toBe(true);
  });

  it('same capacity+rate but DIFFERENT recipes do NOT merge — separate groups, no cross-contamination (Codex P1)', () => {
    // Both jobs: 1000 gal @ 10 gal/ac, 100 ac → 1000 gal → 1 load each. But Job A carries
    // ONLY Roundup and Job B carries ONLY Atrazine. Merging would split BOTH products across
    // both loads, telling the loader to put Atrazine in Job A's tank. They must stay separate.
    const a = job('jA', {
      job_number: 'JOB-A',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const b = job('jB', {
      job_number: 'JOB-B',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 1, rate_unit: 'qt', unit: 'qt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });

    const out = buildMasterMixSummaryData([a, b]);
    // Combined MIX still sums both jobs into one table (each its own product line).
    expect(out.rows.map((r) => r.product_name).sort()).toEqual(['Atrazine', 'Roundup']);
    // But loads are TWO groups (different recipes), each covering only its own job, and each
    // group carries ONLY its own product — never the other job's.
    expect(out.load_groups).toHaveLength(2);
    expect(out.mixed_capacities).toBe(true);
    const gA = out.load_groups.find((g) => g.job_numbers.includes('JOB-A'))!;
    const gB = out.load_groups.find((g) => g.job_numbers.includes('JOB-B'))!;
    expect(gA.job_numbers).toEqual(['JOB-A']);
    expect(gB.job_numbers).toEqual(['JOB-B']);
    // Group A's only product across its loads is Roundup; group B's is Atrazine.
    expect(new Set(gA.worksheet.loads.flatMap((l) => l.products.map((p) => p.product_name)))).toEqual(new Set(['Roundup']));
    expect(new Set(gB.worksheet.loads.flatMap((l) => l.products.map((p) => p.product_name)))).toEqual(new Set(['Atrazine']));
  });

  it('same capacity+rate AND identical recipe DO merge into one combined plan (the real master-mix win)', () => {
    const a = job('jA', {
      job_number: 'JOB-A',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const b = job('jB', {
      job_number: 'JOB-B',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const out = buildMasterMixSummaryData([a, b]);
    expect(out.load_groups).toHaveLength(1);
    expect(out.mixed_capacities).toBe(false);
    expect(out.load_groups[0].job_numbers).toEqual(['JOB-A', 'JOB-B']);
  });

  it('same capacity+rate+product but DIFFERENT per-acre rate do NOT merge (per-load split would smear)', () => {
    const a = job('jA', {
      job_number: 'JOB-A',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const b = job('jB', {
      job_number: 'JOB-B',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 3, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const out = buildMasterMixSummaryData([a, b]);
    expect(out.load_groups).toHaveLength(2);
  });

  it('QUANTITY-ONLY lines (rate_per_acre null) split by EFFECTIVE per-acre concentration (Codex P2)', () => {
    // Both jobs carry Roundup as a HAND-ENTERED total (rate_per_acre null) on 100 ac, but
    // Job A's total is 100 pt (1 pt/ac effective) and Job B's is 200 pt (2 pt/ac effective).
    // A naive rate-only signature collapses both null rates to "na" and merges them, smearing
    // 300 pt across both loads as two 150-pt loads. The effective-rate signature keeps them
    // in SEPARATE groups (1 pt/ac vs 2 pt/ac), each with its own correct per-load amount.
    const a = job('jA', {
      job_number: 'JOB-A',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: null, total_quantity: 100, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const b = job('jB', {
      job_number: 'JOB-B',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: null, total_quantity: 200, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const out = buildMasterMixSummaryData([a, b]);
    // Combined mix still sums to 300 pt across both jobs.
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.total_quantity).toBe(300);
    // But loads are TWO groups (different effective concentration), each with its own total.
    expect(out.load_groups).toHaveLength(2);
    const gA = out.load_groups.find((g) => g.job_numbers.includes('JOB-A'))!;
    const gB = out.load_groups.find((g) => g.job_numbers.includes('JOB-B'))!;
    const totalIn = (g: typeof gA) => g.worksheet.loads.reduce((s, l) => s + (l.products[0]?.amount ?? 0), 0);
    expect(Math.round(totalIn(gA) * 10000) / 10000).toBe(100); // Job A's own 100 pt
    expect(Math.round(totalIn(gB) * 10000) / 10000).toBe(200); // Job B's own 200 pt
  });

  it('QUANTITY-ONLY lines with the SAME effective concentration DO merge (one valid batch)', () => {
    // Both hand-entered 100 pt on 100 ac (1 pt/ac each) → same effective concentration → merge.
    const a = job('jA', { job_number: 'JOB-A', fields: [field({ acres: 100, sort_order: 0 })], products: [product({ product_name: 'Roundup', rate_per_acre: null, total_quantity: 100, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })] }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const b = job('jB', { job_number: 'JOB-B', fields: [field({ acres: 100, sort_order: 0 })], products: [product({ product_name: 'Roundup', rate_per_acre: null, total_quantity: 100, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })] }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const out = buildMasterMixSummaryData([a, b]);
    expect(out.load_groups).toHaveLength(1);
    expect(out.load_groups[0].job_numbers).toEqual(['JOB-A', 'JOB-B']);
  });

  it('a job MISSING a tank capacity is noted (loads not planned) but its mix is STILL counted', () => {
    const withCap = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })], // 200 pt
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const noCap = job('j2', {
      job_number: 'JOB-2',
      fields: [field({ acres: 50, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })], // 100 pt
    }, { tank_capacity: null, carrier_rate_gpa: 10 });

    const out = buildMasterMixSummaryData([withCap, noCap]);
    // The combined mix INCLUDES the no-capacity job (200 + 100 = 300 pt).
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.total_quantity).toBe(300);
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.job_count).toBe(2);
    // The no-capacity job is in the no-load list (NOT silently in a load group).
    expect(out.no_load_jobs.map((j) => j.job_number)).toEqual(['JOB-2']);
    expect(out.no_load_jobs[0].reason).toMatch(/capacity/i);
    // The capacity'd job still has its own loads group, covering only itself.
    expect(out.load_groups).toHaveLength(1);
    expect(out.load_groups[0].job_numbers).toEqual(['JOB-1']);
  });

  it('a job whose capacity could NOT be READ is noted "could not read" (not "enter capacity")', () => {
    // Codex P2: a failed capacity/rate read must NOT masquerade as the user leaving it
    // blank. The mix is still summed; the no-load reason says it could not be read.
    const unreadable = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })],
    }, { tank_capacity: null, carrier_rate_gpa: null });
    unreadable.loads_unreadable = true;
    const out = buildMasterMixSummaryData([unreadable]);
    expect(out.rows.find((r) => r.product_name === 'P')!.total_quantity).toBe(100); // mix still counted
    expect(out.load_groups).toHaveLength(0);
    expect(out.no_load_jobs).toHaveLength(1);
    expect(out.no_load_jobs[0].reason).toMatch(/could not read/i);
    expect(out.no_load_jobs[0].reason).not.toMatch(/enter the sprayer/i);
  });

  it('a job MISSING a carrier rate is noted (loads need a rate) but mix still counted', () => {
    const noRate = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: null });
    const out = buildMasterMixSummaryData([noRate]);
    expect(out.rows.find((r) => r.product_name === 'P')!.total_quantity).toBe(100);
    expect(out.load_groups).toHaveLength(0);
    expect(out.no_load_jobs.map((j) => j.job_number)).toEqual(['JOB-1']);
    expect(out.no_load_jobs[0].reason).toMatch(/carrier rate/i);
  });
});

describe('buildMasterMixSummaryData — product/unit key collisions (Codex P2)', () => {
  it('does NOT collapse "Roundup fl"+"oz" with "Roundup"+"fl oz" (space in name/unit)', () => {
    // A space-joined key would make both produce "roundup fl oz" and silently sum two
    // different products. The NUL-delimited key keeps them on separate lines.
    const j = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [
        product({ product_name: 'Roundup fl', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: 'liquid' }), // "Roundup fl" + "oz"
        product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'fl oz', unit: 'fl oz', product_form: 'liquid' }), // "Roundup" + "fl oz"
      ],
    });
    const out = buildMasterMixSummaryData([j]);
    // Two DISTINCT lines, not one collapsed sum.
    expect(out.rows).toHaveLength(2);
    const a = out.rows.find((r) => r.product_name === 'Roundup fl' && r.unit === 'oz')!;
    const b = out.rows.find((r) => r.product_name === 'Roundup' && r.unit === 'fl oz')!;
    expect(a.total_quantity).toBe(100); // 1 × 100
    expect(b.total_quantity).toBe(200); // 2 × 100
  });
});

describe('buildMasterMixSummaryData — included/excluded accounting (never undercount)', () => {
  it('lists excluded jobs separately and never folds them into the totals', () => {
    const j1 = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { tank_capacity: 1000, carrier_rate_gpa: 10 });
    const out = buildMasterMixSummaryData(
      [j1],
      [{ job_id: 'jX', job_number: 'JOB-9', reason: 'Could not resolve billed customers' }],
    );
    expect(out.included_jobs.map((r) => r.job_number)).toEqual(['JOB-1']);
    expect(out.excluded_jobs).toHaveLength(1);
    expect(out.excluded_jobs[0]).toMatchObject({ job_number: 'JOB-9', reason: 'Could not resolve billed customers' });
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.job_count).toBe(1);
  });

  it('carries customer labels and summed batch acres for the included-jobs list', () => {
    const j1 = job('j1', { job_number: 'JOB-1', customers: [{ customer_name: 'Green Acres', account_number: 'G1' }], fields: [field({ acres: 30, sort_order: 0 })], products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })] }, { tank_capacity: 500, carrier_rate_gpa: 10 });
    const j2 = job('j2', { job_number: 'JOB-2', customers: [{ customer_name: 'Sunrise', account_number: 'S1' }], fields: [field({ acres: 70, sort_order: 0 })], products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })] }, { tank_capacity: 500, carrier_rate_gpa: 10 });
    const out = buildMasterMixSummaryData([j1, j2]);
    expect(out.total_acres).toBe(100);
    expect(out.included_jobs.map((r) => r.customer_label)).toEqual(['Green Acres', 'Sunrise']);
  });

  it('empty selection yields no rows, no loads, no totals (caller guards the no-selection case)', () => {
    const out = buildMasterMixSummaryData([]);
    expect(out.rows).toEqual([]);
    expect(out.load_groups).toEqual([]);
    expect(out.no_load_jobs).toEqual([]);
    expect(out.included_jobs).toEqual([]);
    expect(out.distinct_product_lines).toBe(0);
    expect(out.total_acres).toBe(0);
    expect(out.mixed_capacities).toBe(false);
  });
});
