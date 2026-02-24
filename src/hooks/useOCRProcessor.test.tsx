/**
 * useOCRProcessor.test.tsx — Tests for OCR queue polling hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Mock Supabase (vi.hoisted to avoid hoisting issues) ──────────────────

const { mockInvoke, mockLimit, mockSelect } = vi.hoisted(() => {
  const mockInvoke = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockOrderB = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockOrderA = vi.fn().mockReturnValue({ order: mockOrderB });
  const mockLt = vi.fn().mockReturnValue({ order: mockOrderA });
  const mockIn = vi.fn().mockReturnValue({ lt: mockLt });
  const mockSelect = vi.fn().mockReturnValue({ in: mockIn });

  return { mockInvoke, mockLimit, mockSelect, mockIn, mockLt };
});

vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => ({ select: mockSelect })),
    functions: { invoke: mockInvoke },
  },
}));

import { useOCRProcessor } from './useOCRProcessor';

// ── Tests ────────────────────────────────────────────────────────────────

describe('useOCRProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockLimit.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns isProcessing and processedCount', () => {
    const { result } = renderHook(() => useOCRProcessor(false));
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.processedCount).toBe(0);
  });

  it('does not poll when enabled=false', async () => {
    renderHook(() => useOCRProcessor(false));
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('queries the OCR queue immediately when enabled', async () => {
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockSelect).toHaveBeenCalled();
  });

  it('polls every 30 seconds', async () => {
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockSelect).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mockSelect).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });

  it('clears interval on unmount', async () => {
    const { unmount } = renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    const callsBefore = mockSelect.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mockSelect).toHaveBeenCalledTimes(callsBefore);
  });

  it('invokes Edge Function when pending items are found', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [{ blend_ticket_id: 'bt-1', status: 'pending', retry_count: 0 }],
      error: null,
    });

    renderHook(() => useOCRProcessor(true));
    // First flush: triggers useEffect → checkQueue() starts → resolves supabase query
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Second flush: lets the inner `await functions.invoke(...)` resolve
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockInvoke).toHaveBeenCalledWith('process-blend-ticket', {
      body: { blend_ticket_id: 'bt-1' },
    });
  });

  it('does not invoke Edge Function when query returns empty', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('does not invoke Edge Function when query errors', async () => {
    mockLimit.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('skips recently-started processing items (< 2 min ago)', async () => {
    const recentTime = new Date(Date.now() - 30000).toISOString();
    mockLimit.mockResolvedValueOnce({
      data: [{ blend_ticket_id: 'bt-1', status: 'processing', started_at: recentTime, retry_count: 0 }],
      error: null,
    });
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('re-triggers stuck processing items (> 2 min ago)', async () => {
    const oldTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    mockLimit.mockResolvedValueOnce({
      data: [{ blend_ticket_id: 'bt-1', status: 'processing', started_at: oldTime, retry_count: 1 }],
      error: null,
    });
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockInvoke).toHaveBeenCalledWith('process-blend-ticket', {
      body: { blend_ticket_id: 'bt-1' },
    });
  });

  it('handles Edge Function invoke error gracefully', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [{ blend_ticket_id: 'bt-1', status: 'pending', retry_count: 0 }],
      error: null,
    });
    mockInvoke.mockRejectedValueOnce(new Error('Edge Function timeout'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() => useOCRProcessor(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
