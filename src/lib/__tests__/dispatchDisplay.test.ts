import { describe, it, expect } from 'vitest';
import {
  formatAppliedOfTotal,
  jobStatusToDispatchBadge,
  selectDispatchView,
  hasActiveDispatchFilter,
  emptyDispatchFilters,
  filterDispatchedRows,
  hasActiveDispatchedFilter,
  emptyDispatchedAssigneeFilter,
  groupDispatchedByJob,
  filterFieldViewCards,
  chemicalChargeCents,
  resolveFieldToJob,
  chunkIds,
  cardDetailCacheKey,
  type FieldViewJobCard,
  type DispatchFilters,
  type DispatchSelectableJob,
  type DispatchedListRow,
  type DispatchedAssigneeFilter,
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

  it('applicator filter also matches a per-location-only assignee (#36)', () => {
    // Job D has NO job-level applicator but is dispatched to app-1 at the location
    // level — it must surface under an app-1 filter.
    const withPerLocation = [
      ...jobs,
      mkJob({ job_number: 'D', status: 'scheduled', applicator_id: null, dispatched_applicator_ids: ['app-1', 'app-2'] }),
    ];
    const f: DispatchFilters = { ...emptyDispatchFilters, applicatorId: 'app-1' };
    expect(selectDispatchView(withPerLocation, f, 'list').map((j) => j.job_number).sort()).toEqual(['A', 'D']);
  });

  it('applicator filter excludes a job whose per-location assignees do not include the filter', () => {
    const withPerLocation = [
      mkJob({ job_number: 'E', status: 'scheduled', applicator_id: null, dispatched_applicator_ids: ['app-2'] }),
    ];
    const f: DispatchFilters = { ...emptyDispatchFilters, applicatorId: 'app-1' };
    expect(selectDispatchView(withPerLocation, f, 'list')).toHaveLength(0);
  });

  it('once per-location dispatches exist, the filter matches the DISPLAYED assignee, NOT the stale job-level applicator (#36)', () => {
    // Job F has a LEGACY job-level applicator app-1, but is now per-location
    // dispatched only to app-2. The row displays "app-2" (aggregateAssignedTo hides
    // the legacy app-1), so filtering by app-1 must NOT surface it, and filtering by
    // app-2 must.
    const withLegacy = [
      mkJob({ job_number: 'F', status: 'scheduled', applicator_id: 'app-1', dispatched_applicator_ids: ['app-2'] }),
    ];
    expect(selectDispatchView(withLegacy, { ...emptyDispatchFilters, applicatorId: 'app-1' }, 'list')).toHaveLength(0);
    expect(selectDispatchView(withLegacy, { ...emptyDispatchFilters, applicatorId: 'app-2' }, 'list').map((j) => j.job_number)).toEqual(['F']);
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

function mkDispatchedRow(over: Partial<DispatchedListRow>): DispatchedListRow {
  return {
    dispatch_id: 'd-1',
    job_field_id: 'jf-1',
    job_id: 'job-1',
    job_number: 'JOB-1',
    job_status: 'scheduled',
    dispatch_status: 'dispatched',
    assignee_kind: 'applicator',
    applicator_id: 'app-1',
    crew_id: null,
    assignee_name: 'Bob',
    field_name: 'North 40',
    customer_name: 'Farm A',
    location_acres: 40,
    job_applied_acres: 0,
    job_total_acres: 100,
    ...over,
  };
}

describe('filterDispatchedRows (assignee filter — #37 criterion 3)', () => {
  const rows: DispatchedListRow[] = [
    mkDispatchedRow({ dispatch_id: 'd-a', job_field_id: 'jf-a', applicator_id: 'app-1', crew_id: null, assignee_kind: 'applicator' }),
    mkDispatchedRow({ dispatch_id: 'd-b', job_field_id: 'jf-b', applicator_id: 'app-2', crew_id: null, assignee_kind: 'applicator' }),
    mkDispatchedRow({ dispatch_id: 'd-c', job_field_id: 'jf-c', applicator_id: null, crew_id: 'crew-9', assignee_kind: 'crew' }),
  ];

  it('returns all rows with an empty filter', () =>
    expect(filterDispatchedRows(rows, emptyDispatchedAssigneeFilter)).toHaveLength(3));

  it('filters to a single applicator', () => {
    const f: DispatchedAssigneeFilter = { applicatorId: 'app-1', crewId: '' };
    expect(filterDispatchedRows(rows, f).map((r) => r.dispatch_id)).toEqual(['d-a']);
  });

  it('filters to a single crew', () => {
    const f: DispatchedAssigneeFilter = { applicatorId: '', crewId: 'crew-9' };
    expect(filterDispatchedRows(rows, f).map((r) => r.dispatch_id)).toEqual(['d-c']);
  });

  it('an applicator filter excludes crew rows (and vice versa)', () => {
    expect(filterDispatchedRows(rows, { applicatorId: 'app-2', crewId: '' }).map((r) => r.dispatch_id)).toEqual(['d-b']);
    expect(filterDispatchedRows(rows, { applicatorId: '', crewId: 'crew-9' }).every((r) => r.crew_id === 'crew-9')).toBe(true);
  });

  it('returns empty when no row matches the chosen assignee', () =>
    expect(filterDispatchedRows(rows, { applicatorId: 'app-404', crewId: '' })).toHaveLength(0));
});

describe('hasActiveDispatchedFilter', () => {
  it('false for the empty filter', () =>
    expect(hasActiveDispatchedFilter(emptyDispatchedAssigneeFilter)).toBe(false));
  it('true when an applicator is chosen', () =>
    expect(hasActiveDispatchedFilter({ applicatorId: 'app-1', crewId: '' })).toBe(true));
  it('true when a crew is chosen', () =>
    expect(hasActiveDispatchedFilter({ applicatorId: '', crewId: 'crew-9' })).toBe(true));
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

describe('groupDispatchedByJob (field view #38 — "my jobs" cards)', () => {
  it('returns one card per job, collapsing multiple dispatched locations', () => {
    const rows: DispatchedListRow[] = [
      mkDispatchedRow({ dispatch_id: 'd1', job_id: 'job-A', job_number: 'JOB-A', job_field_id: 'jf-1', field_name: 'North 40', location_acres: 40 }),
      mkDispatchedRow({ dispatch_id: 'd2', job_id: 'job-A', job_number: 'JOB-A', job_field_id: 'jf-2', field_name: 'South 60', location_acres: 60 }),
      mkDispatchedRow({ dispatch_id: 'd3', job_id: 'job-B', job_number: 'JOB-B', job_field_id: 'jf-3', field_name: 'East 80', location_acres: 80 }),
    ];
    const cards = groupDispatchedByJob(rows);
    expect(cards).toHaveLength(2);
    const a = cards.find((c) => c.job_id === 'job-A')!;
    expect(a.locations.map((l) => l.field_name)).toEqual(['North 40', 'South 60']);
    expect(cards.find((c) => c.job_id === 'job-B')!.locations).toHaveLength(1);
  });

  it('carries job-level header data (customer, status, applied/total acres)', () => {
    const cards = groupDispatchedByJob([
      mkDispatchedRow({ job_id: 'job-A', job_number: 'JOB-A', customer_name: 'Farm A', job_status: 'in_progress', job_applied_acres: 25, job_total_acres: 100 }),
    ]);
    expect(cards[0]).toMatchObject({ customer_name: 'Farm A', job_status: 'in_progress', job_applied_acres: 25, job_total_acres: 100 });
  });

  it('de-dupes a repeated job_field_id (defensive against a re-dispatch generation)', () => {
    const cards = groupDispatchedByJob([
      mkDispatchedRow({ dispatch_id: 'd1', job_id: 'job-A', job_field_id: 'jf-1' }),
      mkDispatchedRow({ dispatch_id: 'd2', job_id: 'job-A', job_field_id: 'jf-1' }),
    ]);
    expect(cards[0].locations).toHaveLength(1);
  });

  it('orders cards by job_number (stable list across reloads)', () => {
    const cards = groupDispatchedByJob([
      mkDispatchedRow({ job_id: 'b', job_number: 'JOB-9' }),
      mkDispatchedRow({ job_id: 'a', job_number: 'JOB-1' }),
      mkDispatchedRow({ job_id: 'c', job_number: 'JOB-5' }),
    ]);
    expect(cards.map((c) => c.job_number)).toEqual(['JOB-1', 'JOB-5', 'JOB-9']);
  });

  it('returns an empty list for no rows', () =>
    expect(groupDispatchedByJob([])).toEqual([]));
});

describe('filterFieldViewCards (field view #38 search)', () => {
  const cards = groupDispatchedByJob([
    mkDispatchedRow({ job_id: 'a', job_number: 'JOB-101', customer_name: 'Green Acres' }),
    mkDispatchedRow({ job_id: 'b', job_number: 'JOB-202', customer_name: 'Sunrise Ag' }),
  ]);
  it('returns all cards for an empty query', () =>
    expect(filterFieldViewCards(cards, '   ')).toHaveLength(2));
  it('matches on job number', () =>
    expect(filterFieldViewCards(cards, '202').map((c) => c.job_id)).toEqual(['b']));
  it('matches on customer name (case-insensitive)', () =>
    expect(filterFieldViewCards(cards, 'green').map((c) => c.job_id)).toEqual(['a']));
  it('returns empty when nothing matches', () =>
    expect(filterFieldViewCards(cards, 'zzz')).toHaveLength(0));
});

describe('resolveFieldToJob (field view #38 — map tap-to-open)', () => {
  const f2j = new Map<string, string>([
    ['field-1', 'job-A'],
    ['field-2', 'job-A'],
    ['field-3', 'job-B'],
  ]);

  it('resolves a clicked master field_id to its owning job_id', () => {
    expect(resolveFieldToJob(f2j, 'field-1')).toBe('job-A');
    expect(resolveFieldToJob(f2j, 'field-3')).toBe('job-B');
  });

  it('two fields on the same job both resolve to that job', () => {
    expect(resolveFieldToJob(f2j, 'field-1')).toBe('job-A');
    expect(resolveFieldToJob(f2j, 'field-2')).toBe('job-A');
  });

  it('returns null for a field not in the dispatched set (stray boundary)', () =>
    expect(resolveFieldToJob(f2j, 'field-999')).toBeNull());

  it('returns null for a null/undefined/empty field_id', () => {
    expect(resolveFieldToJob(f2j, null)).toBeNull();
    expect(resolveFieldToJob(f2j, undefined)).toBeNull();
    expect(resolveFieldToJob(f2j, '')).toBeNull();
  });

  it('returns null against an empty map (map not loaded yet)', () =>
    expect(resolveFieldToJob(new Map(), 'field-1')).toBeNull());
});

describe('chunkIds (field view #38 — bound .in() URL length)', () => {
  it('returns a single chunk when under the size', () =>
    expect(chunkIds(['a', 'b', 'c'], 200)).toEqual([['a', 'b', 'c']]));

  it('splits into fixed-size chunks, last chunk shorter', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `id-${i}`);
    expect(chunkIds(ids, 2)).toEqual([['id-0', 'id-1'], ['id-2', 'id-3'], ['id-4']]);
  });

  it('preserves order and loses no ids across chunks', () => {
    const ids = Array.from({ length: 450 }, (_, i) => i);
    const chunks = chunkIds(ids, 200);
    expect(chunks).toHaveLength(3);
    expect(chunks.flat()).toEqual(ids);
  });

  it('returns an empty array for no ids', () =>
    expect(chunkIds([], 200)).toEqual([]));

  it('falls back to a single chunk for a non-positive size (never infinite-loops)', () =>
    expect(chunkIds(['a', 'b'], 0)).toEqual([['a', 'b']]));
});

function mkCard(over: Partial<FieldViewJobCard>): FieldViewJobCard {
  return {
    job_id: 'job-A',
    job_number: 'JOB-A',
    job_status: 'scheduled',
    customer_name: 'Farm A',
    job_applied_acres: 0,
    job_total_acres: 100,
    locations: [{ job_field_id: 'jf-1', field_id: null, field_name: 'North 40', location_acres: 40 }],
    ...over,
  };
}

describe('cardDetailCacheKey (field view #38 — cache invalidates on dispatch change)', () => {
  it('is stable across reloads of an unchanged dispatch set (order-independent)', () => {
    const a = mkCard({ locations: [
      { job_field_id: 'jf-2', field_id: null, field_name: 'B', location_acres: 1 },
      { job_field_id: 'jf-1', field_id: null, field_name: 'A', location_acres: 1 },
    ] });
    const b = mkCard({ locations: [
      { job_field_id: 'jf-1', field_id: null, field_name: 'A', location_acres: 1 },
      { job_field_id: 'jf-2', field_id: null, field_name: 'B', location_acres: 1 },
    ] });
    expect(cardDetailCacheKey(a)).toBe(cardDetailCacheKey(b));
  });

  it('CHANGES when a location is added or removed (forces a refetch)', () => {
    const one = mkCard({ locations: [{ job_field_id: 'jf-1', field_id: null, field_name: 'A', location_acres: 1 }] });
    const two = mkCard({ locations: [
      { job_field_id: 'jf-1', field_id: null, field_name: 'A', location_acres: 1 },
      { job_field_id: 'jf-2', field_id: null, field_name: 'B', location_acres: 1 },
    ] });
    expect(cardDetailCacheKey(one)).not.toBe(cardDetailCacheKey(two));
  });

  it('differs per job even with the same location ids', () => {
    const j1 = mkCard({ job_id: 'job-1' });
    const j2 = mkCard({ job_id: 'job-2' });
    expect(cardDetailCacheKey(j1)).not.toBe(cardDetailCacheKey(j2));
  });
});

describe('chemicalChargeCents (field view #38 — derived charge)', () => {
  it('multiplies quantity by price-per-unit cents (integer cents, no float dust)', () =>
    expect(chemicalChargeCents(200, 1234)).toBe(246800));
  it('rounds a fractional quantity to whole cents', () =>
    expect(chemicalChargeCents(2.5, 333)).toBe(833)); // 832.5 -> 833
  it('reads a null/zero/negative input as 0 (never NaN)', () => {
    expect(chemicalChargeCents(null, 1000)).toBe(0);
    expect(chemicalChargeCents(10, null)).toBe(0);
    expect(chemicalChargeCents(0, 1000)).toBe(0);
    expect(chemicalChargeCents(-5, 1000)).toBe(0);
    expect(chemicalChargeCents(10, -1)).toBe(0);
  });
});
