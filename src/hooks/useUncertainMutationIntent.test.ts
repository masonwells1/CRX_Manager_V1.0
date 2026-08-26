import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { useUncertainMutationIntent } from './useUncertainMutationIntent';

describe('useUncertainMutationIntent', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
  });

  it('keeps the first payload frozen until an exact retry succeeds', async () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());

    let first!: { amount: number };
    await act(async () => {
      first = await result.current.beginIntent({ amount: 100 });
    });
    expect(first).toEqual({ amount: 100 });
    expect(result.current.isIntentLocked).toBe(true);

    let retry!: { amount: number };
    await act(async () => {
      retry = await result.current.beginIntent({ amount: 200 });
    });
    expect(retry).toEqual({ amount: 100 });

    await act(async () => result.current.resolveIntent());
    expect(result.current.isIntentLocked).toBe(false);
  });

  it('unlocks only when the server proves the request was rejected', async () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());
    await act(async () => result.current.beginIntent({ amount: 100 }));

    await act(async () => {
      expect(await result.current.classifyFailure({ code: '23514', message: 'validation failed' }))
        .toBe('definitive');
    });
    expect(result.current.isIntentLocked).toBe(false);
  });

  it('keeps transport failures locked because commit status is unknown', async () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());
    await act(async () => result.current.beginIntent({ amount: 100 }));

    await act(async () => {
      expect(await result.current.classifyFailure({ code: 'ETIMEDOUT', message: 'socket timeout' }))
        .toBe('uncertain');
    });
    expect(result.current.unresolvedIntent).toEqual({ amount: 100 });
  });

  it('keeps an intent mismatch locked until the caller reconciles the receipt', async () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());
    await act(async () => result.current.beginIntent({ amount: 100 }));

    await act(async () => {
      expect(await result.current.classifyFailure({ code: '22023', message: 'IDEMPOTENCY_INTENT_MISMATCH' }))
        .toBe('uncertain');
    });
    expect(result.current.unresolvedIntent).toEqual({ amount: 100 });
  });

  it('does not depend on Error instances for Supabase failures', async () => {
    const errorSpy = vi.fn();
    const plainObject = { code: '08007', message: 'transaction resolution unknown' };
    const { result } = renderHook(() => useUncertainMutationIntent<{ id: string }>());
    await act(async () => result.current.beginIntent({ id: 'one' }));
    await act(async () => errorSpy(await result.current.classifyFailure(plainObject)));
    expect(errorSpy).toHaveBeenCalledWith('uncertain');
    expect(result.current.isIntentLocked).toBe(true);
  });

  it('restores the exact payload and matching key after unmount or reload', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-1',
      surface: 'vendor-bill-detail',
      scope: 'bill-7',
    };
    const first = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    await act(async () => {
      await first.result.current.beginIntent({ amount: 12345 });
    });
    const originalKey = first.result.current.getIdempotencyKey();
    first.unmount();

    const restored = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    expect(restored.result.current.isIntentLocked).toBe(true);
    expect(restored.result.current.unresolvedIntent).toEqual({ amount: 12345 });
    expect(restored.result.current.getIdempotencyKey()).toBe(originalKey);

    await act(async () => restored.result.current.resolveIntent());
    restored.unmount();

    const cleared = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    expect(cleared.result.current.isIntentLocked).toBe(false);
  });

  it('retires the persisted payload and key after a definitive rejection', async () => {
    const options = {
      operation: 'create_vendor_bill',
      userId: 'admin-2',
      surface: 'new-vendor-bill',
    };
    const first = renderHook(() => useUncertainMutationIntent<{ bill: string }>(options));
    await act(async () => first.result.current.beginIntent({ bill: 'VB-9' }));

    await act(async () => {
      expect(await first.result.current.classifyFailure({ code: '23514', message: 'invalid bill' }))
        .toBe('definitive');
    });
    first.unmount();

    const restored = renderHook(() => useUncertainMutationIntent<{ bill: string }>(options));
    expect(restored.result.current.isIntentLocked).toBe(false);
  });

  it('fails closed before the caller can mutate when durable storage is unavailable', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>({
      operation: 'record_vendor_payment',
      userId: 'admin-3',
      surface: 'vendor-bill-detail',
      scope: 'bill-8',
    }));

    await expect(act(async () => result.current.beginIntent({ amount: 5000 })))
      .rejects.toThrow('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
    expect(result.current.isIntentLocked).toBe(false);
    setItem.mockRestore();
  });

  it('fails closed before mutation when transactional browser storage is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>({
      operation: 'record_vendor_payment',
      userId: 'admin-no-idb',
      surface: 'vendor-bill-detail',
      scope: 'bill-no-idb',
    }));

    await expect(act(async () => result.current.beginIntent({ amount: 5000 })))
      .rejects.toThrow('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
    expect(result.current.isIntentLocked).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it('switches route scope without deleting the unresolved record owned by the prior route', async () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) => useUncertainMutationIntent<{ billId: string }>({
        operation: 'record_vendor_payment',
        userId: 'admin-4',
        surface: 'vendor-bill-detail',
        scope,
      }),
      { initialProps: { scope: 'bill-a' } },
    );

    await act(async () => result.current.beginIntent({ billId: 'bill-a' }));
    const billAKey = result.current.getIdempotencyKey();

    act(() => rerender({ scope: 'bill-b' }));
    expect(result.current.unresolvedIntent).toBeNull();
    expect(() => result.current.getIdempotencyKey()).toThrow('DURABLE_MUTATION_INTENT_CONFLICT');

    act(() => rerender({ scope: 'bill-a' }));
    expect(result.current.unresolvedIntent).toEqual({ billId: 'bill-a' });
    expect(result.current.getIdempotencyKey()).toBe(billAKey);
  });

  it('keeps an expired request locked and refuses to return a mutating key', async () => {
    let nowMs = Date.parse('2026-08-26T12:00:00Z');
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-5',
      surface: 'vendor-bill-detail',
      scope: 'bill-expired',
    };
    const first = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    await act(async () => first.result.current.beginIntent({ amount: 9000 }));
    const originalKey = first.result.current.getIdempotencyKey();
    first.unmount();

    nowMs += 23 * 60 * 60 * 1000;
    const restored = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    expect(restored.result.current.isIntentLocked).toBe(true);
    expect(restored.result.current.isRetryExpired).toBe(true);
    expect(await restored.result.current.beginIntent({ amount: 1 })).toEqual({ amount: 9000 });
    expect(() => restored.result.current.getIdempotencyKey())
      .toThrow('DURABLE_MUTATION_INTENT_RETRY_EXPIRED');
    expect(await restored.result.current.classifyFailure(new Error('DURABLE_MUTATION_INTENT_RETRY_EXPIRED')))
      .toBe('uncertain');
    expect(window.localStorage.getItem(
      `crx:uncertain-mutation:v3:${JSON.stringify([
        options.operation,
        options.userId,
      ])}`,
    )).toContain(originalKey);
    restored.unmount();
    now.mockRestore();
  });

  it('fails closed for a legacy durable record that has no retry deadline', () => {
    const options = {
      operation: 'receive_po_items',
      userId: 'admin-6',
      surface: 'quick-receive',
    };
    const storageKey = `crx:uncertain-mutation:v1:${JSON.stringify([
      options.operation,
      options.userId,
      options.surface,
      '',
    ])}`;
    window.sessionStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      operation: options.operation,
      userId: options.userId,
      surface: options.surface,
      scope: '',
      idempotencyKey: 'receive_po_items:admin-6:legacy',
      intent: { item: 'frozen' },
    }));

    const restored = renderHook(() => useUncertainMutationIntent<{ item: string }>(options));
    expect(restored.result.current.unresolvedIntent).toEqual({ item: 'frozen' });
    expect(restored.result.current.isRetryExpired).toBe(true);
    expect(() => restored.result.current.getIdempotencyKey())
      .toThrow('DURABLE_MUTATION_INTENT_RETRY_EXPIRED');
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(window.localStorage.getItem(
      `crx:uncertain-mutation:v3:${JSON.stringify([
        options.operation,
        options.userId,
      ])}`,
    )).toContain('legacy');
  });

  it('survives tab or PWA closure because the unresolved record is in localStorage', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-pwa',
      surface: 'vendor-bill-detail',
      scope: 'bill-pwa',
      getIntentIdentity: (intent: { args: { bill: string; amount: number } }) => intent.args,
    };
    const first = renderHook(() => useUncertainMutationIntent(options));
    await act(async () => first.result.current.beginIntent({ args: { bill: 'bill-pwa', amount: 12_500 } }));
    const originalKey = first.result.current.getIdempotencyKey();

    window.sessionStorage.clear();
    first.unmount();

    const reopened = renderHook(() => useUncertainMutationIntent(options));
    expect(reopened.result.current.unresolvedIntent)
      .toEqual({ args: { bill: 'bill-pwa', amount: 12_500 } });
    expect(reopened.result.current.getIdempotencyKey()).toBe(originalKey);
  });

  it('recovers the original key from IndexedDB if the local UI mirror is missing', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-idb-recovery',
      surface: 'vendor-bill-detail',
      scope: 'bill-idb-recovery',
      getIntentIdentity: (intent: { amount: number }) => intent,
    };
    const first = renderHook(() => useUncertainMutationIntent(options));
    await act(async () => first.result.current.beginIntent({ amount: 17_500 }));
    const originalKey = first.result.current.getIdempotencyKey();
    first.unmount();
    window.localStorage.clear();

    const reopened = renderHook(() => useUncertainMutationIntent(options));
    expect(reopened.result.current.isIntentLocked).toBe(false);
    await act(async () => reopened.result.current.beginIntent({ amount: 17_500 }));
    expect(reopened.result.current.isIntentLocked).toBe(true);
    expect(reopened.result.current.getIdempotencyKey()).toBe(originalKey);
  });

  it('synchronizes an already-open second tab when localStorage changes', async () => {
    const options = {
      operation: 'create_vendor_bill',
      userId: 'admin-tabs',
      surface: 'new-vendor-bill',
      getIntentIdentity: (intent: { bill: string }) => intent,
    };
    const firstTab = renderHook(() => useUncertainMutationIntent(options));
    const secondTab = renderHook(() => useUncertainMutationIntent(options));
    expect(secondTab.result.current.isIntentLocked).toBe(false);

    await act(async () => firstTab.result.current.beginIntent({ bill: 'VB-TABS' }));
    const storageKey = `crx:uncertain-mutation:v3:${JSON.stringify([
      options.operation,
      options.userId,
    ])}`;
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: storageKey,
        newValue: window.localStorage.getItem(storageKey),
        storageArea: window.localStorage,
      }));
    });

    expect(secondTab.result.current.isIntentLocked).toBe(true);
    expect(secondTab.result.current.unresolvedIntent).toEqual({ bill: 'VB-TABS' });
    expect(secondTab.result.current.getIdempotencyKey())
      .toBe(firstTab.result.current.getIdempotencyKey());
  });

  it('allows only one atomic intent claim when two tabs submit concurrently', async () => {
    const firstTab = renderHook(() => useUncertainMutationIntent<{ bill: string }>({
      operation: 'create_vendor_bill',
      userId: 'admin-race',
      surface: 'new-vendor-bill',
      scope: 'tab-a',
    }));
    const secondTab = renderHook(() => useUncertainMutationIntent<{ bill: string }>({
      operation: 'create_vendor_bill',
      userId: 'admin-race',
      surface: 'new-vendor-bill',
      scope: 'tab-b',
    }));

    let outcomes!: PromiseSettledResult<{ bill: string }>[];
    await act(async () => {
      outcomes = await Promise.allSettled([
        firstTab.result.current.beginIntent({ bill: 'VB-A' }),
        secondTab.result.current.beginIntent({ bill: 'VB-B' }),
      ]);
    });

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'DURABLE_MUTATION_INTENT_CONFLICT' }),
    });
  });

  it('coordinates the same receiving payload across surfaces under the original key', async () => {
    type ReceivingIntent = {
      items: Array<{ po_item_id: string; quantity: number }>;
      performedBy: string;
      display: string;
    };
    const getIntentIdentity = (intent: ReceivingIntent) => ({
      p_items: intent.items,
      p_performed_by: intent.performedBy,
      p_allow_over_receive: false,
    });
    const inventory = renderHook(() => useUncertainMutationIntent<ReceivingIntent>({
      operation: 'receive_po_items',
      userId: 'admin-receiving',
      surface: 'inventory-page',
      getIntentIdentity,
    }));
    await act(async () => inventory.result.current.beginIntent({
      items: [{ po_item_id: 'poi-1', quantity: 12 }],
      performedBy: 'admin-receiving',
      display: 'Inventory context',
    }));
    const originalKey = inventory.result.current.getIdempotencyKey();

    const hub = renderHook(() => useUncertainMutationIntent<ReceivingIntent>({
      operation: 'receive_po_items',
      userId: 'admin-receiving',
      surface: 'receiving-hub',
      getIntentIdentity,
    }));
    expect(hub.result.current.isForeignIntentLocked).toBe(true);
    expect(hub.result.current.unresolvedIntent).toBeNull();

    await act(async () => hub.result.current.beginIntent({
      items: [{ po_item_id: 'poi-1', quantity: 12 }],
      performedBy: 'admin-receiving',
      display: 'Hub context',
    }));
    expect(hub.result.current.isForeignIntentLocked).toBe(false);
    expect(hub.result.current.getIdempotencyKey()).toBe(originalKey);
    expect(hub.result.current.unresolvedIntent?.display).toBe('Hub context');
  });

  it('blocks a different receiving payload from another surface before any RPC key exists', async () => {
    type ReceivingIntent = { items: Array<{ po_item_id: string; quantity: number }>; performedBy: string };
    const getIntentIdentity = (intent: ReceivingIntent) => ({
      p_items: intent.items,
      p_performed_by: intent.performedBy,
      p_allow_over_receive: false,
    });
    const first = renderHook(() => useUncertainMutationIntent<ReceivingIntent>({
      operation: 'receive_po_items',
      userId: 'admin-conflict',
      surface: 'quick-receive',
      getIntentIdentity,
    }));
    await act(async () => first.result.current.beginIntent({
      items: [{ po_item_id: 'poi-1', quantity: 12 }],
      performedBy: 'admin-conflict',
    }));

    const second = renderHook(() => useUncertainMutationIntent<ReceivingIntent>({
      operation: 'receive_po_items',
      userId: 'admin-conflict',
      surface: 'receiving-hub',
      getIntentIdentity,
    }));
    await expect(act(async () => second.result.current.beginIntent({
        items: [{ po_item_id: 'poi-1', quantity: 13 }],
        performedBy: 'admin-conflict',
      }))).rejects.toThrow('DURABLE_MUTATION_INTENT_CONFLICT');
    expect(second.result.current.isForeignIntentLocked).toBe(true);
    expect(() => second.result.current.getIdempotencyKey())
      .toThrow('DURABLE_MUTATION_INTENT_CONFLICT');
  });

  it('keeps malformed durable state locked for manual reconciliation', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-corrupt',
      surface: 'vendor-bill-detail',
      scope: 'bill-corrupt',
    };
    const storageKey = `crx:uncertain-mutation:v3:${JSON.stringify([
      options.operation,
      options.userId,
    ])}`;
    window.localStorage.setItem(storageKey, '{not-valid-json');

    const { result } = renderHook(() => useUncertainMutationIntent(options));
    expect(result.current.isIntentLocked).toBe(true);
    expect(result.current.isForeignIntentLocked).toBe(true);
    expect(result.current.isRetryExpired).toBe(true);
    await expect(act(async () => result.current.beginIntent({ amount: 1 })))
      .rejects.toThrow('DURABLE_MUTATION_INTENT_CONFLICT');
    expect(window.localStorage.getItem(storageKey)).toContain('admin-corrupt:blocked');
  });
});
