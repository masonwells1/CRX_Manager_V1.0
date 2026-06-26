/**
 * dispatchDisplay.ts — pure display/selection logic for the Dispatch field view
 * (field-app parity #35).
 *
 * Kept framework-free so it can be unit-tested in isolation:
 *  - formatAppliedOfTotal: ChemMan "X of Y ac" applied-of-total acres label.
 *  - jobStatusToDispatchBadge: maps the job lifecycle status to the field-mode
 *    badge (PENDING / ACTIVE / DONE / BILLED / CANCELLED).
 *  - selectDispatchView: the SINGLE shared-filter selector — one filter object
 *    feeds either the map or the list, so switching view never forks the filter.
 */

export type JobLifecycleStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'invoiced';

export type DispatchView = 'map' | 'list';

export interface DispatchBadge {
  /** Uppercase field-mode label shown on the row. */
  label: string;
  /** Tailwind classes for the dark-mode badge pill. */
  className: string;
}

/**
 * ChemMan "applied of total" acres label, e.g. `153.88 of 153.88 ac`.
 * - Trims trailing zeros so 153.88 shows as `153.88` and 80 shows as `80`.
 * - A null/missing total reads as `0`, so a job with no acres shows `0 of 0 ac`
 *   rather than `NaN`/blank.
 * - Applied is clamped at 0 (never negative); it is NOT clamped to total because
 *   an over-applied job (applied > total) is a real field condition the
 *   dispatcher should see (e.g. 55 of 40 ac).
 */
export function formatAppliedOfTotal(
  appliedAcres: number | null | undefined,
  totalAcres: number | null | undefined
): string {
  const applied = Math.max(0, toNum(appliedAcres));
  const total = Math.max(0, toNum(totalAcres));
  return `${trimAcres(applied)} of ${trimAcres(total)} ac`;
}

function toNum(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Format an acre value with up to 2 decimals, trimming trailing zeros. */
function trimAcres(v: number): string {
  // Round to 2 dp to avoid float dust (e.g. 153.8800000001), then strip zeros.
  const rounded = Math.round(v * 100) / 100;
  return String(rounded);
}

/**
 * Map a job's lifecycle status to its dispatch-mode badge. ChemMan shows
 * PENDING (not yet started) and ACTIVE (in the field); we keep the other live
 * CRX statuses sensible (DONE / BILLED / CANCELLED) so no job renders blank.
 * Never invents a new DB status — purely a display mapping.
 */
export function jobStatusToDispatchBadge(status: string): DispatchBadge {
  switch (status) {
    case 'scheduled':
      return { label: 'PENDING', className: 'bg-amber-500/20 text-amber-300 border border-amber-500/40' };
    case 'in_progress':
      return { label: 'ACTIVE', className: 'bg-crx-green/25 text-crx-green border border-crx-green/50' };
    case 'completed':
      return { label: 'DONE', className: 'bg-sky-500/20 text-sky-300 border border-sky-500/40' };
    case 'invoiced':
      return { label: 'BILLED', className: 'bg-violet-500/20 text-violet-300 border border-violet-500/40' };
    case 'cancelled':
      return { label: 'CANCELLED', className: 'bg-slate-600/30 text-slate-400 border border-slate-500/40' };
    default:
      return { label: String(status || 'UNKNOWN').toUpperCase(), className: 'bg-slate-600/30 text-slate-400 border border-slate-500/40' };
  }
}

/** The filter set shared by BOTH the map and the list views. */
export interface DispatchFilters {
  status: 'all' | JobLifecycleStatus;
  applicatorId: string;
  /** Recipe filter is owned by section #39 — carried here so the shared filter
   *  is the single source of truth; #35 leaves it unset ('' = no recipe filter). */
  recipeId: string;
  search: string;
  startDate: string;
  endDate: string;
}

export const emptyDispatchFilters: DispatchFilters = {
  status: 'all',
  applicatorId: '',
  recipeId: '',
  search: '',
  startDate: '',
  endDate: '',
};

/** Minimal shape the selector needs from a job row. */
export interface DispatchSelectableJob {
  status: string;
  applicator_id: string | null;
  recipe_id: string | null;
  job_number: string;
  customer_name?: string;
  job_date?: string | null;
  /** Applicator ids dispatched to this job at the LOCATION level (#36) — the
   *  Applicator filter matches the job-level applicator OR any of these, so a
   *  per-location-only assignee still surfaces under that applicator's filter. */
  dispatched_applicator_ids?: string[];
}

/**
 * Apply the SHARED filter set to a job collection. The dispatch page calls this
 * ONCE; the result feeds whichever view (`map` or `list`) is active, so toggling
 * the view can never change which jobs are in scope (criterion #6). The `view`
 * arg is accepted for symmetry/future per-view tweaks but does NOT change the
 * filtered set — both views see the identical subset.
 */
export function selectDispatchView<T extends DispatchSelectableJob>(
  jobs: T[],
  filters: DispatchFilters,
  _view: DispatchView
): T[] {
  const search = filters.search.trim().toLowerCase();
  return jobs.filter((j) => {
    if (filters.status !== 'all' && j.status !== filters.status) return false;
    if (filters.applicatorId) {
      // Match the DISPLAYED assignee, mirroring aggregateAssignedTo (#36): when a
      // job has per-location dispatches, the row shows ONLY those assignees (the
      // legacy job-level applicator is hidden), so the filter must match the
      // per-location assignees and NOT the stale jobs.applicator_id. Only when a
      // job has NO per-location dispatch does the job-level applicator count (the
      // display fallback). This keeps the filter consistent with the visible label.
      const perLocation = j.dispatched_applicator_ids ?? [];
      const matches = perLocation.length > 0
        ? perLocation.includes(filters.applicatorId)
        : j.applicator_id === filters.applicatorId;
      if (!matches) return false;
    }
    if (filters.recipeId && j.recipe_id !== filters.recipeId) return false;
    if (filters.startDate && (j.job_date ?? '') < filters.startDate) return false;
    if (filters.endDate && (j.job_date ?? '') > filters.endDate) return false;
    if (search) {
      const hay = `${j.job_number} ${j.customer_name ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/**
 * One row of the "Dispatched List" (#37) — a single CURRENTLY-dispatched location,
 * as returned by the `get_dispatched_list` RPC (assignee name resolved server-side).
 * Acres are display-only (the location's acres_to_treat + the job's applied/total).
 */
export interface DispatchedListRow {
  dispatch_id: string;
  job_field_id: string;
  job_id: string;
  job_number: string;
  /** The job lifecycle status (scheduled/in_progress/...) — drives the row badge. */
  job_status: string;
  dispatch_status: string;
  assignee_kind: 'applicator' | 'crew';
  applicator_id: string | null;
  crew_id: string | null;
  /** Resolved server-side (profiles.full_name / ground_crews.name); never a client embed. */
  assignee_name: string | null;
  field_name: string | null;
  customer_name: string | null;
  location_acres: number | null;
  job_applied_acres: number | null;
  job_total_acres: number | null;
}

/** The assignee filter for the Dispatched List — at most one of applicator/crew. */
export interface DispatchedAssigneeFilter {
  applicatorId: string;
  crewId: string;
}

export const emptyDispatchedAssigneeFilter: DispatchedAssigneeFilter = {
  applicatorId: '',
  crewId: '',
};

/**
 * Apply the assignee filter to the dispatched-list rows (criterion #3). The server
 * RPC can already narrow by assignee, but we ALSO filter client-side so the toggle
 * is instant and the result is consistent whether the rows were fetched filtered or
 * unfiltered. An empty filter returns every row. Only ONE of applicator/crew is ever
 * set (the picker is single-select); if both were somehow set, a row must match both.
 */
export function filterDispatchedRows(
  rows: DispatchedListRow[],
  filter: DispatchedAssigneeFilter
): DispatchedListRow[] {
  const { applicatorId, crewId } = filter;
  if (!applicatorId && !crewId) return rows;
  return rows.filter((r) => {
    if (applicatorId && r.applicator_id !== applicatorId) return false;
    if (crewId && r.crew_id !== crewId) return false;
    return true;
  });
}

/** True when the Dispatched List assignee filter is active. */
export function hasActiveDispatchedFilter(filter: DispatchedAssigneeFilter): boolean {
  return filter.applicatorId !== '' || filter.crewId !== '';
}

/** True when any filter is active (drives the "filters active" hint + Clear). */
export function hasActiveDispatchFilter(filters: DispatchFilters): boolean {
  return (
    filters.status !== 'all' ||
    filters.applicatorId !== '' ||
    filters.recipeId !== '' ||
    filters.search.trim() !== '' ||
    filters.startDate !== '' ||
    filters.endDate !== ''
  );
}
