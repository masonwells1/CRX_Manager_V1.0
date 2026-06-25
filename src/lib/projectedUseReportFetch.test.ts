/**
 * projectedUseReportFetch.test.ts — the scope/inclusion decision for the Projected Use
 * Report (#13), closing the prior test gap and pinning the root-cause fix.
 *
 * THE BUG THIS GUARDS (live-verified on real seed jobs): the projection used to gate
 * inclusion + scale on jobs.remaining_acres / jobs.total_acres. jobs.remaining_acres is a
 * GENERATED column = GREATEST(COALESCE(total_acres,0) − COALESCE(applied_acres,0), 0), so a
 * scheduled/in_progress job with a NULL jobs.total_acres but real un-applied field work
 * reads remaining = 0 (never NULL) and was SILENTLY DROPPED with the false reason "already
 * applied" — the office under-orders. The fix drives BOTH the inclusion decision AND the
 * scale factor off the gatherer's AUTHORITATIVE field-acre total (data.total_acres = Σ
 * job_fields.acres_to_treat) and reads applied_acres to compute remaining honestly.
 *
 * These tests mock the jobs scope read (supabase) and the shared #11 gatherer so the
 * scope/exclusion LOGIC is exercised in isolation; the per-product math is covered in
 * projectedUseReportData.test.ts, and the end-to-end numbers are hand-verified against the
 * local seed jobs in the build loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApplicatorSheetData, type BuildSheetInput } from './applicatorSheetData';
import { buildProjectedUseReportData } from './projectedUseReportData';

const { mockFrom, mockGather } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGather: vi.fn(),
}));

vi.mock('./db', () => ({ supabase: { from: mockFrom } }));
vi.mock('./chemicalApplicationReportFetch', () => ({
  fetchChemicalApplicationReportData: mockGather,
}));

import { fetchProjectedUseData } from './projectedUseReportFetch';

/** A jobs scope row as the .in('id', ids) read returns it. */
interface ScopeRow {
  id: string;
  job_number: string | null;
  status: string | null;
  total_acres: number | null;
  applied_acres: number | null;
}

/** Wire the single `jobs` scope read to return the given rows. */
function wireScope(rows: ScopeRow[]) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      return { select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

/**
 * Build a real ApplicatorSheetData (so data.total_acres = Σ field acres) for a gatherer
 * return. `fieldAcres = 0` models a job with NO job_fields (the jobs.total_acres fallback
 * shape); pass `totalQty` to give such a job a hand-entered product total independent of
 * its (zero) field acres — the realistic no-field-but-has-total fallback case.
 */
function sheet(jobNumber: string, fieldAcres: number, ratePerAcre: number, unit = 'pt', totalQty?: number): BuildSheetInput {
  return {
    job_number: jobNumber,
    customers: [{ customer_name: 'Acme', account_number: 'A1' }],
    scheduled_date: '2026-06-25',
    scheduled_time: null,
    applicator_name: null,
    vehicle_name: null,
    fields: fieldAcres > 0
      ? [{ field_id: 'f', field_name: 'F', county: null, state: null, acres: fieldAcres, crop: null, pest: null, sort_order: 0 }]
      : [],
    products: [{ product_name: 'Roundup', rate_per_acre: ratePerAcre, rate_unit: unit, unit, total_quantity: totalQty ?? ratePerAcre * fieldAcres, product_form: 'liquid', rei_hours: null, phi_days: null, epa_registration: null }],
    loader_comment: null,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('fetchProjectedUseData — drives scope off the gatherer field-acre basis (#13 root-cause fix)', () => {
  it('(a) INCLUDES a scheduled job with NULL jobs.total_acres but real field acres (HIGH: no silent drop)', async () => {
    // The live JOB-PARITY-11 shape: scheduled, jobs.total_acres = NULL (→ generated
    // remaining_acres = 0), applied = 0, but 100 real field acres + chemicals. The OLD code
    // dropped it as "already applied". The fix includes it with the FULL field-acre basis.
    wireScope([{ id: 'j1', job_number: 'JOB-PARITY-11', status: 'scheduled', total_acres: null, applied_acres: 0 }]);
    mockGather.mockResolvedValue(buildApplicatorSheetData(sheet('JOB-PARITY-11', 100, 2)));

    const { jobs, excluded } = await fetchProjectedUseData(['j1']);

    expect(excluded).toEqual([]); // NOT dropped, NOT "already applied"
    expect(jobs).toHaveLength(1);
    expect(jobs[0].remaining_acres).toBe(100); // full field acres (fieldTotal − applied 0)
    expect(jobs[0].status).toBe('scheduled');
    // End-to-end: it projects the full field-acre quantity (2 pt/ac × 100 = 200 pt).
    const out = buildProjectedUseReportData(jobs, excluded);
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.projected_quantity).toBe(200);
    expect(out.included_jobs.map((j) => j.job_number)).toEqual(['JOB-PARITY-11']);
  });

  it('(b) projects a DIVERGENT in_progress job off the field-acre basis (MED: 120, not 150)', async () => {
    // jobs.total_acres = 80 DIVERGES from the 100 real field acres; applied = 40. The
    // planned product total is 200 pt over the 100 field acres. Honest remaining =
    // fieldTotal(100) − applied(40) = 60 → 200 × 60/100 = 120 pt (RIGHT). The OLD code used
    // jobs.total_acres(80) as the denominator → 200 × (80−40)/80 = 200 × 0.5 = 100, or with
    // the old generated remaining (80−40=40) → 200 × 40/80 = 100 — either way WRONG vs 120.
    wireScope([{ id: 'j2', job_number: 'JOB-DIVERGE', status: 'in_progress', total_acres: 80, applied_acres: 40 }]);
    mockGather.mockResolvedValue(buildApplicatorSheetData(sheet('JOB-DIVERGE', 100, 2)));

    const { jobs, excluded } = await fetchProjectedUseData(['j2']);

    expect(excluded).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].remaining_acres).toBe(60); // 100 field acres − 40 applied (NOT 80 − 40)
    const out = buildProjectedUseReportData(jobs, excluded);
    expect(out.rows.find((r) => r.product_name === 'Roundup')!.projected_quantity).toBe(120); // corrected
  });

  it('(c) EXCLUDES a genuinely fully-applied job with the "already applied" reason', async () => {
    // 100 field acres, applied 100 → remaining 0 → genuinely fully applied.
    wireScope([{ id: 'j3', job_number: 'JOB-DONE', status: 'in_progress', total_acres: 100, applied_acres: 100 }]);
    mockGather.mockResolvedValue(buildApplicatorSheetData(sheet('JOB-DONE', 100, 2)));

    const { jobs, excluded } = await fetchProjectedUseData(['j3']);

    expect(jobs).toEqual([]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].job_number).toBe('JOB-DONE');
    expect(excluded[0].reason).toMatch(/already applied — nothing left to project/i);
  });

  it('(d) EXCLUDES a no-acres-basis job with the HONEST "set acres" reason (NOT "already applied")', async () => {
    // No field acres AND NULL jobs.total_acres, applied = 0 → no basis to project. The
    // reason must NOT be "already applied" (applied is 0) — it must tell the office to set acres.
    wireScope([{ id: 'j4', job_number: 'JOB-NOBASIS', status: 'scheduled', total_acres: null, applied_acres: 0 }]);
    mockGather.mockResolvedValue(buildApplicatorSheetData(sheet('JOB-NOBASIS', 0, 2)));

    const { jobs, excluded } = await fetchProjectedUseData(['j4']);

    expect(jobs).toEqual([]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toMatch(/no acres basis to project/i);
    expect(excluded[0].reason).not.toMatch(/already applied/i);
  });

  it('falls back to jobs.total_acres as the basis when the job has no field acres — and PROJECTS it (Codex P2)', async () => {
    // No job_fields, but jobs.total_acres = 50, applied 0, and a hand-entered product total
    // of 100 pt. Fall back to 50 as the acre_basis, include with remaining = 50. The basis
    // MUST flow through to the aggregator so the job is NOT silently zeroed: the Codex P2
    // regression was the aggregator re-deriving the denominator from data.total_acres (= 0
    // here) → factor 0 → the job shows included but projects nothing. With acre_basis carried
    // through: factor = 50/50 = 1 → the full 100 pt projects.
    wireScope([{ id: 'j5', job_number: 'JOB-FALLBACK', status: 'scheduled', total_acres: 50, applied_acres: 0 }]);
    mockGather.mockResolvedValue(buildApplicatorSheetData(sheet('JOB-FALLBACK', 0, 2, 'pt', 100)));

    const { jobs, excluded } = await fetchProjectedUseData(['j5']);

    expect(excluded).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].remaining_acres).toBe(50); // jobs.total_acres − applied 0
    expect(jobs[0].acre_basis).toBe(50); // the fallback basis is carried to the aggregator
    // End-to-end: the fallback job's chemical IS projected (not zeroed). factor 50/50 = 1.
    const out = buildProjectedUseReportData(jobs, excluded);
    const roundup = out.rows.find((r) => r.product_name === 'Roundup');
    expect(roundup).toBeTruthy();
    expect(roundup!.projected_quantity).toBe(100); // NOT 0 — the P2 silent-undercount is fixed
    expect(out.included_jobs[0].total_acres).toBe(50); // basis shown on the report, not 0
    expect(out.projected_acres).toBe(50);
  });

  it('EXCLUDES a non-scheduled/in_progress job by STATUS before any acre math', async () => {
    wireScope([{ id: 'j6', job_number: 'JOB-INV', status: 'invoiced', total_acres: 100, applied_acres: 0 }]);

    const { jobs, excluded } = await fetchProjectedUseData(['j6']);

    expect(jobs).toEqual([]);
    expect(excluded[0].reason).toMatch(/status: invoiced/i);
    expect(mockGather).not.toHaveBeenCalled(); // status-gated before the gatherer fetch
  });
});
