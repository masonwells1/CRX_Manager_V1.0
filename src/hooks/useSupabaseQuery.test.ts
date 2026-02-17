import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSupabaseQuery } from './useSupabaseQuery';

describe('useSupabaseQuery', () => {
  it('starts in loading state when enabled', () => {
    const queryFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() =>
      useSupabaseQuery({ queryFn })
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('fetches data and sets loading to false', async () => {
    const mockData = [{ id: 1, name: 'Test' }];
    const queryFn = vi.fn().mockResolvedValue({ data: mockData, error: null });

    const { result } = renderHook(() =>
      useSupabaseQuery({ queryFn })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(mockData);
    expect(result.current.error).toBeNull();
  });

  it('sets error when query returns an error', async () => {
    const mockError = { message: 'Query failed' };
    const queryFn = vi.fn().mockResolvedValue({ data: null, error: mockError });

    const { result } = renderHook(() =>
      useSupabaseQuery({ queryFn })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toEqual(mockError);
    expect(result.current.data).toBeNull();
  });

  it('calls onError callback when error occurs', async () => {
    const mockError = { message: 'Query failed' };
    const queryFn = vi.fn().mockResolvedValue({ data: null, error: mockError });
    const onError = vi.fn();

    renderHook(() =>
      useSupabaseQuery({ queryFn, onError })
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(mockError);
    });
  });

  it('does not run query when enabled is false', async () => {
    const queryFn = vi.fn().mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() =>
      useSupabaseQuery({ queryFn, enabled: false })
    );

    // Wait a tick to make sure queryFn isn't called
    await new Promise((r) => setTimeout(r, 50));

    expect(queryFn).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it('refetch re-runs the query', async () => {
    let callCount = 0;
    const queryFn = vi.fn().mockImplementation(async () => {
      callCount++;
      return { data: { count: callCount }, error: null };
    });

    const { result } = renderHook(() =>
      useSupabaseQuery({ queryFn })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual({ count: 1 });

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ count: 2 });
    });

    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('handles thrown exceptions in queryFn', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('Network failure'));
    const onError = vi.fn();

    const { result } = renderHook(() =>
      useSupabaseQuery({ queryFn, onError })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalled();
  });

  it('passes AbortSignal to queryFn', async () => {
    const queryFn = vi.fn().mockResolvedValue({ data: null, error: null });

    renderHook(() => useSupabaseQuery({ queryFn }));

    await waitFor(() => {
      expect(queryFn).toHaveBeenCalled();
    });

    const signal = queryFn.mock.calls[0][0];
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
