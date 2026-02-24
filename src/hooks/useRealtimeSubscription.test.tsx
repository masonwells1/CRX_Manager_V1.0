/**
 * useRealtimeSubscription.test.tsx — Tests for Supabase realtime subscription hook
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// ── Mock Supabase (vi.hoisted to avoid hoisting issues) ──────────────────

const { mockSubscribe, mockRemoveChannel, mockChannel, getCapturedCallback } = vi.hoisted(() => {
  const mockSubscribe = vi.fn();
  const mockRemoveChannel = vi.fn();
  let capturedCallback: ((payload: Record<string, unknown>) => void) | undefined;

  const mockChannel = {
    on: vi.fn((_type: string, _opts: Record<string, unknown>, cb: (p: Record<string, unknown>) => void) => {
      capturedCallback = cb;
      return mockChannel;
    }),
    subscribe: mockSubscribe,
  };

  return {
    mockSubscribe,
    mockRemoveChannel,
    mockChannel,
    getCapturedCallback: () => capturedCallback,
  };
});

vi.mock('../lib/db', () => ({
  supabase: {
    channel: vi.fn(() => mockChannel),
    removeChannel: mockRemoveChannel,
  },
}));

import {
  useRealtimeSubscription,
  useRealtimeNotes,
  useRealtimeComments,
  useRealtimeNotifications,
  useRealtimeActivity,
} from './useRealtimeSubscription';
import { supabase } from '../lib/db';

// ── Tests ────────────────────────────────────────────────────────────────

describe('useRealtimeSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a channel on mount', () => {
    renderHook(() => useRealtimeSubscription({ table: 'orders' }));
    expect(supabase.channel).toHaveBeenCalledTimes(1);
  });

  it('subscribes to the channel', () => {
    renderHook(() => useRealtimeSubscription({ table: 'orders' }));
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it('listens on the specified table', () => {
    renderHook(() => useRealtimeSubscription({ table: 'products' }));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'products', schema: 'public' }),
      expect.any(Function),
    );
  });

  it('defaults to wildcard event (*)', () => {
    renderHook(() => useRealtimeSubscription({ table: 'products' }));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: '*' }),
      expect.any(Function),
    );
  });

  it('uses specified event type', () => {
    renderHook(() => useRealtimeSubscription({ table: 'products', event: 'INSERT' }));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'INSERT' }),
      expect.any(Function),
    );
  });

  it('passes filter to subscription config', () => {
    renderHook(() => useRealtimeSubscription({ table: 'notes', filter: 'user_id=eq.abc' }));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ filter: 'user_id=eq.abc' }),
      expect.any(Function),
    );
  });

  it('removes channel on unmount', () => {
    const { unmount } = renderHook(() => useRealtimeSubscription({ table: 'orders' }));
    unmount();
    expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
  });

  it('calls onChange callback on any event', () => {
    const onChange = vi.fn();
    renderHook(() => useRealtimeSubscription({ table: 'orders', onChange }));
    getCapturedCallback()?.({ eventType: 'INSERT', new: {}, old: {} });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('calls onInsert callback for INSERT events', () => {
    const onInsert = vi.fn();
    renderHook(() => useRealtimeSubscription({ table: 'orders', onInsert }));
    getCapturedCallback()?.({ eventType: 'INSERT', new: { id: 1 }, old: {} });
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('calls onUpdate callback for UPDATE events', () => {
    const onUpdate = vi.fn();
    renderHook(() => useRealtimeSubscription({ table: 'orders', onUpdate }));
    getCapturedCallback()?.({ eventType: 'UPDATE', new: { id: 1 }, old: { id: 1 } });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete callback for DELETE events', () => {
    const onDelete = vi.fn();
    renderHook(() => useRealtimeSubscription({ table: 'orders', onDelete }));
    getCapturedCallback()?.({ eventType: 'DELETE', new: {}, old: { id: 1 } });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not call onInsert for UPDATE events', () => {
    const onInsert = vi.fn();
    renderHook(() => useRealtimeSubscription({ table: 'orders', onInsert }));
    getCapturedCallback()?.({ eventType: 'UPDATE', new: {}, old: {} });
    expect(onInsert).not.toHaveBeenCalled();
  });
});

// ── Convenience Hooks ────────────────────────────────────────────────────

describe('useRealtimeNotes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('subscribes to team_notes table', () => {
    renderHook(() => useRealtimeNotes(vi.fn()));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'team_notes' }),
      expect.any(Function),
    );
  });
});

describe('useRealtimeComments', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('subscribes to team_note_comments with filter', () => {
    renderHook(() => useRealtimeComments('note-123', vi.fn()));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'team_note_comments', filter: 'note_id=eq.note-123' }),
      expect.any(Function),
    );
  });

  it('subscribes without filter when noteId is null', () => {
    renderHook(() => useRealtimeComments(null, vi.fn()));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'team_note_comments', filter: undefined }),
      expect.any(Function),
    );
  });
});

describe('useRealtimeNotifications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('subscribes to notifications with user filter', () => {
    renderHook(() => useRealtimeNotifications('user-abc', vi.fn()));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'notifications', filter: 'user_id=eq.user-abc' }),
      expect.any(Function),
    );
  });
});

describe('useRealtimeActivity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('subscribes to note_activity_log with filter', () => {
    renderHook(() => useRealtimeActivity('note-456', vi.fn()));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'note_activity_log', filter: 'note_id=eq.note-456' }),
      expect.any(Function),
    );
  });

  it('subscribes without filter when noteId is null', () => {
    renderHook(() => useRealtimeActivity(null, vi.fn()));
    expect(mockChannel.on).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ table: 'note_activity_log', filter: undefined }),
      expect.any(Function),
    );
  });
});
