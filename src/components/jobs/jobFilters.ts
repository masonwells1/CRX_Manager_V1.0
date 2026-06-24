/**
 * Field-app parity #6: the FULL job-list filter set, AND-combined.
 *
 * ChemMan's job-list filter bar narrows the list by any combination of who /
 * what / where / when. CRX splits the work in two, both feeding the SAME
 * `visibleJobs` memo on the Jobs page so the table, the bottom totals, and the
 * row-selection never disagree:
 *
 *   - SERVER-side filters (status, customer, date range, applicator, vehicle,
 *     type/application-service, ground crew, job #) are chained onto the
 *     PostgREST query before the 500-row cap — they read indexed scalar columns
 *     on `jobs`, so they are cheap and correct against the limit.
 *   - CLIENT-side filters (job tags, crop, county, state, chemical, field name)
 *     read JOINED child rows already pulled with each job. The pure predicate
 *     `jobMatchesClientFilters` below applies them; keeping it pure makes it
 *     unit-testable and guarantees AND-combination semantics.
 *
 * "Draft vs applied": the page keeps a DRAFT filter object the user edits and an
 * APPLIED filter object that actually drives the query/memo. SEARCH copies draft
 * → applied; CLEAR ALL resets BOTH to `emptyJobFilters`. That matches ChemMan's
 * explicit SEARCH / CLEAR ALL FILTERS controls (filters do not auto-run).
 */

/** Every filter ChemMan's job-list bar exposes. Empty array / '' = inert. */
export interface JobFilters {
  // --- server-side (chained on the query) ---
  jobNumber: string;          // substring match on job_number (ilike)
  customerIds: string[];      // multi-select; matches primary OR a per-field share
  applicatorIds: string[];    // multi-select on jobs.applicator_id
  vehicleIds: string[];       // multi-select on jobs.vehicle_id
  typeIds: string[];          // multi-select on jobs.application_service_id ("Type")
  groundCrewIds: string[];    // multi-select on jobs.ground_crew_id
  batchIds: string[];         // multi-select on jobs.batch_ref (field-app parity #3)
  statuses: string[];         // multi-select on jobs.status
  startDate: string;          // job_date >=
  endDate: string;            // job_date <=
  // --- client-side (over joined data) ---
  tagIds: string[];           // reuses #4's jobMatchesTagFilter (OR within tags)
  crop: string;               // substring match on any field's crop
  county: string;             // substring match on any field's county
  state: string;              // substring match on any field's state
  chemical: string;           // substring match on any product name
  fieldName: string;          // substring match on any location/field name
}

export const emptyJobFilters: JobFilters = {
  jobNumber: '',
  customerIds: [],
  applicatorIds: [],
  vehicleIds: [],
  typeIds: [],
  groundCrewIds: [],
  batchIds: [],
  statuses: [],
  startDate: '',
  endDate: '',
  tagIds: [],
  crop: '',
  county: '',
  state: '',
  chemical: '',
  fieldName: '',
};

/** True when no filter is set (the bar is fully cleared). */
export function isJobFiltersEmpty(f: JobFilters): boolean {
  return (
    f.jobNumber.trim() === '' &&
    f.customerIds.length === 0 &&
    f.applicatorIds.length === 0 &&
    f.vehicleIds.length === 0 &&
    f.typeIds.length === 0 &&
    f.groundCrewIds.length === 0 &&
    f.batchIds.length === 0 &&
    f.statuses.length === 0 &&
    f.startDate === '' &&
    f.endDate === '' &&
    f.tagIds.length === 0 &&
    f.crop.trim() === '' &&
    f.county.trim() === '' &&
    f.state.trim() === '' &&
    f.chemical.trim() === '' &&
    f.fieldName.trim() === ''
  );
}

/** Count of distinct active filters — drives the "N active" badge + MORE hint. */
export function activeJobFilterCount(f: JobFilters): number {
  let n = 0;
  if (f.jobNumber.trim()) n++;
  if (f.customerIds.length) n++;
  if (f.applicatorIds.length) n++;
  if (f.vehicleIds.length) n++;
  if (f.typeIds.length) n++;
  if (f.groundCrewIds.length) n++;
  if (f.batchIds.length) n++;
  if (f.statuses.length) n++;
  if (f.startDate) n++;
  if (f.endDate) n++;
  if (f.tagIds.length) n++;
  if (f.crop.trim()) n++;
  if (f.county.trim()) n++;
  if (f.state.trim()) n++;
  if (f.chemical.trim()) n++;
  if (f.fieldName.trim()) n++;
  return n;
}

/**
 * The CLIENT-side, joined-data facts a job carries, normalized once per row so
 * the predicate stays a cheap set/substring check. Tag ids are kept as a Set.
 */
export interface JobFilterFacts {
  tagIds: Set<string>;
  crops: string[];      // job_fields.crop (+ field.crop_type fallback)
  counties: string[];   // field.county
  states: string[];     // field.state
  chemicals: string[];  // product_name per job_chemicals line
  fieldNames: string[]; // field.field_name
}

/** Case-insensitive "any value contains the (trimmed, non-empty) needle". */
function anyContains(values: string[], needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (q === '') return true; // inert filter passes everything
  return values.some((v) => v.toLowerCase().includes(q));
}

/**
 * Pure predicate for the CLIENT-side filters. AND-combined: a job passes only
 * when it satisfies EVERY active client filter. Each individual filter is inert
 * when empty (passes all), so this composes cleanly with the server filters that
 * already ran on the query. Tag semantics are OR-within (reuses #4's contract):
 * a job passes the tag filter when it carries at least one selected tag.
 */
export function jobMatchesClientFilters(facts: JobFilterFacts, f: JobFilters): boolean {
  // Job tags — OR within the selected tags, inert when none selected.
  if (f.tagIds.length > 0) {
    if (!f.tagIds.some((id) => facts.tagIds.has(id))) return false;
  }
  if (!anyContains(facts.crops, f.crop)) return false;
  if (!anyContains(facts.counties, f.county)) return false;
  if (!anyContains(facts.states, f.state)) return false;
  if (!anyContains(facts.chemicals, f.chemical)) return false;
  if (!anyContains(facts.fieldNames, f.fieldName)) return false;
  return true;
}
