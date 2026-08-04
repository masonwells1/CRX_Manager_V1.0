import { describe, it, expect } from 'vitest';
import { formatCents, formatUSD } from './money';

/**
 * money.ts is the canonical formatter for a codebase where money is stored as
 * bigint CENTS. The module's own header warns that the cents-vs-dollars
 * distinction is the bug it exists to prevent, yet it shipped untested — so the
 * distinction itself is what these tests pin.
 *
 * The critical invariant: formatCents DIVIDES by 100, formatUSD DOES NOT.
 * Swapping them renders an amount off by 100x, silently.
 */
describe('money', () => {
  describe('formatCents — input is CENTS, divides by 100', () => {
    it('renders the documented example', () => {
      expect(formatCents(123456)).toBe('$1,234.56');
    });

    it.each([
      [0, '$0.00'],
      [1, '$0.01'],
      [99, '$0.99'],
      [100, '$1.00'],
      [999, '$9.99'],
      [100000, '$1,000.00'],
      [123456789, '$1,234,567.89'],
    ])('formats %i cents as %s', (cents, expected) => {
      expect(formatCents(cents)).toBe(expected);
    });

    it('renders negative amounts (credits, write-offs) with a leading minus', () => {
      expect(formatCents(-123456)).toBe('-$1,234.56');
      expect(formatCents(-1)).toBe('-$0.01');
    });

    it('groups thousands with commas', () => {
      expect(formatCents(1_000_000_00)).toBe('$1,000,000.00');
    });

    it('always shows exactly two decimal places', () => {
      expect(formatCents(500)).toBe('$5.00');
      expect(formatCents(510)).toBe('$5.10');
    });
  });

  describe('formatUSD — input is DOLLARS, does NOT divide', () => {
    it('renders the documented example', () => {
      expect(formatUSD(1234.56)).toBe('$1,234.56');
    });

    it.each([
      [0, '$0.00'],
      [1, '$1.00'],
      [0.01, '$0.01'],
      [1000, '$1,000.00'],
      [1234567.89, '$1,234,567.89'],
    ])('formats %d dollars as %s', (dollars, expected) => {
      expect(formatUSD(dollars)).toBe(expected);
    });

    it('renders negative amounts with a leading minus', () => {
      expect(formatUSD(-1234.56)).toBe('-$1,234.56');
    });

    it('rounds to the nearest cent rather than truncating', () => {
      expect(formatUSD(1.005)).toBe('$1.01');
      expect(formatUSD(1.004)).toBe('$1.00');
    });
  });

  describe('the cents-vs-dollars distinction (the bug this module exists to prevent)', () => {
    it('the two functions are NOT interchangeable for the same number', () => {
      expect(formatCents(1234)).toBe('$12.34');
      expect(formatUSD(1234)).toBe('$1,234.00');
      expect(formatCents(1234)).not.toBe(formatUSD(1234));
    });

    it('passing a cents value to formatUSD overstates by exactly 100x', () => {
      const cents = 500_00; // $500.00
      expect(formatCents(cents)).toBe('$500.00');
      expect(formatUSD(cents)).toBe('$50,000.00'); // the silent 100x bug
    });

    it('dividing by 100 at the call site makes formatUSD agree with formatCents', () => {
      // This is the pattern used across the app (e.g. `fmt(inv.balance_cents / 100)`
      // in OrderDetail.tsx, CustomerDetail.tsx, Quotes.tsx). Nothing enforces the
      // `/ 100`; this test pins that it is what correctness depends on.
      for (const cents of [0, 1, 99, 100, 123456, -4567]) {
        expect(formatUSD(cents / 100)).toBe(formatCents(cents));
      }
    });
  });
});
