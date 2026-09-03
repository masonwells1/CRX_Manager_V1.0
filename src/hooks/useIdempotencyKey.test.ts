import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIdempotencyKey } from './useIdempotencyKey';
import { fingerprintIntentPayload } from '../lib/idempotency';

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

  it('issues a fresh key when the operation scope changes without a remount', () => {
    const { result, rerender } = renderHook(
      ({ operation, userId }) => useIdempotencyKey(operation, userId),
      { initialProps: { operation: 'submit_purchase_order', userId: 'user-5:po-a' } },
    );

    let firstKey: string;
    act(() => { firstKey = result.current.getKey(); });

    rerender({ operation: 'submit_purchase_order', userId: 'user-5:po-b' });

    let secondKey: string;
    act(() => { secondKey = result.current.getKey(); });

    expect(firstKey!).not.toBe(secondKey!);
    expect(secondKey!).toMatch(/^submit_purchase_order:user-5:po-b:/);
  });

  it('replays the original key when the target returns to a row it already touched', () => {
    // The A -> B -> A round trip. A single retained key is indistinguishable
    // from per-target keys on A -> A and on A -> B; it only diverges here, on
    // the way back, which is exactly when an admin returns to the row whose
    // outcome they are unsure about. A third key sent for row A makes the
    // server treat an already-committed payout as a brand-new request.
    const { result, rerender } = renderHook(
      ({ target }) => useIdempotencyKey('post_commission_payment', 'admin-1', target),
      { initialProps: { target: 'payment-a' } },
    );

    let keyA1: string;
    act(() => { keyA1 = result.current.getKey(); });

    rerender({ target: 'payment-b' });
    let keyB: string;
    act(() => { keyB = result.current.getKey(); });

    rerender({ target: 'payment-a' });
    let keyA2: string;
    act(() => { keyA2 = result.current.getKey(); });

    expect(keyB!).not.toBe(keyA1!);
    expect(keyA2!).toBe(keyA1!);
  });

  it('retires only the current target when resetKey is called', () => {
    // Clearing every retained key on success would discard the replay key of
    // any other row the admin still has an unresolved retry on.
    const { result, rerender } = renderHook(
      ({ target }) => useIdempotencyKey('void_commission_payment', 'admin-1', target),
      { initialProps: { target: 'payment-a' } },
    );

    let keyA1: string;
    act(() => { keyA1 = result.current.getKey(); });

    rerender({ target: 'payment-b' });
    act(() => { result.current.getKey(); });
    act(() => { result.current.resetKey(); });

    rerender({ target: 'payment-a' });
    let keyA2: string;
    act(() => { keyA2 = result.current.getKey(); });

    expect(keyA2!).toBe(keyA1!);
  });

  it('rotates on an explicit payload intent without embedding that payload in the key', () => {
    const { result, rerender } = renderHook(
      ({ intentScope }) => useIdempotencyKey('assign_customers_sales_rep', 'admin-1', intentScope),
      { initialProps: { intentScope: 'rep-a|customer-1' } },
    );

    let firstKey: string;
    act(() => { firstKey = result.current.getKey(); });
    rerender({ intentScope: 'rep-b|customer-1,customer-2' });

    let secondKey: string;
    act(() => { secondKey = result.current.getKey(); });

    expect(secondKey!).not.toBe(firstKey!);
    expect(secondKey!).toMatch(/^assign_customers_sales_rep:admin-1:/);
    expect(secondKey!).not.toContain('customer-1');
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

  // Reproduces the BulkFieldImport P1. The modal stays mounted and its scoped
  // keys survive handleClose, so an unresolved save_field key is still cached
  // when a later import runs. A scope built only from row position, customer
  // and field name would hand that stale key to different content, and the
  // server would replay the earlier field_id over the requested new field.
  it('mints a fresh key when a payload-bound scope changes, and replays when it does not', () => {
    const { result } = renderHook(() => useIdempotencyKey('save_field', 'user-1'));
    const scopeFor = (boundary: unknown) =>
      `import:0:cust-1:North 40:${fingerprintIntentPayload([{ field_name: 'North 40' }, boundary, null])}`;

    const originalBoundary = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] };
    const differentBoundary = { type: 'Polygon', coordinates: [[[9, 9], [9, 8], [8, 8], [9, 9]]] };

    // First attempt; its response is lost, so the key is deliberately NOT reset.
    let lostKey: string;
    act(() => { lostKey = result.current.getKeyFor(scopeFor(originalBoundary)); });

    // A genuine retry of the same row must reuse the key so the server replays.
    let retryKey: string;
    act(() => { retryKey = result.current.getKeyFor(scopeFor(originalBoundary)); });
    expect(retryKey!).toBe(lostKey!);

    // A later import of DIFFERENT geometry at the same row must not.
    let newIntentKey: string;
    act(() => { newIntentKey = result.current.getKeyFor(scopeFor(differentBoundary)); });
    expect(newIntentKey!).not.toBe(lostKey!);
  });
});
