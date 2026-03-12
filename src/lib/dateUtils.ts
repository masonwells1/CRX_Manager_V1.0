/**
 * Date utility functions that avoid UTC timezone bugs.
 *
 * Problem: `new Date().toISOString().split('T')[0]` returns tomorrow's date
 * for US users after ~5pm local time (because toISOString() converts to UTC).
 * Similarly, `new Date('2026-03-11')` parses as UTC midnight, which displays
 * as March 10 in US timezones.
 *
 * Solution: Always use local timezone for date-only operations.
 */

/**
 * Returns today's date as YYYY-MM-DD in the user's local timezone.
 * Use this instead of `new Date().toISOString().split('T')[0]`.
 */
export function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parses a YYYY-MM-DD string as a local-timezone Date (midnight local).
 * Use this instead of `new Date(dateString)` for date-only strings.
 *
 * `new Date('2026-03-11')` → UTC midnight → shows as March 10 in US timezones.
 * `parseLocalDate('2026-03-11')` → local midnight → always shows March 11.
 */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Formats a Date object as YYYY-MM-DD in the user's local timezone.
 * Use this instead of `date.toISOString().split('T')[0]`.
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns a date N days from today as YYYY-MM-DD in local timezone.
 * Useful for default due dates (e.g., 30 days from now).
 */
export function localDatePlusDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatLocalDate(date);
}
