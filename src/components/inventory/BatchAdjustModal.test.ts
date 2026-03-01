import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn().mockResolvedValue({ data: { status: 'adjusted', new_quantity: 10 }, error: null });

vi.mock('../../lib/db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  sanitizeError: (e: unknown) => String(e),
}));

vi.mock('../../lib/idempotency', () => ({
  generateIdempotencyKey: vi.fn().mockReturnValue('test-key-123'),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { buildAdjustmentCalls, type AdjustmentItem } from './BatchAdjustModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAdjustmentCalls', () => {
  it('creates one RPC call per item', () => {
    const items: AdjustmentItem[] = [
      { inventory_id: 'inv-1', product_name: 'Product A', current_qty: 10, delta: 5 },
      { inventory_id: 'inv-2', product_name: 'Product B', current_qty: 20, delta: -3 },
    ];
    const calls = buildAdjustmentCalls(items, 'Cycle count correction', 'user-1');
    expect(calls).toHaveLength(2);
    expect(calls[0].p_inventory_id).toBe('inv-1');
    expect(calls[0].p_delta).toBe(5);
    expect(calls[1].p_delta).toBe(-3);
  });

  it('filters out zero-delta items', () => {
    const items: AdjustmentItem[] = [
      { inventory_id: 'inv-1', product_name: 'A', current_qty: 10, delta: 5 },
      { inventory_id: 'inv-2', product_name: 'B', current_qty: 20, delta: 0 },
    ];
    const calls = buildAdjustmentCalls(items, 'fix', 'user-1');
    expect(calls).toHaveLength(1);
  });

  it('includes reason in every call', () => {
    const items: AdjustmentItem[] = [
      { inventory_id: 'inv-1', product_name: 'A', current_qty: 10, delta: 5 },
    ];
    const calls = buildAdjustmentCalls(items, 'Damaged goods', 'user-1');
    expect(calls[0].p_reason).toBe('Damaged goods');
  });
});
