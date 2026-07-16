export interface PendingBulkPOIntent {
  idempotencyKey: string;
  poNumber?: string;
  updatedAt: number;
}

export type PendingBulkPOIntents = Record<string, PendingBulkPOIntent>;

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = 'crx:bulk-po-import-pending:';
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

function storageKey(profileId: string): string {
  return `${STORAGE_PREFIX}${profileId}`;
}

export function loadPendingBulkPOIntents(
  storage: SessionStorageLike,
  profileId: string,
  now = Date.now(),
): PendingBulkPOIntents {
  try {
    const raw = storage.getItem(storageKey(profileId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PendingBulkPOIntents;
    const fresh = Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) =>
        typeof entry?.idempotencyKey === 'string'
        && typeof entry?.updatedAt === 'number'
        && now - entry.updatedAt <= MAX_PENDING_AGE_MS,
      ),
    );
    if (Object.keys(fresh).length === 0) storage.removeItem(storageKey(profileId));
    else if (Object.keys(fresh).length !== Object.keys(parsed).length) {
      storage.setItem(storageKey(profileId), JSON.stringify(fresh));
    }
    return fresh;
  } catch {
    return {};
  }
}

export function savePendingBulkPOIntents(
  storage: SessionStorageLike,
  profileId: string,
  pending: PendingBulkPOIntents,
): void {
  try {
    if (Object.keys(pending).length === 0) storage.removeItem(storageKey(profileId));
    else storage.setItem(storageKey(profileId), JSON.stringify(pending));
  } catch {
    // Retry durability is best-effort when browser storage is unavailable.
  }
}

export function ensurePendingBulkPOIntent(
  pending: PendingBulkPOIntents,
  intentKey: string,
  createIdempotencyKey: () => string,
  now = Date.now(),
): PendingBulkPOIntent {
  const existing = pending[intentKey];
  if (existing) {
    existing.updatedAt = now;
    return existing;
  }

  const created = {
    idempotencyKey: createIdempotencyKey(),
    updatedAt: now,
  };
  pending[intentKey] = created;
  return created;
}

export function clearPendingBulkPOIntent(
  pending: PendingBulkPOIntents,
  intentKey: string,
): void {
  delete pending[intentKey];
}
