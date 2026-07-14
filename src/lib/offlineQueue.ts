/**
 * Offline Queue — IndexedDB-based queue for pending operations.
 * When the driver is offline, critical actions (like delivery completion)
 * are saved locally and auto-synced when the connection returns.
 */

const DB_NAME = 'crx_offline_queue';
const DB_VERSION = 2;
const STORE_NAME = 'pending_actions';
const LEGACY_OWNER_INFERENCE_OPERATIONS = new Set(['complete_delivery', 'complete_job']);
const DURABLE_RECEIPT_OPERATIONS = new Set(['complete_delivery', 'complete_job']);
export const OFFLINE_MAX_RETRIES = 4;
export const OFFLINE_DB_UPGRADE_BLOCKED_MESSAGE =
  'Offline storage could not update because CRX Manager is open in another tab or app window. Close the other CRX Manager tabs and try again.';

export interface PendingAction {
  id?: number;
  operation: string;
  params: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
  /** Authenticated user who created the action. Prevents cross-user replay on shared devices. */
  ownerUserId?: string;
  /** Current queue state. Missing on legacy records and treated as pending. */
  status?: 'pending' | 'retry_wait' | 'needs_attention' | 'office_resolved';
  /** Earliest time an automatic retry may run. */
  nextAttemptAt?: string;
  /** Timestamp of the most recent replay attempt. */
  lastAttemptAt?: string;
  /** Consecutive authenticated-session mismatches, capped before manual review. */
  sessionMismatchCount?: number;
  lastError?: string;
  /** Permanent Stage 1B server receipt identity for approved offline work. */
  clientActionId?: string;
  /** Permanent canonical idempotency key copied out of the RPC parameters. */
  idempotencyKey?: string;
  /** Receipt schema sent to stage_offline_action. */
  schemaVersion?: 1;
  /** Office resolution remains local until the original user acknowledges it. */
  officeResolution?: 'already_completed' | 'abandoned';
  officeResolutionNote?: string;
  officeResolvedAt?: string;
  /** Entity table for conflict detection (e.g. 'deliveries', 'orders') */
  entityTable?: string;
  /** Entity primary key for conflict detection */
  entityId?: string;
  /** Entity updated_at when action was queued — used to detect server-side changes */
  snapshotAt?: string;
}

/**
 * Open (or create) the IndexedDB database.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;

    const rejectOnce = (error: Error | DOMException | null) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error('Failed to open offline storage'));
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('operation', 'operation', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('clientActionId', 'clientActionId', { unique: true });
      } else {
        const store = request.transaction!.objectStore(STORE_NAME);
        if (!store.indexNames.contains('clientActionId')) {
          store.createIndex('clientActionId', 'clientActionId', { unique: true });
        }
      }
    };

    request.onblocked = () => {
      rejectOnce(new Error(OFFLINE_DB_UPGRADE_BLOCKED_MESSAGE));
    };
    request.onsuccess = () => {
      const db = request.result;
      // Release this connection whenever a newer app version needs to upgrade
      // IndexedDB. Older deployed code cannot do this, so onblocked above also
      // fails visibly instead of leaving a field save spinning forever.
      db.onversionchange = () => db.close();
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => rejectOnce(request.error);
  });
}

/**
 * Add a pending action to the offline queue.
 */
export async function queueAction(action: Omit<PendingAction, 'id'>): Promise<number> {
  const preparedAction = prepareQueuedAction(action);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(preparedAction);
    let actionId: number | undefined;

    request.onsuccess = () => {
      actionId = request.result as number;
    };
    tx.oncomplete = () => {
      db.close();
      if (actionId === undefined) {
        reject(new Error('Offline action transaction completed without an action ID'));
        return;
      }
      resolve(actionId);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? request.error ?? new Error('Failed to save offline action'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? request.error ?? new Error('Offline action save was aborted'));
    };
  });
}

/**
 * Give newly queued delivery/job completions a permanent receipt identity
 * before IndexedDB commits them. Legacy records are upgraded lazily during
 * sync, so the v1 -> v2 database upgrade never rewrites or drops user work.
 */
export function prepareQueuedAction(action: Omit<PendingAction, 'id'>): Omit<PendingAction, 'id'> {
  if (!DURABLE_RECEIPT_OPERATIONS.has(action.operation)) return action;

  if (!action.ownerUserId) {
    throw new Error('Durable offline actions require the authenticated owner');
  }
  const idempotencyKey = action.idempotencyKey ?? action.params.p_idempotency_key;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new Error('Durable offline actions require an idempotency key');
  }
  const entityId = action.entityId
    ?? (action.operation === 'complete_delivery'
      ? action.params.p_delivery_id
      : action.params.p_job_id);
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new Error('Durable offline actions require a delivery or job ID');
  }

  return {
    ...action,
    clientActionId: action.clientActionId ?? crypto.randomUUID(),
    idempotencyKey,
    schemaVersion: 1,
    entityId,
  };
}

/**
 * Upgrade a pre-receipt browser row deterministically. IndexedDB write
 * transactions are serialized, but sync loops are tab-local; deriving the ID
 * from the saved intent ensures two tabs cannot assign different server receipt
 * UUIDs to the same legacy action before either write becomes visible.
 */
export async function prepareLegacyQueuedAction(
  action: Omit<PendingAction, 'id'>,
): Promise<Omit<PendingAction, 'id'>> {
  if (!DURABLE_RECEIPT_OPERATIONS.has(action.operation) || action.clientActionId) {
    return prepareQueuedAction(action);
  }

  const idempotencyKey = action.idempotencyKey ?? action.params.p_idempotency_key;
  const entityId = action.entityId
    ?? (action.operation === 'complete_delivery'
      ? action.params.p_delivery_id
      : action.params.p_job_id);
  const identitySource = [
    'crx-offline-receipt-v1',
    action.ownerUserId ?? '',
    action.operation,
    typeof idempotencyKey === 'string' ? idempotencyKey : '',
    typeof entityId === 'string' ? entityId : '',
    action.createdAt,
  ].join('\u0000');
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identitySource),
  ));
  const uuidBytes = digest.slice(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = Array.from(uuidBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const clientActionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  return prepareQueuedAction({ ...action, clientActionId });
}

/**
 * Get all pending actions from the queue.
 */
export async function getPendingActions(): Promise<PendingAction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Remove an action from the queue (after successful sync).
 */
export async function removeAction(id: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? request.error ?? new Error('Failed to remove offline action'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? request.error ?? new Error('Offline action removal was aborted'));
    };
  });
}

/**
 * Update a pending action (e.g., increment retry count, store error).
 */
export async function updateAction(action: PendingAction): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(action);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? request.error ?? new Error('Failed to update offline action'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? request.error ?? new Error('Offline action update was aborted'));
    };
  });
}

/**
 * Get the count of pending actions.
 */
export async function getPendingCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Get only the permanently failed actions (retryCount >= maxRetries).
 * Useful for surfacing failed items to the user in a dashboard.
 */
export async function getFailedActions(maxRetries: number = OFFLINE_MAX_RETRIES): Promise<PendingAction[]> {
  const actions = await getPendingActions();
  return actions.filter((a) =>
    a.status === 'needs_attention'
    || a.status === 'office_resolved'
    || a.retryCount >= maxRetries
  );
}

/**
 * Resolve the owner of new and legacy actions without assigning them to the
 * currently logged-in user. The two active offline operations already carry
 * p_performed_by in their RPC params, so old records can be recovered safely.
 */
export function getActionOwnerUserId(action: PendingAction): string | null {
  if (typeof action.ownerUserId === 'string' && action.ownerUserId.length > 0) {
    return action.ownerUserId;
  }
  if (!LEGACY_OWNER_INFERENCE_OPERATIONS.has(action.operation)) {
    return null;
  }
  const performedBy = action.params.p_performed_by;
  return typeof performedBy === 'string' && performedBy.length > 0 ? performedBy : null;
}

export interface OfflineQueueSummary {
  ownedTotal: number;
  ownedAutoSyncable: number;
  ownedNeedsAttention: number;
  ownedOfficeResolved: number;
  otherUserTotal: number;
  ownerUnknownTotal: number;
  /** Earliest retry time among the current user's actions; null means retry now. */
  nextAutoSyncAt: string | null;
}

/**
 * Summarize the queue without exposing another user's payload on a shared device.
 */
export async function getQueueSummary(currentUserId: string | null): Promise<OfflineQueueSummary> {
  const actions = await getPendingActions();
  let ownedTotal = 0;
  let ownedAutoSyncable = 0;
  let ownedNeedsAttention = 0;
  let ownedOfficeResolved = 0;
  let otherUserTotal = 0;
  let ownerUnknownTotal = 0;
  let nextAutoSyncAt: string | null = null;
  let hasImmediateAction = false;

  for (const action of actions) {
    const ownerUserId = getActionOwnerUserId(action);
    if (!ownerUserId) {
      ownerUnknownTotal++;
      continue;
    }
    if (!currentUserId || ownerUserId !== currentUserId) {
      otherUserTotal++;
      continue;
    }

    ownedTotal++;
    if (action.status === 'office_resolved') {
      ownedOfficeResolved++;
      continue;
    }
    const needsAttention = action.status === 'needs_attention' || action.retryCount >= OFFLINE_MAX_RETRIES;
    if (needsAttention) {
      ownedNeedsAttention++;
      continue;
    }

    ownedAutoSyncable++;
    if (!action.nextAttemptAt) {
      hasImmediateAction = true;
      nextAutoSyncAt = null;
      continue;
    }
    if (!hasImmediateAction && (!nextAutoSyncAt || action.nextAttemptAt < nextAutoSyncAt)) {
      nextAutoSyncAt = action.nextAttemptAt;
    }
  }

  return {
    ownedTotal,
    ownedAutoSyncable,
    ownedNeedsAttention,
    ownedOfficeResolved,
    otherUserTotal,
    ownerUnknownTotal,
    nextAutoSyncAt,
  };
}
