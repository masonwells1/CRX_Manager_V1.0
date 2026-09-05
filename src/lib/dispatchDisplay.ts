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
  /** jobs.job_date (U12) — lets the FieldView card show the date without an
   *  expand-triggered fetch, and drives the Today-first sort / Done section. */
  job_date: string | null;
  /** job_fields.field_id — the master fields.id for this dispatched location
   *  (U12 Codex P1). Returned by get_dispatched_list so the FieldView Complete
   *  form can build complete_job's field_acres payload ({field_id, acres_applied}).
   *  Null when the job_field has no master field linked. */
  field_id: string | null;
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

/**
 * A single job CARD for the phone/mobile applicator field view (#38) — the result of
 * grouping the flat `get_dispatched_list()` rows (one per dispatched LOCATION) by job.
 * The field view shows ONE card per job, listing every location dispatched to the
 * caller. Acres/customer/status are taken from the job-level columns the RPC already
 * resolved (identical across the job's rows). The map plots `field_ids`.
 */
export interface FieldViewJobCard {
  job_id: string;
  job_number: string;
  job_status: string;
  /** jobs.job_date (U12) — see DispatchedListRow.job_date. */
  job_date: string | null;
  customer_name: string | null;
  job_applied_acres: number | null;
  job_total_acres: number | null;
  /** Every location dispatched to the caller on this job (for the card + the map). */
  locations: {
    job_field_id: string;
    field_id: string | null;
    field_name: string | null;
    location_acres: number | null;
  }[];
}

/**
 * Group the flat dispatched-LOCATION rows (`get_dispatched_list()`) into one card per
 * JOB for the field view (#38, criteria #1/#2/#3). A job dispatched to the caller at
 * two locations collapses to a SINGLE card listing both. Cards are returned ordered by
 * job_number (stable, matches the RPC's own ORDER BY) so the list never reshuffles
 * between reloads.
 *
 * `field_id` is carried onto each card location (U12 Codex P1: get_dispatched_list
 * now returns it) so the Complete form can address complete_job's per-field
 * applied-acres override; a location with a null field_id stays display-only there.
 */
export function groupDispatchedByJob(
  rows: DispatchedListRow[]
): FieldViewJobCard[] {
  const byJob = new Map<string, FieldViewJobCard>();
  for (const r of rows) {
    let card = byJob.get(r.job_id);
    if (!card) {
      card = {
        job_id: r.job_id,
        job_number: r.job_number,
        job_status: r.job_status,
        job_date: r.job_date,
        customer_name: r.customer_name,
        job_applied_acres: r.job_applied_acres,
        job_total_acres: r.job_total_acres,
        locations: [],
      };
      byJob.set(r.job_id, card);
    }
    // De-dupe locations by job_field_id (a defensive guard — the RPC returns one row
    // per current dispatch, but a re-dispatch generation could surface a duplicate).
    if (!card.locations.some((l) => l.job_field_id === r.job_field_id)) {
      card.locations.push({
        job_field_id: r.job_field_id,
        field_id: r.field_id ?? null,
        field_name: r.field_name,
        location_acres: r.location_acres,
      });
    }
  }
  return Array.from(byJob.values()).sort((a, b) =>
    a.job_number.localeCompare(b.job_number)
  );
}

/**
 * Free-text filter for the field-view job cards (job# or customer). Mirrors the
 * office search but scoped to the small card set the applicator already owns.
 */
export function filterFieldViewCards(
  cards: FieldViewJobCard[],
  search: string
): FieldViewJobCard[] {
  const q = search.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) =>
    `${c.job_number} ${c.customer_name ?? ''}`.toLowerCase().includes(q)
  );
}

/**
 * Split a list of ids into fixed-size chunks so a PostgREST `.in('col', ids)` filter
 * never serializes an unbounded number of UUIDs into a single GET URL (a large
 * dispatch set could otherwise exceed the gateway URL limit and throw before Postgres
 * runs). Caller fetches each chunk and concatenates. `size` defaults to 200 — well
 * under the URL cap even at 36-char UUIDs, and far above any realistic per-applicator
 * dispatch count, so it's a single request in practice.
 */
export function chunkIds<T>(ids: T[], size = 200): T[][] {
  if (size <= 0) return ids.length ? [ids] : [];
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Stable cache key for a card's lazily-loaded read-only detail (#38). The detail is
 * SCOPED to the caller's dispatched job_field_ids, so the cache must invalidate when
 * that set changes (a dispatcher adding/removing one of the caller's locations) —
 * keying by job_id ALONE would replay a stale location/crop list after a reload.
 * Combines the job_id with the SORTED dispatched job_field_ids so the key is identical
 * across reloads of an unchanged dispatch and differs the moment the set changes.
 */
export function cardDetailCacheKey(card: FieldViewJobCard): string {
  const ids = card.locations.map((l) => l.job_field_id).sort();
  return `${card.job_id}|${ids.join(',')}`;
}

/**
 * Resolve a clicked master `field_id` to the `job_id` it belongs to, using the
 * `field_id → job_id` map built from the caller's dispatched `job_fields` (#38 map
 * tap-to-open). `get_dispatched_list` does NOT carry the master `field_id`, so the
 * field view fetches `job_fields(job_id, field_id)` separately and feeds that map
 * here. Returns `null` when the clicked field isn't one of the caller's dispatched
 * job fields (e.g. a stray boundary). A master field shared across two of the
 * caller's dispatched jobs is a rare tie — the map already collapsed it to one
 * job_id (first writer wins); that's acceptable per the spec.
 */
export function resolveFieldToJob(
  fieldToJob: Map<string, string>,
  fieldId: string | null | undefined
): string | null {
  if (!fieldId) return null;
  return fieldToJob.get(fieldId) ?? null;
}

/**
 * Per-product charge for the read-only card's Chemicals/Charges line, in cents.
 * Charge = quantity × price_per_unit_cents (there is no separate job-charges table —
 * charges are DERIVED from the job_chemicals price column). Returns a non-negative
 * integer cents value; a missing/negative input reads as 0 so the card never shows
 * NaN. Display divides by 100 (money is bigint cents — never float math on dollars).
 */
export function chemicalChargeCents(
  quantity: number | null | undefined,
  pricePerUnitCents: number | null | undefined
): number {
  const qty = toNum(quantity);
  const price = toNum(pricePerUnitCents);
  if (qty <= 0 || price <= 0) return 0;
  return Math.round(qty * price);
}

/**
 * Terminal job-lifecycle statuses (see the AGENTS.md-routed lifecycle documents:
 * `scheduled → in_progress → completed → cancelled → invoiced`). A terminal
 * job's dispatch has nothing left for the applicator to DO — it belongs in
 * the FieldView "Done" section, not mixed in with today's actionable work.
 */
export function isTerminalJobStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'invoiced';
}

/** The two FieldView sections: today-first actionable jobs, and a Done tail. */
export interface FieldViewCardGroups {
  active: FieldViewJobCard[];
  done: FieldViewJobCard[];
}

/**
 * Split + sort the caller's job cards for the FieldView "My Day" list (U12).
 *
 * Design decision (mission #22/#24-33 — "hide terminal jobs by default" vs.
 * "return them with status so the UI can show a Done section"): the LATTER.
 * get_dispatched_list still returns every currently-dispatched row regardless
 * of the job's lifecycle status (unchanged — filtering server-side would give
 * an applicator no way to see what they just finished today), and the CLIENT
 * groups: non-terminal jobs sort TODAY-first (job_date === today) then by
 * ascending job_date (nulls last), tie-broken by job_number; terminal jobs
 * move to a separate `done` bucket, most-recently-dated first, so a completed
 * job doesn't visually compete with today's remaining work but isn't hidden
 * either. `todayStr` is caller-supplied (e.g. `localToday()`) so this stays a
 * pure, framework-free, unit-testable function (no `Date.now()` inside).
 *
 * Current behavior: the job-terminal trigger closes dispatch rows as
 * 'completed'/'cancelled', and get_dispatched_list returns active 'dispatched'
 * rows plus the last seven days of 'completed' rows. The Done bucket is therefore
 * bounded by that seven-day window.
 */
export function groupFieldViewCards(
  cards: FieldViewJobCard[],
  todayStr: string
): FieldViewCardGroups {
  const active: FieldViewJobCard[] = [];
  const done: FieldViewJobCard[] = [];
  for (const c of cards) {
    if (isTerminalJobStatus(c.job_status)) done.push(c);
    else active.push(c);
  }

  active.sort((a, b) => {
    const aToday = a.job_date === todayStr;
    const bToday = b.job_date === todayStr;
    if (aToday !== bToday) return aToday ? -1 : 1;
    const ad = a.job_date ?? '9999-99-99'; // undated sorts last
    const bd = b.job_date ?? '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.job_number.localeCompare(b.job_number);
  });

  done.sort((a, b) => {
    const ad = a.job_date ?? '';
    const bd = b.job_date ?? '';
    if (ad !== bd) return ad > bd ? -1 : 1; // most-recent first
    return a.job_number.localeCompare(b.job_number);
  });

  return { active, done };
}

/**
 * The strictest (longest) REI/PHI across a job's chemical mix (U12, criterion
 * "REI/PHI line when label data exists"). A job applies ALL its listed
 * chemicals together, so the field isn't safe to re-enter / harvest until the
 * LONGEST of any product's re-entry/pre-harvest interval has passed — mirrors
 * how `compareToMaxRate`/label guardrails already treat a job's chemical set.
 * Returns null for a value when NO chemical in the mix has that label field on
 * file (matches the live reality that 0/604 products have REI/PHI data today —
 * the UI shows nothing for a job whose products aren't labeled yet, never a
 * misleading 0).
 */
export function maxLabelReiPhi(
  chemicals: { rei_hours: number | null | undefined; phi_days: number | null | undefined }[]
): { reiHours: number | null; phiDays: number | null } {
  let reiHours: number | null = null;
  let phiDays: number | null = null;
  for (const c of chemicals) {
    if (typeof c.rei_hours === 'number' && (reiHours === null || c.rei_hours > reiHours)) reiHours = c.rei_hours;
    if (typeof c.phi_days === 'number' && (phiDays === null || c.phi_days > phiDays)) phiDays = c.phi_days;
  }
  return { reiHours, phiDays };
}
