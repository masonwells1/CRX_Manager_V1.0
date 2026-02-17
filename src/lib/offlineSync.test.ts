import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase
const mockRpc = vi.fn();
vi.mock('./db', () => ({
  supabase: { rpc: (...args: any[]) => mockRpc(...args) },
}));

// Mock offlineQueue
const mockGetPendingActions = vi.fn();
const mockRemoveAction = vi.fn().mockResolvedValue(undefined);
const mockUpdateAction = vi.fn().mockResolvedValue(undefined);

vi.mock('./offlineQueue', () => ({
  getPendingActions: () => mockGetPendingActions(),
  removeAction: (id: number) => mockRemoveAction(id),
  updateAction: (action: any) => mockUpdateAction(action),
}));

import { syncPendingActions } from './offlineSync';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncPendingActions', () => {
  it('returns { synced: 0, failed: 0 } when queue is empty', async () => {
    mockGetPendingActions.mockResolvedValue([]);
    const result = await syncPendingActions();
    expect(result).toEqual({ synced: 0, failed: 0 });
  });

  it('syncs a complete_delivery action successfully', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 1, operation: 'complete_delivery', params: { delivery_id: 'd-1' }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ error: null });

    const result = await syncPendingActions();

    expect(mockRpc).toHaveBeenCalledWith('complete_delivery', { delivery_id: 'd-1' });
    expect(mockRemoveAction).toHaveBeenCalledWith(1);
    expect(result).toEqual({ synced: 1, failed: 0 });
  });

  it('syncs a record_payment action successfully', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 2, operation: 'record_payment', params: { amount: 100 }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ error: null });

    const result = await syncPendingActions();

    expect(mockRpc).toHaveBeenCalledWith('record_payment', { amount: 100 });
    expect(mockRemoveAction).toHaveBeenCalledWith(2);
    expect(result).toEqual({ synced: 1, failed: 0 });
  });

  it('increments retryCount on RPC error (under max retries)', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 3, operation: 'complete_delivery', params: {}, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ error: { message: 'timeout' } });

    const result = await syncPendingActions();

    expect(mockUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, retryCount: 1, lastError: 'timeout' })
    );
    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 0, failed: 0 }); // not "failed" until max retries
  });

  it('marks as failed after reaching max retries (3)', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 4, operation: 'record_payment', params: {}, createdAt: '2026-01-01', retryCount: 2 },
    ]);
    mockRpc.mockResolvedValue({ error: { message: 'still failing' } });

    const result = await syncPendingActions();

    expect(mockUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 4, retryCount: 3, lastError: 'still failing' })
    );
    expect(result).toEqual({ synced: 0, failed: 1 });
  });

  it('handles unknown operations by failing them', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 5, operation: 'unknown_op', params: {}, createdAt: '2026-01-01', retryCount: 0 },
    ]);

    const result = await syncPendingActions();

    expect(mockUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5, retryCount: 1, lastError: expect.stringContaining('Unknown operation') })
    );
    expect(result).toEqual({ synced: 0, failed: 0 });
  });

  it('processes multiple actions in sequence', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 10, operation: 'complete_delivery', params: { a: 1 }, createdAt: '2026-01-01', retryCount: 0 },
      { id: 11, operation: 'record_payment', params: { b: 2 }, createdAt: '2026-01-01', retryCount: 0 },
      { id: 12, operation: 'receive_po_items', params: { c: 3 }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ error: null });

    const result = await syncPendingActions();

    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRemoveAction).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ synced: 3, failed: 0 });
  });

  it('continues processing remaining actions when one fails', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 20, operation: 'complete_delivery', params: {}, createdAt: '2026-01-01', retryCount: 0 },
      { id: 21, operation: 'record_payment', params: {}, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    // First call fails, second succeeds
    mockRpc
      .mockResolvedValueOnce({ error: { message: 'fail' } })
      .mockResolvedValueOnce({ error: null });

    const result = await syncPendingActions();

    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(mockUpdateAction).toHaveBeenCalledTimes(1); // failed one
    expect(mockRemoveAction).toHaveBeenCalledTimes(1); // synced one
  });
});
