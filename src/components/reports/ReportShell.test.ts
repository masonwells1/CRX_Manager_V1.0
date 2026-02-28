/**
 * ReportShell.test.ts — Unit tests for getPresetDates() date range logic
 *
 * Tests the crop-season boundaries (October 1 → September 30) and all 5 presets.
 */
import { describe, it, expect } from 'vitest';
import { computeSeason, seasonStartDate, seasonEndDate } from '../../utils/season';

// getPresetDates is not exported from ReportShell, so we mirror its logic here
// using the centralized season utility (same imports as ReportShell.tsx).
function getPresetDates(preset: string, now: Date = new Date()): { start: string; end: string } {
  switch (preset) {
    case 'this_season': {
      const s = computeSeason(now);
      return { start: seasonStartDate(s), end: seasonEndDate(s) };
    }
    case 'last_season': {
      const s = computeSeason(now) - 1;
      return { start: seasonStartDate(s), end: seasonEndDate(s) };
    }
    case 'ytd': {
      const s = computeSeason(now);
      return { start: seasonStartDate(s), end: now.toISOString().split('T')[0] };
    }
    case 'last30': {
      const d = new Date(now.getTime() - 30 * 86400000);
      return { start: d.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    }
    case 'last90': {
      const d = new Date(now.getTime() - 90 * 86400000);
      return { start: d.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    }
    default:
      return { start: '', end: '' };
  }
}

describe('getPresetDates', () => {
  describe('this_season', () => {
    it('returns current crop year when date is in October (month >= 9)', () => {
      // October 15, 2025 — Oct-Dec → season 2026 starts Oct 2025
      const now = new Date(2025, 9, 15); // October (month 9)
      const result = getPresetDates('this_season', now);
      expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
    });

    it('returns current crop year when date is in January (month < 9)', () => {
      // February 24, 2026 — Jan-Sep → season 2026 started Oct 2025
      const now = new Date(2026, 1, 24); // February (month 1)
      const result = getPresetDates('this_season', now);
      expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
    });

    it('returns current crop year when date is exactly October 1', () => {
      const now = new Date(2025, 9, 1); // October 1 (month 9)
      const result = getPresetDates('this_season', now);
      expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
    });

    it('returns current crop year when date is September 30 (last day of season)', () => {
      const now = new Date(2026, 8, 30); // September 30 (month 8)
      const result = getPresetDates('this_season', now);
      expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
    });
  });

  describe('last_season', () => {
    it('returns prior crop year when date is in Oct-Dec', () => {
      const now = new Date(2025, 9, 1); // October 2025 → current season 2026
      const result = getPresetDates('last_season', now);
      expect(result).toEqual({ start: '2024-10-01', end: '2025-09-30' });
    });

    it('returns prior crop year when date is in Jan-Sep', () => {
      const now = new Date(2026, 2, 15); // March 2026 → current season 2026
      const result = getPresetDates('last_season', now);
      expect(result).toEqual({ start: '2024-10-01', end: '2025-09-30' });
    });
  });

  describe('ytd', () => {
    it('returns season start (Oct 1) to today for date in Jan-Sep', () => {
      const now = new Date(2026, 1, 24); // Feb 24, 2026 → season 2026
      const result = getPresetDates('ytd', now);
      expect(result.start).toBe('2025-10-01');
      expect(result.end).toBe('2026-02-24');
    });

    it('returns season start to today for date in Oct-Dec', () => {
      const now = new Date(2025, 10, 15); // Nov 15, 2025 → season 2026
      const result = getPresetDates('ytd', now);
      expect(result.start).toBe('2025-10-01');
      expect(result.end).toBe('2025-11-15');
    });

    it('handles October 1 (start === seasonStart)', () => {
      const now = new Date(2025, 9, 1); // Oct 1, 2025
      const result = getPresetDates('ytd', now);
      expect(result.start).toBe('2025-10-01');
      expect(result.end).toBe('2025-10-01');
    });
  });

  describe('last30', () => {
    it('returns 30-day window ending today', () => {
      const now = new Date(2026, 1, 24); // Feb 24, 2026
      const result = getPresetDates('last30', now);
      expect(result.end).toBe('2026-02-24');
      // 30 days before Feb 24 = Jan 25
      expect(result.start).toBe('2026-01-25');
    });
  });

  describe('last90', () => {
    it('returns 90-day window ending today', () => {
      const now = new Date(2026, 1, 24); // Feb 24, 2026
      const result = getPresetDates('last90', now);
      expect(result.end).toBe('2026-02-24');
      // 90 days before Feb 24 = Nov 26
      expect(result.start).toBe('2025-11-26');
    });
  });

  describe('unknown preset', () => {
    it('returns empty strings for unknown preset', () => {
      const result = getPresetDates('foobar', new Date());
      expect(result).toEqual({ start: '', end: '' });
    });

    it('returns empty strings for empty string', () => {
      const result = getPresetDates('', new Date());
      expect(result).toEqual({ start: '', end: '' });
    });
  });

  describe('edge cases', () => {
    it('handles December 31 correctly (month >= 9)', () => {
      const now = new Date(2025, 11, 31); // Dec 31, 2025
      const thisSeason = getPresetDates('this_season', now);
      expect(thisSeason).toEqual({ start: '2025-10-01', end: '2026-09-30' });

      const lastSeason = getPresetDates('last_season', now);
      expect(lastSeason).toEqual({ start: '2024-10-01', end: '2025-09-30' });
    });

    it('handles leap year date in last30/last90', () => {
      // March 1 in a leap year, 30 days back should be Jan 31
      const now = new Date(2024, 2, 1); // March 1, 2024 (leap year)
      const result = getPresetDates('last30', now);
      expect(result.end).toBe('2024-03-01');
      expect(result.start).toBe('2024-01-31');
    });
  });
});
