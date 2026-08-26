import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useUncertainMutationIntent } from './useUncertainMutationIntent';

describe('useUncertainMutationIntent', () => {
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
});
