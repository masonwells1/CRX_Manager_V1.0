/**
 * Offline Sync Service — Processes the offline queue when connection returns.
 * Maps stored operations to actual Supabase RPC calls.
 */
import { supabase } from './db';
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

  // All operations follow the same pattern: call supabase.rpc with params
  const rpcOperations: Record<string, string> = {
    complete_delivery: 'complete_delivery',
    allocate_payment: 'allocate_payment',
    receive_po_items: 'receive_po_items',
    update_order_items: 'update_order_items',
    complete_job: 'complete_job',
    cancel_delivery: 'cancel_delivery',
    cancel_order: 'cancel_order',
    confirm_delivery: 'confirm_delivery',
    match_quick_receive_items: 'match_quick_receive_items',
  };

  const rpcName = rpcOperations[operation];
  if (!rpcName) {
    throw new Error(`Unknown offline operation: ${operation}. Valid operations: ${Object.keys(rpcOperations).join(', ')}`);
  }

  const { error } = await supabase.rpc(rpcName, params);
  if (error) throw error;
}
