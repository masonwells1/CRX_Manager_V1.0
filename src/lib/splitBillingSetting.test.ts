import { describe, it, expect } from 'vitest';
import {
  SPLIT_BILLING_SETTING_KEY,
  DEFAULT_SPLIT_BILLING_ENABLED,
  parseSplitBillingEnabled,
  serializeSplitBillingEnabled,
} from './splitBillingSetting';

/**
 * Mirrors autoDraftSetting.test.ts, because splitBillingSetting.ts deliberately
 * mirrors autoDraftSetting.ts. This flag gates the whole per-line split-billing
 * surface, so "anything that isn't exactly 'true' is OFF" is the safety property
 * that matters: the UI and a server-side `setting_value = 'true'` comparison must
 * never disagree about whether the feature is on.
 */
describe('splitBillingSetting', () => {
  it('defaults to OFF (the shipped, safe default)', () => {
    expect(DEFAULT_SPLIT_BILLING_ENABLED).toBe(false);
  });

  it('uses the canonical setting key the DB reads', () => {
    expect(SPLIT_BILLING_SETTING_KEY).toBe('per_line_split_billing_enabled');
  });

  it('ONLY the exact string "true" parses as ON', () => {
    expect(parseSplitBillingEnabled('true')).toBe(true);
  });

  it.each([
    ['false', false],
    ['', false],
    ['TRUE', false], // case-sensitive — mirrors the DB read `setting_value = 'true'`
    ['True', false],
    ['1', false],
    ['yes', false],
    ['on', false],
    [' true ', false], // whitespace is not trimmed away into ON
    ['{"enabled":true}', false], // malformed JSON is not ON
  ])('treats %j as OFF', (raw, expected) => {
    expect(parseSplitBillingEnabled(raw as string)).toBe(expected);
  });

  it('null / undefined parse as OFF', () => {
    expect(parseSplitBillingEnabled(null)).toBe(false);
    expect(parseSplitBillingEnabled(undefined)).toBe(false);
  });

  it('serializes to the literal strings the DB compares against', () => {
    expect(serializeSplitBillingEnabled(true)).toBe('true');
    expect(serializeSplitBillingEnabled(false)).toBe('false');
  });

  it('round-trips ON and OFF', () => {
    expect(parseSplitBillingEnabled(serializeSplitBillingEnabled(true))).toBe(true);
    expect(parseSplitBillingEnabled(serializeSplitBillingEnabled(false))).toBe(false);
  });
});
