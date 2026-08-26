import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUncertainMutationIntent } from './useUncertainMutationIntent';

describe('useUncertainMutationIntent', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('keeps the first payload frozen until an exact retry succeeds', () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());

    let first!: { amount: number };
    act(() => {
      first = result.current.beginIntent({ amount: 100 });
    });
    expect(first).toEqual({ amount: 100 });
    expect(result.current.isIntentLocked).toBe(true);

    let retry!: { amount: number };
    act(() => {
      retry = result.current.beginIntent({ amount: 200 });
    });
    expect(retry).toEqual({ amount: 100 });

    act(() => result.current.resolveIntent());
    expect(result.current.isIntentLocked).toBe(false);
  });

  it('unlocks only when the server proves the request was rejected', () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());
    act(() => result.current.beginIntent({ amount: 100 }));

    act(() => {
      expect(result.current.classifyFailure({ code: '23514', message: 'validation failed' }))
        .toBe('definitive');
    });
    expect(result.current.isIntentLocked).toBe(false);
  });

  it('keeps transport failures locked because commit status is unknown', () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());
    act(() => result.current.beginIntent({ amount: 100 }));

    act(() => {
      expect(result.current.classifyFailure({ code: 'ETIMEDOUT', message: 'socket timeout' }))
        .toBe('uncertain');
    });
    expect(result.current.unresolvedIntent).toEqual({ amount: 100 });
  });

  it('keeps an intent mismatch locked until the caller reconciles the receipt', () => {
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>());
    act(() => result.current.beginIntent({ amount: 100 }));

    act(() => {
      expect(result.current.classifyFailure({ code: '22023', message: 'IDEMPOTENCY_INTENT_MISMATCH' }))
        .toBe('uncertain');
    });
    expect(result.current.unresolvedIntent).toEqual({ amount: 100 });
  });

  it('does not depend on Error instances for Supabase failures', () => {
    const errorSpy = vi.fn();
    const plainObject = { code: '08007', message: 'transaction resolution unknown' };
    const { result } = renderHook(() => useUncertainMutationIntent<{ id: string }>());
    act(() => result.current.beginIntent({ id: 'one' }));
    act(() => errorSpy(result.current.classifyFailure(plainObject)));
    expect(errorSpy).toHaveBeenCalledWith('uncertain');
    expect(result.current.isIntentLocked).toBe(true);
  });

  it('restores the exact payload and matching key after unmount or reload', () => {
    const options = {
      operation: 'record_vendor_payment',
      userId: 'admin-1',
      surface: 'vendor-bill-detail',
      scope: 'bill-7',
    };
    const first = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));

    act(() => {
      first.result.current.beginIntent({ amount: 12345 });
    });
    const originalKey = first.result.current.getIdempotencyKey();
    first.unmount();

    const restored = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    expect(restored.result.current.isIntentLocked).toBe(true);
    expect(restored.result.current.unresolvedIntent).toEqual({ amount: 12345 });
    expect(restored.result.current.getIdempotencyKey()).toBe(originalKey);

    act(() => restored.result.current.resolveIntent());
    restored.unmount();

    const cleared = renderHook(() => useUncertainMutationIntent<{ amount: number }>(options));
    expect(cleared.result.current.isIntentLocked).toBe(false);
  });

  it('retires the persisted payload and key after a definitive rejection', () => {
    const options = {
      operation: 'create_vendor_bill',
      userId: 'admin-2',
      surface: 'new-vendor-bill',
    };
    const first = renderHook(() => useUncertainMutationIntent<{ bill: string }>(options));
    act(() => first.result.current.beginIntent({ bill: 'VB-9' }));

    act(() => {
      expect(first.result.current.classifyFailure({ code: '23514', message: 'invalid bill' }))
        .toBe('definitive');
    });
    first.unmount();

    const restored = renderHook(() => useUncertainMutationIntent<{ bill: string }>(options));
    expect(restored.result.current.isIntentLocked).toBe(false);
  });

  it('fails closed before the caller can mutate when durable storage is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useUncertainMutationIntent<{ amount: number }>({
      operation: 'record_vendor_payment',
      userId: 'admin-3',
      surface: 'vendor-bill-detail',
      scope: 'bill-8',
    }));

    expect(() => {
      act(() => result.current.beginIntent({ amount: 5000 }));
    }).toThrow('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
    expect(result.current.isIntentLocked).toBe(false);
    setItem.mockRestore();
  });
});
