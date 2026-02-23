/**
 * Offline Queue — IndexedDB-based queue for pending operations.
 * When the driver is offline, critical actions (like delivery completion)
 * are saved locally and auto-synced when the connection returns.
 */

const DB_NAME = 'crx_offline_queue';
const DB_VERSION = 1;
const STORE_NAME = 'pending_actions';

export interface PendingAction {
  id?: number;
  operation: string;
  params: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
  lastError?: string;
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
    request.onsuccess = () => resolve(request.result as number);
    request.onerror = () => reject(request.error);
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
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
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
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
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
 * Remove all actions that have exceeded MAX_RETRIES (permanently failed).
 * Returns the number of cleared actions.
 */
export async function clearFailedActions(maxRetries: number = 3): Promise<number> {
  const actions = await getPendingActions();
  const failed = actions.filter((a) => a.retryCount >= maxRetries);
  for (const action of failed) {
    await removeAction(action.id!);
  }
  return failed.length;
}

/**
 * Remove actions older than the given age in milliseconds.
 * Default: 7 days. Prevents stale data from accumulating.
 */
export async function clearStaleActions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const actions = await getPendingActions();
  const cutoff = Date.now() - maxAgeMs;
  const stale = actions.filter((a) => new Date(a.createdAt).getTime() < cutoff);
  for (const action of stale) {
    await removeAction(action.id!);
  }
  return stale.length;
}

/**
 * Get only the permanently failed actions (retryCount >= maxRetries).
 * Useful for surfacing failed items to the user in a dashboard.
 */
export async function getFailedActions(maxRetries: number = 3): Promise<PendingAction[]> {
  const actions = await getPendingActions();
  return actions.filter((a) => a.retryCount >= maxRetries);
}
