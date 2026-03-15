/**
 * dateUtils.test.ts
 * Unit tests for date utility functions that avoid UTC timezone bugs.
 *
 * Tests:
 * - localToday() returns YYYY-MM-DD in local timezone
 * - parseLocalDate() parses date strings as local midnight
 * - formatLocalDate() formats Date objects as YYYY-MM-DD
 * - localDatePlusDays() adds/subtracts days correctly
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { localToday, parseLocalDate, formatLocalDate, localDatePlusDays } from '../dateUtils';

// ---------------------------------------------------------------------------
// localToday
// ---------------------------------------------------------------------------
describe('localToday', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns YYYY-MM-DD format', () => {
    const result = localToday();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns correct date for a known timestamp', () => {
    // 2026-03-15 10:30:00 local time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 30, 0));
    expect(localToday()).toBe('2026-03-15');
  });

  it('zero-pads single-digit month and day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0)); // Jan 5
    expect(localToday()).toBe('2026-01-05');
  });

  it('handles December 31 correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    expect(localToday()).toBe('2026-12-31');
  });

  it('handles January 1 correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 0));
    expect(localToday()).toBe('2027-01-01');
  });

  it('handles leap day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2028, 1, 29, 12, 0, 0)); // Feb 29, 2028
    expect(localToday()).toBe('2028-02-29');
  });
});

// ---------------------------------------------------------------------------
// parseLocalDate
// ---------------------------------------------------------------------------
describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD as local midnight', () => {
    const date = parseLocalDate('2026-03-11');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2); // March = 2
    expect(date.getDate()).toBe(11);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
    expect(date.getSeconds()).toBe(0);
  });

  it('handles January dates correctly', () => {
    const date = parseLocalDate('2026-01-01');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(1);
  });

  it('handles December dates correctly', () => {
    const date = parseLocalDate('2026-12-31');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(11);
    expect(date.getDate()).toBe(31);
  });

  it('handles leap day', () => {
    const date = parseLocalDate('2028-02-29');
    expect(date.getFullYear()).toBe(2028);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(29);
  });

  it('roundtrips with formatLocalDate', () => {
    const original = '2026-07-04';
    const date = parseLocalDate(original);
    expect(formatLocalDate(date)).toBe(original);
  });

  it('returns a Date object', () => {
    const date = parseLocalDate('2026-06-15');
    expect(date).toBeInstanceOf(Date);
  });

  it('does not produce NaN for valid date strings', () => {
    const date = parseLocalDate('2026-10-01');
    expect(date.getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// formatLocalDate
// ---------------------------------------------------------------------------
describe('formatLocalDate', () => {
  it('formats a date as YYYY-MM-DD', () => {
    const date = new Date(2026, 2, 15); // March 15, 2026
    expect(formatLocalDate(date)).toBe('2026-03-15');
  });

  it('zero-pads single-digit months', () => {
    const date = new Date(2026, 0, 15); // January
    expect(formatLocalDate(date)).toBe('2026-01-15');
  });

  it('zero-pads single-digit days', () => {
    const date = new Date(2026, 2, 5);
    expect(formatLocalDate(date)).toBe('2026-03-05');
  });

  it('handles month 10 (November) without extra padding', () => {
    const date = new Date(2026, 10, 20); // November
    expect(formatLocalDate(date)).toBe('2026-11-20');
  });

  it('handles month 11 (December) correctly', () => {
    const date = new Date(2026, 11, 25);
    expect(formatLocalDate(date)).toBe('2026-12-25');
  });

  it('handles last day of year', () => {
    const date = new Date(2026, 11, 31);
    expect(formatLocalDate(date)).toBe('2026-12-31');
  });

  it('handles first day of year', () => {
    const date = new Date(2026, 0, 1);
    expect(formatLocalDate(date)).toBe('2026-01-01');
  });

  it('handles leap day', () => {
    const date = new Date(2028, 1, 29);
    expect(formatLocalDate(date)).toBe('2028-02-29');
  });

  it('matches YYYY-MM-DD regex pattern', () => {
    const date = new Date(2026, 5, 15);
    expect(formatLocalDate(date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// localDatePlusDays
// ---------------------------------------------------------------------------
describe('localDatePlusDays', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns today when days is 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    expect(localDatePlusDays(0)).toBe('2026-03-15');
  });

  it('adds positive days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    expect(localDatePlusDays(30)).toBe('2026-04-14');
  });

  it('subtracts negative days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    expect(localDatePlusDays(-10)).toBe('2026-03-05');
  });

  it('crosses month boundary forward', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 28, 12, 0, 0)); // Jan 28
    expect(localDatePlusDays(5)).toBe('2026-02-02');
  });

  it('crosses month boundary backward', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 3, 12, 0, 0)); // March 3
    expect(localDatePlusDays(-5)).toBe('2026-02-26');
  });

  it('crosses year boundary forward', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 30, 12, 0, 0)); // Dec 30
    expect(localDatePlusDays(3)).toBe('2027-01-02');
  });

  it('crosses year boundary backward', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 2, 12, 0, 0)); // Jan 2, 2027
    expect(localDatePlusDays(-5)).toBe('2026-12-28');
  });

  it('handles leap year crossing (Feb 28 + 1 in leap year)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2028, 1, 28, 12, 0, 0)); // Feb 28, 2028 (leap)
    expect(localDatePlusDays(1)).toBe('2028-02-29');
  });

  it('handles leap year crossing (Feb 28 + 1 in non-leap year)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 28, 12, 0, 0)); // Feb 28, 2026
    expect(localDatePlusDays(1)).toBe('2026-03-01');
  });

  it('adds 1 day correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    expect(localDatePlusDays(1)).toBe('2026-03-16');
  });

  it('returns YYYY-MM-DD format', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    expect(localDatePlusDays(7)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('handles large positive offset (365 days)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    expect(localDatePlusDays(365)).toBe('2027-03-15');
  });
});
