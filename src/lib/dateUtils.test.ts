import { describe, expect, it } from 'vitest';
import { todayInBusinessTz } from './dateUtils';

describe('todayInBusinessTz', () => {
  it('keeps the late Central evening on the prior business date', () => {
    expect(todayInBusinessTz(new Date('2026-08-01T02:00:00Z'))).toBe('2026-07-31');
  });

  it('uses the next business date after Central midnight', () => {
    expect(todayInBusinessTz(new Date('2026-08-01T12:00:00Z'))).toBe('2026-08-01');
  });

  it('returns the same date during the Central business day', () => {
    expect(todayInBusinessTz(new Date('2026-07-10T12:00:00Z'))).toBe('2026-07-10');
  });

  it('handles the Central year rollover in standard time', () => {
    expect(todayInBusinessTz(new Date('2026-01-01T05:30:00Z'))).toBe('2025-12-31');
  });

  // The SEASON boundary (2026-09-04). compute_season rolls the crop year at October 1, and every
  // invoice-date default feeds this helper's output into that rollover — it decides which
  // customer_application_rates row a grower is charged and which year-end statement the invoice
  // lands on. Until now the boundary was proven only by ad-hoc runs and a Docker-gated smoke
  // script, neither of which runs in CI, so a regression here would have shipped silently.
  describe('the October 1 season boundary', () => {
    it('is still September 30 at 19:30 Chicago, when UTC has already rolled to October 1', () => {
      // 2026-10-01T00:30:00Z === 19:30 CDT on 2026-09-30. This is the exact window the
      // 20260904160000 / 20260904180000 migrations exist to close.
      expect(todayInBusinessTz(new Date('2026-10-01T00:30:00Z'))).toBe('2026-09-30');
    });

    it('is October 1 at 00:30 Chicago, when browsers west of Central are still on September 30', () => {
      // 2026-10-01T05:30:00Z === 00:30 CDT on 2026-10-01, but 22:30 PDT on 2026-09-30.
      // A browser-local helper returns 2026-09-30 here and files the invoice a season early.
      expect(todayInBusinessTz(new Date('2026-10-01T05:30:00Z'))).toBe('2026-10-01');
    });

    it('rolls exactly at Central midnight, not at any UTC hour', () => {
      // 04:59:59Z is 23:59:59 CDT on 09-30; one second later is 00:00:00 CDT on 10-01.
      expect(todayInBusinessTz(new Date('2026-10-01T04:59:59Z'))).toBe('2026-09-30');
      expect(todayInBusinessTz(new Date('2026-10-01T05:00:00Z'))).toBe('2026-10-01');
    });
  });

  // Chicago changes UTC offset twice a year. The transitions happen at 02:00 local, so the DATE
  // must not move — a helper that hardcoded a fixed -5 or -6 offset instead of a real IANA zone
  // would pass every test above and fail these.
  describe('daylight-saving transitions', () => {
    it('holds the date across the spring-forward transition', () => {
      // 2026-03-08 07:59:59Z = 01:59:59 CST; 08:00:00Z = 03:00:00 CDT. Same calendar day.
      expect(todayInBusinessTz(new Date('2026-03-08T07:59:59Z'))).toBe('2026-03-08');
      expect(todayInBusinessTz(new Date('2026-03-08T08:00:00Z'))).toBe('2026-03-08');
    });

    it('holds the date across the fall-back transition', () => {
      // Chicago falls back at 02:00 CDT on 2026-11-01, which is 07:00:00Z — NOT 06:00Z.
      // 06:59:59Z = 01:59:59 CDT (offset -5); 07:00:00Z = 01:00:00 CST (offset -6), the repeated
      // hour. These two instants straddle the actual transition; an earlier version of this test
      // asserted 05:59:59Z/06:00:00Z, which sit on the same (CDT) side and crossed nothing.
      expect(todayInBusinessTz(new Date('2026-11-01T06:59:59Z'))).toBe('2026-11-01');
      expect(todayInBusinessTz(new Date('2026-11-01T07:00:00Z'))).toBe('2026-11-01');
      // And the date must still roll at Central midnight on the 25-hour day, not 24h after the
      // previous one: 05:00:00Z on 11-01 is 00:00:00 CDT, the first instant of the day.
      expect(todayInBusinessTz(new Date('2026-11-01T04:59:59Z'))).toBe('2026-10-31');
      expect(todayInBusinessTz(new Date('2026-11-01T05:00:00Z'))).toBe('2026-11-01');
    });

    it('uses the summer offset in CDT and the winter offset in CST at the same UTC hour', () => {
      // 05:30Z is the NEXT day in CDT (-5) and the SAME day in CST (-6). One assertion that
      // fails if the zone is ever hardcoded to a single offset.
      expect(todayInBusinessTz(new Date('2026-07-01T05:30:00Z'))).toBe('2026-07-01');
      expect(todayInBusinessTz(new Date('2026-12-01T05:30:00Z'))).toBe('2026-11-30');
    });
  });

  it('always returns a zero-padded YYYY-MM-DD string', () => {
    // The helper builds its result from Intl formatToParts. Reading parts by `type` (not by
    // position) is what makes it immune to locale format order, but the padding still has to hold
    // for single-digit months and days.
    expect(todayInBusinessTz(new Date('2026-01-05T18:00:00Z'))).toBe('2026-01-05');
    expect(todayInBusinessTz(new Date('2026-09-09T18:00:00Z'))).toBe('2026-09-09');
    expect(todayInBusinessTz(new Date('2026-10-01T18:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
