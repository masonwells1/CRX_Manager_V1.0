/**
 * offlineQueue.test.ts — Tests for IndexedDB-based offline action queue
 * Mocks IndexedDB at the global level using fake-indexeddb
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

import {
  queueAction,
  getPendingActions,
  removeAction,
  updateAction,
  getPendingCount,
  getFailedActions,
  getActionOwnerUserId,
  getQueueSummary,
  OFFLINE_MAX_RETRIES,
  type PendingAction,
} from './offlineQueue';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<Omit<PendingAction, 'id'>> = {}): Omit<PendingAction, 'id'> {
  return {
    operation: 'complete_delivery',
    params: { p_delivery_id: 'del-001', p_signed_by: 'John Smith', p_performed_by: 'user-1' },
    createdAt: new Date().toISOString(),
    retryCount: 0,
    ownerUserId: 'user-1',
    status: 'pending',
    ...overrides,
  };
}

/** Give each test a fresh IndexedDB instance */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// ── queueAction ──────────────────────────────────────────────────────────

describe('queueAction', () => {
  it('does not resolve until the IndexedDB transaction completes', async () => {
    let signalRequestSuccess: () => void = () => {};
    const requestSucceeded = new Promise<void>((resolve) => { signalRequestSuccess = resolve; });
    const originalAdd = IDBObjectStore.prototype.add;
    const addSpy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
      request.addEventListener('success', signalRequestSuccess);
      return request;
    });
    let settled = false;

    try {
      const pendingWrite = queueAction(makeAction()).finally(() => { settled = true; });
      await requestSucceeded;
      await Promise.resolve();
      expect(settled).toBe(false);
      await pendingWrite;
      expect(settled).toBe(true);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('rejects when the IndexedDB transaction aborts after request success', async () => {
    const originalAdd = IDBObjectStore.prototype.add;
    const addSpy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
      request.addEventListener('success', () => request.transaction?.abort());
      return request;
    });

    try {
      await expect(queueAction(makeAction())).rejects.toBeInstanceOf(Error);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('stores an action and returns a numeric ID', async () => {
    const id = await queueAction(makeAction());
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('auto-increments IDs for subsequent actions', async () => {
    const id1 = await queueAction(makeAction());
    const id2 = await queueAction(makeAction({ operation: 'submit_return' }));
    expect(id2).toBeGreaterThan(id1);
  });

  it('stores operation and params correctly', async () => {
    await queueAction(makeAction({ operation: 'submit_return', params: { return_id: 'r-1' } }));
    const actions = await getPendingActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe('submit_return');
    expect(actions[0].params).toEqual({ return_id: 'r-1' });
  });

  it('stores createdAt timestamp', async () => {
    const now = new Date().toISOString();
    await queueAction(makeAction({ createdAt: now }));
    const actions = await getPendingActions();
    expect(actions[0].createdAt).toBe(now);
  });

  it('stores retryCount as 0 for new actions', async () => {
    await queueAction(makeAction());
    const actions = await getPendingActions();
    expect(actions[0].retryCount).toBe(0);
  });
});

// ── getPendingActions ────────────────────────────────────────────────────

describe('getPendingActions', () => {
  it('returns empty array when queue is empty', async () => {
    const actions = await getPendingActions();
    expect(actions).toEqual([]);
  });

  it('returns all queued actions', async () => {
    await queueAction(makeAction({ operation: 'op1' }));
    await queueAction(makeAction({ operation: 'op2' }));
    await queueAction(makeAction({ operation: 'op3' }));
    const actions = await getPendingActions();
    expect(actions).toHaveLength(3);
  });

  it('returns actions with auto-assigned id field', async () => {
    await queueAction(makeAction());
    const actions = await getPendingActions();
    expect(actions[0].id).toBeDefined();
    expect(typeof actions[0].id).toBe('number');
  });
});

// ── getPendingCount ──────────────────────────────────────────────────────

describe('getPendingCount', () => {
  it('returns 0 for empty queue', async () => {
    const count = await getPendingCount();
    expect(count).toBe(0);
  });

  it('returns correct count after adding actions', async () => {
    await queueAction(makeAction());
    await queueAction(makeAction());
    const count = await getPendingCount();
    expect(count).toBe(2);
  });

  it('returns correct count after removing actions', async () => {
    const id = await queueAction(makeAction());
    await queueAction(makeAction());
    await removeAction(id);
    const count = await getPendingCount();
    expect(count).toBe(1);
  });
});

// ── removeAction ─────────────────────────────────────────────────────────

describe('removeAction', () => {
  it('does not resolve until the delete transaction completes', async () => {
    const id = await queueAction(makeAction());
    let signalRequestSuccess: () => void = () => {};
    const requestSucceeded = new Promise<void>((resolve) => { signalRequestSuccess = resolve; });
    const originalDelete = IDBObjectStore.prototype.delete;
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, query) {
      const request = originalDelete.call(this, query);
      request.addEventListener('success', signalRequestSuccess);
      return request;
    });
    let settled = false;

    try {
      const pendingDelete = removeAction(id).finally(() => { settled = true; });
      await requestSucceeded;
      await Promise.resolve();
      expect(settled).toBe(false);
      await pendingDelete;
      expect(settled).toBe(true);
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('removes an action by ID', async () => {
    const id = await queueAction(makeAction());
    await removeAction(id);
    const actions = await getPendingActions();
    expect(actions).toHaveLength(0);
  });

  it('removes only the specified action', async () => {
    const id1 = await queueAction(makeAction({ operation: 'op1' }));
    await queueAction(makeAction({ operation: 'op2' }));
    await removeAction(id1);
    const actions = await getPendingActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].operation).toBe('op2');
  });

  it('does not throw for non-existent ID', async () => {
    await expect(removeAction(9999)).resolves.toBeUndefined();
  });
});

// ── updateAction ─────────────────────────────────────────────────────────

describe('updateAction', () => {
  it('does not resolve until the update transaction completes', async () => {
    await queueAction(makeAction());
    const [action] = await getPendingActions();
    let signalRequestSuccess: () => void = () => {};
    const requestSucceeded = new Promise<void>((resolve) => { signalRequestSuccess = resolve; });
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
      request.addEventListener('success', signalRequestSuccess);
      return request;
    });
    let settled = false;

    try {
      const pendingUpdate = updateAction({ ...action, retryCount: 1 }).finally(() => { settled = true; });
      await requestSucceeded;
      await Promise.resolve();
      expect(settled).toBe(false);
      await pendingUpdate;
      expect(settled).toBe(true);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('updates retryCount', async () => {
    await queueAction(makeAction());
    const actions = await getPendingActions();
    await updateAction({ ...actions[0], retryCount: 2 });
    const updated = await getPendingActions();
    expect(updated[0].retryCount).toBe(2);
  });

  it('updates lastError', async () => {
    await queueAction(makeAction());
    const actions = await getPendingActions();
    await updateAction({ ...actions[0], lastError: 'Network timeout' });
    const updated = await getPendingActions();
    expect(updated[0].lastError).toBe('Network timeout');
  });

  it('preserves other fields when updating', async () => {
    await queueAction(makeAction({ operation: 'complete_delivery', params: { id: 'd-1' } }));
    const actions = await getPendingActions();
    await updateAction({ ...actions[0], retryCount: 3 });
    const updated = await getPendingActions();
    expect(updated[0].operation).toBe('complete_delivery');
    expect(updated[0].params).toEqual({ id: 'd-1' });
  });

  it('does not change the total count', async () => {
    await queueAction(makeAction());
    await queueAction(makeAction());
    const actions = await getPendingActions();
    await updateAction({ ...actions[0], retryCount: 5 });
    const count = await getPendingCount();
    expect(count).toBe(2);
  });
});

// ── retention and ownership ──────────────────────────────────────────────

describe('retention and ownership', () => {
  it('retains actions that exceeded the retry limit', async () => {
    await queueAction(makeAction({ retryCount: 5, status: 'needs_attention' }));
    const failed = await getFailedActions(3);
    expect(failed).toHaveLength(1);
    expect(await getPendingCount()).toBe(1);
  });

  it('retains actions older than seven days', async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await queueAction(makeAction({ createdAt: oldDate }));
    expect(await getPendingActions()).toHaveLength(1);
  });

  it('infers the owner of a legacy action from p_performed_by', () => {
    const legacy = makeAction({ ownerUserId: undefined });
    expect(getActionOwnerUserId(legacy)).toBe('user-1');
  });

  it('does not assign an owner when a legacy action has no p_performed_by', () => {
    const legacy = makeAction({ ownerUserId: undefined, params: { p_delivery_id: 'del-001' } });
    expect(getActionOwnerUserId(legacy)).toBeNull();
  });

  it('does not infer a legacy owner for an unapproved offline operation', () => {
    const legacy = makeAction({
      operation: 'allocate_payment',
      ownerUserId: undefined,
      params: { p_performed_by: 'user-1' },
    });
    expect(getActionOwnerUserId(legacy)).toBeNull();
  });

  it('summarizes current-user, other-user, and ownerless actions separately', async () => {
    await queueAction(makeAction());
    await queueAction(makeAction({ ownerUserId: 'user-2', params: { p_performed_by: 'user-2' } }));
    await queueAction(makeAction({ ownerUserId: undefined, params: { p_delivery_id: 'legacy' } }));
    await queueAction(makeAction({ retryCount: 3, status: 'needs_attention' }));

    const summary = await getQueueSummary('user-1');
    expect(summary).toEqual({
      ownedTotal: 2,
      ownedAutoSyncable: 1,
      ownedNeedsAttention: 1,
      otherUserTotal: 1,
      ownerUnknownTotal: 1,
      nextAutoSyncAt: null,
    });
  });

  it('returns the earliest scheduled retry for the current user', async () => {
    await queueAction(makeAction({ status: 'retry_wait', nextAttemptAt: '2026-07-13T12:10:00.000Z' }));
    await queueAction(makeAction({ status: 'retry_wait', nextAttemptAt: '2026-07-13T12:05:00.000Z' }));

    const summary = await getQueueSummary('user-1');
    expect(summary.nextAutoSyncAt).toBe('2026-07-13T12:05:00.000Z');
  });
});

// ── getFailedActions ─────────────────────────────────────────────────────

describe('getFailedActions', () => {
  it('returns only actions with retryCount >= maxRetries', async () => {
    await queueAction(makeAction({ retryCount: 5, operation: 'failed_op' }));
    await queueAction(makeAction({ retryCount: 0, operation: 'pending_op' }));
    const failed = await getFailedActions(3);
    expect(failed).toHaveLength(1);
    expect(failed[0].operation).toBe('failed_op');
  });

  it('returns empty array when no failed actions', async () => {
    await queueAction(makeAction({ retryCount: 1 }));
    const failed = await getFailedActions(3);
    expect(failed).toEqual([]);
  });

  it('uses the shared default retry limit', async () => {
    await queueAction(makeAction({ retryCount: OFFLINE_MAX_RETRIES }));
    await queueAction(makeAction({ retryCount: OFFLINE_MAX_RETRIES - 1 }));
    const failed = await getFailedActions();
    expect(failed).toHaveLength(1);
  });

  it('includes lastError from failed actions', async () => {
    await queueAction(makeAction({ retryCount: 0 }));
    const actions = await getPendingActions();
    await updateAction({ ...actions[0], retryCount: 5, lastError: 'Server 500' });
    const failed = await getFailedActions(3);
    expect(failed[0].lastError).toBe('Server 500');
  });
});
