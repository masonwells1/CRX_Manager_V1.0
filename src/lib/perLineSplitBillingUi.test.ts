import { describe, expect, it } from 'vitest';
import { percentStringsToMicro } from './perLineSplitBillingUi';

describe('percentStringsToMicro', () => {
  it('preserves an exact repeating three-way vector', () => {
    expect(percentStringsToMicro(['33.333334', '33.333333', '33.333333'])).toEqual([
      33_333_334, 33_333_333, 33_333_333,
    ]);
  });

  it('rejects a near-100 vector instead of using a tolerance', () => {
    expect(() => percentStringsToMicro(['50.005', '50.004'])).toThrow('exactly 100%');
  });

  it('rejects precision that cannot be represented as micro-percent', () => {
    expect(() => percentStringsToMicro(['50.0000001', '49.9999999'])).toThrow('up to 6 decimal places');
  });
});
