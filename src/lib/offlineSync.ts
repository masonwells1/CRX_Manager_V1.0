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
export async function syncPendingActions(): Promise<{ synced: number; failed: number; cleaned: number }> {
  // Cleanup: remove permanently failed + stale actions first
  const cleanedFailed = await clearFailedActions(MAX_RETRIES);
  const cleanedStale = await clearStaleActions();
  const cleaned = cleanedFailed + cleanedStale;

  const actions = await getPendingActions();
  let synced = 0;
  let failed = 0;

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

  return { synced, failed, cleaned };
}

/**
 * Execute a single queued action against Supabase.
 * Maps operation names to their corresponding RPC calls.
 */
async function executeAction(action: PendingAction): Promise<void> {
  const { operation, params } = action;

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
