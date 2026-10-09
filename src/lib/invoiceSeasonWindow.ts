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
 * season. This is a display filter only; posting and editing still go through the
 * server RPCs and their season guards.
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
 * Label for an invoice whose filed season is not the current one (e.g. "Season 2026"),
 * so a prior-season open invoice is recognisable on a "this season" list. Null when the
 * invoice is in the current season or has no season.
 */
export function otherSeasonLabel(
  season: number | null | undefined,
  currentSeason: number = computeSeason(),
): string | null {
  if (season === null || season === undefined || season === currentSeason) return null;
  return `Season ${season}`;
}
