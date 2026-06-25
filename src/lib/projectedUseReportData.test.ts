import { describe, it, expect } from 'vitest';
import {
  buildApplicatorSheetData,
  type BuildSheetInput,
  type RawSheetField,
  type RawSheetProduct,
} from './applicatorSheetData';
import {
  buildProjectedUseReportData,
  projectedUseCsvRows,
  type ProjectedUseJobInput,
} from './projectedUseReportData';

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

/**
 * An in-scope job input from a built sheet. `remaining_acres`/`acre_basis`/`status` are
 * supplied explicitly (in real use the fetch computes remaining = acre_basis − applied and
 * reads status from jobs.*). The scale-factor DENOMINATOR is `acre_basis` — the SAME basis
 * the caller derived remaining from (normally the gatherer's field-acre total
 * data.total_acres; a no-field fallback job carries jobs.total_acres). When `basis` is
 * omitted it defaults to the sheet's field acres (data.total_acres); when `remaining` is
 * omitted it defaults to that basis (a pure scheduled job: nothing applied → factor 1).
 */
const job = (
  id: string,
  over: Partial<BuildSheetInput>,
  acres?: { basis?: number; remaining?: number; status?: string },
): ProjectedUseJobInput => {
  const data = sheet(over);
  const basis = acres?.basis ?? data.total_acres;
  return {
    job_id: id,
    data,
    acre_basis: basis,
    remaining_acres: acres?.remaining ?? basis,
    status: acres?.status ?? 'scheduled',
  };
};

describe('buildProjectedUseReportData — scheduled job projection (criterion 2 + 6)', () => {
  it('a pure scheduled job projects planned rate × full scheduled acres (factor 1)', () => {
    // 2 pt/ac × 100 scheduled ac = 200 pt projected; 200 pt → 25 gal (8 pt/gal).
    const j = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ field_name: 'A', acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 100, status: 'scheduled' });
    const out = buildProjectedUseReportData([j]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      product_name: 'Roundup',
      unit: 'pt',
      projected_quantity: 200,
      projected_quantity_display: '200 pt',
      gl_lb_display: '25 gal',
      job_count: 1,
    });
    expect(out.included_jobs.map((r) => r.job_number)).toEqual(['JOB-1']);
    expect(out.included_jobs[0]).toMatchObject({ remaining_acres: 100, total_acres: 100, status: 'scheduled' });
    expect(out.projected_acres).toBe(100);
    expect(out.excluded_jobs).toEqual([]);
    expect(out.distinct_product_lines).toBe(1);
  });

  it('sums a shared product across two scheduled jobs and re-derives gal/lb from the projected SUM (hand-math)', () => {
    // Job1: 2 pt/ac × 100 ac = 200 pt. Job2: 2 pt/ac × 50 ac = 100 pt. Projected sum = 300 pt.
    // 300 pt → 37.5 gal (8 pt/gal) — re-derived from 300, not 25+12.5 strings.
    const j1 = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ field_name: 'A', acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 100, status: 'scheduled' });
    const j2 = job('j2', {
      job_number: 'JOB-2',
      fields: [field({ field_name: 'B', acres: 50, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 50, remaining: 50, status: 'scheduled' });
    const out = buildProjectedUseReportData([j1, j2]);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup')!;
    // Hand-verify: planned rate × scheduled acres summed = 200 + 100 = 300.
    expect(roundup.projected_quantity).toBe(300);
    expect(roundup.projected_quantity).toBe(2 * 100 + 2 * 50);
    expect(roundup.projected_quantity_display).toBe('300 pt');
    expect(roundup.gl_lb_display).toBe('37.5 gal');
    expect(roundup.job_count).toBe(2);
    expect(out.projected_acres).toBe(150);
  });
});

describe('buildProjectedUseReportData — in_progress uses REMAINING acres, not total (the crux)', () => {
  it('projects an in_progress job by its remaining (un-applied) acres, NOT its full acres', () => {
    // Job total 100 ac, 40 applied → 60 remaining. 2 pt/ac. The gatherer computes the
    // FULL-acres planned total = 200 pt; the projection scales by 60/100 = 0.6 → 120 pt.
    // This proves the forecast uses the 60 un-sprayed acres, not the full 100.
    const j = job('j1', {
      job_number: 'JOB-IP',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 60, status: 'in_progress' });
    const out = buildProjectedUseReportData([j]);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup')!;
    // 2 pt/ac × 60 remaining ac = 120 pt (NOT 200).
    expect(roundup.projected_quantity).toBe(120);
    expect(roundup.projected_quantity).toBe(2 * 60);
    expect(roundup.gl_lb_display).toBe('15 gal'); // 120 pt / 8 = 15 gal, re-derived
    expect(out.included_jobs[0]).toMatchObject({ remaining_acres: 60, total_acres: 100, status: 'in_progress' });
    expect(out.projected_acres).toBe(60);
  });

  it('scales by the gatherer FIELD-acre total even when jobs.total_acres would diverge (MED fix)', () => {
    // The MED defect: the factor denominator used to be jobs.total_acres. Here the job's
    // FIELD acres (Σ acres_to_treat) = 100 and the saved product quantity = 200 pt
    // (= rate 2 × 100 field acres). If jobs.total_acres were a divergent 80, the OLD code
    // computed factor = remaining/jobs.total = 60/80 = 0.75 → 200 × 0.75 = 150 pt (WRONG).
    // The FIX uses data.total_acres (100) as the denominator → 60/100 = 0.6 → 120 pt (RIGHT).
    // We supply only remaining (60); the denominator is read from data.total_acres (100),
    // so a divergent jobs.total_acres can never reach the math.
    const j = job('jDiv', {
      job_number: 'JOB-DIVERGE',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { remaining: 60, status: 'in_progress' });
    // Sanity: the gatherer basis IS the field-acre total, and the planned total is rate×100.
    expect(j.data.total_acres).toBe(100);
    expect(j.data.products[0].total_applied).toBe(200);
    const out = buildProjectedUseReportData([j]);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup')!;
    expect(roundup.projected_quantity).toBe(120); // the CORRECT field-acre-based number, not 150
    expect(roundup.projected_quantity).toBe(2 * 60);
    expect(roundup.gl_lb_display).toBe('15 gal'); // 120 pt / 8, re-derived from the projected sum
    expect(out.included_jobs[0]).toMatchObject({ remaining_acres: 60, total_acres: 100, status: 'in_progress' });
  });

  it('a scheduled job (full acres) + an in_progress job (remaining) sum correctly by product', () => {
    // Scheduled: 2 pt/ac × 100 = 200 pt. In_progress: 2 pt/ac × 60 remaining (of 100) = 120 pt.
    // Projected sum = 320 pt → 40 gal.
    const sched = job('sched', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 100, status: 'scheduled' });
    const inprog = job('inprog', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 60, status: 'in_progress' });
    const out = buildProjectedUseReportData([sched, inprog]);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup')!;
    expect(roundup.projected_quantity).toBe(320);
    expect(roundup.gl_lb_display).toBe('40 gal');
    expect(roundup.job_count).toBe(2);
    expect(out.projected_acres).toBe(160);
  });
});

describe('buildProjectedUseReportData — excluded accounting (criterion 4: never double-count applied)', () => {
  it('lists excluded (already-applied/completed) jobs separately and never folds them into the projection', () => {
    const sched = job('j1', {
      job_number: 'JOB-1',
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 100, status: 'scheduled' });
    const out = buildProjectedUseReportData(
      [sched],
      [{ job_id: 'jDone', job_number: 'JOB-DONE', reason: 'Already applied / not scheduled (status: completed) — nothing left to project' }],
    );
    expect(out.included_jobs.map((r) => r.job_number)).toEqual(['JOB-1']);
    expect(out.excluded_jobs).toHaveLength(1);
    expect(out.excluded_jobs[0]).toMatchObject({ job_number: 'JOB-DONE' });
    // The excluded (applied) job's chemicals are NOT in the projection.
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.projected_quantity).toBe(200);
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.job_count).toBe(1);
  });

  it('tracks the date range across the included jobs', () => {
    const j1 = job('j1', {
      scheduled_date: '2026-07-01',
      fields: [field({ acres: 10, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const j2 = job('j2', {
      scheduled_date: '2026-07-15',
      fields: [field({ acres: 10, sort_order: 0 })],
      products: [product({ product_name: 'P', rate_per_acre: 1, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    });
    const out = buildProjectedUseReportData([j1, j2]);
    expect(out.date_from).toBe('2026-07-01');
    expect(out.date_to).toBe('2026-07-15');
  });
});

describe('buildProjectedUseReportData — unit-keyed aggregation + form-conflict guard (kept identical to #12)', () => {
  it('keeps the SAME product in DIFFERENT units as separate projected lines', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 1, rate_unit: 'qt', unit: 'qt', product_form: 'liquid' })], // 100 qt
    });
    const j2 = job('j2', {
      fields: [field({ acres: 10, sort_order: 0 })],
      products: [product({ product_name: 'Atrazine', rate_per_acre: 2, rate_unit: 'gal', unit: 'gal', product_form: 'liquid' })], // 20 gal
    });
    const out = buildProjectedUseReportData([j1, j2]);
    const lines = out.rows.filter((r) => r.product_name === 'Atrazine');
    expect(lines).toHaveLength(2);
    expect(lines.find((r) => r.unit === 'qt')!.projected_quantity).toBe(100);
    expect(lines.find((r) => r.unit === 'gal')!.projected_quantity).toBe(20);
  });

  it('omits gal/lb (—) when product_form conflicts (null vs known) across jobs', () => {
    const liquidJob = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Mystery', rate_per_acre: 1, rate_unit: 'oz', unit: 'oz', product_form: 'liquid' })], // 100 oz
    });
    const nullJob = job('j2', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Mystery', rate_per_acre: 16, rate_unit: 'oz', unit: 'oz', product_form: null })], // 1600 oz
    });
    const out = buildProjectedUseReportData([liquidJob, nullJob]);
    const m = out.rows.find((r) => r.product_name === 'Mystery')!;
    expect(m.projected_quantity).toBe(1700); // raw projection still sums
    expect(m.gl_lb_display).toBe('—'); // no guessed branch
    // Order-independence.
    const flipped = buildProjectedUseReportData([nullJob, liquidJob]);
    expect(flipped.rows.find((r) => r.product_name === 'Mystery')!.gl_lb_display).toBe('—');
  });
});

describe('buildProjectedUseReportData — guards & edge cases', () => {
  it('empty selection yields no rows and no totals (criterion-5 guard is the caller’s job)', () => {
    const out = buildProjectedUseReportData([]);
    expect(out.rows).toEqual([]);
    expect(out.included_jobs).toEqual([]);
    expect(out.distinct_product_lines).toBe(0);
    expect(out.projected_acres).toBe(0);
    expect(out.date_from).toBeNull();
    expect(out.date_to).toBeNull();
  });

  it('a job with 0 remaining acres contributes nothing even if mistakenly passed in (never divide by zero)', () => {
    // Defensive: the fetch excludes 0-remaining jobs, but the pure module must still
    // be safe — factor 0 → no projected lines, no NaN.
    const j = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 0, status: 'in_progress' });
    const out = buildProjectedUseReportData([j]);
    expect(out.rows).toEqual([]);
    expect(out.included_jobs).toHaveLength(1); // still listed
    expect(out.projected_acres).toBe(0);
  });

  it('skips a flat/quantity-less product line without erroring', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 0, sort_order: 0 })],
      products: [product({ product_name: 'Bare' })],
    }, { basis: 0, remaining: 0, status: 'scheduled' });
    const out = buildProjectedUseReportData([j1]);
    expect(out.rows).toEqual([]);
    expect(out.included_jobs).toHaveLength(1);
  });
});

describe('projectedUseCsvRows', () => {
  it('flattens projected product+unit lines to CSV records', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [
        product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' }),
        product({ product_name: 'AMS', rate_per_acre: 5, rate_unit: 'lb', unit: 'lb', product_form: 'dry' }),
      ],
    }, { basis: 100, remaining: 100, status: 'scheduled' });
    const out = buildProjectedUseReportData([j1]);
    const csv = projectedUseCsvRows(out);
    expect(csv).toEqual([
      { product_name: 'AMS', unit: 'lb', projected_quantity: '500', gl_lb_equiv: '500 lb', job_count: 1 },
      { product_name: 'Roundup', unit: 'pt', projected_quantity: '200', gl_lb_equiv: '25 gal', job_count: 1 },
    ]);
  });

  it('appends an EXCLUDED marker block so a standalone CSV is never silently partial (Codex P2)', () => {
    const j1 = job('j1', {
      fields: [field({ acres: 100, sort_order: 0 })],
      products: [product({ product_name: 'Roundup', rate_per_acre: 2, rate_unit: 'pt', unit: 'pt', product_form: 'liquid' })],
    }, { basis: 100, remaining: 100, status: 'scheduled' });
    const out = buildProjectedUseReportData(
      [j1],
      [{ job_id: 'jX', job_number: 'JOB-9', reason: 'Could not resolve billed customers' }],
    );
    const csv = projectedUseCsvRows(out);
    // The product line is present...
    expect(csv[0]).toMatchObject({ product_name: 'Roundup', projected_quantity: '200' });
    // ...followed by a marker header + one row per excluded job carrying job # + reason.
    const header = csv.find((r) => String(r.product_name).startsWith('EXCLUDED — NOT projected'));
    expect(header).toBeTruthy();
    const excludedRow = csv.find((r) => r.product_name === 'EXCLUDED job');
    expect(excludedRow).toMatchObject({ unit: 'JOB-9', gl_lb_equiv: 'Could not resolve billed customers' });
  });

  it('emits ONLY the excluded marker block when there are no projected lines (still not silent)', () => {
    const out = buildProjectedUseReportData(
      [],
      [{ job_id: 'jX', job_number: 'JOB-9', reason: 'No remaining acres — all planned acres already applied' }],
    );
    const csv = projectedUseCsvRows(out);
    expect(csv.length).toBe(2); // header + the one excluded job
    expect(csv[0].product_name).toContain('EXCLUDED — NOT projected');
    expect(csv[1]).toMatchObject({ unit: 'JOB-9' });
  });
});
