import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();

const mockFrom = vi.fn().mockReturnValue({
  select: mockSelect.mockReturnValue({
    eq: mockEq.mockReturnValue({
      order: mockOrder.mockResolvedValue({
        data: [
          {
            id: '1',
            transaction_type: 'received',
            quantity: 100,
            notes: 'Initial stock',
            created_at: '2026-01-15T10:00:00Z',
            performed_by: 'user-1',
            order_id: null,
            purchase_order_id: 'po-1',
            delivery_id: null,
            from_location: null,
            to_location: 'Main Warehouse',
            performer: { full_name: 'Admin User' },
          },
          {
            id: '2',
            transaction_type: 'delivered',
            quantity: 25,
            notes: null,
            created_at: '2026-02-01T14:30:00Z',
            performed_by: 'user-2',
            order_id: 'order-1',
            purchase_order_id: null,
            delivery_id: 'del-1',
            from_location: null,
            to_location: null,
            performer: { full_name: 'Driver Bob' },
          },
        ],
        error: null,
      }),
    }),
  }),
});

vi.mock('../../lib/db', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
  sanitizeError: (e: unknown) => String(e),
}));

import { computeRunningBalance, signedQuantity } from './TransactionLedgerModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signedQuantity', () => {
  it('returns positive for received', () => {
    expect(signedQuantity(100, 'received')).toBe(100);
  });

  it('returns positive for returned', () => {
    expect(signedQuantity(50, 'returned')).toBe(50);
  });

  it('returns positive for released', () => {
    expect(signedQuantity(30, 'released')).toBe(30);
  });

  it('returns positive for cancelled_delivery_reversal', () => {
    expect(signedQuantity(20, 'cancelled_delivery_reversal')).toBe(20);
  });

  it('returns positive for void_delivery_reversal', () => {
    expect(signedQuantity(15, 'void_delivery_reversal')).toBe(15);
  });

  it('returns negative for delivered', () => {
    expect(signedQuantity(25, 'delivered')).toBe(-25);
  });

  it('returns negative for booked', () => {
    expect(signedQuantity(200, 'booked')).toBe(-200);
  });

  it('returns negative for prebooked', () => {
    expect(signedQuantity(100, 'prebooked')).toBe(-100);
  });

  it('returns negative for job_applied', () => {
    expect(signedQuantity(10, 'job_applied')).toBe(-10);
  });

  it('preserves sign for adjusted (positive)', () => {
    expect(signedQuantity(5, 'adjusted')).toBe(5);
  });

  it('preserves sign for adjusted (negative)', () => {
    expect(signedQuantity(-5, 'adjusted')).toBe(-5);
  });

  it('preserves sign for transferred', () => {
    expect(signedQuantity(-8, 'transferred')).toBe(-8);
  });

  it('forces absolute for negative-stored received', () => {
    expect(signedQuantity(-100, 'received')).toBe(100);
  });

  it('forces negative absolute for negative-stored delivered', () => {
    expect(signedQuantity(-25, 'delivered')).toBe(-25);
  });

  it('falls through to raw quantity for unknown type', () => {
    expect(signedQuantity(7, 'some_future_type')).toBe(7);
  });
});

describe('computeRunningBalance', () => {
  it('computes cumulative balance using type-based sign logic', () => {
    const txns = [
      { quantity: 100, transaction_type: 'received' },
      { quantity: 25, transaction_type: 'delivered' },
      { quantity: 50, transaction_type: 'received' },
      { quantity: 10, transaction_type: 'adjusted' },
    ];
    // received +100 = 100, delivered -25 = 75, received +50 = 125, adjusted +10 = 135
    expect(computeRunningBalance(txns)).toEqual([100, 75, 125, 135]);
  });

  it('returns empty array for no transactions', () => {
    expect(computeRunningBalance([])).toEqual([]);
  });

  it('handles booked and released correctly', () => {
    const txns = [
      { quantity: 500, transaction_type: 'received' },
      { quantity: 200, transaction_type: 'booked' },
      { quantity: 50, transaction_type: 'released' },
    ];
    // received +500 = 500, booked -200 = 300, released +50 = 350
    expect(computeRunningBalance(txns)).toEqual([500, 300, 350]);
  });

  it('handles a real-world scenario matching the screenshot data', () => {
    const txns = [
      { quantity: 153, transaction_type: 'booked' },
      { quantity: 1590, transaction_type: 'booked' },
      { quantity: 1060, transaction_type: 'booked' },
      { quantity: 600, transaction_type: 'booked' },
      { quantity: 265, transaction_type: 'released' },
      { quantity: 275, transaction_type: 'received' },
      { quantity: 275, transaction_type: 'delivered' },
      { quantity: 265, transaction_type: 'adjusted' },
      { quantity: 10, transaction_type: 'adjusted' },
      { quantity: 530, transaction_type: 'booked' },
      { quantity: -10, transaction_type: 'adjusted' },
      { quantity: 2965, transaction_type: 'received' },
      { quantity: 55, transaction_type: 'received' },
    ];
    // -153, -1743, -2803, -3403, -3138, -2863, -3138, -2873, -2863, -3393, -3403, -438, -383
    const balances = computeRunningBalance(txns);
    expect(balances[0]).toBe(-153);
    expect(balances[4]).toBe(-3138); // after released +265
    expect(balances[5]).toBe(-2863); // after received +275
    expect(balances[6]).toBe(-3138); // after delivered -275
    expect(balances[12]).toBe(-383); // final balance
  });

  it('handles all reversal types as positive', () => {
    const txns = [
      { quantity: 100, transaction_type: 'delivered' },
      { quantity: 100, transaction_type: 'cancelled_delivery_reversal' },
      { quantity: 50, transaction_type: 'delivered' },
      { quantity: 50, transaction_type: 'void_delivery_reversal' },
    ];
    // -100, 0, -50, 0
    expect(computeRunningBalance(txns)).toEqual([-100, 0, -50, 0]);
  });
});
