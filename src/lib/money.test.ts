import { describe, it, expect } from 'vitest';
import { formatCents, formatExactUSD, formatUSD, centsToDollarInput, centsTimesQuantity, isExactDecimalText, quantitySurvivesSave, sameExactDecimal } from './money';

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

  describe('formatExactUSD — lossless whole-cent report values', () => {
    it.each([
      ['1.01', '$1.01'],
      [2.05, '$2.05'],
      ['1234567.8', '$1,234,567.80'],
      ['-50.25', '-$50.25'],
      ['-0.00', '$0.00'],
    ])('formats %s exactly as %s', (dollars, expected) => {
      expect(formatExactUSD(dollars)).toBe(expected);
    });

    it('accepts constrained whole-cent JSON numbers below the cent-resolution limit', () => {
      expect(formatExactUSD(JSON.parse('35184372088831.99'))).toBe('$35,184,372,088,831.99');
    });

    it('rejects JSON numeric amounts once adjacent cents can collide', () => {
      expect(formatExactUSD(JSON.parse('70368744177664.01'))).toBe('Invalid amount');
      expect(formatExactUSD(JSON.parse('90071992547409.93'))).toBe('Invalid amount');
    });

    it('preserves lossless decimal text beyond JSON-number precision', () => {
      expect(formatExactUSD('90071992547409.93')).toBe('$90,071,992,547,409.93');
    });

    it.each(['1.005', '1e3', 'NaN', 'Infinity', '-Infinity', Number.NaN, Number.POSITIVE_INFINITY, null, undefined])(
      'fails visibly for invalid amount %s',
      (dollars) => {
        expect(formatExactUSD(dollars)).toBe('Invalid amount');
      },
    );
  });

  describe('centsToDollarInput — exact editable decimal text', () => {
    it.each([
      [0, '0.00'],
      [1, '0.01'],
      [105, '1.05'],
      [123456, '1234.56'],
      [-105, '-1.05'],
    ])('formats %i cents as %s without floating-point math', (cents, expected) => {
      expect(centsToDollarInput(cents)).toBe(expected);
    });

    it('fails closed for values that are not safe integer cents', () => {
      expect(centsToDollarInput(1.5)).toBe('0.00');
      expect(centsToDollarInput(Number.MAX_SAFE_INTEGER + 1)).toBe('0.00');
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

describe('centsTimesQuantity — exact parity with the server safe_cents_qty', () => {
  // Every expected value below was VERIFIED against the live database
  // (project rhyzpcqhnizqbxphqdkr, read-only) by evaluating safe_cents_qty's own body,
  // `SELECT ROUND(<cents>::numeric * <qty>)`, on 2026-08-20.
  describe('the rounding RULE the server actually uses', () => {
    it('rounds half AWAY FROM ZERO, not to even (live: ROUND(2.5::numeric) = 3)', () => {
      // This is the case that distinguishes the two candidate rules. Banker's rounding
      // would give 2 here and 4 below; away-from-zero gives 3 and 4. The live database
      // returns 3, so away-from-zero is the rule. NOTE: migration 20260513030000's own
      // comment calls it "banker's rounding" — the comment is wrong, the SQL is right.
      expect(centsTimesQuantity(1, '2.5')).toBe(3);   // live ROUND(1::numeric * 2.5) = 3
      expect(centsTimesQuantity(1, '3.5')).toBe(4);   // live ROUND(1::numeric * 3.5) = 4
      expect(centsTimesQuantity(1, '1.5')).toBe(2);   // live = 2
      expect(centsTimesQuantity(1, '0.5')).toBe(1);   // live = 1
    });

    it('beats binary floating point on the half-cent boundaries it gets wrong', () => {
      // These are REAL divergences, found by sweeping 59,403 realistic (cents, 4-dp
      // quantity) combinations — not hand-picked pathological values. In each case the
      // exact product lands on a half cent, but the binary product falls just below it,
      // so Math.round goes DOWN while the server's exact numeric multiply goes UP.
      //
      //   25c x 0.58 → exact 14.50 (verified live) → server 15c, JS float 14c
      //
      // Each row is [cents, quantity, correct]; all three verified against the live
      // database on 2026-08-20 via ROUND(<cents>::numeric * <qty>).
      const cases: Array<[number, string, number]> = [
        [25, '0.58', 15],
        [50, '0.29', 15],
        [45, '0.70', 32],
      ];
      for (const [cents, qty, correct] of cases) {
        expect(Math.round(parseFloat(qty) * cents)).toBe(correct - 1); // the old float path, off by a cent
        expect(centsTimesQuantity(cents, qty)).toBe(correct);          // exact, matches the server
      }
    });
  });

  describe('the live money cases this remediation is about', () => {
    it('reproduces the Dry oz over-bill and the true amount', () => {
      expect(centsTimesQuantity(150, '3200')).toBe(480000);  // live = 480000 ($4,800 wrong)
      expect(centsTimesQuantity(150, '200')).toBe(30000);    // live = 30000  ($300 right)
    });

    it('reproduces the blank-unit pint case to the exact cent', () => {
      expect(centsTimesQuantity(3800, '9.16375')).toBe(34822); // live = 34822 ($348.22)
    });
  });

  describe('defensive input handling (matches the server COALESCE(...,0))', () => {
    it('treats blank, whitespace, and unparseable quantities as zero', () => {
      for (const q of ['', '   ', 'abc', '1e3', 'Infinity', 'NaN', '.', '1.2.3']) {
        expect(centsTimesQuantity(500, q)).toBe(0);
      }
    });
    it('treats a non-integer or non-finite cents amount as zero — cents are whole', () => {
      expect(centsTimesQuantity(1.5, '10')).toBe(0);
      expect(centsTimesQuantity(NaN, '10')).toBe(0);
      expect(centsTimesQuantity(Infinity, '10')).toBe(0);
    });
    it('handles zero, leading dots, and trailing dots', () => {
      expect(centsTimesQuantity(150, '0')).toBe(0);
      expect(centsTimesQuantity(200, '.5')).toBe(100);
      expect(centsTimesQuantity(200, '5.')).toBe(1000);
    });
    it('rounds a negative product away from zero too', () => {
      expect(centsTimesQuantity(1, '-2.5')).toBe(-3);
      expect(centsTimesQuantity(-1, '2.5')).toBe(-3);
    });
    it('stays exact far beyond the precision a float retains', () => {
      // The BigInt path carries the full product before rounding.
      // live: ROUND(999999999::numeric * 1234.5678) = 1234567798765
      expect(centsTimesQuantity(999999999, '1234.5678')).toBe(1234567798765);
    });
  });

  describe('the 2^53 boundary — a result a Number cannot hold exactly is NaN, never a neighbour (Codex Medium, 2026-08-24)', () => {
    it('returns the exact figure at the boundary itself', () => {
      // 2^53 − 1 = 9007199254740991 — the largest integer a Number holds exactly.
      expect(centsTimesQuantity(9007199254740991, '1')).toBe(9007199254740991);
    });
    it('refuses one cent past the boundary instead of silently landing on …992', () => {
      // 9007199254740993 is NOT representable: Number() would give 9007199254740992,
      // a real but WRONG amount. NaN fails the save gate loudly instead.
      expect(centsTimesQuantity(3002399751580331, '3')).toBeNaN();  // 3002399751580331 × 3 = exactly 9007199254740993
    });
    it('refuses far past the boundary too, in either sign', () => {
      expect(centsTimesQuantity(9007199254740991, '1000')).toBeNaN();
      expect(centsTimesQuantity(9007199254740991, '-1000')).toBeNaN();
    });
  });

  describe('isExactDecimalText — the saveability gate (Codex P2)', () => {
    // The bug this closes: callers gated on Number.isFinite(Number(text)), which is a
    // LOOSER test than what centsTimesQuantity can actually multiply. Anything the two
    // disagree about saves a nonzero line against a zero total.
    it('rejects exactly what centsTimesQuantity cannot multiply', () => {
      for (const bad of ['1e3', '1E3', '1e-3', 'NaN', 'Infinity', '-Infinity', '0x10', '1,000', 'abc', '', '   ', null, undefined]) {
        expect(isExactDecimalText(bad)).toBe(false);
        expect(centsTimesQuantity(150, bad as string)).toBe(0);
      }
    });

    it("'1e3' is the reachable case: Number() accepts it and the money path does not", () => {
      // `<input type="number">` accepts '1e3', so this arrives from the keyboard.
      expect(Number.isFinite(Number('1e3'))).toBe(true);   // the old, too-loose gate passed it
      expect(isExactDecimalText('1e3')).toBe(false);       // the real grammar refuses it
      expect(centsTimesQuantity(150, '1e3')).toBe(0);      // hence: line 1000, total 0
    });

    it('accepts every plain decimal the grid actually produces', () => {
      for (const ok of ['0', '150', '1.5', '.5', '5.', '-2.5', '+3', '232.9001', '1234.5678']) {
        expect(isExactDecimalText(ok)).toBe(true);
      }
    });
  });

  describe('quantitySurvivesSave — the header/line agreement gate (Codex P2, 2026-08-23)', () => {
    // THE BUG: the page totals money from the exact decimal TEXT, but
    // buildJobChemicalsPayload persists that same field as parseFloat(quantity). When the
    // text carries more precision than a double holds, those are two different numbers, and
    // the stored total contradicts the stored line.
    it('catches the exact divergence Codex reported: 5c x 0.29999999999999999', () => {
      const typed = '0.29999999999999999';
      // What the page's exact math bills from the TEXT:
      expect(centsTimesQuantity(5, typed)).toBe(1);       // exact 1.4999… → 1c
      // What the database bills from the PERSISTED value (parseFloat → 0.3):
      expect(String(parseFloat(typed))).toBe('0.3');
      expect(centsTimesQuantity(5, '0.3')).toBe(2);       // exact 1.5 → 2c, away from zero
      // A cent apart, so the row is refused rather than saved to either figure.
      expect(quantitySurvivesSave(typed)).toBe(false);
    });

    it('accepts every quantity the grid actually produces', () => {
      // fmt4 caps a derived quantity at 4 dp; all of these round-trip through a double.
      for (const ok of ['0', '150', '1.5', '.5', '5.', '3200', '232.9001', '1234.5678', '0.3', '73.31', '3752.64']) {
        expect(quantitySurvivesSave(ok)).toBe(true);
      }
    });

    it('refuses whatever isExactDecimalText refuses — one grammar, one gate', () => {
      for (const bad of ['1e3', 'NaN', 'Infinity', 'abc', '', '   ', null, undefined]) {
        expect(quantitySurvivesSave(bad)).toBe(false);
      }
    });

    it('refuses a value whose float form is EXPONENT notation, which cannot be billed at all', () => {
      expect(String(parseFloat('0.0000001'))).toBe('1e-7');
      expect(centsTimesQuantity(150, '1e-7')).toBe(0);
      expect(quantitySurvivesSave('0.0000001')).toBe(false);
    });

    it('sameExactDecimal compares VALUE, not spelling', () => {
      expect(sameExactDecimal('0.30', '0.3')).toBe(true);
      expect(sameExactDecimal('5.', '5')).toBe(true);
      expect(sameExactDecimal('.5', '0.5')).toBe(true);
      expect(sameExactDecimal('-0', '0')).toBe(true);
      expect(sameExactDecimal('0.3', '0.30000000000000004')).toBe(false);
      expect(sameExactDecimal('-2.5', '2.5')).toBe(false);
    });
  });
});
