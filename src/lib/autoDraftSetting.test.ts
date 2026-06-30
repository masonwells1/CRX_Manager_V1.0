import { describe, it, expect } from 'vitest';
import {
  AUTO_DRAFT_SETTING_KEY,
  DEFAULT_AUTO_DRAFT_ENABLED,
  parseAutoDraftEnabled,
  serializeAutoDraftEnabled,
} from './autoDraftSetting';

describe('autoDraftSetting', () => {
  it('defaults to OFF (the safe default)', () => {
    expect(DEFAULT_AUTO_DRAFT_ENABLED).toBe(false);
  });

  it('uses the canonical setting key the DB reads', () => {
    expect(AUTO_DRAFT_SETTING_KEY).toBe('auto_draft_invoice_on_job_completion');
  });

  it('ONLY the exact string "true" parses as ON', () => {
    expect(parseAutoDraftEnabled('true')).toBe(true);
  });

  it.each([
    ['false', false],
    ['', false],
    ['TRUE', false], // case-sensitive — mirrors the DB read `setting_value = ''true''`
    ['1', false],
    ['yes', false],
    ['on', false],
    [' true ', false], // whitespace is not trimmed away into ON
    ['{"enabled":true}', false], // malformed JSON is not ON
  ])('treats %j as OFF', (raw, expected) => {
    expect(parseAutoDraftEnabled(raw as string)).toBe(expected);
  });

  it('null / undefined parse as OFF', () => {
    expect(parseAutoDraftEnabled(null)).toBe(false);
    expect(parseAutoDraftEnabled(undefined)).toBe(false);
  });

  it('serializes to the literal strings the DB compares against', () => {
    expect(serializeAutoDraftEnabled(true)).toBe('true');
    expect(serializeAutoDraftEnabled(false)).toBe('false');
  });

  it('round-trips ON and OFF', () => {
    expect(parseAutoDraftEnabled(serializeAutoDraftEnabled(true))).toBe(true);
    expect(parseAutoDraftEnabled(serializeAutoDraftEnabled(false))).toBe(false);
  });
});
