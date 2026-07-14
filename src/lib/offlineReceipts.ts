import type {
  OfflineActionOperation,
  OfflineActionReceiptResult,
  OfflineActionStatusResult,
  StageOfflineActionArgs,
} from '../types';
import type { Json } from '../types/supabase';
import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabase } from './db';
import type { PendingAction } from './offlineQueue';

export const DAILY_CAP_RETRY_DELAY_MS = 60 * 60 * 1000;
export const REVIEW_BACKLOG_RETRY_DELAY_MS = 60 * 60 * 1000;

export type OfflineReceiptDisposition =
  | 'retry_later'
  | 'needs_attention'
  | 'office_resolved';

/**
 * A durable receipt reached a known state that the generic network retry path
 * must not reinterpret. The caller uses this disposition to retain the local
 * action with the correct next step.
 */
export class OfflineReceiptSyncError extends Error {
  constructor(
    message: string,
    readonly disposition: OfflineReceiptDisposition,
    readonly retryAfterMs?: number,
    readonly receipt?: OfflineActionReceiptResult,
  ) {
    super(message);
    this.name = 'OfflineReceiptSyncError';
  }
}

export function isDurableOfflineOperation(operation: string): operation is OfflineActionOperation {
  return operation === 'complete_delivery' || operation === 'complete_job';
}

function asJsonObject(value: unknown, label: string): { [key: string]: Json | undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as { [key: string]: Json | undefined };
}

/** Map trusted canonical RPC arguments to the narrower receipt payload. */
export function buildOfflineReceiptPayload(
  operation: OfflineActionOperation,
  params: Record<string, unknown>,
): { [key: string]: Json | undefined } {
  if (operation === 'complete_job') {
    return asJsonObject(params.p_applied_info, 'complete_job applied info');
  }

  const signedBy = params.p_signed_by;
  if (typeof signedBy !== 'string' || signedBy.trim().length === 0) {
    throw new Error('complete_delivery signed_by is required');
  }

  const payload: { [key: string]: Json | undefined } = {
    signed_by: signedBy,
  };
  if (params.p_quantities !== undefined) payload.quantities = params.p_quantities as Json;
  if (params.p_issue_type !== undefined) payload.issue_type = params.p_issue_type as Json;
  if (params.p_issue_notes !== undefined) payload.issue_notes = params.p_issue_notes as Json;
  if (params.p_completed_at !== undefined) payload.completed_at = params.p_completed_at as Json;
  return payload;
}

function requireDurableIdentity(action: PendingAction): {
  operation: OfflineActionOperation;
  clientActionId: string;
  idempotencyKey: string;
  entityId: string;
  schemaVersion: 1;
} {
  if (!isDurableOfflineOperation(action.operation)) {
    throw new Error(`Operation ${action.operation} does not use permanent offline receipts`);
  }
  if (!action.clientActionId || !action.idempotencyKey || !action.entityId || action.schemaVersion !== 1) {
    throw new Error('Durable offline action identity is incomplete');
  }
  return {
    operation: action.operation,
    clientActionId: action.clientActionId,
    idempotencyKey: action.idempotencyKey,
    entityId: action.entityId,
    schemaVersion: action.schemaVersion,
  };
}

function receiptStateError(receipt: OfflineActionReceiptResult): OfflineReceiptSyncError | null {
  if (receipt.status !== 'needs_review') return null;

  if (receipt.resolved_at && receipt.review_resolution) {
    const outcome = receipt.review_resolution === 'already_completed'
      ? 'The office confirmed this work was already handled.'
      : 'The office confirmed this saved action must not run.';
    return new OfflineReceiptSyncError(
      `${outcome} Review the office note and acknowledge it on this device.`,
      'office_resolved',
      undefined,
      receipt,
    );
  }

  return new OfflineReceiptSyncError(
    receipt.failure_summary ?? 'The server kept this action for office review.',
    'needs_attention',
    undefined,
    receipt,
  );
}

async function stageOfflineAction(action: PendingAction): Promise<OfflineActionReceiptResult> {
  const identity = requireDurableIdentity(action);
  const args: StageOfflineActionArgs = {
    p_client_action_id: identity.clientActionId,
    p_operation: identity.operation,
    p_entity_id: identity.entityId,
    p_schema_version: identity.schemaVersion,
    p_client_created_at: action.createdAt,
    p_payload: buildOfflineReceiptPayload(identity.operation, action.params),
    p_idempotency_key: identity.idempotencyKey,
    ...(action.snapshotAt ? { p_entity_snapshot_at: action.snapshotAt } : {}),
  };

  const { data, error } = await supabase.rpc('stage_offline_action', args);
  if (error) {
    if (hasRpcCode(error, RpcErrorCodes.OFFLINE_STAGE_REVIEW_BACKLOG)) {
      throw new OfflineReceiptSyncError(
        'The office review backlog must be cleared before this action can reach the server. It remains saved and will retry automatically.',
        'retry_later',
        REVIEW_BACKLOG_RETRY_DELAY_MS,
      );
    }
    if (
      hasRpcCode(error, RpcErrorCodes.OFFLINE_STAGE_DAILY_CAP)
      || hasRpcCode(error, RpcErrorCodes.OFFLINE_STAGE_RATE_LIMIT)
    ) {
      throw new OfflineReceiptSyncError(
        'The server staging limit was reached. This action remains saved and will retry later.',
        'retry_later',
        DAILY_CAP_RETRY_DELAY_MS,
      );
    }
    throw error;
  }
  return assertRpcResult<OfflineActionReceiptResult>(data, 'stage_offline_action');
}

export async function getOfflineReceiptStatus(clientActionId: string): Promise<OfflineActionStatusResult> {
  const { data, error } = await supabase.rpc('get_offline_action_status', {
    p_client_action_id: clientActionId,
  });
  if (error) throw error;
  return assertRpcResult<OfflineActionStatusResult>(data, 'get_offline_action_status');
}

/**
 * Stage, process, and recover one durable offline action. Returning means the
 * server permanently proves success. Every other known outcome throws a typed
 * retention instruction so the IndexedDB copy cannot be deleted accidentally.
 */
export async function executeDurableOfflineAction(
  action: PendingAction,
): Promise<OfflineActionReceiptResult> {
  const identity = requireDurableIdentity(action);
  const staged = await stageOfflineAction(action);
  if (staged.status === 'succeeded') return staged;
  if (staged.status === 'needs_review') {
    // Exact stage replays intentionally return the base receipt shape, which
    // predates office-resolution metadata. Fetch the sanitized full status so
    // an original device can discover and acknowledge the office decision.
    const status = await getOfflineReceiptStatus(identity.clientActionId);
    throw receiptStateError(status)
      ?? new OfflineReceiptSyncError('The server kept this action for office review.', 'needs_attention', undefined, status);
  }
  const stagedStateError = receiptStateError(staged);
  if (stagedStateError) throw stagedStateError;

  const { data, error } = await supabase.rpc('process_offline_action', {
    p_client_action_id: identity.clientActionId,
    p_idempotency_key: identity.idempotencyKey,
  });
  if (error) {
    if (hasRpcCode(error, RpcErrorCodes.OFFLINE_ACTION_NEEDS_REVIEW)) {
      const status = await getOfflineReceiptStatus(identity.clientActionId);
      throw receiptStateError(status)
        ?? new OfflineReceiptSyncError('The server kept this action for office review.', 'needs_attention', undefined, status);
    }
    throw error;
  }

  const processed = assertRpcResult<OfflineActionReceiptResult>(data, 'process_offline_action');
  if (processed.status === 'succeeded') return processed;
  throw receiptStateError(processed)
    ?? new OfflineReceiptSyncError('The server did not provide permanent success proof.', 'needs_attention', undefined, processed);
}
