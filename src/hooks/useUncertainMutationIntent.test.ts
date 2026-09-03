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

  it('keeps transport failures locked when durable reconciliation storage fails', async () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>({
      operation: 'record_vendor_payment',
      userId: 'admin-classify-read-failure',
      surface: 'vendor-bill-detail',
      scope: 'bill-classify-read-failure',
    }));
    await act(async () => result.current.beginIntent({ amount: 100 }));
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    await act(async () => {
      expect(await result.current.classifyFailure({ code: 'ETIMEDOUT', message: 'socket timeout' }))
        .toBe('uncertain');
    });
    expect(result.current.unresolvedIntent).toEqual({ amount: 100 });
    expect(result.current.isIntentLocked).toBe(true);
  });

  it('does not unlock a definitive rejection when durable claim release fails', async () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>({
      operation: 'record_vendor_payment',
      userId: 'admin-classify-delete-failure',
      surface: 'vendor-bill-detail',
      scope: 'bill-classify-delete-failure',
    }));
    await act(async () => result.current.beginIntent({ amount: 100 }));
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    await act(async () => {
      expect(await result.current.classifyFailure({ code: '23514', message: 'validation failed' }))
        .toBe('uncertain');
    });
    expect(result.current.unresolvedIntent).toEqual({ amount: 100 });
    expect(result.current.isIntentLocked).toBe(true);
  });

  it('reports a retained intent to the handler that is still running, not just to the next render', async () => {
    // Models NewVendorBill's PO-overage branch: one handler calls beginIntent(),
    // gets a definitive rejection, calls classifyFailure(), and must then decide
    // whether the pending record survived — all before React re-renders. Reading
    // the unresolvedIntent STATE field there returns the render-time value (null),
    // so the survivor is invisible and the confirmation retry silently drops its
    // p_confirm_po_overage fields. getUnresolvedIntent() reads the ref instead.
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>({
      operation: 'create_vendor_bill',
      userId: 'admin-same-tick-read',
      surface: 'new-vendor-bill',
      scope: 'bill-same-tick-read',
    }));

    // Captured at the render that STARTS the save, exactly like a component closure.
    const handler = result.current;
    expect(handler.unresolvedIntent).toBeNull();

    let staleStateRead: { amount: number } | null = null;
    let currentRefRead: { amount: number } | null = null;
    await act(async () => {
      await handler.beginIntent({ amount: 100 });
      // Break durable claim release so classifyFailure RETAINS the record, which
      // is the "another claimant still holds it" case the branch must detect.
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      await handler.classifyFailure({ code: '23514', message: 'validation failed' });
      staleStateRead = handler.unresolvedIntent;
      currentRefRead = handler.getUnresolvedIntent();
    });

    // The state field is stale inside the handler — this is the trap, asserted so
    // nobody "simplifies" the call site back to it.
    expect(staleStateRead).toBeNull();
    // The accessor sees the survivor immediately.
    expect(currentRefRead).toEqual({ amount: 100 });
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
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'storage-test-tab');
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
      `crx:uncertain-mutation:v4:${JSON.stringify([
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
      `crx:uncertain-mutation:v4:${JSON.stringify([
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
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
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
    await act(async () => secondTab.result.current.beginIntent({ bill: 'VB-TABS' }));
    expect(secondTab.result.current.getIdempotencyKey())
      .toBe(firstTab.result.current.getIdempotencyKey());
  });

  it('rejects a different concurrent request from the same surface instead of reporting the winner as its result', async () => {
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'tab-a');
    const firstTab = renderHook(() => useUncertainMutationIntent<{ bill: string }>({
      operation: 'create_vendor_bill',
      userId: 'admin-race',
      surface: 'new-vendor-bill',
    }));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'tab-b');
    const secondTab = renderHook(() => useUncertainMutationIntent<{ bill: string }>({
      operation: 'create_vendor_bill',
      userId: 'admin-race',
      surface: 'new-vendor-bill',
    }));

    let outcomes!: PromiseSettledResult<{ bill: string }>[];
    await act(async () => {
      outcomes = await Promise.allSettled([
        firstTab.result.current.beginIntent({ bill: 'VB-A' }),
        secondTab.result.current.beginIntent({ bill: 'VB-B' }),
      ]);
    });

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'DURABLE_MUTATION_INTENT_CONFLICT' }),
    });
    const stored = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify(['create_vendor_bill', 'admin-race'])}`,
    )!);
    expect(stored.claimTabIds).toHaveLength(1);
    expect([{ bill: 'VB-A' }, { bill: 'VB-B' }]).toContainEqual(stored.intent);
  });

  it('coordinates identical concurrent same-surface requests under one request version and key', async () => {
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'same-tab-a');
    const firstTab = renderHook(() => useUncertainMutationIntent<{ bill: string }>({
      operation: 'create_vendor_bill',
      userId: 'admin-same-race',
      surface: 'new-vendor-bill',
    }));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'same-tab-b');
    const secondTab = renderHook(() => useUncertainMutationIntent<{ bill: string }>({
      operation: 'create_vendor_bill',
      userId: 'admin-same-race',
      surface: 'new-vendor-bill',
    }));

    await act(async () => {
      const values = await Promise.all([
        firstTab.result.current.beginIntent({ bill: 'VB-SAME' }),
        secondTab.result.current.beginIntent({ bill: 'VB-SAME' }),
      ]);
      expect(values).toEqual([{ bill: 'VB-SAME' }, { bill: 'VB-SAME' }]);
    });

    expect(secondTab.result.current.getIdempotencyKey())
      .toBe(firstTab.result.current.getIdempotencyKey());
    const stored = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify(['create_vendor_bill', 'admin-same-race'])}`,
    )!);
    expect(stored.claimTabIds.some((claim: string) => claim.startsWith('same-tab-a:'))).toBe(true);
    expect(stored.claimTabIds.some((claim: string) => claim.startsWith('same-tab-b:'))).toBe(true);
  });

  it('releases only the definitively rejected tab claim while a peer request remains in flight', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-definitive-race',
      surface: 'vendor-bill-detail',
      scope: 'bill-definitive-race',
    };
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'reject-tab');
    const rejectTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'commit-tab');
    const commitTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    await act(async () => rejectTab.result.current.beginIntent({ amount: 10_000 }));
    await act(async () => commitTab.result.current.beginIntent({ amount: 10_000 }));
    const originalKey = commitTab.result.current.getIdempotencyKey();

    await act(async () => {
      expect(await rejectTab.result.current.classifyFailure({
        code: '23514',
        message: 'request rejected in this tab',
      })).toBe('definitive');
    });
    expect(rejectTab.result.current.isIntentLocked).toBe(true);
    const pending = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify([options.operation, options.userId])}`,
    )!);
    expect(pending.status).toBe('pending');
    expect(pending.claimTabIds).toHaveLength(1);
    expect(pending.claimTabIds[0]).toMatch(/^commit-tab:/);

    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'blocked-tab');
    const blockedTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    await expect(blockedTab.result.current.beginIntent({ amount: 20_000 }))
      .rejects.toThrow('DURABLE_MUTATION_INTENT_CONFLICT');

    await act(async () => commitTab.result.current.resolveIntent());
    const resolved = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify([options.operation, options.userId])}`,
    )!);
    expect(resolved.status).toBe('resolved');
    expect(resolved.idempotencyKey).toBe(originalKey);
  });

  it('drops an unmounted claimant so a remounted definitive rejection clears the lock', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-remounted-rejection',
      surface: 'vendor-bill-detail',
      scope: 'bill-remounted-rejection',
    };
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'first-mount');
    const firstMount = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    await act(async () => firstMount.result.current.beginIntent({ amount: 11_000 }));
    const originalKey = firstMount.result.current.getIdempotencyKey();
    firstMount.unmount();

    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'second-mount');
    const secondMount = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    await act(async () => secondMount.result.current.beginIntent({ amount: 11_000 }));
    expect(secondMount.result.current.getIdempotencyKey()).toBe(originalKey);

    await act(async () => {
      expect(await secondMount.result.current.classifyFailure({
        code: '23514',
        message: 'request rejected after remount',
      })).toBe('definitive');
    });

    expect(secondMount.result.current.isIntentLocked).toBe(false);
    expect(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify([options.operation, options.userId])}`,
    )).toBeNull();
  });

  it('cannot erase a peer completion when the definitive rejection arrives second', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-resolve-before-reject',
      surface: 'vendor-bill-detail',
      scope: 'bill-resolve-before-reject',
    };
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'resolve-first-tab');
    const resolveTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'reject-second-tab');
    const rejectTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    await act(async () => resolveTab.result.current.beginIntent({ amount: 12_500 }));
    await act(async () => rejectTab.result.current.beginIntent({ amount: 12_500 }));
    const completedKey = resolveTab.result.current.getIdempotencyKey();
    await act(async () => resolveTab.result.current.resolveIntent());
    await act(async () => {
      expect(await rejectTab.result.current.classifyFailure({
        code: '23514',
        message: 'late definitive rejection',
      })).toBe('resolved');
    });

    const resolved = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify([options.operation, options.userId])}`,
    )!);
    expect(resolved.status).toBe('resolved');
    expect(resolved.idempotencyKey).toBe(completedKey);
    expect(resolved.claimTabIds).toHaveLength(2);
    expect(resolved.claimTabIds.some((claim: string) => claim.startsWith('resolve-first-tab:'))).toBe(true);
    expect(resolved.claimTabIds.some((claim: string) => claim.startsWith('reject-second-tab:'))).toBe(true);

    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'after-resolve-tab');
    const afterResolve = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    await act(async () => afterResolve.result.current.beginIntent({ amount: 2_500 }));
    expect(afterResolve.result.current.getIdempotencyKey()).not.toBe(completedKey);
  });

  it('keeps duplicated tabs distinct and never erases a peer resolved tombstone', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-cloned-tab-race',
      surface: 'vendor-bill-detail',
      scope: 'bill-cloned-tab-race',
    };
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'copied-tab-id');
    const resolveTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'copied-tab-id');
    const rejectTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    await act(async () => resolveTab.result.current.beginIntent({ amount: 15_000 }));
    await act(async () => rejectTab.result.current.beginIntent({ amount: 15_000 }));
    const pending = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify([options.operation, options.userId])}`,
    )!);
    expect(pending.claimTabIds).toHaveLength(2);
    expect(new Set(pending.claimTabIds).size).toBe(2);
    expect(pending.claimTabIds.every((claim: string) => claim.startsWith('copied-tab-id:'))).toBe(true);

    const completedKey = resolveTab.result.current.getIdempotencyKey();
    await act(async () => resolveTab.result.current.resolveIntent());
    await act(async () => {
      expect(await rejectTab.result.current.classifyFailure({
        code: '23514',
        message: 'late rejection from duplicated tab',
      })).toBe('resolved');
    });

    const resolved = JSON.parse(window.localStorage.getItem(
      `crx:uncertain-mutation:v4:${JSON.stringify([options.operation, options.userId])}`,
    )!);
    expect(resolved.status).toBe('resolved');
    expect(resolved.idempotencyKey).toBe(completedKey);
    expect(resolved.claimTabIds).toHaveLength(2);
  });

  it('distinguishes a peer-tab completion from a stale failure after a newer request starts', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-success-race',
      surface: 'vendor-bill-detail',
      scope: 'bill-race',
    };
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'success-tab');
    const successTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'lost-tab');
    const lostTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'stale-tab');
    const staleTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    await act(async () => successTab.result.current.beginIntent({ amount: 10_000 }));
    await act(async () => lostTab.result.current.beginIntent({ amount: 10_000 }));
    await act(async () => staleTab.result.current.beginIntent({ amount: 10_000 }));
    const completedKey = successTab.result.current.getIdempotencyKey();
    await act(async () => successTab.result.current.resolveIntent());

    let completedDisposition!: string;
    await act(async () => {
      completedDisposition = await lostTab.result.current.classifyFailure({
        code: 'ETIMEDOUT',
        message: 'response lost after peer commit',
      });
    });
    expect(completedDisposition).toBe('resolved');
    expect(lostTab.result.current.isIntentLocked).toBe(false);

    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'new-tab');
    const newTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    await act(async () => newTab.result.current.beginIntent({ amount: 2_500 }));
    const newerKey = newTab.result.current.getIdempotencyKey();
    expect(newerKey).not.toBe(completedKey);

    let disposition!: string;
    await act(async () => {
      disposition = await staleTab.result.current.classifyFailure({
        code: 'ETIMEDOUT',
        message: 'response lost after commit',
      });
    });
    expect(disposition).toBe('uncertain');
    expect(staleTab.result.current.isIntentLocked).toBe(true);
    expect(staleTab.result.current.unresolvedIntent).toEqual({ amount: 2_500 });
    expect(() => staleTab.result.current.getIdempotencyKey())
      .toThrow('DURABLE_MUTATION_INTENT_CONFLICT');
    expect(newTab.result.current.getIdempotencyKey()).toBe(newerKey);
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
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
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

  // A live claim is a renewable lease, not a permanent marker. Release only runs
  // from `pagehide` and effect cleanup, and neither survives a crash or a force
  // kill. These three cases pin the whole contract: an abandoned lease must age
  // out, a mounted one must not, and an unreadable one must fail closed.
  const LIVE_CLAIM_PREFIX = 'crx:durable-mutation:live-claim:';

  it('expires an abandoned live claim so a crashed tab cannot lock the operation forever', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-abandoned-claim',
      surface: 'vendor-bill-detail',
      scope: 'bill-abandoned-claim',
    };
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
      options.operation,
      options.userId,
    ])}`;
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    try {
      window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'crashed-tab');
      const crashedTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
      window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'surviving-tab');
      const survivingTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

      await act(async () => crashedTab.result.current.beginIntent({ amount: 42_000 }));
      await act(async () => survivingTab.result.current.beginIntent({ amount: 42_000 }));
      const pending = JSON.parse(window.localStorage.getItem(storageKey)!);
      expect(pending.claimTabIds).toHaveLength(2);
      expect(pending.claimTabIds.some((claim: string) => claim.startsWith('crashed-tab:'))).toBe(true);

      // The crashed tab is deliberately never unmounted and never fires
      // `pagehide`, so its lease is left behind exactly as a force kill leaves
      // it. Only the TTL can retire it. 16 minutes is past the 15-minute lease
      // TTL and far inside the 23-hour safe-retry window, so nothing else in the
      // record has expired.
      offsetMs = 16 * 60 * 1000;

      await act(async () => {
        expect(await survivingTab.result.current.classifyFailure({
          code: '23514',
          message: 'server rejected the payment',
        })).toBe('definitive');
      });

      expect(survivingTab.result.current.isIntentLocked).toBe(false);
      expect(window.localStorage.getItem(storageKey)).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it('keeps a mounted claimant live past the lease TTL because its heartbeat renews it', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-renewed-claim',
      surface: 'vendor-bill-detail',
      scope: 'bill-renewed-claim',
    };
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
      options.operation,
      options.userId,
    ])}`;
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    // Only the interval is faked. React's scheduler and fake-indexeddb both rely
    // on setTimeout/microtasks and must keep running for real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'live-peer-tab');
      const livePeerTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
      window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'rejecting-tab');
      const rejectingTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

      await act(async () => livePeerTab.result.current.beginIntent({ amount: 51_000 }));
      await act(async () => rejectingTab.result.current.beginIntent({ amount: 51_000 }));
      const lockedKey = rejectingTab.result.current.getIdempotencyKey();

      offsetMs = 16 * 60 * 1000;
      // The peer is still mounted, so its heartbeat re-stamps the lease at the
      // advanced clock. Without that renewal the lease would already be stale.
      act(() => { vi.advanceTimersByTime(60 * 1000); });

      await act(async () => {
        expect(await rejectingTab.result.current.classifyFailure({
          code: '23514',
          message: 'server rejected this tab',
        })).toBe('definitive');
      });

      // A live peer means the record survives the definitive rejection.
      expect(window.localStorage.getItem(storageKey)).not.toBeNull();
      const stillPending = JSON.parse(window.localStorage.getItem(storageKey)!);
      expect(stillPending.status).toBe('pending');
      expect(stillPending.idempotencyKey).toBe(lockedKey);
      expect(stillPending.claimTabIds).toHaveLength(1);
      expect(stillPending.claimTabIds[0]).toMatch(/^live-peer-tab:/);
      expect(rejectingTab.result.current.isIntentLocked).toBe(true);
    } finally {
      vi.useRealTimers();
      now.mockRestore();
    }
  });

  it('treats an unreadable live-claim lease as live so a storage fault cannot free a locked key', async () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-unreadable-claim',
      surface: 'vendor-bill-detail',
      scope: 'bill-unreadable-claim',
    };
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
      options.operation,
      options.userId,
    ])}`;
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'peer-tab');
    const peerTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    window.sessionStorage.setItem('crx:durable-mutation:tab-id', 'faulting-tab');
    const faultingTab = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    await act(async () => peerTab.result.current.beginIntent({ amount: 33_000 }));
    await act(async () => faultingTab.result.current.beginIntent({ amount: 33_000 }));
    const lockedKey = faultingTab.result.current.getIdempotencyKey();

    // Delete every lease first, so a lease that could be READ would report the
    // peer as gone. Then make lease reads throw. Only a fail-closed read keeps
    // the peer's claim, and with it the frozen idempotency key.
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(LIVE_CLAIM_PREFIX)) window.localStorage.removeItem(key);
    }
    const realGetItem = Storage.prototype.getItem;
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
      .mockImplementation(function mockGetItem(this: Storage, key: string) {
        if (key.startsWith(LIVE_CLAIM_PREFIX)) {
          throw new DOMException('storage read blocked', 'SecurityError');
        }
        return realGetItem.call(this, key);
      });
    try {
      await act(async () => {
        expect(await faultingTab.result.current.classifyFailure({
          code: '23514',
          message: 'server rejected this tab',
        })).toBe('definitive');
      });
    } finally {
      getItem.mockRestore();
    }

    // An unreadable lease must not be read as "the peer is gone".
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
    const stillPending = JSON.parse(window.localStorage.getItem(storageKey)!);
    expect(stillPending.status).toBe('pending');
    expect(stillPending.idempotencyKey).toBe(lockedKey);
    expect(stillPending.claimTabIds).toHaveLength(1);
    expect(stillPending.claimTabIds[0]).toMatch(/^peer-tab:/);
    expect(faultingTab.result.current.isIntentLocked).toBe(true);
  });
});
