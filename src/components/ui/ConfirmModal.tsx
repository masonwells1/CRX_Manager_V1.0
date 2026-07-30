import { AlertTriangle, Trash2, ClipboardCheck, type LucideIcon } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';

type ConfirmVariant = 'danger' | 'warning' | 'info';

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  icon?: LucideIcon;
  loading?: boolean;
}

const variantStyles: Record<ConfirmVariant, { bg: string; text: string; icon: string }> = {
  danger: { bg: 'bg-red-50', text: 'text-red-800', icon: 'text-red-600' },
  warning: { bg: 'bg-amber-50', text: 'text-amber-800', icon: 'text-amber-600' },
  info: { bg: 'bg-blue-50', text: 'text-blue-800', icon: 'text-blue-600' },
};

const defaultIcons: Record<ConfirmVariant, LucideIcon> = {
  danger: Trash2,
  warning: AlertTriangle,
  info: ClipboardCheck,
};

export default function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  icon,
  loading = false,
}: ConfirmModalProps) {
  const styles = variantStyles[variant];
  const Icon = icon || defaultIcons[variant];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} className="min-h-11 w-full sm:w-auto">
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'info' ? 'primary' : 'danger'}
            icon={<Icon className="w-4 h-4" />}
            onClick={onConfirm}
            loading={loading}
            className="min-h-11 w-full sm:w-auto"
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className={`flex items-center gap-3 p-3 ${styles.bg} rounded-lg`}>
          <Icon className={`w-5 h-5 ${styles.icon} flex-shrink-0`} />
          <p className={`text-sm ${styles.text}`}>{message}</p>
        </div>
      </div>
    </Modal>
  );
}
