import { useCallback, useEffect, useRef, useState } from 'react';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from '../lib/idempotency';

export type MutationFailureDisposition = 'definitive' | 'uncertain';

export type DurableMutationIntentOptions<T> = {
  operation: string;
  userId: string;
  surface: string;
  scope?: string;
  getIntentIdentity?: (intent: T) => unknown;
};

type DurableMutationIntentRecord<T> = {
  version: 3;
  operation: string;
  userId: string;
  surface: string;
  scope: string;
  idempotencyKey: string;
  intentIdentity: string | null;
  intent: T;
  createdAtMs: number;
  retryNotAfterMs: number;
};

type LegacyDurableMutationIntentCandidate<T> = {
  version?: 1 | 2;
  operation?: string;
  userId?: string;
  surface?: string;
  scope?: string;
  idempotencyKey?: string;
  intent?: T;
  createdAtMs?: number;
  retryNotAfterMs?: number;
};

const DURABLE_INTENT_PREFIX = 'crx:uncertain-mutation:v3:';
const LEGACY_SESSION_PREFIX = 'crx:uncertain-mutation:v1:';
const DURABLE_INTENT_DB = 'crx_durable_mutation_intents';
const DURABLE_INTENT_STORE = 'intents';
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const UNCERTAIN_MUTATION_RETRY_EXPIRED = 'DURABLE_MUTATION_INTENT_RETRY_EXPIRED';
export const UNCERTAIN_MUTATION_INTENT_CONFLICT = 'DURABLE_MUTATION_INTENT_CONFLICT';
export const UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE =
  'The safe automatic retry window expired. Do not submit this mutation again. Verify the authoritative record and reconcile it manually.';
export const UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE =
  'Another page or tab has an unresolved request for this operation. Return there to retry it unchanged, or verify the authoritative record before reconciling it manually.';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprintIntent<T>(
  intent: T,
  getIntentIdentity: ((candidate: T) => unknown) | undefined,
): string {
  return JSON.stringify(canonicalize(getIntentIdentity ? getIntentIdentity(intent) : intent));
}

function durableStorageKey<T>(options: DurableMutationIntentOptions<T> | undefined): string | null {
  if (!options || !options.operation || !options.userId || !options.surface) return null;
  // Surface and route scope deliberately do not participate in the key. One
  // actor cannot mint a second key for the same operation merely by opening a
  // new tab or using a different receiving screen.
  return `${DURABLE_INTENT_PREFIX}${JSON.stringify([options.operation, options.userId])}`;
}

function isValidRecord<T>(
  candidate: Partial<DurableMutationIntentRecord<T>>,
  options: DurableMutationIntentOptions<T>,
): candidate is DurableMutationIntentRecord<T> {
  return candidate.version === 3
    && candidate.operation === options.operation
    && candidate.userId === options.userId
    && typeof candidate.surface === 'string'
    && typeof candidate.scope === 'string'
    && typeof candidate.idempotencyKey === 'string'
    && candidate.idempotencyKey.startsWith(`${options.operation}:${options.userId}:`)
    && (typeof candidate.intentIdentity === 'string' || candidate.intentIdentity === null)
    && candidate.intent !== null
    && typeof candidate.intent === 'object'
    && typeof candidate.createdAtMs === 'number'
    && Number.isFinite(candidate.createdAtMs)
    && typeof candidate.retryNotAfterMs === 'number'
    && Number.isFinite(candidate.retryNotAfterMs)
    && candidate.retryNotAfterMs >= candidate.createdAtMs;
}

function blockedDurableRecord<T>(
  options: DurableMutationIntentOptions<T>,
): DurableMutationIntentRecord<T> {
  return {
    version: 3,
    operation: options.operation,
    userId: options.userId,
    surface: '__reconciliation_required__',
    scope: '',
    idempotencyKey: `${options.operation}:${options.userId}:blocked`,
    intentIdentity: null,
    intent: {} as T,
    createdAtMs: 0,
    retryNotAfterMs: 0,
  };
}

function migrateLegacySessionRecord<T>(
  storageKey: string,
  options: DurableMutationIntentOptions<T>,
): DurableMutationIntentRecord<T> | null {
  try {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const legacyKey = window.sessionStorage.key(index);
      if (!legacyKey?.startsWith(LEGACY_SESSION_PREFIX)) continue;
      const raw = window.sessionStorage.getItem(legacyKey);
      if (!raw) continue;
      const candidate = JSON.parse(raw) as LegacyDurableMutationIntentCandidate<T>;
      if (
        (candidate.version !== 1 && candidate.version !== 2)
        || candidate.operation !== options.operation
        || candidate.userId !== options.userId
        || typeof candidate.surface !== 'string'
        || typeof candidate.scope !== 'string'
        || typeof candidate.idempotencyKey !== 'string'
        || !candidate.idempotencyKey.startsWith(`${options.operation}:${options.userId}:`)
        || candidate.intent === null
        || typeof candidate.intent !== 'object'
      ) continue;

      const ownedByCurrentSurface = candidate.surface === options.surface
        && candidate.scope === (options.scope || '');
      const canRetainDeadline = candidate.version === 2
        && ownedByCurrentSurface
        && typeof candidate.createdAtMs === 'number'
        && Number.isFinite(candidate.createdAtMs)
        && typeof candidate.retryNotAfterMs === 'number'
        && Number.isFinite(candidate.retryNotAfterMs)
        && candidate.retryNotAfterMs > candidate.createdAtMs;
      const migrated: DurableMutationIntentRecord<T> = {
        version: 3,
        operation: options.operation,
        userId: options.userId,
        surface: candidate.surface,
        scope: candidate.scope,
        idempotencyKey: candidate.idempotencyKey,
        intentIdentity: canRetainDeadline
          ? fingerprintIntent(candidate.intent, options.getIntentIdentity)
          : null,
        intent: candidate.intent,
        createdAtMs: canRetainDeadline ? candidate.createdAtMs! : 0,
        retryNotAfterMs: canRetainDeadline ? candidate.retryNotAfterMs! : 0,
      };
      window.localStorage.setItem(storageKey, JSON.stringify(migrated));
      window.sessionStorage.removeItem(legacyKey);
      return migrated;
    }
  } catch {
    // A legacy record that cannot be migrated stays in sessionStorage. A new
    // mutation will still fail closed when localStorage cannot be written.
  }
  return null;
}

function readDurableRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
): DurableMutationIntentRecord<T> | null {
  if (!storageKey || !options || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return migrateLegacySessionRecord(storageKey, options);
    const candidate = JSON.parse(raw) as Partial<DurableMutationIntentRecord<T>>;
    return isValidRecord(candidate, options) ? candidate : blockedDurableRecord(options);
  } catch {
    return blockedDurableRecord(options);
  }
}

function writeDurableRecord<T>(storageKey: string, record: DurableMutationIntentRecord<T>): void {
  if (typeof window === 'undefined') {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function removeDurableRecord(storageKey: string | null): void {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The in-memory lock still clears after a definitive result. Storage
    // failures before a mutation fail closed in writeDurableRecord().
  }
}

function openDurableIntentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
      return;
    }
    const request = indexedDB.open(DURABLE_INTENT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DURABLE_INTENT_STORE)) {
        request.result.createObjectStore(DURABLE_INTENT_STORE, { keyPath: 'storageKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
    );
    request.onblocked = () => reject(new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
  });
}

async function coordinateDurableRecord<T>(
  storageKey: string,
  proposed: DurableMutationIntentRecord<T>,
  candidateIntent: T,
  options: DurableMutationIntentOptions<T>,
): Promise<{ record: DurableMutationIntentRecord<T>; conflict: boolean }> {
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let result: { record: DurableMutationIntentRecord<T>; conflict: boolean } | null = null;

      request.onsuccess = () => {
        const stored = request.result as { storageKey?: string; record?: unknown } | undefined;
        const existingCandidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        const existing = existingCandidate && isValidRecord(existingCandidate, options)
          ? existingCandidate
          : stored
            ? blockedDurableRecord(options)
            : proposed;
        const owned = existing.surface === options.surface
          && existing.scope === (options.scope || '');
        if (owned) {
          result = { record: existing, conflict: false };
        } else {
          const candidateIdentity = fingerprintIntent(candidateIntent, options.getIntentIdentity);
          if (
            existing.intentIdentity !== null
            && existing.intentIdentity === candidateIdentity
            && Date.now() < existing.retryNotAfterMs
          ) {
            const transferred = {
              ...existing,
              surface: options.surface,
              scope: options.scope || '',
              intent: candidateIntent,
            };
            result = { record: transferred, conflict: false };
            store.put({ storageKey, record: transferred });
          } else {
            result = { record: existing, conflict: true };
          }
        }
        if (!stored) store.put({ storageKey, record: result.record });
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.oncomplete = () => {
        if (result) resolve(result);
        else reject(new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'));
      };
      transaction.onerror = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

async function deleteCoordinatedRecord(storageKey: string | null): Promise<void> {
  if (!storageKey) return;
  const db = await openDurableIntentDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      transaction.objectStore(DURABLE_INTENT_STORE).delete(storageKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.onabort = () => reject(
        transaction.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

/**
 * Freezes the exact payload of a mutation whose outcome is not yet known.
 *
 * A transport failure can arrive after PostgreSQL committed. Until an exact
 * retry replays that receipt (or the server proves it rejected the request),
 * callers must not accept edited input or mint a new idempotency key.
 */
export function useUncertainMutationIntent<T>(options?: DurableMutationIntentOptions<T>) {
  const storageKey = durableStorageKey(options);
  const surface = options?.surface || '';
  const scope = options?.scope || '';
  const identityToken = `${storageKey || ''}:${JSON.stringify([surface, scope])}`;
  const getIntentIdentityRef = useRef(options?.getIntentIdentity);
  getIntentIdentityRef.current = options?.getIntentIdentity;
  const initialRecord = readDurableRecord<T>(storageKey, options);
  const initialOwned = initialRecord?.surface === surface && initialRecord.scope === scope;
  const activeIdentityRef = useRef(identityToken);
  const recordRef = useRef<DurableMutationIntentRecord<T> | null>(initialRecord);
  const idempotencyKeyRef = useRef<string | null>(initialRecord?.idempotencyKey ?? null);
  const intentRef = useRef<T | null>(initialOwned ? initialRecord.intent : null);
  const retryNotAfterRef = useRef<number | null>(initialRecord?.retryNotAfterMs ?? null);
  const [unresolvedIntent, setUnresolvedIntent] = useState<T | null>(initialOwned ? initialRecord.intent : null);
  const [hasUnresolvedRecord, setHasUnresolvedRecord] = useState(initialRecord !== null);
  const [isForeignIntentLocked, setIsForeignIntentLocked] = useState(Boolean(initialRecord && !initialOwned));
  const [retryNotAfterMs, setRetryNotAfterMs] = useState<number | null>(initialRecord?.retryNotAfterMs ?? null);
  const [, setExpiryRevision] = useState(0);

  const applyRecord = useCallback((record: DurableMutationIntentRecord<T> | null) => {
    const owned = record?.surface === surface && record.scope === scope;
    recordRef.current = record;
    idempotencyKeyRef.current = record?.idempotencyKey ?? null;
    intentRef.current = owned ? record.intent : null;
    retryNotAfterRef.current = record?.retryNotAfterMs ?? null;
    setUnresolvedIntent(owned ? record.intent : null);
    setHasUnresolvedRecord(record !== null);
    setIsForeignIntentLocked(Boolean(record && !owned));
    setRetryNotAfterMs(record?.retryNotAfterMs ?? null);
  }, [scope, surface]);

  const activateCurrentIdentity = useCallback((force = false) => {
    if (!storageKey) return;
    if (!force && activeIdentityRef.current === identityToken) return;
    activeIdentityRef.current = identityToken;
    applyRecord(readDurableRecord<T>(storageKey, options));
  }, [applyRecord, identityToken, options, storageKey]);

  useEffect(() => {
    activateCurrentIdentity();
  }, [activateCurrentIdentity]);

  useEffect(() => {
    if (!storageKey) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === storageKey) {
        activateCurrentIdentity(true);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [activateCurrentIdentity, storageKey]);

  useEffect(() => {
    if (retryNotAfterMs === null) return;
    const remainingMs = retryNotAfterMs - Date.now();
    if (remainingMs <= 0) {
      setExpiryRevision((revision) => revision + 1);
      return;
    }
    const timer = window.setTimeout(
      () => setExpiryRevision((revision) => revision + 1),
      remainingMs + 1,
    );
    return () => window.clearTimeout(timer);
  }, [retryNotAfterMs]);

  const beginIntent = useCallback(async (intent: T): Promise<T> => {
    activateCurrentIdentity(true);
    if (!options && intentRef.current !== null) return intentRef.current;
    const existing = recordRef.current;
    if (options) {
      if (!storageKey) throw new Error('DURABLE_MUTATION_INTENT_IDENTITY_MISSING');
      const idempotencyKey = generateIdempotencyKey(options.operation, options.userId);
      const createdAtMs = Date.now();
      const retryNotAfterMs = createdAtMs + SAFE_RETRY_WINDOW_MS;
      const proposed: DurableMutationIntentRecord<T> = existing ?? {
        version: 3,
        operation: options.operation,
        userId: options.userId,
        surface,
        scope,
        idempotencyKey,
        intentIdentity: fingerprintIntent(intent, getIntentIdentityRef.current),
        intent,
        createdAtMs,
        retryNotAfterMs,
      };
      const coordinated = await coordinateDurableRecord(storageKey, proposed, intent, options);
      writeDurableRecord(storageKey, coordinated.record);
      applyRecord(coordinated.record);
      if (coordinated.conflict) throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
      return coordinated.record.intent;
    }

    intentRef.current = intent;
    setUnresolvedIntent(intent);
    setHasUnresolvedRecord(true);
    return intent;
  }, [activateCurrentIdentity, applyRecord, options, scope, storageKey, surface]);

  const getIdempotencyKey = useCallback((): string => {
    activateCurrentIdentity(true);
    if (
      recordRef.current
      && (recordRef.current.surface !== surface || recordRef.current.scope !== scope)
    ) {
      throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    }
    if (intentRef.current === null || idempotencyKeyRef.current === null) {
      throw new Error('DURABLE_MUTATION_INTENT_NOT_STARTED');
    }
    if (retryNotAfterRef.current === null || Date.now() >= retryNotAfterRef.current) {
      throw new Error(UNCERTAIN_MUTATION_RETRY_EXPIRED);
    }
    return idempotencyKeyRef.current;
  }, [activateCurrentIdentity, scope, surface]);

  const resolveIntent = useCallback(async () => {
    activateCurrentIdentity(true);
    await deleteCoordinatedRecord(storageKey);
    removeDurableRecord(storageKey);
    applyRecord(null);
  }, [activateCurrentIdentity, applyRecord, storageKey]);

  const classifyFailure = useCallback(async (error: unknown): Promise<MutationFailureDisposition> => {
    activateCurrentIdentity(true);
    if (
      error instanceof Error
      && (error.message === UNCERTAIN_MUTATION_RETRY_EXPIRED
        || error.message === UNCERTAIN_MUTATION_INTENT_CONFLICT)
    ) {
      return 'uncertain';
    }
    if (isDefinitiveRpcRejection(error)) {
      await deleteCoordinatedRecord(storageKey);
      removeDurableRecord(storageKey);
      applyRecord(null);
      return 'definitive';
    }
    return 'uncertain';
  }, [activateCurrentIdentity, applyRecord, storageKey]);

  return {
    beginIntent,
    getIdempotencyKey,
    resolveIntent,
    classifyFailure,
    unresolvedIntent,
    isIntentLocked: hasUnresolvedRecord,
    isForeignIntentLocked,
    isRetryExpired: retryNotAfterMs !== null && Date.now() >= retryNotAfterMs,
  };
}
