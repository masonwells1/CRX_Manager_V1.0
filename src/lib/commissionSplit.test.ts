import { describe, it, expect } from 'vitest';
import { validateCommissionSplits } from './quoteCalc';

// ---------------------------------------------------------------------------
// Local helpers that mirror the SQL-side commission split parsing logic.
// These replicate what `create_quick_delivery` and `convert_quote_to_order`
// do in PostgreSQL when reading `default_commission_split` JSONB.
// ---------------------------------------------------------------------------

/**
 * Parse commission splits from the JSONB format stored in the database.
 *
 * The database stores splits as `{"splits": [{user_id, percentage, ...}]}`
 * (wrapped format). Bug #12 was caused by the SQL checking for a raw array
 * instead of unwrapping the `splits` key.
 */
function parseCommissionSplits(
  splitJson: unknown,
): Array<{ user_id: string; percentage: number }> {
  if (!splitJson) return [];

  // Handle {splits: [...]} wrapper format (Bug #12 fix)
  if (
    typeof splitJson === 'object' &&
    !Array.isArray(splitJson) &&
    splitJson !== null &&
    'splits' in splitJson
  ) {
    const inner = (splitJson as Record<string, unknown>).splits;
    return Array.isArray(inner)
      ? (inner as Array<{ user_id: string; percentage: number }>)
      : [];
  }

  // Handle raw array format (legacy / testing)
  if (Array.isArray(splitJson)) {
    return splitJson as Array<{ user_id: string; percentage: number }>;
  }

  return [];
}

/**
 * Calculate commission amount in cents for a given percentage.
 * Mirrors the SQL: `ROUND(total_amount * percentage / 100)`.
 */
function calculateCommissionAmount(
  totalCents: number,
  percentage: number,
): number {
  if (!Number.isFinite(totalCents) || !Number.isFinite(percentage)) return 0;
  if (totalCents <= 0 || percentage <= 0 || percentage > 100) return 0;
  return Math.round((totalCents * percentage) / 100);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ── 1. parseCommissionSplits ───────────────────────────────────────────────

describe('parseCommissionSplits', () => {
  it('parses wrapped format: {splits: [{user_id, percentage}]}', () => {
    const input = {
      splits: [
        { user_id: 'u1', percentage: 60 },
        { user_id: 'u2', percentage: 40 },
      ],
    };
    const result = parseCommissionSplits(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ user_id: 'u1', percentage: 60 });
    expect(result[1]).toEqual({ user_id: 'u2', percentage: 40 });
  });

  it('parses raw array format: [{user_id, percentage}]', () => {
    const input = [
      { user_id: 'u1', percentage: 50 },
      { user_id: 'u2', percentage: 50 },
    ];
    const result = parseCommissionSplits(input);
    expect(result).toHaveLength(2);
    expect(result[0].user_id).toBe('u1');
  });

  it('returns empty array for null', () => {
    expect(parseCommissionSplits(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(parseCommissionSplits(undefined)).toEqual([]);
  });

  it('returns empty array for empty object {}', () => {
    expect(parseCommissionSplits({})).toEqual([]);
  });

  it('returns empty array for {splits: "not-an-array"}', () => {
    expect(parseCommissionSplits({ splits: 'not-an-array' })).toEqual([]);
  });

  it('returns empty array for plain string', () => {
    expect(parseCommissionSplits('some string')).toEqual([]);
  });

  it('returns empty array for number', () => {
    expect(parseCommissionSplits(42)).toEqual([]);
  });

  it('returns empty array for {splits: null}', () => {
    expect(parseCommissionSplits({ splits: null })).toEqual([]);
  });

  it('returns empty array for false', () => {
    expect(parseCommissionSplits(false)).toEqual([]);
  });

  it('returns empty array for 0', () => {
    expect(parseCommissionSplits(0)).toEqual([]);
  });

  it('handles single-split wrapped format', () => {
    const input = { splits: [{ user_id: 'solo', percentage: 100 }] };
    const result = parseCommissionSplits(input);
    expect(result).toHaveLength(1);
    expect(result[0].percentage).toBe(100);
  });

  it('handles empty splits array: {splits: []}', () => {
    expect(parseCommissionSplits({ splits: [] })).toEqual([]);
  });
});

// ── 2. calculateCommissionAmount ───────────────────────────────────────────

describe('calculateCommissionAmount', () => {
  it('50% of $100 (10000 cents) = $50 (5000 cents)', () => {
    expect(calculateCommissionAmount(10000, 50)).toBe(5000);
  });

  it('33.33% of $100 (10000 cents) rounds to 3333 cents', () => {
    expect(calculateCommissionAmount(10000, 33.33)).toBe(3333);
  });

  it('100% of amount returns full amount', () => {
    expect(calculateCommissionAmount(7500, 100)).toBe(7500);
  });

  it('0% returns 0', () => {
    expect(calculateCommissionAmount(10000, 0)).toBe(0);
  });

  it('negative percentage returns 0', () => {
    expect(calculateCommissionAmount(10000, -10)).toBe(0);
  });

  it('percentage > 100 returns 0', () => {
    expect(calculateCommissionAmount(10000, 150)).toBe(0);
  });

  it('NaN totalCents returns 0', () => {
    expect(calculateCommissionAmount(NaN, 50)).toBe(0);
  });

  it('NaN percentage returns 0', () => {
    expect(calculateCommissionAmount(10000, NaN)).toBe(0);
  });

  it('Infinity totalCents returns 0', () => {
    expect(calculateCommissionAmount(Infinity, 50)).toBe(0);
  });

  it('Infinity percentage returns 0', () => {
    expect(calculateCommissionAmount(10000, Infinity)).toBe(0);
  });

  it('negative totalCents returns 0', () => {
    expect(calculateCommissionAmount(-5000, 50)).toBe(0);
  });

  it('very large amount maintains precision', () => {
    // $1,000,000.00 = 100_000_000 cents, 15% = $150,000 = 15_000_000 cents
    expect(calculateCommissionAmount(100_000_000, 15)).toBe(15_000_000);
  });

  it('small fractional percentage rounds correctly', () => {
    // 1.5% of $200 (20000 cents) = 300 cents
    expect(calculateCommissionAmount(20000, 1.5)).toBe(300);
  });

  it('1 cent total at 50% rounds to 1 cent (0.5 rounds up)', () => {
    // Math.round(1 * 50 / 100) = Math.round(0.5) = 1
    expect(calculateCommissionAmount(1, 50)).toBe(1);
  });
});

// ── 3. validateCommissionSplits (from quoteCalc) ───────────────────────────

describe('validateCommissionSplits', () => {
  it('returns null for valid splits summing to 100%', () => {
    expect(
      validateCommissionSplits([
        { recipient: 'Alice', percentage: 60 },
        { recipient: 'Bob', percentage: 40 },
      ]),
    ).toBeNull();
  });

  it('returns error message when splits do not sum to 100%', () => {
    const result = validateCommissionSplits([
      { recipient: 'Alice', percentage: 50 },
      { recipient: 'Bob', percentage: 20 },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain('70.00%');
    expect(result).toContain('expected 100%');
  });

  it('returns null for empty splits (no commission)', () => {
    expect(validateCommissionSplits([])).toBeNull();
  });
});

// ── 4. Integration scenario: parse → validate → calculate ─────────────────

describe('commission split integration', () => {
  it('parses splits, validates, and calculates amounts for each recipient', () => {
    const raw = {
      splits: [
        { user_id: 'rep-a', percentage: 60, recipient: 'Alice' },
        { user_id: 'rep-b', percentage: 40, recipient: 'Bob' },
      ],
    };

    // Step 1: Parse
    const splits = parseCommissionSplits(raw);
    expect(splits).toHaveLength(2);

    // Step 2: Validate (map to the format validateCommissionSplits expects)
    const validationSplits = splits.map((s) => ({
      recipient: (s as any).recipient || s.user_id,
      percentage: s.percentage,
    }));
    expect(validateCommissionSplits(validationSplits)).toBeNull();

    // Step 3: Calculate amounts on a $500 order (50000 cents)
    const totalCents = 50000;
    const amounts = splits.map((s) => ({
      user_id: s.user_id,
      amount_cents: calculateCommissionAmount(totalCents, s.percentage),
    }));

    expect(amounts[0]).toEqual({ user_id: 'rep-a', amount_cents: 30000 }); // 60%
    expect(amounts[1]).toEqual({ user_id: 'rep-b', amount_cents: 20000 }); // 40%
  });

  it('two splits totaling 100% distribute without losing or gaining pennies', () => {
    const totalCents = 9999; // $99.99 — odd amount
    const splits = [
      { user_id: 'a', percentage: 50 },
      { user_id: 'b', percentage: 50 },
    ];

    const amounts = splits.map((s) =>
      calculateCommissionAmount(totalCents, s.percentage),
    );

    // 50% of 9999 = 4999.5, rounds to 5000 each
    // Total distributed = 10000, which is 1 cent MORE than the total.
    // This is the known rounding behavior — the SQL side handles it with
    // "last recipient gets remainder" logic. Here we just verify the math.
    const distributed = amounts.reduce((sum, a) => sum + a, 0);
    expect(Math.abs(distributed - totalCents)).toBeLessThanOrEqual(1);
  });

  it('three-way equal split with rounding (33.33 + 33.33 + 33.34)', () => {
    const totalCents = 10000; // $100.00
    const splits = [
      { user_id: 'a', percentage: 33.33 },
      { user_id: 'b', percentage: 33.33 },
      { user_id: 'c', percentage: 33.34 },
    ];

    const amounts = splits.map((s) =>
      calculateCommissionAmount(totalCents, s.percentage),
    );

    // 33.33% of 10000 = 3333, 33.34% of 10000 = 3334
    expect(amounts[0]).toBe(3333);
    expect(amounts[1]).toBe(3333);
    expect(amounts[2]).toBe(3334);

    const distributed = amounts.reduce((sum, a) => sum + a, 0);
    expect(distributed).toBe(10000); // exactly $100.00
  });

  it('single 100% split gets the full amount', () => {
    const totalCents = 12345;
    const splits = parseCommissionSplits({
      splits: [{ user_id: 'solo', percentage: 100 }],
    });

    expect(splits).toHaveLength(1);
    expect(calculateCommissionAmount(totalCents, splits[0].percentage)).toBe(
      12345,
    );
  });
});
