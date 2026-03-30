import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useOCRThresholds } from './useOCRThresholds';

// Mock supabase chain: from().select().eq().single()
const mockSingle = vi.fn();
const mockEq = vi.fn(() => ({ single: mockSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));

vi.mock('../lib/db', () => ({
  supabase: {
    from: () => ({ select: mockSelect }),
  },
}));

describe('useOCRThresholds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default thresholds before fetch completes', () => {
    mockSingle.mockResolvedValue({ data: null });
    const { result } = renderHook(() => useOCRThresholds());

    expect(result.current).toEqual({ auto_approve: 85, needs_review: 50 });
  });

  it('returns defaults when no setting exists', async () => {
    mockSingle.mockResolvedValue({ data: null });
    const { result } = renderHook(() => useOCRThresholds());

    await waitFor(() => {
      expect(mockSelect).toHaveBeenCalled();
    });

    expect(result.current).toEqual({ auto_approve: 85, needs_review: 50 });
  });

  it('parses JSON string setting_value', async () => {
    mockSingle.mockResolvedValue({
      data: { setting_value: '{"auto_approve": 90, "needs_review": 40}' },
    });
    const { result } = renderHook(() => useOCRThresholds());

    await waitFor(() => {
      expect(result.current).toEqual({ auto_approve: 90, needs_review: 40 });
    });
  });

  it('handles setting_value as object (jsonb)', async () => {
    mockSingle.mockResolvedValue({
      data: { setting_value: { auto_approve: 75, needs_review: 30 } },
    });
    const { result } = renderHook(() => useOCRThresholds());

    await waitFor(() => {
      expect(result.current).toEqual({ auto_approve: 75, needs_review: 30 });
    });
  });

  it('keeps defaults on malformed JSON', async () => {
    mockSingle.mockResolvedValue({
      data: { setting_value: 'not valid json' },
    });
    const { result } = renderHook(() => useOCRThresholds());

    await waitFor(() => {
      expect(mockSelect).toHaveBeenCalled();
    });

    expect(result.current).toEqual({ auto_approve: 85, needs_review: 50 });
  });

  it('handles threshold value of 0 correctly (null check not truthy check)', async () => {
    mockSingle.mockResolvedValue({
      data: { setting_value: '{"auto_approve": 0, "needs_review": 0}' },
    });
    const { result } = renderHook(() => useOCRThresholds());

    await waitFor(() => {
      expect(result.current).toEqual({ auto_approve: 0, needs_review: 0 });
    });
  });
});
