/**
 * useFormDraft — Persists form state to localStorage so it survives Android
 * killing the PWA process when the user switches to another app.
 *
 * Each draft is stored with a timestamp and automatically expires after
 * DRAFT_TTL_MS (4 hours) to prevent stale data from accumulating.
 *
 * A `visibilitychange` listener flushes pending writes immediately when
 * the app goes to background — `beforeunload` is unreliable on mobile.
 *
 * Usage:
 *   const { saveDraft, clearDraft } = useFormDraft('new-order', {
 *     customerId, orderName, notes, items,
 *   });
 *   // On successful submit: clearDraft()
 *
 * To restore a draft on mount, use the returned `draft` value:
 *   const { draft, clearDraft } = useFormDraft<MyForm>('new-order');
 *   useEffect(() => { if (draft) { /* restore state from draft *\/ } }, []);
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DRAFT_PREFIX = 'crx_form_draft_';
const DEBOUNCE_MS = 500;
const DRAFT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface DraftEnvelope<T> {
  savedAt: number;
  data: T;
}

export function useFormDraft<T extends object>(
  key: string,
  currentState?: T,
): {
  draft: T | null;
  saveDraft: (state: T) => void;
  clearDraft: () => void;
} {
  const storageKey = DRAFT_PREFIX + key;
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestState = useRef<T | undefined>(currentState);

  // Keep latestState in sync so the visibility handler can flush it
  latestState.current = currentState;

  // Read the draft once on mount — ignore if expired
  const [draft] = useState<T | null>(() => {
    try {
      // Migrate any existing sessionStorage draft (one-time carry-over)
      const sessionRaw = sessionStorage.getItem(storageKey);
      if (sessionRaw) {
        const data = JSON.parse(sessionRaw) as T;
        sessionStorage.removeItem(storageKey);
        const envelope: DraftEnvelope<T> = { savedAt: Date.now(), data };
        localStorage.setItem(storageKey, JSON.stringify(envelope));
        return data;
      }

      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const envelope = JSON.parse(raw) as DraftEnvelope<T>;
      if (Date.now() - envelope.savedAt > DRAFT_TTL_MS) {
        localStorage.removeItem(storageKey);
        return null;
      }
      return envelope.data;
    } catch {
      return null;
    }
  });

  /** Write state to localStorage immediately (no debounce). */
  const flushNow = useCallback(
    (state: T) => {
      try {
        const envelope: DraftEnvelope<T> = { savedAt: Date.now(), data: state };
        localStorage.setItem(storageKey, JSON.stringify(envelope));
      } catch {
        // localStorage full or unavailable — silently ignore
      }
    },
    [storageKey],
  );

  const saveDraft = useCallback(
    (state: T) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        flushNow(state);
      }, DEBOUNCE_MS);
    },
    [flushNow],
  );

  const clearDraft = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);

  // Auto-save whenever currentState changes (if provided)
  useEffect(() => {
    if (currentState !== undefined) {
      saveDraft(currentState);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(currentState)]);

  // Flush immediately when the app goes to background (mobile app-switch).
  // beforeunload is unreliable on Android — visibilitychange fires consistently.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && latestState.current !== undefined) {
        // Cancel pending debounce and write synchronously
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        flushNow(latestState.current);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushNow]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  return { draft, saveDraft, clearDraft };
}
