import { describe, it, expect } from 'vitest';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  selectDispatchView,
  hasActiveDispatchFilter,
  emptyDispatchFilters,
  type DispatchFilters,
  type DispatchSelectableJob,
} from '../dispatchDisplay';

describe('formatAppliedOfTotal', () => {
  it('renders applied-of-total with decimals (ChemMan 153.88 of 153.88 ac)', () =>
    expect(formatAppliedOfTotal(153.88, 153.88)).toBe('153.88 of 153.88 ac'));
  it('renders whole numbers without decimals', () =>
    expect(formatAppliedOfTotal(40, 100)).toBe('40 of 100 ac'));
  it('treats null total as 0', () =>
    expect(formatAppliedOfTotal(0, null)).toBe('0 of 0 ac'));
  it('treats null applied as 0', () =>
    expect(formatAppliedOfTotal(null, 50)).toBe('0 of 50 ac'));
  it('clamps negative applied to 0', () =>
    expect(formatAppliedOfTotal(-5, 50)).toBe('0 of 50 ac'));
  it('does NOT clamp over-applied (real field condition 55 of 40)', () =>
    expect(formatAppliedOfTotal(55, 40)).toBe('55 of 40 ac'));
  it('trims float dust to 2 dp', () =>
    expect(formatAppliedOfTotal(153.880000001, 153.88)).toBe('153.88 of 153.88 ac'));
  it('handles undefined for both', () =>
    expect(formatAppliedOfTotal(undefined, undefined)).toBe('0 of 0 ac'));
});

describe('jobStatusToDispatchBadge', () => {
  it('maps scheduled -> PENDING', () =>
    expect(jobStatusToDispatchBadge('scheduled').label).toBe('PENDING'));
  it('maps in_progress -> ACTIVE', () =>
    expect(jobStatusToDispatchBadge('in_progress').label).toBe('ACTIVE'));
  it('maps completed -> DONE', () =>
    expect(jobStatusToDispatchBadge('completed').label).toBe('DONE'));
  it('maps invoiced -> BILLED', () =>
    expect(jobStatusToDispatchBadge('invoiced').label).toBe('BILLED'));
  it('maps cancelled -> CANCELLED', () =>
    expect(jobStatusToDispatchBadge('cancelled').label).toBe('CANCELLED'));
  it('falls back to upper-cased unknown status', () =>
    expect(jobStatusToDispatchBadge('weird').label).toBe('WEIRD'));
  it('always returns a non-empty className', () =>
    expect(jobStatusToDispatchBadge('scheduled').className.length).toBeGreaterThan(0));
});

function mkJob(over: Partial<DispatchSelectableJob>): DispatchSelectableJob {
  return {
    status: 'scheduled',
    applicator_id: null,
    recipe_id: null,
    job_number: 'JOB-1',
    customer_name: 'Farm A',
    job_date: '2026-06-25',
    ...over,
  };
}

describe('selectDispatchView (shared filter)', () => {
  const jobs: DispatchSelectableJob[] = [
    mkJob({ job_number: 'A', status: 'scheduled', applicator_id: 'app-1', job_date: '2026-06-20' }),
    mkJob({ job_number: 'B', status: 'in_progress', applicator_id: 'app-2', job_date: '2026-06-25' }),
    mkJob({ job_number: 'C', status: 'scheduled', applicator_id: null, customer_name: 'Beta Ranch', job_date: '2026-06-30' }),
  ];

  it('returns all jobs with empty filters', () =>
    expect(selectDispatchView(jobs, emptyDispatchFilters, 'list')).toHaveLength(3));

  it('filters by status', () => {
    const f: DispatchFilters = { ...emptyDispatchFilters, status: 'in_progress' };
    const out = selectDispatchView(jobs, f, 'list');
    expect(out.map((j) => j.job_number)).toEqual(['B']);
  });

  it('filters by applicator', () => {
    const f: DispatchFilters = { ...emptyDispatchFilters, applicatorId: 'app-1' };
    expect(selectDispatchView(jobs, f, 'list').map((j) => j.job_number)).toEqual(['A']);
  });

  it('filters by search over job number and customer', () => {
    const f: DispatchFilters = { ...emptyDispatchFilters, search: 'beta' };
    expect(selectDispatchView(jobs, f, 'list').map((j) => j.job_number)).toEqual(['C']);
  });

  it('filters by date range', () => {
    const f: DispatchFilters = { ...emptyDispatchFilters, startDate: '2026-06-24', endDate: '2026-06-26' };
    expect(selectDispatchView(jobs, f, 'list').map((j) => j.job_number)).toEqual(['B']);
  });

  it('the SAME filter yields the SAME subset for map and list (criterion #6)', () => {
    const f: DispatchFilters = { ...emptyDispatchFilters, status: 'scheduled' };
    const list = selectDispatchView(jobs, f, 'list').map((j) => j.job_number);
    const map = selectDispatchView(jobs, f, 'map').map((j) => j.job_number);
    expect(map).toEqual(list);
    expect(list).toEqual(['A', 'C']);
  });

  it('filters by recipe (stub for #39, but the shared field already works)', () => {
    const withRecipe = [mkJob({ job_number: 'R', recipe_id: 'rec-9' }), ...jobs];
    const f: DispatchFilters = { ...emptyDispatchFilters, recipeId: 'rec-9' };
    expect(selectDispatchView(withRecipe, f, 'list').map((j) => j.job_number)).toEqual(['R']);
  });
});

describe('hasActiveDispatchFilter', () => {
  it('false for empty filters', () =>
    expect(hasActiveDispatchFilter(emptyDispatchFilters)).toBe(false));
  it('true when a status filter is set', () =>
    expect(hasActiveDispatchFilter({ ...emptyDispatchFilters, status: 'scheduled' })).toBe(true));
  it('true when search has content', () =>
    expect(hasActiveDispatchFilter({ ...emptyDispatchFilters, search: ' x ' })).toBe(true));
  it('false when search is only whitespace', () =>
    expect(hasActiveDispatchFilter({ ...emptyDispatchFilters, search: '   ' })).toBe(false));
});
