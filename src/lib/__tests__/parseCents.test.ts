import { describe, it, expect } from 'vitest';
import { parseDollarsToCents } from '../parseCents';

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
});
