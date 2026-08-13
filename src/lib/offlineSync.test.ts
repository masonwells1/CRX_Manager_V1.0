import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingAction } from './offlineQueue';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockCaptureException = vi.fn();
const mockExecuteDurable = vi.fn();
vi.mock('./sentry', () => ({
  Sentry: { captureException: (...args: unknown[]) => mockCaptureException(...args) },
}));
vi.mock('./db', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
  assertRpcResult: <T,>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data as T;
  },
}));

const mockGetPendingActions = vi.fn();
const mockRemoveAction = vi.fn().mockResolvedValue(undefined);
const mockUpdateAction = vi.fn().mockResolvedValue(undefined);
vi.mock('./offlineQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./offlineQueue')>();
  return {
    ...actual,
    getPendingActions: () => mockGetPendingActions(),
    removeAction: (id: number) => mockRemoveAction(id),
    updateAction: (action: unknown) => mockUpdateAction(action),
  };
});

vi.mock('./offlineReceipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./offlineReceipts')>();
  return {
    ...actual,
    executeDurableOfflineAction: (action: PendingAction) => mockExecuteDurable(action),
  };
});

import { MAX_RETRIES, syncPendingActions } from './offlineSync';
import { OfflineReceiptSyncError } from './offlineReceipts';

const EMPTY_RESULT = {
  synced: 0,
  failed: 0,
  deferred: 0,
  skippedOtherUser: 0,
  needsAttention: 0,
  conflicts: [],
};

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 1,
    operation: 'complete_delivery',
    params: {
      p_delivery_id: 'd-1',
      p_signed_by: 'Driver',
      p_performed_by: 'user-1',
      p_idempotency_key: 'complete_delivery:user-1:test-key',
    },
    entityId: 'd-1',
    entityTable: 'deliveries',
    snapshotAt: '2026-07-13T12:00:00.000Z',
    receiptOrigin: 'native',
    clientActionId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'complete_delivery:user-1:test-key',
    schemaVersion: 1,
    createdAt: '2026-07-13T12:00:00.000Z',
    retryCount: 0,
    ownerUserId: 'user-1',
    status: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockCaptureException.mockReset();
  mockExecuteDurable.mockReset();
  mockGetPendingActions.mockReset();
  mockRemoveAction.mockReset().mockResolvedValue(undefined);
  mockUpdateAction.mockReset().mockResolvedValue(undefined);
  mockExecuteDurable.mockImplementation(async (action: PendingAction) => {
    const response = await mockRpc(action.operation, action.params);
    if (response.error) throw response.error;
    if (response.data === null || response.data === undefined) {
      throw new Error(`${action.operation} returned no data — operation may have been denied`);
    }
    return response.data;
  });
});

describe('syncPendingActions', () => {
  it('returns an empty result when the queue is empty', async () => {
    mockGetPendingActions.mockResolvedValue([]);
    await expect(syncPendingActions('user-1')).resolves.toEqual(EMPTY_RESULT);
  });

  it('syncs and removes a current-user action after a successful RPC', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction()]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions('user-1');

    expect(mockRpc).toHaveBeenCalledWith('complete_delivery', {
      p_delivery_id: 'd-1',
      p_signed_by: 'Driver',
      p_performed_by: 'user-1',
      p_idempotency_key: 'complete_delivery:user-1:test-key',
    });
    expect(mockRemoveAction).toHaveBeenCalledWith(1);
    expect(result).toEqual({ ...EMPTY_RESULT, synced: 1 });
  });

  it('retains a failed action and schedules a delayed retry', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction()]);
    mockRpc.mockResolvedValue({ error: { message: 'network timeout' } });

    const result = await syncPendingActions('user-1');

    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      retryCount: 1,
      status: 'retry_wait',
      nextAttemptAt: expect.any(String),
      lastAttemptAt: expect.any(String),
      lastError: 'network timeout',
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1 });
  });

  it('retains an action as needs attention after the retry limit', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction({ retryCount: MAX_RETRIES - 1 })]);
    mockRpc.mockResolvedValue({ error: { message: 'still failing' } });

    const result = await syncPendingActions('user-1');

    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: MAX_RETRIES,
      status: 'needs_attention',
      nextAttemptAt: undefined,
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('persists the 10-minute retry before the final attempt limit', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction({ retryCount: MAX_RETRIES - 2 })]);
    mockRpc.mockResolvedValue({ error: { message: 'still offline' } });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: MAX_RETRIES - 1,
      status: 'retry_wait',
      nextAttemptAt: expect.any(String),
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1 });
  });

  it('does not execute or age another user\'s action', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ ownerUserId: 'user-2', params: { p_performed_by: 'user-2' }, retryCount: 2 }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdateAction).not.toHaveBeenCalled();
    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(result).toEqual({ ...EMPTY_RESULT, skippedOtherUser: 1 });
  });

  it('infers and persists a legacy owner before replay', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction({ ownerUserId: undefined })]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user-1' }));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRemoveAction).toHaveBeenCalledWith(1);
    expect(result).toEqual({ ...EMPTY_RESULT, synced: 1 });
  });

  it('quarantines ownerless legacy work without consuming a retry', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ ownerUserId: undefined, params: { p_delivery_id: 'd-1' } }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 0,
      status: 'needs_attention',
      lastError: 'Offline action owner could not be determined',
    }));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'owner_unknown' }) })
    );
    expect(result).toEqual({ ...EMPTY_RESULT, needsAttention: 1 });
  });

  it('quarantines one malformed legacy receipt without stopping the remaining queue', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({
        clientActionId: undefined,
        idempotencyKey: undefined,
        schemaVersion: undefined,
        params: {
          p_delivery_id: 'd-legacy',
          p_signed_by: 'Driver',
          p_performed_by: 'user-1',
        },
      }),
      makeAction({ id: 2, clientActionId: '22222222-2222-4222-8222-222222222222' }),
    ]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      retryCount: 0,
      status: 'needs_attention',
      lastError: expect.stringContaining('Durable offline actions require an idempotency key'),
    }));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'legacy_receipt_identity_missing' }),
      })
    );
    expect(mockRemoveAction).toHaveBeenCalledWith(2);
    expect(result).toEqual({ ...EMPTY_RESULT, synced: 1, needsAttention: 1 });
  });

  it('keeps pre-receipt work without a queue-time snapshot in office review', async () => {
    const legacy = makeAction({
      clientActionId: undefined,
      idempotencyKey: undefined,
      schemaVersion: undefined,
      receiptOrigin: undefined,
      snapshotAt: undefined,
      entityTable: undefined,
    });
    mockGetPendingActions.mockResolvedValue([legacy]);
    mockExecuteDurable.mockRejectedValue(new OfflineReceiptSyncError(
      'The server kept this action for office review.',
      'needs_attention',
    ));

    const result = await syncPendingActions('user-1');

    expect(mockExecuteDurable).toHaveBeenCalledWith(expect.objectContaining({
      receiptOrigin: 'legacy',
      snapshotAt: undefined,
      entityTable: undefined,
    }));
    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('keeps a native field completion without a queue-time snapshot in office review', async () => {
    const nativeFieldAction = makeAction({
      operation: 'complete_job',
      entityId: 'job-1',
      entityTable: 'jobs',
      receiptOrigin: 'native',
      snapshotAt: undefined,
      params: {
        p_job_id: 'job-1',
        p_performed_by: 'user-1',
        p_idempotency_key: 'complete_job:user-1:test-key',
      },
    });
    mockGetPendingActions.mockResolvedValue([nativeFieldAction]);
    mockExecuteDurable.mockRejectedValue(new OfflineReceiptSyncError(
      'The server kept this action for office review.',
      'needs_attention',
    ));

    const result = await syncPendingActions('user-1');

    expect(mockExecuteDurable).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'complete_job',
      receiptOrigin: 'native',
      snapshotAt: undefined,
      entityTable: 'jobs',
    }));
    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('stages a permanent office-visible receipt when the target cannot be read', async () => {
    const unreadableTarget = makeAction({ snapshotAt: undefined });
    mockGetPendingActions.mockResolvedValue([unreadableTarget]);
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    });
    mockExecuteDurable.mockRejectedValue(new OfflineReceiptSyncError(
      'The server kept this action for office review.',
      'needs_attention',
    ));

    const result = await syncPendingActions('user-1');

    expect(mockExecuteDurable).toHaveBeenCalledWith(expect.objectContaining({
      clientActionId: unreadableTarget.clientActionId,
      snapshotAt: undefined,
    }));
    expect(mockUpdateAction).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'needs_attention',
      lastError: 'The server kept this action for office review.',
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('quarantines and reports an actor that differs from the saved owner', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ params: { p_delivery_id: 'd-1', p_performed_by: 'different-user' } }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      status: 'needs_attention',
      lastError: 'Offline action actor does not match its saved owner',
    }));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'actor_owner_mismatch' }) })
    );
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('quarantines a legacy operation that is not approved for owner inference', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({
        operation: 'allocate_payment',
        ownerUserId: undefined,
        params: { p_performed_by: 'user-1' },
      }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      status: 'needs_attention',
      retryCount: 0,
      lastError: 'Offline action owner could not be determined',
    }));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'owner_unknown' }) })
    );
    expect(result).toEqual({ ...EMPTY_RESULT, needsAttention: 1 });
  });

  it('defers an action until nextAttemptAt without calling the RPC', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ status: 'retry_wait', nextAttemptAt: '2999-01-01T00:00:00.000Z' }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdateAction).not.toHaveBeenCalled();
    expect(result).toEqual({ ...EMPTY_RESULT, deferred: 1 });
  });

  it('does not auto-retry an action already marked needs attention', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ retryCount: MAX_RETRIES, status: 'needs_attention' }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(result).toEqual({ ...EMPTY_RESULT, needsAttention: 1 });
  });

  it('allows a manual retry of an action that needs attention', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ retryCount: MAX_RETRIES, status: 'needs_attention' }),
    ]);
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncPendingActions('user-1', { force: true });

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRemoveAction).toHaveBeenCalledWith(1);
    expect(result).toEqual({ ...EMPTY_RESULT, synced: 1 });
  });

  it('retains a conflict as needs attention without calling the business RPC', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({
        operation: 'cancel_delivery',
        entityTable: 'deliveries',
        entityId: 'd-1',
        snapshotAt: '2026-07-13T12:00:00.000Z',
      }),
    ]);
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { updated_at: '2026-07-13T12:05:00.000Z' },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    mockFrom.mockReturnValue({ select });

    const result = await syncPendingActions('user-1');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: MAX_RETRIES,
      status: 'needs_attention',
      nextAttemptAt: undefined,
      lastError: expect.stringContaining('Conflict:'),
    }));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'conflict' }) })
    );
    expect(result).toEqual(expect.objectContaining({
      failed: 1,
      needsAttention: 1,
      conflicts: [expect.stringContaining('Conflict:')],
    }));
  });

  it('consults the permanent receipt before a durable action even when its local snapshot is stale', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({
        entityTable: 'deliveries',
        entityId: 'd-1',
        snapshotAt: '2026-07-13T12:00:00.000Z',
      }),
    ]);
    mockRpc.mockResolvedValue({ data: { status: 'succeeded' }, error: null });

    const result = await syncPendingActions('user-1');

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockExecuteDurable).toHaveBeenCalledTimes(1);
    expect(mockRemoveAction).toHaveBeenCalledWith(1);
    expect(result).toEqual({ ...EMPTY_RESULT, synced: 1 });
  });

  it('shares one in-flight replay promise within a browser tab', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction()]);
    let resolveRpc: (value: unknown) => void = () => {};
    mockRpc.mockReturnValue(new Promise((resolve) => { resolveRpc = resolve; }));

    const first = syncPendingActions('user-1');
    const second = syncPendingActions('user-1');

    expect(second).toBe(first);
    resolveRpc({ data: { success: true }, error: null });
    await expect(first).resolves.toEqual({ ...EMPTY_RESULT, synced: 1 });
    expect(mockGetPendingActions).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('queues a different user behind the active replay instead of sharing its result', async () => {
    mockGetPendingActions
      .mockResolvedValueOnce([makeAction({ ownerUserId: 'user-1' })])
      .mockResolvedValueOnce([
        makeAction({
          id: 2,
          ownerUserId: 'user-2',
          params: { p_delivery_id: 'd-2', p_performed_by: 'user-2' },
        }),
      ]);
    let resolveFirstRpc: (value: unknown) => void = () => {};
    mockRpc
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstRpc = resolve; }))
      .mockResolvedValueOnce({ data: { success: true }, error: null });

    const first = syncPendingActions('user-1');
    const second = syncPendingActions('user-2');

    expect(second).not.toBe(first);
    resolveFirstRpc({ data: { success: true }, error: null });
    await expect(first).resolves.toEqual({ ...EMPTY_RESULT, synced: 1 });
    await expect(second).resolves.toEqual({ ...EMPTY_RESULT, synced: 1 });
    expect(mockGetPendingActions).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('still starts a queued replay after the active replay rejects', async () => {
    let rejectFirstRead: (reason?: unknown) => void = () => {};
    mockGetPendingActions
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirstRead = reject; }))
      .mockResolvedValueOnce([]);

    const first = syncPendingActions('user-1');
    const second = syncPendingActions('user-2');

    rejectFirstRead(new Error('IndexedDB unavailable'));
    await expect(first).rejects.toThrow('IndexedDB unavailable');
    await expect(second).resolves.toEqual(EMPTY_RESULT);
    expect(mockGetPendingActions).toHaveBeenCalledTimes(2);
  });

  it('queues a forced same-user replay behind a non-forced active replay', async () => {
    mockGetPendingActions
      .mockResolvedValueOnce([makeAction()])
      .mockResolvedValueOnce([]);
    let resolveFirstRpc: (value: unknown) => void = () => {};
    mockRpc.mockReturnValueOnce(new Promise((resolve) => { resolveFirstRpc = resolve; }));

    const first = syncPendingActions('user-1');
    const forced = syncPendingActions('user-1', { force: true });

    expect(forced).not.toBe(first);
    resolveFirstRpc({ data: { success: true }, error: null });
    await expect(first).resolves.toEqual({ ...EMPTY_RESULT, synced: 1 });
    await expect(forced).resolves.toEqual(EMPTY_RESULT);
    expect(mockGetPendingActions).toHaveBeenCalledTimes(2);
  });

  it('does not consume a retry when the authenticated session changes during replay', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction({ retryCount: 1 })]);
    mockRpc.mockResolvedValue({
      error: { message: 'p_performed_by does not match authenticated user' },
    });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 1,
      status: 'retry_wait',
      nextAttemptAt: expect.any(String),
      sessionMismatchCount: 1,
      lastError: 'Sync session changed before this action could finish',
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, deferred: 1 });
  });

  it('treats the canonical ACTOR_MISMATCH token as a deferred session mismatch', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction({ retryCount: 1 })]);
    mockRpc.mockResolvedValue({ error: { message: 'ACTOR_MISMATCH' } });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 1,
      status: 'retry_wait',
      sessionMismatchCount: 1,
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, deferred: 1 });
  });

  it('treats an expired unauthenticated session as a deferred session mismatch', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction({ retryCount: 1 })]);
    mockRpc.mockResolvedValue({ error: { message: 'Not authenticated' } });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 1,
      status: 'retry_wait',
      sessionMismatchCount: 1,
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, deferred: 1 });
  });

  it('caps repeated authenticated-session mismatch deferrals as needs attention', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ retryCount: 1, sessionMismatchCount: 2 }),
    ]);
    mockRpc.mockResolvedValue({
      error: { message: 'p_performed_by does not match authenticated user' },
    });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 1,
      status: 'needs_attention',
      nextAttemptAt: undefined,
      sessionMismatchCount: 3,
      lastError: 'Sync session could not be verified after repeated attempts',
    }));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'session_mismatch_limit' }) })
    );
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('quarantines unknown operations instead of deleting them', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ operation: 'unknown_op', entityTable: undefined, snapshotAt: undefined }),
    ]);

    const result = await syncPendingActions('user-1');

    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 1,
      status: 'needs_attention',
      lastError: expect.stringContaining('Unknown offline operation'),
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1, needsAttention: 1 });
  });

  it('continues processing remaining actions when one fails', async () => {
    mockGetPendingActions.mockResolvedValue([
      makeAction({ id: 20 }),
      makeAction({
        id: 21,
        operation: 'allocate_payment',
        params: { p_performed_by: 'user-1' },
        entityTable: undefined,
        snapshotAt: undefined,
      }),
    ]);
    mockRpc
      .mockResolvedValueOnce({ error: { message: 'temporary failure' } })
      .mockResolvedValueOnce({ data: { success: true }, error: null });

    const result = await syncPendingActions('user-1');

    expect(mockUpdateAction).toHaveBeenCalledTimes(1);
    expect(mockRemoveAction).toHaveBeenCalledWith(21);
    expect(result).toEqual({ ...EMPTY_RESULT, synced: 1, failed: 1 });
  });

  it('retains an action when an RPC returns null data with no error', async () => {
    mockGetPendingActions.mockResolvedValue([makeAction()]);
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await syncPendingActions('user-1');

    expect(mockRemoveAction).not.toHaveBeenCalled();
    expect(mockUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      retryCount: 1,
      status: 'retry_wait',
      lastError: expect.stringContaining('returned no data'),
    }));
    expect(result).toEqual({ ...EMPTY_RESULT, failed: 1 });
  });
});
