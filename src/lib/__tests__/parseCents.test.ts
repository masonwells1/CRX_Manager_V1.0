import { describe, it, expect } from 'vitest';
import { parseDollarsToCents, parseDollarsToCentsPositive } from '../parseCents';

describe('parseDollarsToCents', () => {
  it('parses whole dollars', () => expect(parseDollarsToCents('25')).toBe(2500));
  it('parses dollars and cents', () => expect(parseDollarsToCents('25.50')).toBe(2550));
  it('strips $ and commas', () => expect(parseDollarsToCents('$1,234.56')).toBe(123456));
  it('returns 0 for empty string', () => expect(parseDollarsToCents('')).toBe(0));
  it('pads single cent digit', () => expect(parseDollarsToCents('1.5')).toBe(150));
  it('avoids float precision issue (1.01)', () => expect(parseDollarsToCents('1.01')).toBe(101));
  it('avoids float precision issue (0.1 + 0.2)', () => expect(parseDollarsToCents('0.30')).toBe(30));
  it('truncates beyond 2 decimals', () => expect(parseDollarsToCents('1.999')).toBe(199));
  it('handles zero', () => expect(parseDollarsToCents('0')).toBe(0));
  it('handles zero cents', () => expect(parseDollarsToCents('100.00')).toBe(10000));

  // Audit #20 (2026-05-11): loose-input edge cases that previously silently
  // parsed wrong values. All three should return 0 (treat as invalid).
  describe('loose-input rejection (audit #20)', () => {
    it('rejects scientific notation "1e5" (was parsing as $15 after e-strip)', () =>
      expect(parseDollarsToCents('1e5')).toBe(0));
    it('rejects scientific notation "1E5"', () =>
      expect(parseDollarsToCents('1E5')).toBe(0));
    it('rejects multi-dot "1.2.3" (was parsing as $1.20)', () =>
      expect(parseDollarsToCents('1.2.3')).toBe(0));
    it('rejects multi-dot "1.2.3.4"', () =>
      expect(parseDollarsToCents('1.2.3.4')).toBe(0));
    it('accepts legitimate decimal with currency formatting', () =>
      expect(parseDollarsToCents('$1,234.56')).toBe(123456));
  });

  // PR-15: negative-sign preservation for discount/credit fields
  describe('negative input (PR-15)', () => {
    it('preserves leading minus on whole dollars', () =>
      expect(parseDollarsToCents('-50')).toBe(-5000));
    it('preserves leading minus on dollars + cents', () =>
      expect(parseDollarsToCents('-5.50')).toBe(-550));
    it('preserves leading minus inside currency formatting ("$-50")', () =>
      expect(parseDollarsToCents('$-50')).toBe(-5000));
    it('preserves leading minus before currency ("-$50")', () =>
      expect(parseDollarsToCents('-$50.00')).toBe(-5000));
    it('treats lone "-" as zero (no digits)', () =>
      expect(parseDollarsToCents('-')).toBe(0));
    it('treats lone "-." as zero', () =>
      expect(parseDollarsToCents('-.')).toBe(0));
  });
});

describe('parseDollarsToCentsPositive', () => {
  it('returns positive for positive input', () =>
    expect(parseDollarsToCentsPositive('25')).toBe(2500));
  it('returns positive for negative input (absolute value)', () =>
    expect(parseDollarsToCentsPositive('-25')).toBe(2500));
  it('returns 0 for empty', () =>
    expect(parseDollarsToCentsPositive('')).toBe(0));
  it('returns 0 for lone minus', () =>
    expect(parseDollarsToCentsPositive('-')).toBe(0));
});
