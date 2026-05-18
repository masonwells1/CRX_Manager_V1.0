/**
 * useUnsavedChanges.test.tsx — Tests for unsaved changes navigation guard
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { renderHook } from '@testing-library/react';

// ── Mock react-router ────────────────────────────────────────────────────

const mockBlocker = { state: 'unblocked' as string, proceed: vi.fn(), reset: vi.fn() };

vi.mock('react-router', () => ({
  useBlocker: vi.fn((shouldBlock: boolean) => {
    if (shouldBlock) {
      mockBlocker.state = 'blocked';
    } else {
      mockBlocker.state = 'unblocked';
    }
    return mockBlocker;
  }),
}));

import { useUnsavedChanges } from './useUnsavedChanges';

// ── Tests ────────────────────────────────────────────────────────────────

describe('useUnsavedChanges', () => {
  let addSpy: MockInstance<typeof window.addEventListener>;
  let removeSpy: MockInstance<typeof window.removeEventListener>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBlocker.state = 'unblocked';
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('returns the blocker object', () => {
    const { result } = renderHook(() => useUnsavedChanges(false));
    expect(result.current).toBe(mockBlocker);
  });

  it('does not block navigation when isDirty=false', () => {
    const { result } = renderHook(() => useUnsavedChanges(false));
    expect(result.current.state).toBe('unblocked');
  });

  it('blocks navigation when isDirty=true', () => {
    const { result } = renderHook(() => useUnsavedChanges(true));
    expect(result.current.state).toBe('blocked');
  });

  it('adds beforeunload listener when isDirty=true', () => {
    renderHook(() => useUnsavedChanges(true));
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('does not add beforeunload listener when isDirty=false', () => {
    renderHook(() => useUnsavedChanges(false));
    const beforeUnloadCalls = addSpy.mock.calls.filter(
      (call) => call[0] === 'beforeunload'
    );
    expect(beforeUnloadCalls).toHaveLength(0);
  });

  it('removes beforeunload listener on cleanup', () => {
    const { unmount } = renderHook(() => useUnsavedChanges(true));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('removes beforeunload listener when isDirty changes to false', () => {
    const { rerender } = renderHook(
      ({ dirty }) => useUnsavedChanges(dirty),
      { initialProps: { dirty: true } }
    );
    rerender({ dirty: false });
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('beforeunload handler calls preventDefault', () => {
    renderHook(() => useUnsavedChanges(true));
    const handler = addSpy.mock.calls.find(
      (call) => call[0] === 'beforeunload'
    )?.[1] as EventListener;
    expect(handler).toBeDefined();

    const event = new Event('beforeunload');
    const preventSpy = vi.spyOn(event, 'preventDefault');
    handler(event);
    expect(preventSpy).toHaveBeenCalled();
  });
});
