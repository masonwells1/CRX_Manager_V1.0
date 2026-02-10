import { useEffect } from 'react';
import { useBlocker } from 'react-router';

/**
 * Hook to warn users when navigating away from a page with unsaved changes.
 * Uses React Router's useBlocker for in-app navigation and beforeunload for tab close.
 *
 * @param isDirty - Whether the form has unsaved changes
 * @returns blocker object from useBlocker (state, proceed, reset)
 */
export function useUnsavedChanges(isDirty: boolean) {
  const blocker = useBlocker(isDirty);

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
