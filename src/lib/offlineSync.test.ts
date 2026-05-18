import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase
const mockRpc = vi.fn();
vi.mock('./db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  // assertRpcResult is used in executeAction to catch silent {data:null,error:null}
  // responses (audit 2026-05-16 P1 #3). Mock the same behavior as the real impl.
  assertRpcResult: <T,>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data as T;
  },
}));

// Mock offlineQueue
const mockGetPendingActions = vi.fn();
const mockRemoveAction = vi.fn().mockResolvedValue(undefined);
const mockUpdateAction = vi.fn().mockResolvedValue(undefined);
const mockClearFailedActions = vi.fn().mockResolvedValue(0);
const mockClearStaleActions = vi.fn().mockResolvedValue(0);
const mockGetFailedActions = vi.fn().mockResolvedValue([]);

vi.mock('./offlineQueue', () => ({
  getPendingActions: () => mockGetPendingActions(),
  removeAction: (id: number) => mockRemoveAction(id),
  updateAction: (action: unknown) => mockUpdateAction(action),
  clearFailedActions: (...args: unknown[]) => mockClearFailedActions(...args),
  clearStaleActions: (...args: unknown[]) => mockClearStaleActions(...args),
  getFailedActions: (...args: unknown[]) => mockGetFailedActions(...args),
}));

import { syncPendingActions } from './offlineSync';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncPendingActions', () => {
  it('returns { synced: 0, failed: 0 } when queue is empty', async () => {
    mockGetPendingActions.mockResolvedValue([]);
    const result = await syncPendingActions();
    expect(result).toEqual({ synced: 0, failed: 0, cleaned: 0, conflicts: [] });
  });

  it('syncs a complete_delivery action successfully', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 1, operation: 'complete_delivery', params: { delivery_id: 'd-1' }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions();

    expect(mockRpc).toHaveBeenCalledWith('complete_delivery', { delivery_id: 'd-1' });
    expect(mockRemoveAction).toHaveBeenCalledWith(1);
    expect(result).toEqual({ synced: 1, failed: 0, cleaned: 0, conflicts: [] });
  });

  it('syncs a allocate_payment action successfully', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 2, operation: 'allocate_payment', params: { amount: 100 }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions();

    expect(mockRpc).toHaveBeenCalledWith('allocate_payment', { amount: 100 });
    expect(mockRemoveAction).toHaveBeenCalledWith(2);
    expect(result).toEqual({ synced: 1, failed: 0, cleaned: 0, conflicts: [] });
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
    expect(result).toEqual({ synced: 0, failed: 0, cleaned: 0, conflicts: [] }); // not "failed" until max retries
  });

  it('marks as failed after reaching max retries (3)', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 4, operation: 'allocate_payment', params: {}, createdAt: '2026-01-01', retryCount: 2 },
    ]);
    mockRpc.mockResolvedValue({ error: { message: 'still failing' } });

    const result = await syncPendingActions();

    expect(mockUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 4, retryCount: 3, lastError: 'still failing' })
    );
    expect(result).toEqual({ synced: 0, failed: 1, cleaned: 0, conflicts: [] });
  });

  it('handles unknown operations by failing them', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 5, operation: 'unknown_op', params: {}, createdAt: '2026-01-01', retryCount: 0 },
    ]);

    const result = await syncPendingActions();

    expect(mockUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5, retryCount: 1, lastError: expect.stringContaining('Unknown offline operation') })
    );
    expect(result).toEqual({ synced: 0, failed: 0, cleaned: 0, conflicts: [] });
  });

  it('processes multiple actions in sequence', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 10, operation: 'complete_delivery', params: { a: 1 }, createdAt: '2026-01-01', retryCount: 0 },
      { id: 11, operation: 'allocate_payment', params: { b: 2 }, createdAt: '2026-01-01', retryCount: 0 },
      { id: 12, operation: 'receive_po_items', params: { c: 3 }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions();

    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRemoveAction).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ synced: 3, failed: 0, cleaned: 0, conflicts: [] });
  });

  it('continues processing remaining actions when one fails', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 20, operation: 'complete_delivery', params: {}, createdAt: '2026-01-01', retryCount: 0 },
      { id: 21, operation: 'allocate_payment', params: {}, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    // First call fails, second succeeds
    mockRpc
      .mockResolvedValueOnce({ error: { message: 'fail' } })
      .mockResolvedValueOnce({ data: { success: true }, error: null });

    const result = await syncPendingActions();

    expect(result).toEqual({ synced: 1, failed: 0, cleaned: 0, conflicts: [] });
    expect(mockUpdateAction).toHaveBeenCalledTimes(1); // failed one
    expect(mockRemoveAction).toHaveBeenCalledTimes(1); // synced one
  });

  // Audit 2026-05-16 P1 #3 regression coverage: { data: null, error: null }
  // (RLS denial on a SELECT chain, trigger fail-soft path, etc.) must NOT
  // remove the queued action. It should throw and increment retryCount.
  it('does not mark action as synced when RPC returns null data with no error', async () => {
    mockGetPendingActions.mockResolvedValue([
      { id: 30, operation: 'complete_delivery', params: { delivery_id: 'd-1' }, createdAt: '2026-01-01', retryCount: 0 },
    ]);
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await syncPendingActions();

    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 30,
        retryCount: 1,
        lastError: expect.stringContaining('returned no data'),
      })
    );
    expect(result).toEqual({ synced: 0, failed: 0, cleaned: 0, conflicts: [] });
  });
});
