/**
 * Season calendar utilities.
 * Season runs October 1 to September 30, named by end-year.
 * Season 2026 = Oct 1, 2025 – Sep 30, 2026.
 *
 * To change the season boundary in the future, update SEASON_START_MONTH
 * here and the matching compute_season() SQL function.
 */

/** October (0-indexed) — first month of a new season */
const SEASON_START_MONTH = 9;

/** Compute the season number for a given date (defaults to now). */
export function computeSeason(date: Date = new Date()): number {
  return date.getMonth() >= SEASON_START_MONTH
    ? date.getFullYear() + 1
    : date.getFullYear();
}

/** First day of a season: Oct 1 of (season - 1). */
export function seasonStartDate(season: number): string {
  return `${season - 1}-10-01`;
}

/** Last day of a season: Sep 30 of season year. */
export function seasonEndDate(season: number): string {
  return `${season}-09-30`;
}

/** Get the start and end dates for the season containing the given date. */
export function getSeasonDates(date: Date = new Date()): { start: string; end: string } {
  const season = computeSeason(date);
  return { start: seasonStartDate(season), end: seasonEndDate(season) };
}
