// Field-app parity #8: Customizable list columns (List Settings).
//
// This module is the SINGLE SOURCE OF TRUTH for which columns the Manage Job
// Scheduling list can show, their defaults, and the pure logic that merges a
// user's saved preferences with the current registry. Keeping it free of React
// makes the default-merge + visibility logic trivially unit-testable.
//
// The Jobs page renders its `dataColumns` array, then keeps only the columns
// whose id is currently "visible" (per the user's saved settings, defaulted).
// Each column here maps 1:1 to a column key on the Jobs page.

/** Stable ids for every toggleable job-list column. */
export type JobColumnId =
  | 'jobTags'
  | 'batch_name'
  | 'job_number'
  | 'customer_name'
  | 'customer_phone'
  | 'locations'
  | 'applicator_name'
  | 'crops'
  | 'chemicals'
  | 'wind_direction'
  | 'total_acres'
  | 'remaining_acres'
  | 'call_date'
  | 'job_date'
  | 'status'
  | 'vehicle_name'
  | 'total_price_cents'
  | 'created_by_name'
  | 'updated_by_name'
  | 'printed_at';

/** A column the user can toggle on/off in the List Settings panel. */
export interface JobColumnDef {
  id: JobColumnId;
  /** Human label shown in the toggle panel (matches the ChemMan wording). */
  label: string;
  /** True = also available on the field-application invoice list (shared
   *  toggle, acceptance criterion #5). */
  shared: boolean;
  /** Visible by default when a user has no saved settings. */
  defaultVisible: boolean;
}

/**
 * The full registry, IN DISPLAY ORDER. The Jobs page renders columns in this
 * order (filtered to the visible set). Order here = order on screen, so adding
 * a column in the right spot here places it correctly without touching Jobs.tsx
 * ordering.
 *
 * Columns whose underlying data is not yet on the job list (wind_direction,
 * customer_phone, call_date) are present so the toggle exists per acceptance
 * criterion #3; their cells render "-" until the upstream data lands. They
 * default to OFF so today's list looks unchanged.
 */
export const JOB_COLUMN_REGISTRY: JobColumnDef[] = [
  { id: 'jobTags', label: 'Job Tags', shared: false, defaultVisible: true },
  { id: 'batch_name', label: 'Batch', shared: false, defaultVisible: true },
  { id: 'job_number', label: 'Job #', shared: false, defaultVisible: true },
  { id: 'customer_name', label: 'Customers', shared: true, defaultVisible: true },
  { id: 'customer_phone', label: 'Customer Phone', shared: false, defaultVisible: false },
  { id: 'locations', label: 'Locations', shared: true, defaultVisible: true },
  { id: 'applicator_name', label: 'Applicators', shared: true, defaultVisible: true },
  { id: 'crops', label: 'Crops', shared: true, defaultVisible: true },
  { id: 'chemicals', label: 'Chemical Application', shared: true, defaultVisible: true },
  { id: 'wind_direction', label: 'Wind Direction', shared: false, defaultVisible: false },
  { id: 'total_acres', label: 'Total Acres', shared: true, defaultVisible: true },
  { id: 'remaining_acres', label: 'Remaining Acres', shared: false, defaultVisible: true },
  { id: 'call_date', label: 'Call Date', shared: false, defaultVisible: false },
  { id: 'job_date', label: 'Scheduled Date', shared: false, defaultVisible: true },
  { id: 'status', label: 'Status', shared: false, defaultVisible: true },
  { id: 'vehicle_name', label: 'Vehicle', shared: false, defaultVisible: false },
  { id: 'total_price_cents', label: 'Price', shared: false, defaultVisible: false },
  { id: 'created_by_name', label: 'Created By', shared: false, defaultVisible: false },
  { id: 'updated_by_name', label: 'Updated By', shared: false, defaultVisible: false },
  { id: 'printed_at', label: 'Last Printed By', shared: false, defaultVisible: true },
];

/** The list_key used for the job-scheduling list in user_list_settings. */
export const JOBS_LIST_KEY = 'jobs';

/** Every valid column id, for fast membership checks. */
const VALID_IDS = new Set<string>(JOB_COLUMN_REGISTRY.map((c) => c.id));

/** The shape of the `settings` jsonb we persist for the jobs list. */
export interface JobListSettings {
  /** Ids of the columns the user wants visible, IN no particular order (the
   *  registry decides display order). */
  visibleColumns: JobColumnId[];
  /** Whether completed jobs appear in the list (acceptance criterion #6). */
  showCompleted: boolean;
}

/** The default config when a user has never saved settings. */
export function defaultJobListSettings(): JobListSettings {
  return {
    visibleColumns: JOB_COLUMN_REGISTRY.filter((c) => c.defaultVisible).map((c) => c.id),
    showCompleted: true,
  };
}

/**
 * Merge a raw saved `settings` blob (from the DB, possibly partial / stale /
 * from an older app version) with the current registry into a clean, fully
 * specified JobListSettings.
 *
 * Rules:
 *  - Unknown / removed column ids in the saved blob are dropped (the registry
 *    is authoritative).
 *  - A column ADDED to the registry AFTER the user last saved does NOT silently
 *    appear: we only ever show what the user explicitly chose. The single
 *    exception is the very first load (no saved row at all) which uses the
 *    defaults. This keeps a user's curated layout stable across app updates.
 *  - showCompleted defaults to true when absent/invalid.
 *
 * Passing `null`/`undefined` (no saved row) returns the full defaults.
 */
export function mergeJobListSettings(raw: unknown): JobListSettings {
  if (raw == null || typeof raw !== 'object') {
    return defaultJobListSettings();
  }
  const obj = raw as Record<string, unknown>;

  // visibleColumns: keep only known ids, dedup, preserve nothing about order.
  let visible: JobColumnId[];
  if (Array.isArray(obj.visibleColumns)) {
    const seen = new Set<string>();
    visible = obj.visibleColumns.filter(
      (v): v is JobColumnId => typeof v === 'string' && VALID_IDS.has(v) && !seen.has(v) && (seen.add(v), true)
    );
  } else {
    // No (valid) visibleColumns key at all -> treat as a fresh default. This
    // covers an empty {} row written by some earlier flow.
    visible = defaultJobListSettings().visibleColumns;
  }

  const showCompleted = typeof obj.showCompleted === 'boolean' ? obj.showCompleted : true;

  return { visibleColumns: visible, showCompleted };
}

/**
 * Given the merged settings, return the visible column ids IN REGISTRY ORDER.
 * The Jobs page uses this to filter + order its rendered columns so the on/off
 * choice never changes column order unexpectedly.
 */
export function orderedVisibleColumnIds(settings: JobListSettings): JobColumnId[] {
  const want = new Set(settings.visibleColumns);
  return JOB_COLUMN_REGISTRY.filter((c) => want.has(c.id)).map((c) => c.id);
}

/**
 * The shared columns (acceptance criterion #5) keyed by the column id used on
 * the FIELD-APPLICATION INVOICE list. Only the shared subset the invoice list
 * actually has is mapped here (Customers / Applicators / Total Acres) — the
 * other shared toggles (Locations / Crops / Chemical Appl.) have no column on
 * the per-invoice summary list, so there is nothing to hide there.
 */
export const SHARED_INVOICE_COLUMN_IDS: Record<string, JobColumnId> = {
  customer_name: 'customer_name',
  applicator_name: 'applicator_name',
  total_acres: 'total_acres',
};

/**
 * Given the user's (merged) job-list settings, decide whether a SHARED column
 * on the invoice list should be visible. A column not in the shared map is
 * always visible (it isn't governed by the shared toggles). A shared column is
 * visible iff the user has it on in their job-list settings — so toggling e.g.
 * "Applicators" off on the job list also hides it on the field-invoice list.
 */
export function isInvoiceColumnVisible(settings: JobListSettings, invoiceColumnKey: string): boolean {
  const sharedId = SHARED_INVOICE_COLUMN_IDS[invoiceColumnKey];
  if (!sharedId) return true; // not a shared column -> always shown
  return settings.visibleColumns.includes(sharedId);
}

/** Toggle a single column id on/off, returning a NEW settings object. */
export function toggleColumn(settings: JobListSettings, id: JobColumnId): JobListSettings {
  const has = settings.visibleColumns.includes(id);
  const visibleColumns = has
    ? settings.visibleColumns.filter((c) => c !== id)
    : [...settings.visibleColumns, id];
  return { ...settings, visibleColumns };
}
