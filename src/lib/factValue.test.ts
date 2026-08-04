import { describe, it, expect } from 'vitest';
import { factValueToText } from './factValue';

/**
 * factValueToText renders a customer_facts value for a reviewer. The documented
 * requirement is that it "never hides a structured value behind a placeholder" —
 * a reviewer must be able to read the whole value before verifying it. So the
 * nested/structured cases are the point, not decoration.
 */
describe('factValueToText', () => {
  it('prefers rep-typed value_text when present', () => {
    expect(factValueToText('irrigated quarter', { ignored: true })).toBe('irrigated quarter');
  });

  it.each([null, undefined, ''])('falls through to value_json when value_text is %j', (text) => {
    expect(factValueToText(text, 'from json')).toBe('from json');
  });

  it('returns empty string when both sides are absent', () => {
    expect(factValueToText(null, null)).toBe('');
    expect(factValueToText(undefined, undefined)).toBe('');
    expect(factValueToText('', null)).toBe('');
  });

  describe('primitive value_json', () => {
    it.each([
      ['a string', 'hello', 'hello'],
      ['a number', 42, '42'],
      ['zero', 0, '0'],
      ['true', true, 'true'],
      ['false', false, 'false'],
    ])('renders %s', (_label, json, expected) => {
      expect(factValueToText(null, json)).toBe(expected);
    });
  });

  describe('arrays join with ", "', () => {
    it('renders a flat array', () => {
      expect(factValueToText(null, ['corn', 'soybeans'])).toBe('corn, soybeans');
    });

    it('renders an empty array as empty string', () => {
      expect(factValueToText(null, [])).toBe('');
    });

    it('renders mixed primitives', () => {
      expect(factValueToText(null, ['corn', 2026, true])).toBe('corn, 2026, true');
    });
  });

  describe('objects render key: value pairs joined with " · "', () => {
    it('underscores in keys become spaces', () => {
      expect(factValueToText(null, { crop_type: 'corn' })).toBe('crop type: corn');
    });

    it('renders multiple keys', () => {
      expect(factValueToText(null, { crop_type: 'corn', acres: 120 })).toBe(
        'crop type: corn · acres: 120',
      );
    });

    it('renders an empty object as empty string', () => {
      expect(factValueToText(null, {})).toBe('');
    });
  });

  describe('nested structures are fully rendered, never truncated', () => {
    it('renders an array nested inside an object', () => {
      expect(factValueToText(null, { crops: ['corn', 'beans'] })).toBe('crops: corn, beans');
    });

    it('renders an object nested inside an object', () => {
      expect(factValueToText(null, { field: { name: 'north 40', acres: 40 } })).toBe(
        'field: name: north 40 · acres: 40',
      );
    });

    it('renders objects nested inside an array', () => {
      expect(factValueToText(null, [{ a: 1 }, { b: 2 }])).toBe('a: 1, b: 2');
    });

    it('never emits a placeholder for a structured value', () => {
      const rendered = factValueToText(null, { deep: { deeper: ['x', 'y'] } });
      expect(rendered).toBe('deep: deeper: x, y');
      expect(rendered).not.toContain('[object Object]');
    });
  });
});
