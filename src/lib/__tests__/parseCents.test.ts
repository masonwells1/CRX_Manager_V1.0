import { describe, it, expect } from 'vitest';
import {
  isWholeCentDollarInput,
  parseDollarsToCents,
  parseDollarsToCentsSigned,
} from '../parseCents';

describe('isWholeCentDollarInput', () => {
  it.each(['25', '25.5', '25.50', '25.', '.50', '0'])('accepts exact-cent input %s', (value) => {
    expect(isWholeCentDollarInput(value)).toBe(true);
  });

  it.each(['1.999', '1e5', '1.2.3', '$1.00', '', '-1.00'])('rejects unsafe positive input %s', (value) => {
    expect(isWholeCentDollarInput(value)).toBe(false);
  });

  it('accepts a leading minus only when the field allows negative amounts', () => {
    expect(isWholeCentDollarInput('-10.25', { allowNegative: true })).toBe(true);
    expect(isWholeCentDollarInput('10-25', { allowNegative: true })).toBe(false);
  });

  it('rejects an amount whose cents value exceeds exact integer range', () => {
    // The decimal-places pattern alone bounds precision but not magnitude:
    // "90071992547409.93" parses to 9007199254740993 cents, one past
    // Number.MAX_SAFE_INTEGER (9007199254740991), so it cannot be represented
    // exactly and would reach a money RPC silently rounded.
    expect(Number.isSafeInteger(parseDollarsToCentsSigned('90071992547409.93'))).toBe(false);
    expect(isWholeCentDollarInput('90071992547409.93')).toBe(false);
    expect(isWholeCentDollarInput('-90071992547409.93', { allowNegative: true })).toBe(false);
  });

  it('still accepts the largest exactly representable amount', () => {
    // Boundary immediately below the limit must remain usable.
    expect(isWholeCentDollarInput('90071992547409.90')).toBe(true);
  });
});

describe('parseDollarsToCents (positive-only default)', () => {
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

  // Codex P2 fix (PR #59, 2026-05-13): the default helper now strips negative
  // signs so positive-only callsites (credit_limit, write-off, payment amount,
  // etc.) cannot store a negative cents value that would bypass server checks.
  describe('negative-input clamping (codex P2 fix for PR #59)', () => {
    it('strips leading minus on whole dollars', () =>
      expect(parseDollarsToCents('-50')).toBe(5000));
    it('strips leading minus on dollars + cents', () =>
      expect(parseDollarsToCents('-5.50')).toBe(550));
    it('strips minus inside currency formatting ("$-50")', () =>
      expect(parseDollarsToCents('$-50')).toBe(5000));
    it('strips minus before currency ("-$50.00")', () =>
      expect(parseDollarsToCents('-$50.00')).toBe(5000));
    it('treats lone "-" as zero (no digits)', () =>
      expect(parseDollarsToCents('-')).toBe(0));
  });
});

describe('parseDollarsToCentsSigned (negative-capable variant)', () => {
  it('parses positive whole dollars', () =>
    expect(parseDollarsToCentsSigned('25')).toBe(2500));
  it('parses positive dollars and cents', () =>
    expect(parseDollarsToCentsSigned('25.50')).toBe(2550));
  it('preserves leading minus on whole dollars', () =>
    expect(parseDollarsToCentsSigned('-50')).toBe(-5000));
  it('preserves leading minus on dollars + cents', () =>
    expect(parseDollarsToCentsSigned('-5.50')).toBe(-550));
  it('preserves leading minus inside currency formatting ("$-50")', () =>
    expect(parseDollarsToCentsSigned('$-50')).toBe(-5000));
  it('preserves leading minus before currency ("-$50.00")', () =>
    expect(parseDollarsToCentsSigned('-$50.00')).toBe(-5000));
  it('treats lone "-" as zero (no digits)', () =>
    expect(parseDollarsToCentsSigned('-')).toBe(0));
  it('treats lone "-." as zero', () =>
    expect(parseDollarsToCentsSigned('-.')).toBe(0));
  it('rejects scientific notation', () =>
    expect(parseDollarsToCentsSigned('1e5')).toBe(0));
  it('rejects multi-dot input', () =>
    expect(parseDollarsToCentsSigned('1.2.3')).toBe(0));

  // codex-driven hunt cycle 2: a minus is only the LEADING sign. A dash anywhere
  // else is malformed — previously "12-34" stripped the dash and parsed as a
  // large negative (-123400), corrupting signed vendor-bill/discount adjustments.
  describe('rejects non-leading dash (malformed signed input)', () => {
    it('rejects an embedded dash "12-34" (was -123400)', () =>
      expect(parseDollarsToCentsSigned('12-34')).toBe(0));
    it('rejects a trailing dash "50-"', () =>
      expect(parseDollarsToCentsSigned('50-')).toBe(0));
    it('rejects a double leading dash "--50"', () =>
      expect(parseDollarsToCentsSigned('--50')).toBe(0));
    it('rejects an embedded dash with cents "5-0.50"', () =>
      expect(parseDollarsToCentsSigned('5-0.50')).toBe(0));
    it('still accepts a valid leading-minus value "-1234.56"', () =>
      expect(parseDollarsToCentsSigned('-1234.56')).toBe(-123456));
  });
});
