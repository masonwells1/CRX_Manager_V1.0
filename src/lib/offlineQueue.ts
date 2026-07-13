/**
 * Offline Queue — IndexedDB-based queue for pending operations.
 * When the driver is offline, critical actions (like delivery completion)
 * are saved locally and auto-synced when the connection returns.
 */

const DB_NAME = 'crx_offline_queue';
const DB_VERSION = 1;
const STORE_NAME = 'pending_actions';
const LEGACY_OWNER_INFERENCE_OPERATIONS = new Set(['complete_delivery', 'complete_job']);
export const OFFLINE_MAX_RETRIES = 4;

export interface PendingAction {
  id?: number;
  operation: string;
  params: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
  /** Authenticated user who created the action. Prevents cross-user replay on shared devices. */
  ownerUserId?: string;
  /** Current queue state. Missing on legacy records and treated as pending. */
  status?: 'pending' | 'retry_wait' | 'needs_attention';
  /** Earliest time an automatic retry may run. */
  nextAttemptAt?: string;
  /** Timestamp of the most recent replay attempt. */
  lastAttemptAt?: string;
  /** Consecutive authenticated-session mismatches, capped before manual review. */
  sessionMismatchCount?: number;
  lastError?: string;
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

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('operation', 'operation', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Add a pending action to the offline queue.
 */
export async function queueAction(action: Omit<PendingAction, 'id'>): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(action);
    let actionId: number | undefined;

    request.onsuccess = () => {
      actionId = request.result as number;
    };
    tx.oncomplete = () => {
      if (actionId === undefined) {
        reject(new Error('Offline action transaction completed without an action ID'));
        return;
      }
      resolve(actionId);
    };
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Failed to save offline action'));
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Offline action save was aborted'));
  });
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Failed to remove offline action'));
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Offline action removal was aborted'));
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Failed to update offline action'));
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Offline action update was aborted'));
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get only the permanently failed actions (retryCount >= maxRetries).
 * Useful for surfacing failed items to the user in a dashboard.
 */
export async function getFailedActions(maxRetries: number = OFFLINE_MAX_RETRIES): Promise<PendingAction[]> {
  const actions = await getPendingActions();
  return actions.filter((a) => a.status === 'needs_attention' || a.retryCount >= maxRetries);
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
    otherUserTotal,
    ownerUnknownTotal,
    nextAutoSyncAt,
  };
}
