import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clipboard, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  getActionOwnerUserId,
  getPendingActions,
  removeAction,
  type PendingAction,
} from '../../lib/offlineQueue';
import { Sentry } from '../../lib/sentry';
import Button from './Button';
import ConfirmModal from './ConfirmModal';
import Modal from './Modal';
import { useToast } from './Toast';

interface OfflineWorkPanelProps {
  open: boolean;
  currentUserId: string;
  isOnline: boolean;
  onClose: () => void;
  onRetry: () => Promise<void>;
  onChanged: () => Promise<void>;
}

function safeActionLabel(action: PendingAction): string {
  return action.operation === 'complete_delivery'
    ? 'Complete delivery'
    : action.operation === 'complete_job'
      ? 'Complete job'
      : 'Saved offline action';
}

function actionHref(action: PendingAction): string | null {
  if (!action.entityId) return null;
  if (action.operation === 'complete_delivery') return `/deliveries/${action.entityId}`;
  if (action.operation === 'complete_job') return `/jobs/${action.entityId}`;
  return null;
}

function statusLabel(action: PendingAction): string {
  if (action.status === 'office_resolved') return 'Office resolved — acknowledgement required';
  if (action.status === 'needs_attention') return 'Needs attention';
  if (action.status === 'retry_wait') return 'Retrying later';
  return 'Waiting to sync';
}

export default function OfflineWorkPanel({
  open,
  currentUserId,
  isOnline,
  onClose,
  onRetry,
  onChanged,
}: OfflineWorkPanelProps) {
  const { toast } = useToast();
  const [actions, setActions] = useState<PendingAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeAction, setAcknowledgeAction] = useState<PendingAction | null>(null);

  const loadActions = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const pending = await getPendingActions();
      setActions(pending.filter((action) => getActionOwnerUserId(action) === currentUserId));
    } catch (error) {
      Sentry.captureException(error, { tags: { component: 'OfflineWorkPanel', action: 'load' } });
      toast('error', 'Could not read saved offline work on this device.');
    } finally {
      setLoading(false);
    }
  }, [currentUserId, open, toast]);

  useEffect(() => {
    void loadActions();
  }, [loadActions]);

  const unresolvedCount = useMemo(
    () => actions.filter((action) => action.status !== 'office_resolved').length,
    [actions],
  );

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry();
      await loadActions();
    } finally {
      setRetrying(false);
    }
  };

  const handleCopySupportId = async (clientActionId: string | undefined) => {
    if (!clientActionId) {
      toast('error', 'This older saved action does not have a support ID yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(clientActionId);
      toast('success', 'Support ID copied.');
    } catch (error) {
      Sentry.captureException(error, { tags: { component: 'OfflineWorkPanel', action: 'copy_support_id' } });
      toast('error', 'Could not copy the support ID.');
    }
  };

  const handleAcknowledge = async () => {
    if (!acknowledgeAction?.id) return;
    setAcknowledging(true);
    try {
      await removeAction(acknowledgeAction.id);
      setAcknowledgeAction(null);
      await loadActions();
      await onChanged();
      toast('success', 'Office resolution acknowledged and removed from this device.');
    } catch (error) {
      Sentry.captureException(error, { tags: { component: 'OfflineWorkPanel', action: 'acknowledge' } });
      toast('error', 'Could not acknowledge this office resolution.');
    } finally {
      setAcknowledging(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Saved Offline Work"
        size="large"
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={onClose} className="min-h-11">Close</Button>
            {unresolvedCount > 0 && isOnline && (
              <Button
                onClick={() => void handleRetry()}
                loading={retrying}
                icon={<RefreshCw className="h-4 w-4" />}
                className="min-h-11"
              >
                Retry saved work
              </Button>
            )}
            {unresolvedCount > 0 && !isOnline && (
              <span className="self-center text-sm text-amber-700">Reconnect before retrying saved work.</span>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            These records stay on this device until the server proves success or you acknowledge an audited office resolution. Raw saved payloads are never shown here.
          </div>

          {loading && <p className="py-8 text-center text-sm text-secondary">Reading this device&apos;s saved work…</p>}

          {!loading && actions.length === 0 && (
            <div className="py-10 text-center">
              <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-crx-green" />
              <p className="font-medium text-primary">No saved offline work remains.</p>
            </div>
          )}

          {!loading && actions.map((action) => {
            const href = actionHref(action);
            const officeResolved = action.status === 'office_resolved';
            return (
              <article key={action.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className={`h-5 w-5 ${officeResolved ? 'text-blue-600' : 'text-amber-600'}`} />
                      <h3 className="font-semibold text-primary">{safeActionLabel(action)}</h3>
                    </div>
                    <p className={`mt-1 text-sm font-medium ${officeResolved ? 'text-blue-700' : 'text-amber-700'}`}>
                      {statusLabel(action)}
                    </p>
                    <p className="mt-1 text-xs text-tertiary">
                      Saved {new Date(action.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {href && (
                    <Link
                      to={href}
                      onClick={onClose}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-primary hover:bg-gray-50"
                    >
                      Open record <ExternalLink className="h-4 w-4" />
                    </Link>
                  )}
                </div>

                {action.lastError && (
                  <p className="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-secondary">{action.lastError}</p>
                )}

                {officeResolved && action.officeResolutionNote && (
                  <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Office note</p>
                    <p className="mt-1 text-sm text-blue-900">{action.officeResolutionNote}</p>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Clipboard className="h-4 w-4" />}
                    onClick={() => void handleCopySupportId(action.clientActionId)}
                  >
                    Copy support ID
                  </Button>
                  {officeResolved && (
                    <Button size="sm" onClick={() => setAcknowledgeAction(action)}>
                      Acknowledge resolution
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </Modal>

      <ConfirmModal
        open={acknowledgeAction !== null}
        onClose={() => setAcknowledgeAction(null)}
        onConfirm={() => void handleAcknowledge()}
        title="Acknowledge office resolution?"
        message="This removes only the saved browser copy after the office recorded a permanent audited resolution. It does not rerun or undo inventory work."
        confirmLabel="Acknowledge and remove"
        variant="info"
        loading={acknowledging}
      />
    </>
  );
}
