/**
 * OfflineBanner — Shows a warning banner when the user is offline.
 * Also displays the count of pending actions waiting to sync.
 * Auto-syncs when the connection comes back.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { WifiOff, RefreshCw, CheckCircle2, ClipboardList } from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useAuth } from '../../contexts/AuthContext';
import { useBelowCostApproval } from '../../contexts/BelowCostApprovalContext';
import {
  getOfflineStorageErrorMessage,
  getQueueSummary,
  type OfflineQueueSummary,
} from '../../lib/offlineQueue';
import { RETRY_DELAYS_MS, syncPendingActions, type OfflineSyncResult } from '../../lib/offlineSync';
import OfflineWorkPanel from './OfflineWorkPanel';

const EMPTY_SUMMARY: OfflineQueueSummary = {
  ownedTotal: 0,
  ownedAutoSyncable: 0,
  ownedNeedsAttention: 0,
  ownedOfficeResolved: 0,
  otherUserTotal: 0,
  ownerUnknownTotal: 0,
  nextAutoSyncAt: null,
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const currentUserId = profile?.id ?? null;
  const [summary, setSummary] = useState<OfflineQueueSummary>(EMPTY_SUMMARY);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [syncResult, setSyncResult] = useState<OfflineSyncResult | null>(null);
  const [syncRetryAt, setSyncRetryAt] = useState<number | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const syncingRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check pending count periodically
  const checkQueue = useCallback(async () => {
    try {
      setSummary(await getQueueSummary(currentUserId));
      setStorageError(null);
    } catch (error) {
      const message = getOfflineStorageErrorMessage(error, '');
      if (message) setStorageError(message);
    }
  }, [currentUserId]);

  useEffect(() => {
    void checkQueue();
    const interval = setInterval(() => void checkQueue(), 5000);
    return () => {
      clearInterval(interval);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, [checkQueue]);

  const handleSync = useCallback(async (force = false) => {
    if (!currentUserId || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncResult(null);
    setSyncError(false);
    try {
      const result = await syncPendingActions(currentUserId, { force, runWithBelowCostApproval });
      setSyncResult(result);
      setSyncRetryAt(null);

      // Clear success message after 5 seconds
      if (result.synced > 0 && result.failed === 0 && result.needsAttention === 0) {
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => {
          setSyncResult(null);
          successTimerRef.current = null;
        }, 5000);
      }
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'Sync failed' } });
      setSyncError(true);
      setSyncRetryAt(Date.now() + RETRY_DELAYS_MS[0]);
    } finally {
      await checkQueue();
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [checkQueue, currentUserId, runWithBelowCostApproval]);

  // Schedule one replay when due. This deliberately does not depend on
  // `syncing`, so finishing a failed attempt cannot trigger an immediate loop.
  useEffect(() => {
    if (!isOnline || !currentUserId || summary.ownedAutoSyncable === 0) return;

    const queueNextAttemptMs = summary.nextAutoSyncAt
      ? new Date(summary.nextAutoSyncAt).getTime()
      : Date.now();
    const nextAttemptMs = Math.max(queueNextAttemptMs, syncRetryAt ?? 0);
    const delayMs = Number.isFinite(nextAttemptMs)
      ? Math.max(0, nextAttemptMs - Date.now())
      : 0;
    const timer = setTimeout(
      () => void handleSync(false),
      Math.min(delayMs, MAX_TIMER_DELAY_MS)
    );
    return () => clearTimeout(timer);
  }, [currentUserId, handleSync, isOnline, summary.nextAutoSyncAt, summary.ownedAutoSyncable, syncRetryAt]);

  const unresolvedTotal = summary.ownedTotal + summary.otherUserTotal + summary.ownerUnknownTotal;
  const ownedWaiting = summary.ownedTotal - summary.ownedNeedsAttention - summary.ownedOfficeResolved;

  // Show nothing if online and no pending actions and no sync result
  if (isOnline && unresolvedTotal === 0 && !storageError && (!syncResult || syncResult.synced === 0)) {
    return null;
  }

  // Show sync success briefly
  if (isOnline && unresolvedTotal === 0 && syncResult && syncResult.synced > 0 && syncResult.failed === 0) {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 py-2 flex items-center justify-center gap-2 text-sm text-green-700">
        <CheckCircle2 className="h-4 w-4" />
        <span>{syncResult.synced} action{syncResult.synced !== 1 ? 's' : ''} synced successfully</span>
      </div>
    );
  }

  return (
    <div className={`${isOnline ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'} border-b px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-sm`}>
      <div className="flex flex-wrap items-center gap-2">
        {!isOnline && (
          <>
            <WifiOff className="h-4 w-4 text-red-600" />
            <span className="text-red-700 font-medium">You are offline.</span>
          </>
        )}
        {ownedWaiting > 0 && (
          <span className={isOnline ? 'text-yellow-700' : 'text-red-600'}>
            {ownedWaiting} offline action{ownedWaiting !== 1 ? 's' : ''} waiting to sync
            {!isOnline && ' — they will sync when you reconnect'}
          </span>
        )}
        {summary.ownedNeedsAttention > 0 && (
          <span className="text-red-700 font-medium">
            {summary.ownedNeedsAttention} offline action{summary.ownedNeedsAttention !== 1 ? 's need' : ' needs'} attention — saved safely on this device
          </span>
        )}
        {summary.ownedOfficeResolved > 0 && (
          <span className="text-blue-700 font-medium">
            {summary.ownedOfficeResolved} office resolution{summary.ownedOfficeResolved !== 1 ? 's are' : ' is'} ready for your acknowledgement
          </span>
        )}
        {summary.otherUserTotal > 0 && (
          <span className="text-amber-800 font-medium">
            Offline work for another user is safely stored on this device. Sign in as that user to sync it.
          </span>
        )}
        {summary.ownerUnknownTotal > 0 && (
          <span className="text-red-700 font-medium">
            Older offline work needs support before it can sync. It has not been deleted.
          </span>
        )}
        {syncResult && syncResult.failed > 0 && (
          <span className="text-red-600">
            {syncResult.failed} action{syncResult.failed !== 1 ? 's' : ''} failed to sync and remain saved
          </span>
        )}
        {syncError && (
          <span className="text-red-600">Sync failed — please try again</span>
        )}
        {storageError && (
          <span className="text-red-700 font-medium">{storageError}</span>
        )}
      </div>

      {currentUserId && summary.ownedTotal > 0 && (
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setWorkPanelOpen(true)}
            className="flex min-h-11 items-center gap-1 text-blue-700 hover:text-blue-800 font-medium"
          >
            <ClipboardList className="h-4 w-4" />
            Review
          </button>
          {isOnline && ownedWaiting + summary.ownedNeedsAttention > 0 && (
            <button
              type="button"
              onClick={() => void handleSync(true)}
              disabled={syncing}
              className="flex min-h-11 items-center gap-1 text-blue-600 hover:text-blue-700 font-medium"
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : summary.ownedNeedsAttention > 0 ? 'Try Again' : 'Sync Now'}
            </button>
          )}
        </div>
      )}

      {currentUserId && (
        <OfflineWorkPanel
          open={workPanelOpen}
          currentUserId={currentUserId}
          isOnline={isOnline}
          onClose={() => setWorkPanelOpen(false)}
          onRetry={() => handleSync(true)}
          onChanged={checkQueue}
        />
      )}
    </div>
  );
}
