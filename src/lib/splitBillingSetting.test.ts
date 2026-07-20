import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT_BILLING_ENABLED,
  SPLIT_BILLING_SETTING_KEY,
  parseSplitBillingEnabled,
  serializeSplitBillingEnabled,
} from './splitBillingSetting';

describe('split billing feature flag', () => {
  it('uses the authoritative OFF-by-default setting', () => {
    expect(SPLIT_BILLING_SETTING_KEY).toBe('feature_per_line_split_billing');
    expect(DEFAULT_SPLIT_BILLING_ENABLED).toBe(false);
  });

  it.each([null, undefined, '', 'false', 'TRUE', '1', 'yes'])(
    'fails closed for %s',
    (value) => expect(parseSplitBillingEnabled(value)).toBe(false),
  );

  it('accepts only the exact stored true value', () => {
    expect(parseSplitBillingEnabled('true')).toBe(true);
    expect(serializeSplitBillingEnabled(true)).toBe('true');
    expect(serializeSplitBillingEnabled(false)).toBe('false');
  });
});
