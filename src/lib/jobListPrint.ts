// Field-app parity #15: Print the job list.
//
// Pure logic that turns the CURRENTLY-DISPLAYED job rows + the user's VISIBLE
// List-Settings columns (in registry order) into the columns / rows / totals
// row a print-ready PDF needs. Keeping it React-free makes the screen→paper
// mapping (which column shows what text, what the acre totals sum to) trivially
// unit-testable, and guarantees the printout matches the on-screen list:
//   - the SAME columns the page shows (orderedVisibleColumnIds), in that order,
//   - with the SAME header labels the screen uses,
//   - the SAME formatted cell value the screen renders (as plain text), and
//   - a footer TOTALS row whose acres equal the on-screen bottom totals.
//
// The page passes its filtered `visibleJobs` here (NOT the checkbox selection),
// so a list PRINT works with zero rows selected.

import type { ReportPdfColumn } from './reportPdf';
import { JOB_COLUMN_REGISTRY, type JobColumnId } from '../components/jobs/jobListColumns';
import { parseLocalDate } from './dateUtils';

/**
 * The minimal shape of a job row the printer reads. The Jobs page's richer
 * `JobRow` structurally satisfies this, so it can be passed straight in without
 * a cast. Every field the visible columns can reference is listed here.
 */
export interface JobListPrintRow {
  status: string;
  job_number: string;
  job_date: string | null;
  call_date: string | null;
  total_acres: number | null;
  remaining_acres: number | null;
  total_price_cents: number | null;
  customer_phone: string | null;
  printed_at: string | null;
  // Resolved display strings the page already computed.
  customer_name: string;
  applicator_name: string;
  vehicle_name: string;
  created_by_name: string;
  updated_by_name: string;
  last_printed_by_name: string;
  batch_name: string | null;
  locations: string[];
  crops: string[];
  chemicals: Array<{ product_name: string; rate_per_acre: number | null; rate_unit: string | null }>;
  customers: Array<{ customer_name: string; account_number: string | null }>;
  jobTags: Array<{ name: string }>;
}

/**
 * The ON-SCREEN header label for each toggleable column, matching exactly what
 * the DataTable shows (these are the page's `dataColumns` headers, which are
 * intentionally terser than the List-Settings toggle labels, e.g. "Tot. ac"
 * vs. "Total Acres"). The print must read like the screen, so the paper uses
 * these — the same text the user sees in the table head.
 */
const PRINT_HEADERS: Record<JobColumnId, string> = {
  jobTags: 'Tags',
  batch_name: 'Batch',
  job_number: 'Job #',
  customer_name: 'Customers',
  customer_phone: 'Customer Phone',
  locations: 'Locations',
  applicator_name: 'Applicators',
  crops: 'Crops',
  chemicals: 'Chemicals',
  wind_direction: 'Wind Dir.',
  total_acres: 'Tot. ac',
  remaining_acres: 'Rem. ac',
  call_date: 'Call Date',
  job_date: 'Scheduled',
  status: 'Status',
  vehicle_name: 'Vehicle',
  total_price_cents: 'Price',
  created_by_name: 'Created By',
  updated_by_name: 'Updated By',
  printed_at: 'Last Printed By',
};

/** Columns whose values are numeric/acreage/price — right-aligned on paper. */
const RIGHT_ALIGNED: ReadonlySet<JobColumnId> = new Set<JobColumnId>([
  'total_acres',
  'remaining_acres',
  'total_price_cents',
]);

/** The PLACEHOLDER the screen renders for an empty cell ("-"). */
const DASH = '-';

function fmtAcres(n: number | null | undefined): string {
  if (n == null) return DASH;
  return n.toLocaleString();
}

function fmtPriceCents(cents: number | null | undefined): string {
  if (!cents) return DASH;
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
}

function fmtLocalDateCell(dateStr: string | null | undefined): string {
  if (!dateStr) return DASH;
  return parseLocalDate(dateStr).toLocaleDateString();
}

function joinOrDash(items: string[]): string {
  return items.length > 0 ? items.join(', ') : DASH;
}

/**
 * Map a single visible column id to the PLAIN-TEXT value for one job row,
 * mirroring what the on-screen cell renders. A column with no print-able source
 * (wind_direction, until the as-applied weather lands) renders the same "-" the
 * screen shows — never a crash.
 */
export function jobPrintCellValue(id: JobColumnId, row: JobListPrintRow): string {
  switch (id) {
    case 'jobTags':
      return joinOrDash(row.jobTags.map((t) => t.name));
    case 'batch_name':
      return row.batch_name || DASH;
    case 'job_number':
      return row.job_number || DASH;
    case 'customer_name':
      return joinOrDash(
        row.customers.map((c) =>
          c.account_number ? `${c.customer_name} (${c.account_number})` : c.customer_name
        )
      );
    case 'customer_phone':
      return row.customer_phone || DASH;
    case 'locations':
      return joinOrDash(row.locations);
    case 'applicator_name':
      return row.applicator_name || DASH;
    case 'crops':
      return joinOrDash(row.crops);
    case 'chemicals':
      return row.chemicals.length === 0
        ? DASH
        : row.chemicals
            .map((c) => {
              const rate =
                c.rate_per_acre != null
                  ? ` — ${c.rate_per_acre}${c.rate_unit ? ` ${c.rate_unit}` : ''}`
                  : '';
              return `${c.product_name}${rate}`;
            })
            .join('; ');
    case 'wind_direction':
      // No wind source on the job list yet (rides the as-applied weather, #19).
      return DASH;
    case 'total_acres':
      return fmtAcres(row.total_acres);
    case 'remaining_acres':
      return fmtAcres(row.remaining_acres ?? row.total_acres);
    case 'call_date':
      return fmtLocalDateCell(row.call_date);
    case 'job_date':
      return fmtLocalDateCell(row.job_date);
    case 'status':
      return row.status.replace('_', ' ');
    case 'vehicle_name':
      return row.vehicle_name && row.vehicle_name !== DASH ? row.vehicle_name : DASH;
    case 'total_price_cents':
      return fmtPriceCents(row.total_price_cents);
    case 'created_by_name':
      return row.created_by_name || DASH;
    case 'updated_by_name':
      return row.updated_by_name || DASH;
    case 'printed_at':
      return row.printed_at
        ? `Printed · ${row.last_printed_by_name && row.last_printed_by_name !== DASH ? row.last_printed_by_name : 'Unknown'} · ${new Date(row.printed_at).toLocaleDateString()}`
        : 'Not printed';
    default:
      return DASH;
  }
}

/**
 * Sum the on-screen bottom totals over the CURRENTLY-LISTED jobs. This is the
 * single source of truth for both the page's bottom totals row and the print
 * footer totals row, so paper == screen by construction (criterion #3). Mirrors
 * the page's `totals` memo: remaining falls back to total_acres when null.
 */
export function computeJobListTotals(rows: JobListPrintRow[]): {
  totalAcres: number;
  remainingAcres: number;
} {
  return rows.reduce(
    (acc, j) => {
      acc.totalAcres += j.total_acres || 0;
      acc.remainingAcres += j.remaining_acres ?? (j.total_acres || 0);
      return acc;
    },
    { totalAcres: 0, remainingAcres: 0 }
  );
}

export interface JobListPrintData {
  columns: ReportPdfColumn[];
  rows: Record<string, string>[];
  /** One cell per visible column; the totals land under their own columns. */
  totalsRow: string[];
}

/**
 * Build the print columns + rows + footer totals row from the displayed jobs and
 * the visible column ids (already in registry order). The columns and per-row
 * values mirror the screen exactly; the totals row puts the acre totals under the
 * Tot. ac / Rem. ac columns (and a "TOTALS" label under the first column).
 */
export function buildJobListPrintData(
  rows: JobListPrintRow[],
  visibleColumnIds: JobColumnId[]
): JobListPrintData {
  // Guard against an unknown id slipping in: keep only real registry ids, so a
  // bad saved setting can never crash the print (it just omits that column).
  const validIds = new Set<JobColumnId>(JOB_COLUMN_REGISTRY.map((c) => c.id));
  const ids = visibleColumnIds.filter((id) => validIds.has(id));

  const columns: ReportPdfColumn[] = ids.map((id) => ({
    header: PRINT_HEADERS[id],
    key: id,
    align: RIGHT_ALIGNED.has(id) ? 'right' : 'left',
  }));

  const printRows: Record<string, string>[] = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const id of ids) out[id] = jobPrintCellValue(id, r);
    return out;
  });

  const totals = computeJobListTotals(rows);
  const totalsRow = ids.map((id, i) => {
    if (id === 'total_acres') {
      return totals.totalAcres.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    if (id === 'remaining_acres') {
      return totals.remainingAcres.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    // Anchor the label to the first column; a "Job count" hint helps when the
    // first column isn't an acre column.
    if (i === 0) return `TOTALS (${rows.length} job${rows.length === 1 ? '' : 's'})`;
    return '';
  });

  return { columns, rows: printRows, totalsRow };
}
