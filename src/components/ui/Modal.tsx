import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  accent?: string;
  children: ReactNode;
  maxWidth?: string;
  size?: 'default' | 'large';
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  title,
  accent,
  children,
  maxWidth,
  size = 'default',
}: ModalProps) {
  const sizeClass = maxWidth || (size === 'large' ? 'max-w-4xl' : 'max-w-lg');
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`).current;

  // Escape key handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Focus trap: cycle focus within modal
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', handleKeyDown);
      // Focus the dialog on open
      requestAnimationFrame(() => {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable && focusable.length > 0) {
          focusable[0].focus();
        }
      });
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className={`
          relative bg-white rounded-xl shadow-xl border border-gray-100
          w-full mx-4 ${sizeClass} max-h-[90vh] overflow-y-auto
          animate-in fade-in zoom-in-95
        `}
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 id={titleId} className="text-lg font-semibold font-heading text-nav-dark">
            {title}
            {accent && <span className="split-heading-accent"> {accent}</span>}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
