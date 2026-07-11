import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  accent?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
  size?: 'default' | 'large' | 'fullscreen';
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  title,
  accent,
  children,
  footer,
  maxWidth,
  size = 'default',
}: ModalProps) {
  const panelSizeClass = size === 'fullscreen'
    ? 'h-[100dvh] max-h-[100dvh] max-w-full rounded-none'
    : `h-[100dvh] max-h-[100dvh] max-w-full rounded-none ${maxWidth === 'max-w-2xl'
      ? 'md:max-w-2xl'
      : size === 'large'
        ? 'md:max-w-4xl'
        : 'md:max-w-lg'} md:mx-4 md:h-auto md:max-h-[90vh] md:rounded-xl`;
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

  // Separate effect for keyboard listener (updates when handler changes)
  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, handleKeyDown]);

  // Separate effect for focus + body overflow (only runs when open changes)
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
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
    };
  }, [open]);

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
        data-modal-panel
        className={`
          relative flex w-full flex-col bg-white shadow-xl border border-gray-100
          ${panelSizeClass}
          animate-in fade-in zoom-in-95
        `}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-4 pt-[calc(1rem+env(safe-area-inset-top))] md:p-5">
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
        <div data-modal-body className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-5">
          {children}
        </div>
        {footer && (
          <div
            data-modal-footer
            className="sticky bottom-0 shrink-0 border-t border-gray-100 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:p-5"
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
