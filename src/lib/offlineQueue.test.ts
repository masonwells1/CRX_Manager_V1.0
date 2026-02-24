/**
 * offlineQueue.test.ts — Tests for IndexedDB-based offline action queue
 * Mocks IndexedDB at the global level using fake-indexeddb
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  queueAction,
  getPendingActions,
  removeAction,
  updateAction,
  getPendingCount,
  clearFailedActions,
  clearStaleActions,
  getFailedActions,
  type PendingAction,
} from './offlineQueue';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<Omit<PendingAction, 'id'>> = {}): Omit<PendingAction, 'id'> {
  return {
    operation: 'complete_delivery',
    params: { delivery_id: 'del-001', signed_by: 'John Smith' },
    createdAt: new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  };
}

/** Give each test a fresh IndexedDB instance */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// ── queueAction ──────────────────────────────────────────────────────────

describe('queueAction', () => {
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

// ── clearFailedActions ───────────────────────────────────────────────────

describe('clearFailedActions', () => {
  it('removes actions with retryCount >= maxRetries', async () => {
    await queueAction(makeAction({ retryCount: 5 }));
    await queueAction(makeAction({ retryCount: 0 }));
    const cleared = await clearFailedActions(3);
    expect(cleared).toBe(1);
    const remaining = await getPendingActions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].retryCount).toBe(0);
  });

  it('returns 0 when no failed actions exist', async () => {
    await queueAction(makeAction({ retryCount: 1 }));
    const cleared = await clearFailedActions(3);
    expect(cleared).toBe(0);
  });

  it('uses default maxRetries of 3', async () => {
    await queueAction(makeAction({ retryCount: 3 }));
    await queueAction(makeAction({ retryCount: 2 }));
    const cleared = await clearFailedActions();
    expect(cleared).toBe(1);
  });

  it('clears all failed actions when all exceed maxRetries', async () => {
    await queueAction(makeAction({ retryCount: 5 }));
    await queueAction(makeAction({ retryCount: 10 }));
    const cleared = await clearFailedActions(3);
    expect(cleared).toBe(2);
    const count = await getPendingCount();
    expect(count).toBe(0);
  });
});

// ── clearStaleActions ────────────────────────────────────────────────────

describe('clearStaleActions', () => {
  it('removes actions older than maxAgeMs', async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    await queueAction(makeAction({ createdAt: oldDate }));
    await queueAction(makeAction()); // fresh
    const cleared = await clearStaleActions(7 * 24 * 60 * 60 * 1000); // 7 days
    expect(cleared).toBe(1);
    const remaining = await getPendingActions();
    expect(remaining).toHaveLength(1);
  });

  it('preserves recent actions', async () => {
    await queueAction(makeAction()); // just now
    const cleared = await clearStaleActions(7 * 24 * 60 * 60 * 1000);
    expect(cleared).toBe(0);
    const count = await getPendingCount();
    expect(count).toBe(1);
  });

  it('returns 0 when queue is empty', async () => {
    const cleared = await clearStaleActions();
    expect(cleared).toBe(0);
  });

  it('uses custom maxAgeMs', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await queueAction(makeAction({ createdAt: twoHoursAgo }));
    // 1 hour threshold — 2-hour-old action should be cleared
    const cleared = await clearStaleActions(1 * 60 * 60 * 1000);
    expect(cleared).toBe(1);
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

  it('uses default maxRetries of 3', async () => {
    await queueAction(makeAction({ retryCount: 3 }));
    await queueAction(makeAction({ retryCount: 2 }));
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
