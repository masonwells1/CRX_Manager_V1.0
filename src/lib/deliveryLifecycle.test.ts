/**
 * deliveryLifecycle.test.ts
 * Pure function tests for delivery status transitions, remainder chain logic,
 * and multi-item delivery scenarios.
 *
 * These test the business rules independent of Supabase or React.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Domain functions under test
// ---------------------------------------------------------------------------

/** Valid delivery status transitions */
const VALID_TRANSITIONS: Record<string, string[]> = {
  scheduled: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],  // terminal
  cancelled: [],  // terminal
};

/** Check whether a status transition is allowed */
function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Calculate remaining quantity after a delivery */
function calculateRemainder(ordered: number, delivered: number): number {
  if (ordered <= 0 || delivered < 0) return 0;
  return Math.max(0, ordered - delivered);
}

/** Decide whether a remainder delivery should be created */
function shouldCreateRemainder(ordered: number, delivered: number): boolean {
  return calculateRemainder(ordered, delivered) > 0;
}

/** Summary of remainder decisions for a multi-item delivery */
interface DeliveryLineItem {
  product_id: string;
  quantity_ordered: number;
  quantity_delivered: number;
}

function computeDeliveryRemainders(items: DeliveryLineItem[]): Array<{
  product_id: string;
  remainder: number;
  needsFollowUp: boolean;
}> {
  return items.map((item) => {
    const remainder = calculateRemainder(item.quantity_ordered, item.quantity_delivered);
    return {
      product_id: item.product_id,
      remainder,
      needsFollowUp: remainder > 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. Status Transition Tests
// ---------------------------------------------------------------------------

describe('Delivery status transitions', () => {
  it('allows scheduled -> confirmed', () => {
    expect(isValidTransition('scheduled', 'confirmed')).toBe(true);
  });

  it('allows scheduled -> cancelled', () => {
    expect(isValidTransition('scheduled', 'cancelled')).toBe(true);
  });

  it('allows confirmed -> in_progress', () => {
    expect(isValidTransition('confirmed', 'in_progress')).toBe(true);
  });

  it('allows confirmed -> cancelled', () => {
    expect(isValidTransition('confirmed', 'cancelled')).toBe(true);
  });

  it('allows in_progress -> completed', () => {
    expect(isValidTransition('in_progress', 'completed')).toBe(true);
  });

  it('allows in_progress -> cancelled', () => {
    expect(isValidTransition('in_progress', 'cancelled')).toBe(true);
  });

  it('rejects backward transition completed -> scheduled', () => {
    expect(isValidTransition('completed', 'scheduled')).toBe(false);
  });

  it('rejects backward transition completed -> in_progress', () => {
    expect(isValidTransition('completed', 'in_progress')).toBe(false);
  });

  it('rejects backward transition cancelled -> scheduled', () => {
    expect(isValidTransition('cancelled', 'scheduled')).toBe(false);
  });

  it('rejects transition from terminal state completed', () => {
    // completed is terminal -- cannot transition to anything
    for (const target of ['scheduled', 'confirmed', 'in_progress', 'cancelled']) {
      expect(isValidTransition('completed', target)).toBe(false);
    }
  });

  it('rejects transition from terminal state cancelled', () => {
    for (const target of ['scheduled', 'confirmed', 'in_progress', 'completed']) {
      expect(isValidTransition('cancelled', target)).toBe(false);
    }
  });

  it('returns false for unknown source status', () => {
    expect(isValidTransition('unknown_status', 'confirmed')).toBe(false);
  });

  it('returns false for unknown target status from valid source', () => {
    expect(isValidTransition('scheduled', 'unknown_target')).toBe(false);
  });

  it('does not allow skipping steps (scheduled -> completed)', () => {
    expect(isValidTransition('scheduled', 'completed')).toBe(false);
  });

  it('does not allow skipping steps (scheduled -> in_progress)', () => {
    expect(isValidTransition('scheduled', 'in_progress')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Remainder Calculation Tests
// ---------------------------------------------------------------------------

describe('Delivery remainder calculations', () => {
  it('returns 0 for full delivery (ordered === delivered)', () => {
    expect(calculateRemainder(100, 100)).toBe(0);
  });

  it('returns correct remainder for partial delivery', () => {
    expect(calculateRemainder(100, 60)).toBe(40);
  });

  it('returns 0 for over-delivery (clamped at zero)', () => {
    expect(calculateRemainder(100, 120)).toBe(0);
  });

  it('returns 0 for zero ordered quantity', () => {
    expect(calculateRemainder(0, 50)).toBe(0);
  });

  it('returns 0 for negative ordered quantity', () => {
    expect(calculateRemainder(-10, 5)).toBe(0);
  });

  it('returns full ordered amount when zero delivered', () => {
    expect(calculateRemainder(100, 0)).toBe(100);
  });

  it('returns 0 for negative delivered quantity', () => {
    expect(calculateRemainder(100, -5)).toBe(0);
  });

  it('handles fractional quantities correctly', () => {
    expect(calculateRemainder(10.5, 7.3)).toBeCloseTo(3.2, 10);
  });
});

// ---------------------------------------------------------------------------
// 3. Remainder Chain Decision Tests
// ---------------------------------------------------------------------------

describe('Remainder chain decisions (shouldCreateRemainder)', () => {
  it('returns true for partial delivery', () => {
    expect(shouldCreateRemainder(100, 60)).toBe(true);
  });

  it('returns false for full delivery', () => {
    expect(shouldCreateRemainder(100, 100)).toBe(false);
  });

  it('returns false for over-delivery', () => {
    expect(shouldCreateRemainder(100, 150)).toBe(false);
  });

  it('returns true when nothing delivered', () => {
    expect(shouldCreateRemainder(100, 0)).toBe(true);
  });

  it('returns false for zero ordered', () => {
    expect(shouldCreateRemainder(0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-Item Delivery Scenarios
// ---------------------------------------------------------------------------

describe('Multi-item delivery scenarios', () => {
  it('identifies mixed partial and full deliveries correctly', () => {
    const items: DeliveryLineItem[] = [
      { product_id: 'prod-a', quantity_ordered: 50, quantity_delivered: 50 },  // full
      { product_id: 'prod-b', quantity_ordered: 80, quantity_delivered: 40 },  // partial
      { product_id: 'prod-c', quantity_ordered: 30, quantity_delivered: 30 },  // full
    ];
    const results = computeDeliveryRemainders(items);

    expect(results[0].remainder).toBe(0);
    expect(results[0].needsFollowUp).toBe(false);

    expect(results[1].remainder).toBe(40);
    expect(results[1].needsFollowUp).toBe(true);

    expect(results[2].remainder).toBe(0);
    expect(results[2].needsFollowUp).toBe(false);
  });

  it('returns no remainders when all items are fully delivered', () => {
    const items: DeliveryLineItem[] = [
      { product_id: 'prod-a', quantity_ordered: 100, quantity_delivered: 100 },
      { product_id: 'prod-b', quantity_ordered: 200, quantity_delivered: 200 },
      { product_id: 'prod-c', quantity_ordered: 50, quantity_delivered: 50 },
    ];
    const results = computeDeliveryRemainders(items);

    expect(results.every((r) => r.remainder === 0)).toBe(true);
    expect(results.every((r) => r.needsFollowUp === false)).toBe(true);
  });

  it('returns all remainders when zero delivered on every item', () => {
    const items: DeliveryLineItem[] = [
      { product_id: 'prod-a', quantity_ordered: 100, quantity_delivered: 0 },
      { product_id: 'prod-b', quantity_ordered: 50, quantity_delivered: 0 },
    ];
    const results = computeDeliveryRemainders(items);

    expect(results[0].remainder).toBe(100);
    expect(results[0].needsFollowUp).toBe(true);
    expect(results[1].remainder).toBe(50);
    expect(results[1].needsFollowUp).toBe(true);
  });

  it('handles empty items array', () => {
    const results = computeDeliveryRemainders([]);
    expect(results).toEqual([]);
  });

  it('handles single item partial delivery', () => {
    const items: DeliveryLineItem[] = [
      { product_id: 'prod-a', quantity_ordered: 75, quantity_delivered: 25 },
    ];
    const results = computeDeliveryRemainders(items);
    expect(results).toHaveLength(1);
    expect(results[0].remainder).toBe(50);
    expect(results[0].needsFollowUp).toBe(true);
  });
});
