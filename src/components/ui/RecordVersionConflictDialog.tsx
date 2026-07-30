import { useEffect, useState } from 'react';
import ConfirmModal from './ConfirmModal';

interface RecordVersionConflictDialogProps {
  open: boolean;
  entityLabel: 'quote' | 'customer';
  onKeepEditing: () => void;
  onReload: () => void | Promise<void>;
}

/** Shared fail-closed UI; it never retries or merges a stale payload. */
export default function RecordVersionConflictDialog({ open, entityLabel, onKeepEditing, onReload }: RecordVersionConflictDialogProps) {
  const label = entityLabel === 'quote' ? 'Quote' : 'Customer';
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);

  useEffect(() => {
    if (!open) {
      setReloading(false);
      setReloadFailed(false);
    }
  }, [open]);

  const handleReload = async () => {
    if (reloading) return;
    setReloadFailed(false);
    setReloading(true);
    try {
      await onReload();
    } catch {
      setReloadFailed(true);
    } finally {
      setReloading(false);
    }
  };

  return (
    <ConfirmModal
      open={open}
      onClose={onKeepEditing}
      onConfirm={() => { void handleReload(); }}
      title={`${label} needs a refresh before saving`}
      message={reloadFailed
        ? `Reload could not finish. Your unsaved ${entityLabel} edits are still available; check your connection and try again.`
        : `This ${entityLabel} may have changed in another workflow, or its current version could not be confirmed. Reload to review the saved version before trying again. Your unsaved edits stay available until you choose Reload.`}
      confirmLabel={`Reload ${label}`}
      cancelLabel="Keep editing"
      variant="warning"
      loading={reloading}
    />
  );
}
