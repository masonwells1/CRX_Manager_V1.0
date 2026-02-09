/**
 * Offline Sync Service — Processes the offline queue when connection returns.
 * Maps stored operations to actual Supabase RPC calls.
 */
import { supabase } from './db';
import { getPendingActions, removeAction, updateAction, type PendingAction } from './offlineQueue';

const MAX_RETRIES = 3;

/**
 * Process all pending actions in the offline queue.
 * Called automatically when the browser comes back online.
 * Returns the number of successfully synced actions.
 */
export async function syncPendingActions(): Promise<{ synced: number; failed: number }> {
  const actions = await getPendingActions();
  let synced = 0;
  let failed = 0;

  for (const action of actions) {
    try {
      await executeAction(action);
      await removeAction(action.id!);
      synced++;
    } catch (error: any) {
      const newRetryCount = action.retryCount + 1;

      if (newRetryCount >= MAX_RETRIES) {
        // Mark as permanently failed — keep in queue for manual review
        await updateAction({
          ...action,
          retryCount: newRetryCount,
          lastError: error.message || 'Unknown error',
        });
        failed++;
      } else {
        await updateAction({
          ...action,
          retryCount: newRetryCount,
          lastError: error.message || 'Unknown error',
        });
      }
    }
  }

  return { synced, failed };
}

/**
 * Execute a single queued action against Supabase.
 */
async function executeAction(action: PendingAction): Promise<void> {
  switch (action.operation) {
    case 'complete_delivery': {
      const { error } = await supabase.rpc('complete_delivery', action.params);
      if (error) throw error;
      break;
    }
    case 'record_payment': {
      const { error } = await supabase.rpc('record_payment', action.params);
      if (error) throw error;
      break;
    }
    case 'receive_po_items': {
      const { error } = await supabase.rpc('receive_po_items', action.params);
      if (error) throw error;
      break;
    }
    case 'update_order_items': {
      const { error } = await supabase.rpc('update_order_items', action.params);
      if (error) throw error;
      break;
    }
    default:
      throw new Error(`Unknown operation: ${action.operation}`);
  }
}
