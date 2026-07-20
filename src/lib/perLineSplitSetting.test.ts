import { describe, expect, it } from 'vitest';
import { parsePercentToMicro, parsePerLineSplitEnabled, perLineBillingModeBlocker } from './perLineSplitSetting';

describe('parsePerLineSplitEnabled', () => {
  it('enables only the exact true literal', () => {
    expect(parsePerLineSplitEnabled('true')).toBe(true);
    for (const value of ['TRUE', '1', 'false', '', null, undefined]) {
      expect(parsePerLineSplitEnabled(value)).toBe(false);
    }
  });

  it('parses percentages to exact integer micro-percent without float rounding', () => {
    expect(parsePercentToMicro('33.333333')).toBe(33333333);
    expect(parsePercentToMicro('0.000001')).toBe(1);
    expect(parsePercentToMicro('100')).toBe(100000000);
    expect(parsePercentToMicro('100.000001')).toBeNull();
    expect(parsePercentToMicro('1e2')).toBeNull();
  });

  it('rejects Mode A before preview/save when the feature is enabled', () => {
    expect(perLineBillingModeBlocker(true, ['North 40'], 'job-1')).toMatch(/Mode A.*North 40/);
    expect(perLineBillingModeBlocker(false, ['North 40'], null)).toBeNull();
  });

  it('fails closed while the setting is unknown and requires a source job when enabled', () => {
    expect(perLineBillingModeBlocker(null, [], 'job-1')).toMatch(/could not be verified/);
    expect(perLineBillingModeBlocker(true, [], null)).toMatch(/requires a source job/);
    expect(perLineBillingModeBlocker(true, [], 'job-1', false)).toMatch(/Mode A status could not be verified/);
  });
});
