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
            quantity: -25,
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

import { computeRunningBalance } from './TransactionLedgerModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeRunningBalance', () => {
  it('computes cumulative balance from transactions', () => {
    const txns = [
      { quantity: 100 },
      { quantity: -25 },
      { quantity: 50 },
      { quantity: -10 },
    ];
    const balances = computeRunningBalance(txns as Array<{ quantity: number }>);
    expect(balances).toEqual([100, 75, 125, 115]);
  });

  it('returns empty array for no transactions', () => {
    expect(computeRunningBalance([])).toEqual([]);
  });

  it('handles negative starting balance', () => {
    const txns = [{ quantity: -5 }, { quantity: 10 }];
    expect(computeRunningBalance(txns as Array<{ quantity: number }>)).toEqual([-5, 5]);
  });
});
