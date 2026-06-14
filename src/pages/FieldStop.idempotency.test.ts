import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';

/**
 * Field Mode — per-stop complete_delivery idempotency guarantee.
 *
 * The adversarial review's top correctness risk was a complete_delivery key
 * being reused across stops (which would silently "complete" the next stop
 * with the previous stop's cached result). Field Mode prevents this two ways:
 *
 *  1. Route-per-stop: /my-route/:id mounts a FRESH FieldStop (and therefore a
 *     fresh useIdempotencyKey ref) per stop, so navigating "Next Stop" issues
 *     a brand-new key — modeled here by unmount/remount.
 *  2. resetKey() fires on completion success, so even a second completion
 *     within the same mount gets a fresh key.
 *
 * These assert that contract at the hook level (no heavy FieldStop render).
 */
describe('Field Mode — per-stop complete_delivery idempotency', () => {
  it('a new stop mount issues a distinct complete_delivery key (Next Stop navigation)', () => {
    const stopA = renderHook(() => useIdempotencyKey('complete_delivery', 'driver-1'));
    let keyA = '';
    act(() => { keyA = stopA.result.current.getKey(); });
    stopA.unmount(); // navigate away: Next Stop → /my-route → next /my-route/:id

    const stopB = renderHook(() => useIdempotencyKey('complete_delivery', 'driver-1'));
    let keyB = '';
    act(() => { keyB = stopB.result.current.getKey(); });

    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(/^complete_delivery:driver-1:/);
    expect(keyB).toMatch(/^complete_delivery:driver-1:/);
  });

  it('resetKey() on success yields a fresh key for a follow-up completion in the same mount', () => {
    const { result } = renderHook(() => useIdempotencyKey('complete_delivery', 'driver-2'));
    let first = '';
    let second = '';
    act(() => { first = result.current.getKey(); });
    act(() => { result.current.resetKey(); }); // fires on completion success
    act(() => { second = result.current.getKey(); });
    expect(first).not.toBe(second);
  });

  it('a retry before success keeps the same key (no duplicate completion)', () => {
    const { result } = renderHook(() => useIdempotencyKey('complete_delivery', 'driver-3'));
    let attempt = '';
    let retry = '';
    act(() => { attempt = result.current.getKey(); });
    // simulate a failed complete (e.g. transient error) — do NOT reset
    act(() => { retry = result.current.getKey(); });
    expect(retry).toBe(attempt);
  });
});
