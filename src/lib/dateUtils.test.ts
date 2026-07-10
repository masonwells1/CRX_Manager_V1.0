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
});
