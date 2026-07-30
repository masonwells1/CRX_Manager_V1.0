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
  return (
    <ConfirmModal
      open={open}
      onClose={onKeepEditing}
      onConfirm={() => { void onReload(); }}
      title={`${label} needs a refresh before saving`}
      message={`This ${entityLabel} may have changed in another workflow, or its current version could not be confirmed. Reload to review the saved version before trying again. Your unsaved edits stay available until you choose Reload.`}
      confirmLabel={`Reload ${label}`}
      cancelLabel="Keep editing"
      variant="warning"
    />
  );
}
