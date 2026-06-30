import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GUARDRAIL_MODE,
  parseGuardrailMode,
  serializeGuardrailMode,
} from './labelGuardrailSetting';

describe('labelGuardrailSetting', () => {
  it('defaults to warn (the safe value that never blocks a save)', () => {
    expect(DEFAULT_GUARDRAIL_MODE).toBe('warn');
  });

  it('parses only the exact string "block" as block; everything else is warn', () => {
    expect(parseGuardrailMode('block')).toBe('block');
    expect(parseGuardrailMode('warn')).toBe('warn');
    // We NEVER invent block from a blank/missing/malformed value.
    expect(parseGuardrailMode('')).toBe('warn');
    expect(parseGuardrailMode(null)).toBe('warn');
    expect(parseGuardrailMode(undefined)).toBe('warn');
    expect(parseGuardrailMode('BLOCK')).toBe('warn'); // case-sensitive on purpose
    expect(parseGuardrailMode('true')).toBe('warn');
    expect(parseGuardrailMode('anything')).toBe('warn');
  });

  it('round-trips through serialize/parse', () => {
    expect(parseGuardrailMode(serializeGuardrailMode('warn'))).toBe('warn');
    expect(parseGuardrailMode(serializeGuardrailMode('block'))).toBe('block');
  });
});
