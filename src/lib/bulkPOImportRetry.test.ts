import { describe, expect, it, vi } from 'vitest';
import {
  clearPendingBulkPOIntent,
  ensurePendingBulkPOIntent,
  loadPendingBulkPOIntents,
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
  it('reuses the same idempotency key and PO number after close/reopen or a lost response', () => {
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

    clearPendingBulkPOIntent(reopened, 'intent-A');
    savePendingBulkPOIntents(storage, 'sales-1', reopened);
    const laterImport = ensurePendingBulkPOIntent(reopened, 'intent-A', createKey, 3_000);
    expect(laterImport.idempotencyKey).toBe('idem-second');
  });

  it('expires abandoned pending imports after 24 hours', () => {
    const storage = fakeStorage();
    const pending = {};
    ensurePendingBulkPOIntent(pending, 'intent-A', () => 'idem-old', 1_000);
    savePendingBulkPOIntents(storage, 'sales-1', pending);

    expect(loadPendingBulkPOIntents(storage, 'sales-1', 24 * 60 * 60 * 1000 + 1_001)).toEqual({});
  });
});
