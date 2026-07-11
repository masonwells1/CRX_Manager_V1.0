import { useEffect, useCallback } from 'react';
import Button from './Button';

interface UnsavedChangesModalProps {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}

/**
 * Confirmation modal shown when a user tries to navigate away from a page with unsaved changes.
 */
export default function UnsavedChangesModal({ open, onStay, onLeave }: UnsavedChangesModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStay();
    },
    [onStay]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-changes-title" aria-describedby="unsaved-changes-desc">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onStay} aria-hidden="true" />
      <div data-modal-panel className="relative flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col rounded-none bg-white shadow-xl border border-gray-100 animate-in fade-in zoom-in-95 md:mx-4 md:h-auto md:max-h-[90vh] md:max-w-sm md:rounded-xl">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pt-[calc(1.5rem+env(safe-area-inset-top))] text-center md:p-6">
          <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 id="unsaved-changes-title" className="text-lg font-semibold text-nav-dark mb-2">Unsaved Changes</h3>
          <p id="unsaved-changes-desc" className="text-sm text-secondary mb-6">
            You have unsaved changes that will be lost if you leave this page.
          </p>
        </div>
        <div className="sticky bottom-0 flex shrink-0 flex-col-reverse gap-3 border-t border-gray-100 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-center md:p-5">
          <Button variant="secondary" onClick={onLeave} className="min-h-11 w-full sm:w-auto">
            Leave
          </Button>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- safe default: keep user on page if they hit Enter */}
          <Button onClick={onStay} autoFocus className="min-h-11 w-full sm:w-auto">
            Stay
          </Button>
        </div>
      </div>
    </div>
  );
}
