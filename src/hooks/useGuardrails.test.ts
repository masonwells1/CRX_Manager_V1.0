import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStaleQuoteCheck } from './useGuardrails';

// We test the pure/synchronous hook. The async hooks (credit limit, driver)
// depend on supabase and are better tested via integration/E2E.

describe('useStaleQuoteCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no warning for a fresh quote', () => {
    const { result } = renderHook(() => useStaleQuoteCheck());
    const now = new Date().toISOString();
    act(() => {
      result.current.check(now);
    });
    expect(result.current.warning).toBeNull();
  });

  it('returns warning for a quote older than 30 days', () => {
    const { result } = renderHook(() => useStaleQuoteCheck());
    const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString();
    act(() => {
      result.current.check(oldDate);
    });
    expect(result.current.warning).not.toBeNull();
    expect(result.current.warning?.message).toContain('45 days old');
    expect(result.current.warning?.severity).toBe('warning');
  });

  it('returns false for stale quote, true for fresh', () => {
    const { result } = renderHook(() => useStaleQuoteCheck());

    let isFresh: boolean;

    act(() => {
      isFresh = result.current.check(new Date().toISOString());
    });
    expect(isFresh!).toBe(true);

    act(() => {
      isFresh = result.current.check(new Date(Date.now() - 60 * 86_400_000).toISOString());
    });
    expect(isFresh!).toBe(false);
  });

  it('dismiss clears the warning display', () => {
    const { result } = renderHook(() => useStaleQuoteCheck());
    const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString();
    act(() => {
      result.current.check(oldDate);
    });
    expect(result.current.warning?.dismissed).toBe(false);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.warning?.dismissed).toBe(true);
  });

  it('returns no warning for exactly 30 day old quote', () => {
    const { result } = renderHook(() => useStaleQuoteCheck());
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    act(() => {
      result.current.check(thirtyDaysAgo);
    });
    expect(result.current.warning).toBeNull();
  });
});
