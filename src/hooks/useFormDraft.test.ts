import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFormDraft } from './useFormDraft';

const DRAFT_PREFIX = 'crx_form_draft_';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useFormDraft', () => {
  it('returns null draft when no saved data exists', () => {
    const { result } = renderHook(() => useFormDraft<{ name: string }>('test-form'));
    expect(result.current.draft).toBeNull();
  });

  it('restores draft from localStorage on mount', () => {
    const envelope = {
      savedAt: Date.now(),
      data: { name: 'Smith Farm', notes: 'test' },
    };
    localStorage.setItem(`${DRAFT_PREFIX}test-form`, JSON.stringify(envelope));

    const { result } = renderHook(() => useFormDraft<{ name: string; notes: string }>('test-form'));
    expect(result.current.draft).toEqual({ name: 'Smith Farm', notes: 'test' });
  });

  it('returns null for expired drafts (>4 hours)', () => {
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    const envelope = {
      savedAt: fiveHoursAgo,
      data: { name: 'Old Data' },
    };
    localStorage.setItem(`${DRAFT_PREFIX}expired`, JSON.stringify(envelope));

    const { result } = renderHook(() => useFormDraft<{ name: string }>('expired'));
    expect(result.current.draft).toBeNull();
    expect(localStorage.getItem(`${DRAFT_PREFIX}expired`)).toBeNull();
  });

  it('migrates sessionStorage draft to localStorage on mount', () => {
    const data = { name: 'Session Data' };
    sessionStorage.setItem(`${DRAFT_PREFIX}migrate`, JSON.stringify(data));

    const { result } = renderHook(() => useFormDraft<{ name: string }>('migrate'));
    expect(result.current.draft).toEqual({ name: 'Session Data' });
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}migrate`)).toBeNull();
    expect(localStorage.getItem(`${DRAFT_PREFIX}migrate`)).toBeTruthy();
  });

  it('saveDraft writes to localStorage after debounce', () => {
    const { result } = renderHook(() => useFormDraft<{ name: string }>('save-test'));

    act(() => {
      result.current.saveDraft({ name: 'New Data' });
    });

    // Not saved immediately (debounced)
    expect(localStorage.getItem(`${DRAFT_PREFIX}save-test`)).toBeNull();

    // Advance past debounce (500ms)
    act(() => {
      vi.advanceTimersByTime(600);
    });

    const stored = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}save-test`)!);
    expect(stored.data).toEqual({ name: 'New Data' });
  });

  it('clearDraft removes from localStorage', () => {
    const envelope = { savedAt: Date.now(), data: { name: 'To Delete' } };
    localStorage.setItem(`${DRAFT_PREFIX}clear-test`, JSON.stringify(envelope));

    const { result } = renderHook(() => useFormDraft<{ name: string }>('clear-test'));

    act(() => {
      result.current.clearDraft();
    });

    expect(localStorage.getItem(`${DRAFT_PREFIX}clear-test`)).toBeNull();
  });

  it('clearDraft cancels pending debounced save', () => {
    const { result } = renderHook(() => useFormDraft<{ name: string }>('cancel-test'));

    act(() => {
      result.current.saveDraft({ name: 'Pending' });
    });

    act(() => {
      result.current.clearDraft();
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(localStorage.getItem(`${DRAFT_PREFIX}cancel-test`)).toBeNull();
  });

  it('auto-saves when currentState changes', () => {
    const { rerender } = renderHook(
      ({ state }) => useFormDraft('auto-save', state),
      { initialProps: { state: { name: 'A' } } },
    );

    act(() => { vi.advanceTimersByTime(600); });

    const stored1 = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}auto-save`)!);
    expect(stored1.data).toEqual({ name: 'A' });

    rerender({ state: { name: 'B' } });
    act(() => { vi.advanceTimersByTime(600); });

    const stored2 = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}auto-save`)!);
    expect(stored2.data).toEqual({ name: 'B' });
  });

  it('flushes immediately on visibilitychange to hidden', () => {
    renderHook(() => useFormDraft('visibility', { name: 'Flush Me' }));

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    const stored = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}visibility`)!);
    expect(stored.data).toEqual({ name: 'Flush Me' });

    // Restore
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem(`${DRAFT_PREFIX}corrupt`, 'not-json{{{');

    const { result } = renderHook(() => useFormDraft<{ name: string }>('corrupt'));
    expect(result.current.draft).toBeNull();
  });

  it('uses separate keys for different form identifiers', () => {
    const envelope1 = { savedAt: Date.now(), data: { name: 'Form A' } };
    const envelope2 = { savedAt: Date.now(), data: { name: 'Form B' } };
    localStorage.setItem(`${DRAFT_PREFIX}form-a`, JSON.stringify(envelope1));
    localStorage.setItem(`${DRAFT_PREFIX}form-b`, JSON.stringify(envelope2));

    const { result: resultA } = renderHook(() => useFormDraft<{ name: string }>('form-a'));
    const { result: resultB } = renderHook(() => useFormDraft<{ name: string }>('form-b'));

    expect(resultA.current.draft).toEqual({ name: 'Form A' });
    expect(resultB.current.draft).toEqual({ name: 'Form B' });
  });
});
