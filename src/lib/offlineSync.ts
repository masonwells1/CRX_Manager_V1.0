/**
 * Offline Sync Service — Processes the offline queue when connection returns.
 * Maps stored operations to actual Supabase RPC calls.
 */
import { supabase, assertRpcResult } from './db';
import { Sentry } from './sentry';
import type { Database } from '../types/supabase';
import { withBelowCostReason, type BelowCostApprovalRunner } from './belowCostApproval';
import {
  getPendingActions,
  getActionOwnerUserId,
  OFFLINE_MAX_RETRIES,
  prepareLegacyQueuedAction,
  removeAction,
  updateAction,
  type PendingAction,
} from './offlineQueue';
import {
  executeDurableOfflineAction,
  isDurableOfflineOperation,
  OfflineReceiptSyncError,
} from './offlineReceipts';

export const MAX_RETRIES = OFFLINE_MAX_RETRIES;
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
const MAX_SESSION_MISMATCH_DEFERRALS = 3;

export interface OfflineSyncResult {
  synced: number;
  failed: number;
  deferred: number;
  skippedOtherUser: number;
  needsAttention: number;
  conflicts: string[];
}

let activeSync: { userId: string; promise: Promise<OfflineSyncResult> } | null = null;

/** Known RPC-name union from the generated DB types. */
type FunctionName = keyof Database['public']['Functions'];
/** Args shape the typed client expects for a given RPC. */
type FunctionArgs<N extends FunctionName> = Database['public']['Functions'][N] extends {
  Args: infer A;
}
  ? A
  : never;

/**
 * Process all pending actions in the offline queue.
 * Called automatically when the browser comes back online.
 * Unresolved actions are never automatically deleted. A single in-memory
 * promise prevents overlapping replay loops within the current browser tab.
 */
export function syncPendingActions(
  currentUserId: string,
  options: { force?: boolean; runWithBelowCostApproval?: BelowCostApprovalRunner } = {}
): Promise<OfflineSyncResult> {
  if (activeSync) {
    if (activeSync.userId === currentUserId && !options.force) return activeSync.promise;
    return activeSync.promise.then(
      () => syncPendingActions(currentUserId, options),
      () => syncPendingActions(currentUserId, options),
    );
  }

  const promise: Promise<OfflineSyncResult> = processPendingActions(currentUserId, options).finally(() => {
    if (activeSync?.promise === promise) activeSync = null;
  });
  activeSync = { userId: currentUserId, promise };
  return promise;
}

async function processPendingActions(
  currentUserId: string,
  { force = false, runWithBelowCostApproval }: { force?: boolean; runWithBelowCostApproval?: BelowCostApprovalRunner }
): Promise<OfflineSyncResult> {
  const now = Date.now();
  const attemptTimestamp = new Date(now).toISOString();

  const actions = await getPendingActions();
  let synced = 0;
  let failed = 0;
  let deferred = 0;
  let skippedOtherUser = 0;
  let needsAttention = 0;
  const conflicts: string[] = [];

  for (const storedAction of actions) {
    const ownerUserId = getActionOwnerUserId(storedAction);
    if (!ownerUserId) {
      needsAttention++;
      if (storedAction.status !== 'needs_attention' || storedAction.lastError !== 'Offline action owner could not be determined') {
        const message = 'Offline action owner could not be determined';
        await updateAction({
          ...storedAction,
          status: 'needs_attention',
          lastError: message,
        });
        captureNeedsAttention(storedAction, 'owner_unknown', message);
      }
      continue;
    }

    // Shared device safety: another user's session must never execute, age, or
    // consume retries for the original user's saved work.
    if (ownerUserId !== currentUserId) {
      skippedOtherUser++;
      continue;
    }

    let action = storedAction;
    if (!action.ownerUserId) {
      action = { ...action, ownerUserId };
      await updateAction(action);
    }

    // Version-1 IndexedDB rows are never rewritten during schema upgrade. Give
    // an approved legacy delivery/job action its permanent receipt identity
    // lazily, then persist that identity before the first network request.
    if (
      isDurableOfflineOperation(action.operation)
      && (!action.clientActionId || !action.idempotencyKey || action.schemaVersion !== 1)
    ) {
      try {
        const { id, ...withoutId } = action;
        action = { ...await prepareLegacyQueuedAction(withoutId), id };
        await updateAction(action);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : 'receipt identity could not be created';
        const message = `Legacy offline action needs manual review: ${detail}`;
        needsAttention++;
        await updateAction({
          ...action,
          status: 'needs_attention',
          nextAttemptAt: undefined,
          lastError: message,
        });
        captureNeedsAttention(action, 'legacy_receipt_identity_missing', message);
        continue;
      }
    }

    if (action.status === 'office_resolved') {
      needsAttention++;
      continue;
    }

    const alreadyNeedsAttention = action.status === 'needs_attention' || action.retryCount >= MAX_RETRIES;
    if (!force && alreadyNeedsAttention) {
      needsAttention++;
      continue;
    }

    const performedBy = action.params.p_performed_by;
    if (typeof performedBy === 'string' && performedBy !== ownerUserId) {
      const message = 'Offline action actor does not match its saved owner';
      failed++;
      needsAttention++;
      await updateAction({
        ...action,
        status: 'needs_attention',
        nextAttemptAt: undefined,
        lastError: message,
      });
      captureNeedsAttention(action, 'actor_owner_mismatch', message);
      continue;
    }

    const nextAttemptMs = action.nextAttemptAt ? new Date(action.nextAttemptAt).getTime() : 0;
    if (!force && Number.isFinite(nextAttemptMs) && nextAttemptMs > now) {
      deferred++;
      continue;
    }

    try {
      // Never synthesize a missing queue-time snapshot after reconnecting.
      // Doing so would accept office edits made during the offline window as
      // the action's baseline. The durable server path stages these actions as
      // permanent LEGACY_OUTCOME_UNKNOWN review work instead.
      await executeAction(action, runWithBelowCostApproval);
      await removeAction(action.id!);
      synced++;
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const errMsg = error instanceof Error
        ? error.message
        : typeof errObj?.message === 'string'
          ? errObj.message
          : 'Unknown error';

      if (error instanceof OfflineReceiptSyncError) {
        if (error.disposition === 'retry_later') {
          await updateAction({
            ...action,
            status: 'retry_wait',
            nextAttemptAt: new Date(now + (error.retryAfterMs ?? RETRY_DELAYS_MS[0])).toISOString(),
            lastAttemptAt: attemptTimestamp,
            lastError: error.message,
          });
          deferred++;
          continue;
        }

        const receipt = error.receipt;
        await updateAction({
          ...action,
          status: error.disposition === 'office_resolved' ? 'office_resolved' : 'needs_attention',
          nextAttemptAt: undefined,
          lastAttemptAt: attemptTimestamp,
          lastError: error.message,
          officeResolution: receipt?.review_resolution ?? action.officeResolution,
          officeResolutionNote: receipt?.review_note ?? action.officeResolutionNote,
          officeResolvedAt: receipt?.resolved_at ?? action.officeResolvedAt,
        });
        if (error.disposition === 'needs_attention') failed++;
        needsAttention++;
        captureNeedsAttention(action, error.disposition, error.message);
        continue;
      }

      // Track conflicts separately so UI can show them
      if (errMsg.startsWith('Conflict:')) {
        conflicts.push(errMsg);
        await updateAction({
          ...action,
          retryCount: Math.max(action.retryCount, MAX_RETRIES),
          status: 'needs_attention',
          nextAttemptAt: undefined,
          lastAttemptAt: attemptTimestamp,
          lastError: errMsg,
        });
        failed++;
        needsAttention++;
        captureNeedsAttention(action, 'conflict', errMsg);
        continue;
      }

      // The authenticated Supabase session may have changed while an earlier
      // action was awaiting its RPC. Do not consume a retry or quarantine the
      // original user's work; apply only a short persisted cooldown so a stale
      // auth context cannot create another immediate replay loop.
      if (isSessionMismatch(errMsg)) {
        const sessionMismatchCount = (action.sessionMismatchCount ?? 0) + 1;
        const needsSessionReview = sessionMismatchCount >= MAX_SESSION_MISMATCH_DEFERRALS;
        await updateAction({
          ...action,
          status: needsSessionReview ? 'needs_attention' : 'retry_wait',
          nextAttemptAt: needsSessionReview
            ? undefined
            : new Date(now + RETRY_DELAYS_MS[0]).toISOString(),
          lastAttemptAt: attemptTimestamp,
          sessionMismatchCount,
          lastError: needsSessionReview
            ? 'Sync session could not be verified after repeated attempts'
            : 'Sync session changed before this action could finish',
        });
        if (needsSessionReview) {
          failed++;
          needsAttention++;
          captureNeedsAttention(
            action,
            'session_mismatch_limit',
            'Sync session could not be verified after repeated attempts'
          );
        } else {
          deferred++;
        }
        continue;
      }

      const newRetryCount = action.retryCount + 1;
      const permanentFailure = isPermanentFailure(errMsg) || newRetryCount >= MAX_RETRIES;
      const nextAttemptAt = permanentFailure
        ? undefined
        : new Date(now + retryDelayMs(newRetryCount)).toISOString();

      await updateAction({
        ...action,
        retryCount: newRetryCount,
        status: permanentFailure ? 'needs_attention' : 'retry_wait',
        nextAttemptAt,
        lastAttemptAt: attemptTimestamp,
        lastError: errMsg,
      });

      // Audit #29: Capture offline-sync failures in Sentry so silent retries
      // aren't invisible to oncall. Permanent failures (retryCount >= MAX)
      // get level=error; intermediate retries get level=warning.
      Sentry.captureException(error, {
        level: permanentFailure ? 'error' : 'warning',
        tags: { source: 'offlineSync', operation: action.operation },
        extra: {
          actionId: action.id,
          ownerUserId,
          retryCount: newRetryCount,
          maxRetries: MAX_RETRIES,
          entityTable: action.entityTable,
          entityId: action.entityId,
        },
      });

      failed++;
      if (permanentFailure) needsAttention++;
    }
  }

  return { synced, failed, deferred, skippedOtherUser, needsAttention, conflicts };
}

function retryDelayMs(retryCount: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(retryCount - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

function isSessionMismatch(message: string): boolean {
  const normalized = message.toLowerCase();
  // ACTOR_MISMATCH is the canonical actor-forgery token raised by save_customer,
  // save_quote (as of 2026-07-22), and other governed RPCs. The older
  // 'does not match authenticated user' string is kept so in-flight queued
  // actions from a pre-canonicalization client still classify correctly.
  return normalized.includes('actor_mismatch')
    || normalized.includes('does not match authenticated user')
    || normalized.includes('not authenticated');
}

function captureNeedsAttention(action: PendingAction, reason: string, message: string): void {
  Sentry.captureException(new Error(message), {
    level: 'error',
    tags: { source: 'offlineSync', operation: action.operation, reason },
    extra: {
      actionId: action.id,
      ownerUserId: getActionOwnerUserId(action),
      retryCount: action.retryCount,
      entityTable: action.entityTable,
      entityId: action.entityId,
    },
  });
}

function isPermanentFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('no longer exists')
    || normalized.includes('unknown offline operation')
    || normalized.includes('not authorized')
    || normalized.includes('must be in_progress');
}

/**
 * Execute a single queued action against Supabase.
 * Maps operation names to their corresponding RPC calls.
 */
async function executeAction(
  action: PendingAction,
  runWithBelowCostApproval?: BelowCostApprovalRunner,
): Promise<void> {
  const { operation, params } = action;

  // Conflict detection: if we captured a snapshot, check for server-side changes
  if (!isDurableOfflineOperation(operation) && action.snapshotAt && action.entityTable && action.entityId) {
    // entityTable is a runtime-dynamic name; for typing we treat it as a table
    // known to carry `updated_at` (the conflict path is only ever used for such
    // tables — deliveries/orders). The runtime value is still action.entityTable.
    const { data, error: lookupError } = await supabase
      .from(action.entityTable as 'deliveries')
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
      await executeDurableOfflineAction(action);
      return;
    }
    case 'allocate_payment': {
      const { data, error } = await supabase.rpc('allocate_payment', params as FunctionArgs<'allocate_payment'>);
      if (error) throw error;
      assertRpcResult(data, 'allocate_payment');
      return;
    }
    case 'receive_po_items': {
      const { data, error } = await supabase.rpc('receive_po_items', params as FunctionArgs<'receive_po_items'>);
      if (error) throw error;
      assertRpcResult(data, 'receive_po_items');
      return;
    }
    case 'update_order_items': {
      const execute = runWithBelowCostApproval ?? ((attempt) => attempt(null));
      const { data, error } = await execute((reason) => supabase.rpc(
        'update_order_items',
        withBelowCostReason(
          'update_order_items',
          params as FunctionArgs<'update_order_items'>,
          reason,
        ),
      ));
      if (error) throw error;
      assertRpcResult(data, 'update_order_items');
      return;
    }
    case 'complete_job': {
      await executeDurableOfflineAction(action);
      return;
    }
    case 'cancel_delivery': {
      const { data, error } = await supabase.rpc('cancel_delivery', params as FunctionArgs<'cancel_delivery'>);
      if (error) throw error;
      assertRpcResult(data, 'cancel_delivery');
      return;
    }
    case 'cancel_order': {
      const { data, error } = await supabase.rpc('cancel_order', params as FunctionArgs<'cancel_order'>);
      if (error) throw error;
      assertRpcResult(data, 'cancel_order');
      return;
    }
    case 'confirm_delivery': {
      const { data, error } = await supabase.rpc('confirm_delivery', params as FunctionArgs<'confirm_delivery'>);
      if (error) throw error;
      assertRpcResult(data, 'confirm_delivery');
      return;
    }
    case 'match_quick_receive_items': {
      const { data, error } = await supabase.rpc('match_quick_receive_items', params as FunctionArgs<'match_quick_receive_items'>);
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
