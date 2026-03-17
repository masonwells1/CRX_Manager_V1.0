/**
 * OfflineBanner — Shows a warning banner when the user is offline.
 * Also displays the count of pending actions waiting to sync.
 * Auto-syncs when the connection comes back.
 */
import { useEffect, useState, useCallback } from 'react';
import { WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react';
import * as Sentry from '@sentry/react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { getPendingCount } from '../../lib/offlineQueue';
import { syncPendingActions } from '../../lib/offlineSync';

export default function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: number } | null>(null);

  // Check pending count periodically
  useEffect(() => {
    checkPending();
    const interval = setInterval(checkPending, 5000);
    return () => clearInterval(interval);
  }, []);

  async function checkPending() {
    try {
      const count = await getPendingCount();
      setPendingCount(count);
    } catch {
      // IndexedDB not available
    }
  }

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(false);
    try {
      const result = await syncPendingActions();
      setSyncResult(result);
      await checkPending();

      // Clear success message after 5 seconds
      if (result.failed === 0) {
        setTimeout(() => setSyncResult(null), 5000);
      }
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'Sync failed' } });
      setSyncError(true);
    }
    setSyncing(false);
  }, []);

  // Auto-sync when coming back online or when items are queued while online
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !syncing) {
      handleSync();
    }
  }, [isOnline, pendingCount, syncing, handleSync]);

  // Show nothing if online and no pending actions and no sync result
  if (isOnline && pendingCount === 0 && !syncResult) {
    return null;
  }

  // Show sync success briefly
  if (isOnline && pendingCount === 0 && syncResult && syncResult.failed === 0) {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 py-2 flex items-center justify-center gap-2 text-sm text-green-700">
        <CheckCircle2 className="h-4 w-4" />
        <span>{syncResult.synced} action{syncResult.synced !== 1 ? 's' : ''} synced successfully</span>
      </div>
    );
  }

  return (
    <div className={`${isOnline ? 'bg-yellow-50 border-yellow-200' : 'bg-red-50 border-red-200'} border-b px-4 py-2 flex items-center justify-between text-sm`}>
      <div className="flex items-center gap-2">
        {!isOnline && (
          <>
            <WifiOff className="h-4 w-4 text-red-600" />
            <span className="text-red-700 font-medium">You are offline.</span>
          </>
        )}
        {pendingCount > 0 && (
          <span className={isOnline ? 'text-yellow-700' : 'text-red-600'}>
            {pendingCount} pending action{pendingCount !== 1 ? 's' : ''} waiting to sync
            {!isOnline && ' — they will sync when you reconnect'}
          </span>
        )}
        {syncResult && syncResult.failed > 0 && (
          <span className="text-red-600">
            {syncResult.failed} action{syncResult.failed !== 1 ? 's' : ''} failed to sync
          </span>
        )}
        {syncError && (
          <span className="text-red-600">Sync failed — please try again</span>
        )}
      </div>

      {isOnline && pendingCount > 0 && (
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync Now'}
        </button>
      )}
    </div>
  );
}
