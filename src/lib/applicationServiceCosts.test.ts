import { describe, expect, it } from 'vitest';
import {
  formatApplicationServiceCostDollars,
  formatApplicationServiceCostPerAcre,
  parseApplicationServiceCostCents,
} from './applicationServiceCosts';

describe('application service exact cents', () => {
  it('preserves cents larger than JavaScript safe integers when the RPC returns text', () => {
    const cents = parseApplicationServiceCostCents('9007199254740993');
    expect(cents).toBe(9007199254740993n);
    expect(formatApplicationServiceCostDollars(cents)).toBe('90071992547409.93');
    expect(formatApplicationServiceCostPerAcre(cents)).toBe('$90071992547409.93/ac');
  });

  it('accepts safe legacy JSON numbers during the deploy transition', () => {
    expect(parseApplicationServiceCostCents(650)).toBe(650n);
  });

  it('accepts the already-normalized bigint used by PDF export rows', () => {
    expect(parseApplicationServiceCostCents(650n)).toBe(650n);
  });

  it('rejects unsafe, negative, fractional, and malformed values', () => {
    expect(() => parseApplicationServiceCostCents(9007199254740992)).toThrow('unsafe cents');
    expect(() => parseApplicationServiceCostCents(-1)).toThrow('unsafe cents');
    expect(() => parseApplicationServiceCostCents(-1n)).toThrow('unsafe cents');
    expect(() => parseApplicationServiceCostCents(1.5)).toThrow('unsafe cents');
    expect(() => parseApplicationServiceCostCents('6.50')).toThrow('unsafe cents');
  });
});
