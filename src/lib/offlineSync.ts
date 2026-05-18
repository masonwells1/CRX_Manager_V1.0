/**
 * Offline Sync Service — Processes the offline queue when connection returns.
 * Maps stored operations to actual Supabase RPC calls.
 */
import { supabase, assertRpcResult } from './db';
import { Sentry } from './sentry';
import {
  getPendingActions,
  removeAction,
  updateAction,
  clearFailedActions,
  clearStaleActions,
  type PendingAction,
} from './offlineQueue';

export const MAX_RETRIES = 3;

/**
 * Process all pending actions in the offline queue.
 * Called automatically when the browser comes back online.
 * Also cleans up stale/failed actions to prevent IndexedDB bloat.
 * Returns the number of successfully synced actions.
 */
export async function syncPendingActions(): Promise<{ synced: number; failed: number; cleaned: number; conflicts: string[] }> {
  // Cleanup: remove permanently failed + stale actions first
  const cleanedFailed = await clearFailedActions(MAX_RETRIES);
  const cleanedStale = await clearStaleActions();
  const cleaned = cleanedFailed + cleanedStale;

  const actions = await getPendingActions();
  let synced = 0;
  let failed = 0;
  const conflicts: string[] = [];

  for (const action of actions) {
    try {
      await executeAction(action);
      await removeAction(action.id!);
      synced++;
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const errMsg = error instanceof Error
        ? error.message
        : typeof errObj?.message === 'string'
          ? errObj.message
          : 'Unknown error';

      // Track conflicts separately so UI can show them
      if (errMsg.startsWith('Conflict:')) {
        conflicts.push(errMsg);
        await updateAction({
          ...action,
          retryCount: MAX_RETRIES, // Mark as permanently failed
          lastError: errMsg,
        });
        failed++;
        continue;
      }

      const newRetryCount = action.retryCount + 1;

      await updateAction({
        ...action,
        retryCount: newRetryCount,
        lastError: errMsg,
      });

      // Audit #29: Capture offline-sync failures in Sentry so silent retries
      // aren't invisible to oncall. Permanent failures (retryCount >= MAX)
      // get level=error; intermediate retries get level=warning.
      Sentry.captureException(error, {
        level: newRetryCount >= MAX_RETRIES ? 'error' : 'warning',
        tags: { source: 'offlineSync', operation: action.operation },
        extra: {
          actionId: action.id,
          retryCount: newRetryCount,
          maxRetries: MAX_RETRIES,
          entityTable: action.entityTable,
          entityId: action.entityId,
        },
      });

      if (newRetryCount >= MAX_RETRIES) {
        failed++;
      }
    }
  }

  return { synced, failed, cleaned, conflicts };
}

/**
 * Execute a single queued action against Supabase.
 * Maps operation names to their corresponding RPC calls.
 */
async function executeAction(action: PendingAction): Promise<void> {
  const { operation, params } = action;

  // Conflict detection: if we captured a snapshot, check for server-side changes
  if (action.snapshotAt && action.entityTable && action.entityId) {
    const { data, error: lookupError } = await supabase
      .from(action.entityTable)
      .select('updated_at')
      .eq('id', action.entityId)
      .maybeSingle();

    if (lookupError) {
      // Query itself failed (network error, RLS denial, etc.) — don't misreport as "deleted"
      throw new Error(
        `Failed to check ${action.entityTable} ${action.entityId} for conflicts: ${lookupError.message}. ` +
        `Action '${action.operation}' deferred.`
      );
    }

    if (!data) {
      // Entity was deleted while offline — skip this action
      throw new Error(
        `Entity ${action.entityTable} ${action.entityId} no longer exists. ` +
        `Action '${action.operation}' skipped.`
      );
    }

    if (new Date(data.updated_at) > new Date(action.snapshotAt)) {
      throw new Error(
        `Conflict: ${action.entityTable} ${action.entityId} was modified ` +
        `while offline (server: ${data.updated_at}, queued: ${action.snapshotAt}). ` +
        `Action '${operation}' skipped to prevent data loss.`
      );
    }
  }

  // Audit 2026-05-16 P1 #3: all mapped offline RPCs return jsonb (verified
  // via pg_proc). If supabase returns { data: null, error: null } — RLS denial
  // on a chained SELECT, trigger fail-soft path, etc. — the action would be
  // silently removed as synced. assertRpcResult throws on null data so the
  // action is retained in queue for retry.
  //
  // Per-branch literal RPC names (not a dynamic `supabase.rpc(name, ...)`)
  // because assertRpcCoverage.test.ts's regex only matches string-literal call
  // sites. See LogbookReport.tsx for the canonical example of this shape.
  switch (operation) {
    case 'complete_delivery': {
      const { data, error } = await supabase.rpc('complete_delivery', params);
      if (error) throw error;
      assertRpcResult(data, 'complete_delivery');
      return;
    }
    case 'allocate_payment': {
      const { data, error } = await supabase.rpc('allocate_payment', params);
      if (error) throw error;
      assertRpcResult(data, 'allocate_payment');
      return;
    }
    case 'receive_po_items': {
      const { data, error } = await supabase.rpc('receive_po_items', params);
      if (error) throw error;
      assertRpcResult(data, 'receive_po_items');
      return;
    }
    case 'update_order_items': {
      const { data, error } = await supabase.rpc('update_order_items', params);
      if (error) throw error;
      assertRpcResult(data, 'update_order_items');
      return;
    }
    case 'complete_job': {
      const { data, error } = await supabase.rpc('complete_job', params);
      if (error) throw error;
      assertRpcResult(data, 'complete_job');
      return;
    }
    case 'cancel_delivery': {
      const { data, error } = await supabase.rpc('cancel_delivery', params);
      if (error) throw error;
      assertRpcResult(data, 'cancel_delivery');
      return;
    }
    case 'cancel_order': {
      const { data, error } = await supabase.rpc('cancel_order', params);
      if (error) throw error;
      assertRpcResult(data, 'cancel_order');
      return;
    }
    case 'confirm_delivery': {
      const { data, error } = await supabase.rpc('confirm_delivery', params);
      if (error) throw error;
      assertRpcResult(data, 'confirm_delivery');
      return;
    }
    case 'match_quick_receive_items': {
      const { data, error } = await supabase.rpc('match_quick_receive_items', params);
      if (error) throw error;
      assertRpcResult(data, 'match_quick_receive_items');
      return;
    }
    default:
      throw new Error(
        `Unknown offline operation: ${operation}. Valid operations: ` +
        `complete_delivery, allocate_payment, receive_po_items, update_order_items, ` +
        `complete_job, cancel_delivery, cancel_order, confirm_delivery, match_quick_receive_items`
      );
  }
}
