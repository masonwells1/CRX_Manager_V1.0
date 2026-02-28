import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIdempotencyKey } from './useIdempotencyKey';

describe('useIdempotencyKey', () => {
  it('returns the same key on repeated getKey calls (retry-safe)', () => {
    const { result } = renderHook(() => useIdempotencyKey('complete_delivery', 'user-1'));

    let key1: string;
    let key2: string;
    act(() => { key1 = result.current.getKey(); });
    act(() => { key2 = result.current.getKey(); });

    expect(key1!).toBe(key2!);
  });

  it('returns a new key after resetKey (new action intent)', () => {
    const { result } = renderHook(() => useIdempotencyKey('create_order', 'user-1'));

    let firstKey: string;
    let secondKey: string;
    act(() => { firstKey = result.current.getKey(); });
    act(() => { result.current.resetKey(); });
    act(() => { secondKey = result.current.getKey(); });

    expect(firstKey!).not.toBe(secondKey!);
  });

  it('includes operation and userId in key', () => {
    const { result } = renderHook(() => useIdempotencyKey('allocate_payment', 'abc-123'));

    let key: string;
    act(() => { key = result.current.getKey(); });

    expect(key!).toMatch(/^allocate_payment:abc-123:/);
  });

  it('key survives re-renders (persisted in ref)', () => {
    const { result, rerender } = renderHook(() =>
      useIdempotencyKey('post_invoice', 'user-5')
    );

    let keyBefore: string;
    act(() => { keyBefore = result.current.getKey(); });

    rerender();

    let keyAfter: string;
    act(() => { keyAfter = result.current.getKey(); });

    expect(keyBefore!).toBe(keyAfter!);
  });

  it('simulates retry scenario: error keeps same key, success resets', () => {
    const { result } = renderHook(() => useIdempotencyKey('complete_delivery', 'driver-3'));

    // First attempt
    let attemptKey: string;
    act(() => { attemptKey = result.current.getKey(); });

    // Simulate error — do NOT reset
    // Retry with same key
    let retryKey: string;
    act(() => { retryKey = result.current.getKey(); });
    expect(retryKey!).toBe(attemptKey!);

    // Simulate success — reset
    act(() => { result.current.resetKey(); });

    // New action gets new key
    let newKey: string;
    act(() => { newKey = result.current.getKey(); });
    expect(newKey!).not.toBe(attemptKey!);
  });
});
