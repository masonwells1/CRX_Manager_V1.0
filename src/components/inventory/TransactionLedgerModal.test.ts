import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { mockFrom, mockRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  sanitizeError: (error: unknown) => String(error),
  assertRpcResult: <T,>(data: T) => data,
}));

import TransactionLedgerModal, { signedQuantity, summarizeInventoryPosition } from './TransactionLedgerModal';

describe('signedQuantity', () => {
  it.each([
    ['received', 100, 100],
    ['returned', 50, 50],
    ['released', 30, 30],
    ['cancelled_delivery_reversal', 20, 20],
    ['void_delivery_reversal', 15, 15],
    ['delivered', 25, -25],
    ['booked', 200, -200],
    ['prebooked', 100, -100],
    ['job_applied', 10, -10],
    ['adjusted', -5, -5],
    ['transferred', -8, -8],
    ['prebook_reconciliation', -12, -12],
  ])('normalizes %s quantities', (type, quantity, expected) => {
    expect(signedQuantity(quantity as number, type as string)).toBe(expected);
  });

  it('returns the raw quantity for an unknown future type', () => {
    expect(signedQuantity(7, 'some_future_type')).toBe(7);
  });
});

describe('summarizeInventoryPosition', () => {
  it('uses authoritative inventory rows for the selected product', () => {
    const rows = [
      { product_id: 'product-a', quantity_available: 100, quantity_prebooked: 25 },
      { product_id: 'product-a', quantity_available: 40, quantity_prebooked: 5 },
      { product_id: 'product-b', quantity_available: 999, quantity_prebooked: 999 },
    ];

    expect(summarizeInventoryPosition(rows, 'product-a')).toEqual({
      onFloor: 140,
      prebooked: 30,
    });
  });

  it('returns zeroes when no inventory row exists', () => {
    expect(summarizeInventoryPosition([], 'missing')).toEqual({ onFloor: 0, prebooked: 0 });
  });
});

describe('TransactionLedgerModal', () => {
  it('renders authoritative stock totals and review-required transactions', async () => {
    const transaction = {
      id: 'txn-1',
      transaction_type: 'adjusted',
      quantity: -2,
      notes: 'Needs investigation',
      created_at: '2026-07-15T12:00:00Z',
      performed_by: null,
      order_id: null,
      purchase_order_id: null,
      delivery_id: null,
      from_location: null,
      to_location: null,
      order: null,
      purchase_order: null,
      delivery: null,
      requires_review: true,
    };
    const inventoryQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
    };
    inventoryQuery.select.mockReturnValue(inventoryQuery);
    inventoryQuery.eq.mockReturnValue(inventoryQuery);
    inventoryQuery.order.mockResolvedValue({ data: [transaction], error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'inventory_transactions') return inventoryQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    mockRpc.mockResolvedValue({
      data: [{ product_id: 'product-a', quantity_available: 15, quantity_prebooked: 4 }],
      error: null,
    });

    render(createElement(TransactionLedgerModal, {
      open: true,
      onClose: vi.fn(),
      productId: 'product-a',
      productName: 'Test Product',
    }));

    expect(await screen.findByText('Review required')).toBeInTheDocument();
    expect(screen.getByText(/On floor:/)).toHaveTextContent('On floor: 15');
    expect(screen.getByText(/Prebooked:/)).toHaveTextContent('Prebooked: 4');
    expect(screen.getByText('1 transaction need review')).toBeInTheDocument();
    expect(screen.queryByText(/Current balance:/)).not.toBeInTheDocument();
  });
});
