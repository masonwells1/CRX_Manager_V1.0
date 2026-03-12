/**
 * useFormDraft — Persists form state to sessionStorage so it survives a
 * PWA reload when the user switches away on mobile (e.g. to the calculator).
 *
 * sessionStorage is used instead of localStorage so drafts are automatically
 * discarded when the browser tab is fully closed — no stale drafts on next visit.
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

  // Read the draft once on mount (before any state is set)
  const [draft] = useState<T | null>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  });

  const saveDraft = useCallback(
    (state: T) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(state));
        } catch {
          // sessionStorage full or unavailable — silently ignore
        }
      }, DEBOUNCE_MS);
    },
    [storageKey],
  );

  const clearDraft = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    try {
      sessionStorage.removeItem(storageKey);
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

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  return { draft, saveDraft, clearDraft };
}
