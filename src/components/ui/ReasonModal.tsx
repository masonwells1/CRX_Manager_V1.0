import { useEffect, useState } from 'react';
import { AlertTriangle, Trash2, ClipboardCheck, type LucideIcon } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';

type ReasonVariant = 'danger' | 'warning' | 'info';

interface ReasonModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called with the trimmed reason once the user submits. The component
   * already validates the reason is non-empty before calling this.
   */
  onConfirm: (reason: string) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: ReasonVariant;
  icon?: LucideIcon;
  loading?: boolean;
  /**
   * Placeholder text inside the textarea. Default: "Reason (required)".
   */
  placeholder?: string;
  /**
   * Minimum length of the trimmed reason. Default: 1 (any non-blank).
   */
  minLength?: number;
}

const variantStyles: Record<ReasonVariant, { bg: string; text: string; icon: string }> = {
  danger:  { bg: 'bg-red-50',   text: 'text-red-800',   icon: 'text-red-600' },
  warning: { bg: 'bg-amber-50', text: 'text-amber-800', icon: 'text-amber-600' },
  info:    { bg: 'bg-blue-50',  text: 'text-blue-800',  icon: 'text-blue-600' },
};

const defaultIcons: Record<ReasonVariant, LucideIcon> = {
  danger:  Trash2,
  warning: AlertTriangle,
  info:    ClipboardCheck,
};

/**
 * Modal that collects a required free-form reason before confirming a
 * destructive action. Replaces window.prompt for cancellation reasons,
 * void reasons, etc. — window.prompt is unreliable on iOS Safari and
 * PWA-installed Chrome (returns null silently when the page isn't the
 * active top-level frame), and is also against the project rule against
 * native browser dialogs (AGENTS.md CRX Hard Rules).
 *
 * Wave B audit B-6.
 */
export default function ReasonModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'danger',
  icon,
  loading = false,
  placeholder = 'Reason (required)',
  minLength = 1,
}: ReasonModalProps) {
  const styles = variantStyles[variant];
  const Icon = icon || defaultIcons[variant];
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  // Reset state whenever the modal is opened so a previous abort doesn't
  // leak a stale reason into the next call.
  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const trimmed = reason.trim();
  const tooShort = trimmed.length < minLength;
  const showError = touched && tooShort;

  const handleConfirm = () => {
    setTouched(true);
    if (tooShort) return;
    onConfirm(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={loading} className="min-h-11 w-full sm:w-auto">
            Cancel
          </Button>
          <Button
            variant={variant === 'info' ? 'primary' : 'danger'}
            icon={<Icon className="w-4 h-4" />}
            onClick={handleConfirm}
            loading={loading}
            disabled={loading}
            className="min-h-11 w-full sm:w-auto"
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className={`flex items-start gap-3 p-3 ${styles.bg} rounded-lg`}>
          <Icon className={`w-5 h-5 ${styles.icon} flex-shrink-0 mt-0.5`} />
          <p className={`text-sm ${styles.text}`}>{message}</p>
        </div>

        <div>
          <label htmlFor="reason-modal-textarea" className="block text-sm font-medium text-gray-700 mb-1">
            Reason <span className="text-red-600">*</span>
          </label>
          <textarea
            id="reason-modal-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder={placeholder}
            rows={3}
            disabled={loading}
            className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
              showError
                ? 'border-red-400 focus:ring-red-400 focus:border-red-400'
                : 'border-gray-300 focus:ring-crx-green focus:border-crx-green'
            }`}
          />
          {showError && (
            <p className="mt-1 text-xs text-red-600">
              {minLength > 1
                ? `Reason must be at least ${minLength} characters.`
                : 'Reason is required.'}
            </p>
          )}
        </div>

      </div>
    </Modal>
  );
}
