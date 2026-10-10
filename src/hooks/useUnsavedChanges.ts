import { useCallback, useEffect, type MutableRefObject } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';

/**
 * Hook to warn users when navigating away from a page with unsaved changes.
 * Uses React Router's useBlocker for in-app navigation and beforeunload for tab close.
 *
 * @param isDirty - Whether the form has unsaved changes
 * @param skipNextBlockRef - Optional. Set `.current = true` right before a navigate()
 *   that must not be blocked (e.g. leaving a page straight after a successful save).
 *   It lets exactly the next navigation through and then resets itself. This exists
 *   because the router keeps the block check from the last COMMITTED render: a
 *   `setDirty(false)` immediately followed by `navigate()` is still blocked by the
 *   stale "dirty" check, which showed a false "Unsaved Changes" prompt after a save
 *   (FieldApplicationInvoice, 2026-10-09). The ref is read at navigation time, so it
 *   is never stale. Without it, behaviour is exactly `useBlocker(isDirty)`.
 * @returns blocker object from useBlocker (state, proceed, reset)
 */
export function useUnsavedChanges(isDirty: boolean, skipNextBlockRef?: MutableRefObject<boolean>) {
  const shouldBlock = useCallback<BlockerFunction>(() => {
    if (skipNextBlockRef?.current) {
      skipNextBlockRef.current = false;
      return false;
    }
    return isDirty;
  }, [isDirty, skipNextBlockRef]);
  const blocker = useBlocker(skipNextBlockRef ? shouldBlock : isDirty);

  // Handle browser tab close / refresh
  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  return blocker;
}
