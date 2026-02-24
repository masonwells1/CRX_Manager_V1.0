import { Trash2, XCircle, ToggleLeft } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';

interface BulkDeleteConfirmModalProps {
  open: boolean;
  onClose: () => void;
  count: number;
  entityName: string;
  entityNamePlural?: string;
  actionWord?: 'delete' | 'deactivate' | 'cancel';
  onConfirm: () => void;
  loading?: boolean;
}

const iconMap = {
  delete: Trash2,
  deactivate: ToggleLeft,
  cancel: XCircle,
};

const colorMap = {
  delete: { bg: 'bg-red-50', text: 'text-red-800', icon: 'text-red-600' },
  deactivate: { bg: 'bg-amber-50', text: 'text-amber-800', icon: 'text-amber-600' },
  cancel: { bg: 'bg-red-50', text: 'text-red-800', icon: 'text-red-600' },
};

export default function BulkDeleteConfirmModal({
  open,
  onClose,
  count,
  entityName,
  entityNamePlural,
  actionWord = 'delete',
  onConfirm,
  loading = false,
}: BulkDeleteConfirmModalProps) {
  const plural = entityNamePlural || `${entityName}s`;
  const label = count === 1 ? entityName : plural;
  const Icon = iconMap[actionWord];
  const colors = colorMap[actionWord];

  const titleMap = {
    delete: `Delete ${label}`,
    deactivate: `Deactivate ${label}`,
    cancel: `Cancel ${label}`,
  };

  return (
    <Modal open={open} onClose={onClose} title={titleMap[actionWord]}>
      <div className="space-y-4">
        <div className={`flex items-center gap-3 p-3 ${colors.bg} rounded-lg`}>
          <Icon className={`w-5 h-5 ${colors.icon} flex-shrink-0`} />
          <p className={`text-sm ${colors.text}`}>
            You are about to {actionWord} <strong>{count}</strong> {label}. This action will be
            recorded in the audit log.
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={<Icon className="w-4 h-4" />}
            onClick={onConfirm}
            loading={loading}
          >
            {actionWord === 'delete' ? 'Delete' : actionWord === 'deactivate' ? 'Deactivate' : 'Cancel'} {count} {label}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
