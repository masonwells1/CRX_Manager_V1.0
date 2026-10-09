/**
 * Season windowing for the invoice LIST pages (Chemical Sales, Field Invoices tabs).
 *
 * The lists show "this season" so they stay short, but open work must never fall off
 * a list just because October 1 passed. Before 2026-10-09 every list filtered the
 * whole query to the current season, so on the Oct 1 rollover every prior-season
 * draft, unposted, posted-but-unpaid and overdue invoice vanished — including from
 * the field Drafts tab's Post All.
 *
 * Rule: an OPEN invoice (still to post or still to collect) shows whatever season it
 * is in; only a CLOSED invoice (paid, voided, cancelled) is limited to the current
 * season. This is a display filter only.
 *
 * Caution: post_invoice / post_invoice_group do NOT check the invoice's SEASON. They
 * DO refuse an invoice dated in a closed accounting period (check_period_open, in
 * _post_invoice_impl_20260714 and _post_invoice_group_customer_scope_impl; live
 * pg_proc read, 2026-10-09). Listing an older open invoice would make it reachable by
 * bulk actions, so the bulk actions leave other-season invoices out by default: the
 * field Drafts tab's Post All and the Posted tab's Unpost All (default scope) skip
 * them, and the Chemical Sales "Select All" picks only this season's rows. An older
 * invoice is still posted or changed one at a time, as an explicit choice.
 */
import type { InvoiceStatus } from '../types';
import { computeSeason, seasonStartDate } from '../utils/season';

/** Statuses that still need someone to post or collect the invoice. */
export const OPEN_INVOICE_STATUSES: ReadonlyArray<InvoiceStatus> = ['draft', 'unposted', 'posted', 'overdue'];

/**
 * PostgREST `.or()` filter: any open invoice, OR a closed one whose `column` falls in
 * the season (Oct 1 to Sep 30). Pass the column each list already windowed on, so the
 * set of closed invoices a list shows is unchanged.
 */
export function openOrInSeasonFilter(
  column: 'created_at' | 'invoice_date',
  season: number = computeSeason(),
): string {
  const start = seasonStartDate(season);
  // Half-open [Oct 1, next Oct 1): covers the whole of Sep 30 for a timestamp column too.
  const nextStart = seasonStartDate(season + 1);
  return `status.in.(${OPEN_INVOICE_STATUSES.join(',')}),and(${column}.gte.${start},${column}.lt.${nextStart})`;
}

/**
 * True only when the invoice is filed in the current season. A missing season counts
 * as NOT current (unknown), so a bulk action limited to this season leaves it out.
 * The current season comes from the browser clock (computeSeason).
 */
export function isCurrentSeason(
  season: number | null | undefined,
  currentSeason: number = computeSeason(),
): boolean {
  return season === currentSeason;
}

/**
 * Distinct season labels of rows that are NOT in the current season, for confirm text
 * (e.g. "Season 2026, Season 2028, Season unknown").
 */
export function otherSeasonLabels(
  rows: ReadonlyArray<{ season?: number | null }>,
  currentSeason: number = computeSeason(),
): string {
  const labels = rows
    .map((row) => otherSeasonLabel(row.season, currentSeason))
    .filter((label): label is string => label !== null);
  return [...new Set(labels)].join(', ');
}

/** Label shown for an invoice with no season on it. */
export const UNKNOWN_SEASON_LABEL = 'Season unknown';

/**
 * Label for an invoice that is NOT in the current season, so a prior-season open
 * invoice is recognisable on a "this season" list: "Season 2026", or "Season unknown"
 * when the invoice has no season. Null only when it is in the current season. This
 * matches isCurrentSeason: every row that gets a label is one the this-season bulk
 * actions leave out.
 */
export function otherSeasonLabel(
  season: number | null | undefined,
  currentSeason: number = computeSeason(),
): string | null {
  if (isCurrentSeason(season, currentSeason)) return null;
  if (season === null || season === undefined) return UNKNOWN_SEASON_LABEL;
  return `Season ${season}`;
}
