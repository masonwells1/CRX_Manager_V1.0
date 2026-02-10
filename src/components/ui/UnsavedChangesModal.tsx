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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onStay} />
      <div className="relative bg-white rounded-xl shadow-xl border border-gray-100 w-full mx-4 max-w-sm animate-in fade-in zoom-in-95">
        <div className="p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-nav-dark mb-2">Unsaved Changes</h3>
          <p className="text-sm text-secondary mb-6">
            You have unsaved changes that will be lost if you leave this page.
          </p>
          <div className="flex gap-3 justify-center">
            <Button variant="secondary" onClick={onLeave}>
              Leave
            </Button>
            <Button onClick={onStay}>
              Stay
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
