import { describe, it, expect } from 'vitest';
import {
  parseDiluentRate,
  isValidDiluentRate,
  isDiluentInputValid,
  computeTotalDiluentGallons,
  formatGallons,
} from './fieldAppDiluent';

describe('parseDiluentRate', () => {
  it('returns null for blank / whitespace / null / undefined', () => {
    expect(parseDiluentRate('')).toBeNull();
    expect(parseDiluentRate('   ')).toBeNull();
    expect(parseDiluentRate(null)).toBeNull();
    expect(parseDiluentRate(undefined)).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(parseDiluentRate('abc')).toBeNull();
    expect(parseDiluentRate('12gal')).toBeNull();
  });

  it('parses a valid positive number', () => {
    expect(parseDiluentRate('15')).toBe(15);
    expect(parseDiluentRate('12.5')).toBe(12.5);
    expect(parseDiluentRate('  20  ')).toBe(20);
  });

  it('returns zero for "0" (a legitimately recorded zero)', () => {
    expect(parseDiluentRate('0')).toBe(0);
  });

  it('returns the negative value as-is (UI/RPC decide rejection, not the parser)', () => {
    expect(parseDiluentRate('-5')).toBe(-5);
  });
});

describe('isValidDiluentRate', () => {
  it('accepts null (cleared / not entered)', () => {
    expect(isValidDiluentRate(null)).toBe(true);
    expect(isValidDiluentRate(undefined)).toBe(true);
  });

  it('accepts zero and positive finite numbers', () => {
    expect(isValidDiluentRate(0)).toBe(true);
    expect(isValidDiluentRate(15)).toBe(true);
    expect(isValidDiluentRate(12.5)).toBe(true);
  });

  it('rejects negative numbers', () => {
    expect(isValidDiluentRate(-1)).toBe(false);
    expect(isValidDiluentRate(-0.01)).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    expect(isValidDiluentRate(Number.NaN)).toBe(false);
    expect(isValidDiluentRate(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('isDiluentInputValid (raw-string save gate — Codex P2)', () => {
  it('treats blank / whitespace / null / undefined as VALID (optional field)', () => {
    expect(isDiluentInputValid('')).toBe(true);
    expect(isDiluentInputValid('   ')).toBe(true);
    expect(isDiluentInputValid(null)).toBe(true);
    expect(isDiluentInputValid(undefined)).toBe(true);
  });

  it('accepts a non-empty finite >= 0 value', () => {
    expect(isDiluentInputValid('0')).toBe(true);
    expect(isDiluentInputValid('15')).toBe(true);
    expect(isDiluentInputValid('12.5')).toBe(true);
    expect(isDiluentInputValid('  20 ')).toBe(true);
  });

  it('REJECTS a non-empty unparseable typo (would otherwise clear a saved rate)', () => {
    expect(isDiluentInputValid('-')).toBe(false);
    expect(isDiluentInputValid('e')).toBe(false);
    expect(isDiluentInputValid('1.2.3')).toBe(false);
    expect(isDiluentInputValid('abc')).toBe(false);
    expect(isDiluentInputValid('12gal')).toBe(false);
  });

  it('REJECTS a non-empty negative value', () => {
    expect(isDiluentInputValid('-5')).toBe(false);
    expect(isDiluentInputValid('-0.01')).toBe(false);
  });
});

describe('computeTotalDiluentGallons', () => {
  it('computes rate x acres for valid inputs', () => {
    expect(computeTotalDiluentGallons(15, 100)).toBe(1500);
    expect(computeTotalDiluentGallons(12.5, 80)).toBe(1000);
  });

  it('returns null when the rate is null/undefined (the null-rate case)', () => {
    expect(computeTotalDiluentGallons(null, 100)).toBeNull();
    expect(computeTotalDiluentGallons(undefined, 100)).toBeNull();
  });

  it('returns null when acres is null/undefined (the null-acres case)', () => {
    expect(computeTotalDiluentGallons(15, null)).toBeNull();
    expect(computeTotalDiluentGallons(15, undefined)).toBeNull();
  });

  it('returns null when BOTH rate and acres are null (no spurious 0)', () => {
    expect(computeTotalDiluentGallons(null, null)).toBeNull();
  });

  it('returns null for negative rate or negative acres (never a phantom product)', () => {
    expect(computeTotalDiluentGallons(-5, 100)).toBeNull();
    expect(computeTotalDiluentGallons(15, -100)).toBeNull();
  });

  it('returns null for non-finite inputs', () => {
    expect(computeTotalDiluentGallons(Number.NaN, 100)).toBeNull();
    expect(computeTotalDiluentGallons(15, Number.NaN)).toBeNull();
  });

  it('returns 0 for a recorded zero rate with valid acres (not null)', () => {
    expect(computeTotalDiluentGallons(0, 100)).toBe(0);
  });

  it('returns 0 when acres is 0 (a real field with no applied acres yet)', () => {
    expect(computeTotalDiluentGallons(15, 0)).toBe(0);
  });
});

describe('formatGallons', () => {
  it('returns empty string for null/undefined/non-finite', () => {
    expect(formatGallons(null)).toBe('');
    expect(formatGallons(undefined)).toBe('');
    expect(formatGallons(Number.NaN)).toBe('');
  });

  it('trims trailing zeros', () => {
    expect(formatGallons(75)).toBe('75');
    expect(formatGallons(12.5)).toBe('12.5');
    expect(formatGallons(1500)).toBe('1500');
  });

  it('rounds to the requested decimals', () => {
    expect(formatGallons(12.499, 2)).toBe('12.5');
    expect(formatGallons(12.345, 2)).toBe('12.35');
  });

  it('formats 0 as "0"', () => {
    expect(formatGallons(0)).toBe('0');
  });
});
