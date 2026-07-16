import { describe, expect, it, vi } from 'vitest';
import {
  ensurePendingBulkPOIntent,
  isImportedBulkPOIntent,
  loadPendingBulkPOIntents,
  markBulkPOIntentImported,
  savePendingBulkPOIntents,
} from './bulkPOImportRetry';

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('bulk PO import retry state', () => {
  it('reuses pending work and persists successful imports across close/reopen', () => {
    const storage = fakeStorage();
    const createKey = vi.fn()
      .mockReturnValueOnce('idem-first')
      .mockReturnValueOnce('idem-second');
    const pending = {};

    const first = ensurePendingBulkPOIntent(pending, 'intent-A', createKey, 1_000);
    first.poNumber = 'PO-1001';
    savePendingBulkPOIntents(storage, 'sales-1', pending);

    const reopened = loadPendingBulkPOIntents(storage, 'sales-1', 2_000);
    const retry = ensurePendingBulkPOIntent(reopened, 'intent-A', createKey, 2_000);

    expect(retry).toMatchObject({ idempotencyKey: 'idem-first', poNumber: 'PO-1001' });
    expect(createKey).toHaveBeenCalledTimes(1);

    markBulkPOIntentImported(reopened, 'intent-A', 'po-id-1001', 3_000);
    savePendingBulkPOIntents(storage, 'sales-1', reopened);

    const afterSuccessReopen = loadPendingBulkPOIntents(storage, 'sales-1', 4_000);
    expect(isImportedBulkPOIntent(afterSuccessReopen, 'intent-A')).toBe(true);
    expect(afterSuccessReopen['intent-A']).toMatchObject({
      idempotencyKey: 'idem-first',
      poNumber: 'PO-1001',
      poId: 'po-id-1001',
      status: 'imported',
    });
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('expires abandoned pending imports after 24 hours', () => {
    const storage = fakeStorage();
    const pending = {};
    ensurePendingBulkPOIntent(pending, 'intent-A', () => 'idem-old', 1_000);
    savePendingBulkPOIntents(storage, 'sales-1', pending);

    expect(loadPendingBulkPOIntents(storage, 'sales-1', 24 * 60 * 60 * 1000 + 1_001)).toEqual({});
  });
});
