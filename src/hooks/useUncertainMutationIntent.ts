import { useCallback, useEffect, useRef, useState } from 'react';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from '../lib/idempotency';

export type MutationFailureDisposition = 'definitive' | 'resolved' | 'uncertain';

export type DurableMutationIntentOptions<T> = {
  operation: string;
  userId: string;
  surface: string;
  scope?: string;
  getIntentIdentity?: (intent: T) => unknown;
};

type DurableMutationIntentRecord<T> = {
  version: 4;
  status: 'pending' | 'resolved';
  requestVersion: string;
  claimTabIds: string[];
  resolvedAtMs: number | null;
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

const DURABLE_INTENT_PREFIX = 'crx:uncertain-mutation:v4:';
const LEGACY_SESSION_PREFIX = 'crx:uncertain-mutation:v1:';
const ACKNOWLEDGMENT_PREFIX = 'crx:uncertain-mutation-ack:v1:';
const DURABLE_INTENT_TAB_ID = 'crx:durable-mutation:tab-id';
const DURABLE_INTENT_LIVE_CLAIM_PREFIX = 'crx:durable-mutation:live-claim:';
const DURABLE_INTENT_DB = 'crx_durable_mutation_intents';
const DURABLE_INTENT_STORE = 'intents';
const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
// A live claim is a renewable lease, not a permanent marker. Release runs from
// `pagehide` and effect cleanup, and neither survives a browser crash, a force
// quit, or an OS kill. A marker with no expiry would then keep a dead claimant
// in claimTabIds forever, deleteCoordinatedRecord could never delete the
// record, and once SAFE_RETRY_WINDOW_MS passed getIdempotencyKey() would throw
// UNCERTAIN_MUTATION_RETRY_EXPIRED on every attempt. Because storage is keyed
// by [operation, userId] only, one crash would lock that user out of every
// vendor payment or receiving attempt for that operation permanently. The TTL
// caps that outage instead of eliminating it: long enough that a mounted page
// keeps renewing through background-tab timer throttling (Chrome's intensive
// throttling still fires roughly once a minute), short enough that a crash
// self-heals in minutes rather than never.
const DURABLE_INTENT_LIVE_CLAIM_TTL_MS = 15 * 60 * 1000;
const DURABLE_INTENT_LIVE_CLAIM_HEARTBEAT_MS = 60 * 1000;
export const UNCERTAIN_MUTATION_RETRY_EXPIRED = 'DURABLE_MUTATION_INTENT_RETRY_EXPIRED';
export const UNCERTAIN_MUTATION_INTENT_CONFLICT = 'DURABLE_MUTATION_INTENT_CONFLICT';
export const UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE =
  'The safe automatic retry window expired. Do not submit this mutation again. Verify the authoritative record and reconcile it manually.';
export const UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE =
  'A saved request for this operation needs reconciliation. If another page or tab owns it, return there to retry it unchanged. Otherwise verify the authoritative record and reconcile it manually before starting another request.';

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

function currentTabId(): string {
  try {
    const existing = window.sessionStorage.getItem(DURABLE_INTENT_TAB_ID);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(DURABLE_INTENT_TAB_ID, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function currentPageClaimId(): string {
  // sessionStorage is copied when a browser tab is duplicated. A fresh UUID
  // suffix makes each mounted page claimant distinct even when both pages
  // inherit the same tab ID.
  return `${currentTabId()}:${crypto.randomUUID()}`;
}

function writeClaimLease(claimId: string): void {
  window.localStorage.setItem(
    `${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`,
    String(Date.now()),
  );
}

function markClaimLive(claimId: string): void {
  try {
    writeClaimLease(claimId);
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function renewLiveClaim(claimId: string): void {
  // Heartbeat. Only an existing lease is refreshed: a page that never started a
  // mutation must not mint a claim, and a released claim must stay released.
  try {
    if (window.localStorage.getItem(`${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`) === null) {
      return;
    }
    writeClaimLease(claimId);
  } catch {
    // A missed heartbeat only ages the lease. Peers keep treating the claim as
    // live until the TTL passes, which is the safe direction.
  }
}

function releaseLiveClaim(claimId: string): void {
  try {
    window.localStorage.removeItem(`${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`);
  } catch {
    // A failed release leaves the lease in place, so peers keep treating this
    // claimant as live rather than pretending it is gone. The lease still
    // expires on its own, so a release failure delays reconciliation by at most
    // DURABLE_INTENT_LIVE_CLAIM_TTL_MS instead of stranding the record.
  }
}

function isClaimLive(claimId: string): boolean {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(`${DURABLE_INTENT_LIVE_CLAIM_PREFIX}${claimId}`);
  } catch {
    // Liveness could not be READ. Treat the claim as live: reporting a
    // peer as dead on a storage error would let a second request delete the
    // record and mint a new idempotency key while the first is still in flight.
    return true;
  }
  // An absent lease means the claimant released it, or never held one.
  if (raw === null) return false;
  const renewedAtMs = Number(raw);
  if (!Number.isFinite(renewedAtMs)) {
    // A lease of unknown age (corrupt, or written by an older build that stored
    // a static marker). Treat it as live now, and stamp it so it acquires a
    // bounded expiry instead of surviving forever.
    try {
      writeClaimLease(claimId);
    } catch {
      // Best effort. The claim stays live either way.
    }
    return true;
  }
  return Date.now() - renewedAtMs < DURABLE_INTENT_LIVE_CLAIM_TTL_MS;
}

function retainLiveClaims(claimIds: string[], currentClaimId: string): string[] {
  return claimIds.filter(
    (claimId) => claimId === currentClaimId || isClaimLive(claimId),
  );
}

function isValidRecord<T>(
  candidate: Partial<DurableMutationIntentRecord<T>>,
  options: DurableMutationIntentOptions<T>,
): candidate is DurableMutationIntentRecord<T> {
  return candidate.version === 4
    && (candidate.status === 'pending' || candidate.status === 'resolved')
    && typeof candidate.requestVersion === 'string'
    && candidate.requestVersion.length > 0
    && Array.isArray(candidate.claimTabIds)
    && candidate.claimTabIds.every((tabId) => typeof tabId === 'string' && tabId.length > 0)
    && (candidate.resolvedAtMs === null
      || (typeof candidate.resolvedAtMs === 'number' && Number.isFinite(candidate.resolvedAtMs)))
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
    version: 4,
    status: 'pending',
    requestVersion: `${options.operation}:${options.userId}:blocked`,
    claimTabIds: [],
    resolvedAtMs: null,
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
        version: 4,
        status: 'pending',
        requestVersion: candidate.idempotencyKey,
        claimTabIds: [currentPageClaimId()],
        resolvedAtMs: null,
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

function readAcknowledgmentRecord<T>(
  key: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
): DurableMutationIntentRecord<T> | null {
  if (!key || !options || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<DurableMutationIntentRecord<T>>;
    return isValidRecord(record, options) && record.status === 'pending'
      && record.surface === options.surface && record.scope === (options.scope || '')
      ? record : blockedDurableRecord(options);
  } catch {
    return blockedDurableRecord(options);
  }
}

function writeAcknowledgmentRecord<T>(key: string | null, record: DurableMutationIntentRecord<T>): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(record));
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function clearAcknowledgmentRecord<T>(
  key: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
  expectedVersion: string | null,
): void {
  if (!key) return;
  const record = readAcknowledgmentRecord(key, options);
  if (record?.surface === '__reconciliation_required__') {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
  if (!record || record.requestVersion !== expectedVersion) return;
  try {
    window.sessionStorage.removeItem(key);
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
  tabId: string,
  localMirror: DurableMutationIntentRecord<T> | null = null,
  ownAttemptRequestVersion: string | null = null,
  expectedIdempotencyKey?: string,
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
        // With NO coordinator row, the local mirror is the only evidence
        // that an earlier request may have committed (IndexedDB evicted or
        // cleared). Decide it like an authoritative pending record rather than
        // letting the fresh candidate mint a second key for the same work. A
        // resolved mirror counts too: it still names the key a peer committed.
        const existing = existingCandidate && isValidRecord(existingCandidate, options)
          ? existingCandidate
          : stored
            ? blockedDurableRecord(options)
            : localMirror ?? proposed;
        if (
          expectedIdempotencyKey !== undefined
          && (existing.status !== 'pending' || existing.idempotencyKey !== expectedIdempotencyKey)
        ) {
          // The caller is retrying one specific request that was resolved or
          // replaced after the caller read it. Claiming or minting a record here
          // would send that request again under a different key, so nothing is
          // written. If IndexedDB lost its row, the local mirror must still
          // identify the pending request and its required key.
          result = { record: existing, conflict: true };
          return;
        }
        if (ownAttemptRequestVersion !== null && existing.requestVersion !== ownAttemptRequestVersion) {
          // A newer shared request cannot acknowledge this tab's older one.
          // Keep reconciliation locked instead of minting another receipt.
          result = { record: existing, conflict: true };
          if (!stored) store.put({ storageKey, record: existing });
          return;
        }
        const owned = existing.surface === options.surface
          && existing.scope === (options.scope || '');
        const candidateIdentity = fingerprintIntent(candidateIntent, options.getIntentIdentity);
        const sameIntent = existing.intentIdentity !== null
          && existing.intentIdentity === candidateIdentity;
        const intentExpired = Date.now() >= existing.retryNotAfterMs;
        const sameActiveIntent = sameIntent && !intentExpired;
        if (existing.status === 'resolved') {
          if (ownAttemptRequestVersion !== null && intentExpired) {
            result = { record: existing, conflict: true };
            if (!stored) store.put({ storageKey, record: existing });
            return;
          }
          // A peer tab can finish this tab's uncertain attempt under the same
          // key before, or without, the storage event reaching this tab. A
          // retry of that same request must keep the committed key so the
          // server replays its saved receipt; a fresh key would apply the
          // work a second time. Any other request starts fresh.
          const reopensOwnAttempt = sameActiveIntent
            && ownAttemptRequestVersion !== null
            && ownAttemptRequestVersion === existing.requestVersion;
          const record = reopensOwnAttempt
            ? {
              ...proposed,
              requestVersion: existing.requestVersion,
              idempotencyKey: existing.idempotencyKey,
              createdAtMs: existing.createdAtMs,
              retryNotAfterMs: existing.retryNotAfterMs,
            }
            : proposed;
          result = { record, conflict: false };
          store.put({ storageKey, record });
        } else if (owned && (sameIntent || intentExpired)) {
          const liveClaimTabIds = retainLiveClaims(existing.claimTabIds, tabId);
          const claimed = {
            ...existing,
            claimTabIds: liveClaimTabIds.includes(tabId)
              ? liveClaimTabIds
              : [...liveClaimTabIds, tabId],
          };
          result = { record: claimed, conflict: false };
          store.put({ storageKey, record: claimed });
        } else {
          if (sameActiveIntent) {
            const liveClaimTabIds = retainLiveClaims(existing.claimTabIds, tabId);
            const transferred = {
              ...existing,
              surface: options.surface,
              scope: options.scope || '',
              claimTabIds: liveClaimTabIds.includes(tabId)
                ? liveClaimTabIds
                : [...liveClaimTabIds, tabId],
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

async function readCoordinatedRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
): Promise<DurableMutationIntentRecord<T> | null> {
  if (!storageKey || !options) return null;
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readonly');
      const request = transaction.objectStore(DURABLE_INTENT_STORE).get(storageKey);
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        const candidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        resolve(candidate && isValidRecord(candidate, options)
          ? candidate
          : stored
            ? blockedDurableRecord(options)
            : null);
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
    });
  } finally {
    db.close();
  }
}

async function resolveCoordinatedRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
  requestVersion: string | null,
): Promise<DurableMutationIntentRecord<T> | null> {
  if (!storageKey || !options || !requestVersion) return null;
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let result: DurableMutationIntentRecord<T> | null = null;
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        const candidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        if (!candidate || !isValidRecord(candidate, options)) return;
        if (candidate.requestVersion !== requestVersion) {
          result = candidate;
          return;
        }
        result = {
          ...candidate,
          status: 'resolved',
          resolvedAtMs: Date.now(),
        };
        store.put({ storageKey, record: result });
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.oncomplete = () => resolve(result);
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

async function deleteCoordinatedRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions<T> | undefined,
  requestVersion: string | null,
  tabId: string | null,
): Promise<{ deleted: boolean; current: DurableMutationIntentRecord<T> | null }> {
  if (!storageKey || !options || !requestVersion || !tabId) {
    return { deleted: false, current: null };
  }
  const db = await openDurableIntentDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DURABLE_INTENT_STORE, 'readwrite');
      const store = transaction.objectStore(DURABLE_INTENT_STORE);
      const request = store.get(storageKey);
      let outcome: { deleted: boolean; current: DurableMutationIntentRecord<T> | null } = {
        deleted: false,
        current: null,
      };
      request.onsuccess = () => {
        const stored = request.result as { record?: unknown } | undefined;
        const candidate = stored?.record as Partial<DurableMutationIntentRecord<T>> | undefined;
        if (!candidate || !isValidRecord(candidate, options)) return;
        if (candidate.requestVersion === requestVersion) {
          if (candidate.status === 'resolved') {
            // A definitive response from one claimant must never erase proof
            // that an identical peer request already committed.
            outcome = { deleted: false, current: candidate };
            return;
          }
          const remainingClaimTabIds = candidate.claimTabIds.filter(
            (claimTabId) => claimTabId !== tabId && isClaimLive(claimTabId),
          );
          if (remainingClaimTabIds.length === 0) {
            store.delete(storageKey);
            outcome = { deleted: true, current: null };
          } else {
            const current = { ...candidate, claimTabIds: remainingClaimTabIds };
            store.put({ storageKey, record: current });
            outcome = { deleted: false, current };
          }
        } else {
          outcome = { deleted: false, current: candidate };
        }
      };
      request.onerror = () => reject(
        request.error ?? new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE'),
      );
      transaction.oncomplete = () => resolve(outcome);
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
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null && typeof window !== 'undefined') tabIdRef.current = currentPageClaimId();
  // The stable tab prefix preserves an unacknowledged receipt across reload.
  // Duplicating a tab copies its sessionStorage snapshot: the copied attempt
  // must still replay the old receipt, never become a fresh key. If newer shared
  // work conflicts with that snapshot, keep it locked for staff reconciliation.
  // The separate page claim UUID distinguishes live claimants, not receipts.
  const acknowledgmentKey = storageKey && options && tabIdRef.current
    ? `${ACKNOWLEDGMENT_PREFIX}${JSON.stringify([options.operation, options.userId,
      surface, scope, tabIdRef.current.slice(0, tabIdRef.current.lastIndexOf(':'))])}`
    : null;
  const initialRecord = readDurableRecord<T>(storageKey, options);
  const savedAttempt = readAcknowledgmentRecord<T>(acknowledgmentKey, options);
  const initialVisible = savedAttempt ?? initialRecord;
  const initialPending = initialVisible?.status === 'pending';
  const initialOwned = initialPending
    && initialVisible.surface === surface
    && initialVisible.scope === scope;
  const activeIdentityRef = useRef(identityToken);
  const recordRef = useRef<DurableMutationIntentRecord<T> | null>(
    savedAttempt?.surface === '__reconciliation_required__' ? savedAttempt : initialRecord ?? initialVisible,
  );
  const attemptRecordRef = useRef<DurableMutationIntentRecord<T> | null>(savedAttempt ?? (initialOwned ? initialVisible : null));
  const persistedAcknowledgmentIdentityRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(initialPending ? initialVisible.idempotencyKey : null);
  const intentRef = useRef<T | null>(initialOwned ? initialVisible.intent : null);
  const retryNotAfterRef = useRef<number | null>(initialPending ? initialVisible.retryNotAfterMs : null);
  const [unresolvedIntent, setUnresolvedIntent] = useState<T | null>(initialOwned ? initialVisible.intent : null);
  const [hasUnresolvedRecord, setHasUnresolvedRecord] = useState(initialPending);
  const [isIntentResolved, setIsIntentResolved] = useState(initialRecord?.status === 'resolved'
    && (!savedAttempt || initialRecord.requestVersion === savedAttempt.requestVersion));
  const [isForeignIntentLocked, setIsForeignIntentLocked] = useState(Boolean(initialPending && !initialOwned));
  const [retryNotAfterMs, setRetryNotAfterMs] = useState<number | null>(
    initialPending ? initialVisible.retryNotAfterMs : null,
  );
  const [, setExpiryRevision] = useState(0);

  const applyRecord = useCallback((record: DurableMutationIntentRecord<T> | null) => {
    // A peer completion is still this tab's retry until its handler acknowledges
    // the result. Unlocking early would present identical new work while
    // beginIntent still correctly replays this attempt's committed receipt.
    const attempt = attemptRecordRef.current;
    const visible = attempt?.surface === '__reconciliation_required__'
      || (attempt?.status === 'pending' && attempt.surface === surface && attempt.scope === scope)
      ? attempt : record;
    const pending = visible?.status === 'pending';
    const owned = pending && visible.surface === surface && visible.scope === scope;
    recordRef.current = attempt?.surface === '__reconciliation_required__' ? attempt : record ?? attempt;
    setIsIntentResolved(recordRef.current?.status === 'resolved'
      && (!attempt || recordRef.current.requestVersion === attempt.requestVersion));
    idempotencyKeyRef.current = pending ? visible.idempotencyKey : null;
    intentRef.current = owned ? visible.intent : null;
    retryNotAfterRef.current = pending ? visible.retryNotAfterMs : null;
    setUnresolvedIntent(owned ? visible.intent : null);
    setHasUnresolvedRecord(pending);
    setIsForeignIntentLocked(Boolean(pending && !owned));
    setRetryNotAfterMs(pending ? visible.retryNotAfterMs : null);
  }, [scope, surface]);

  const activateCurrentIdentity = useCallback((force = false) => {
    if (!storageKey) return;
    if (!force && activeIdentityRef.current === identityToken) return;
    if (activeIdentityRef.current !== identityToken) {
      persistedAcknowledgmentIdentityRef.current = null;
      attemptRecordRef.current = readAcknowledgmentRecord<T>(acknowledgmentKey, options);
    }
    activeIdentityRef.current = identityToken;
    applyRecord(readDurableRecord<T>(storageKey, options));
  }, [acknowledgmentKey, applyRecord, identityToken, options, storageKey]);

  useEffect(() => {
    activateCurrentIdentity();
  }, [activateCurrentIdentity]);

  useEffect(() => {
    const attempt = attemptRecordRef.current;
    if (!attempt || attempt.status !== 'pending'
      || attempt.surface !== surface || attempt.scope !== scope) return;
    const acknowledgmentIdentity = JSON.stringify([acknowledgmentKey, surface, scope, attempt.requestVersion]);
    if (persistedAcknowledgmentIdentityRef.current === acknowledgmentIdentity) return;
    try {
      // Restored pending requests need the same per-tab acknowledgment record
      // before a peer can resolve their shared durable tombstone.
      writeAcknowledgmentRecord(acknowledgmentKey, attempt);
      persistedAcknowledgmentIdentityRef.current = acknowledgmentIdentity;
    } catch {
      if (options) {
        const blocked = blockedDurableRecord<T>(options);
        attemptRecordRef.current = blocked;
        applyRecord(blocked);
      }
    }
  }, [acknowledgmentKey, applyRecord, options, scope, surface]);

  useEffect(() => {
    const claimId = tabIdRef.current;
    if (!claimId) return;
    const release = () => releaseLiveClaim(claimId);
    // Renew this page's lease for as long as it is mounted. Without the
    // heartbeat the lease would expire under a page that is still running and a
    // peer could delete a record whose request is genuinely in flight.
    const heartbeat = window.setInterval(
      () => renewLiveClaim(claimId),
      DURABLE_INTENT_LIVE_CLAIM_HEARTBEAT_MS,
    );
    window.addEventListener('pagehide', release);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', release);
      release();
    };
  }, []);

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

  // `requireIdempotencyKey` is for retrying a request the caller has already
  // shown as unresolved: the retry proceeds only while that exact request is
  // still pending under that key, checked again inside the durable transaction.
  // If another tab resolved or replaced it in the meantime, this throws
  // UNCERTAIN_MUTATION_INTENT_CONFLICT without starting a new request, because a
  // new request would carry a new key and could apply the mutation twice.
  const beginIntent = useCallback(async (
    intent: T,
    beginOptions?: { requireIdempotencyKey?: string },
  ): Promise<T> => {
    activateCurrentIdentity(true);
    const requiredKey = beginOptions?.requireIdempotencyKey;
    const mirrorRecord = recordRef.current;
    if (
      requiredKey !== undefined
      && (!options || mirrorRecord?.status !== 'pending' || mirrorRecord.idempotencyKey !== requiredKey)
    ) {
      throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    }
    if (!options && intentRef.current !== null) return intentRef.current;
    if (options) {
      if (!storageKey) throw new Error('DURABLE_MUTATION_INTENT_IDENTITY_MISSING');
      // A malformed mirror cannot establish whether it represented a pending
      // request before the local failure. Do not let an absent IndexedDB record
      // turn that uncertainty into permission for a new mutation.
      if (mirrorRecord?.surface === '__reconciliation_required__') {
        writeDurableRecord(storageKey, mirrorRecord);
        throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
      }
      const currentClaimId = tabIdRef.current ?? currentPageClaimId();
      tabIdRef.current = currentClaimId;
      markClaimLive(currentClaimId);
      const idempotencyKey = generateIdempotencyKey(options.operation, options.userId);
      const createdAtMs = Date.now();
      const retryNotAfterMs = createdAtMs + SAFE_RETRY_WINDOW_MS;
      // localStorage is only a UI mirror. It can lag behind IndexedDB when a
      // response resolves between the two writes, so a coordinator record
      // always wins: a pending one is restored (including conflict and expiry
      // refusal) and a resolved one receives a fresh candidate unless it is
      // this tab's own uncertain attempt, which keeps its committed key.
      // Only when the coordinator has no record at all is the local mirror
      // offered in its place, because then it is the sole evidence that an
      // earlier request may have committed.
      const proposed: DurableMutationIntentRecord<T> = {
        version: 4,
        status: 'pending',
        requestVersion: crypto.randomUUID(),
        claimTabIds: [currentClaimId],
        resolvedAtMs: null,
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
      try {
        const coordinated = await coordinateDurableRecord(
          storageKey,
          proposed,
          intent,
          options,
          currentClaimId,
          mirrorRecord,
          attemptRecordRef.current?.requestVersion ?? null,
          requiredKey,
        );
        writeDurableRecord(storageKey, coordinated.record);
        if (coordinated.conflict) {
          applyRecord(coordinated.record);
          throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
        }
        writeAcknowledgmentRecord(acknowledgmentKey, coordinated.record);
        persistedAcknowledgmentIdentityRef.current = JSON.stringify([
          acknowledgmentKey, surface, scope, coordinated.record.requestVersion,
        ]);
        attemptRecordRef.current = coordinated.record;
        applyRecord(coordinated.record);
        return coordinated.record.intent;
      } catch (error) {
        releaseLiveClaim(currentClaimId);
        throw error;
      }
    }

    intentRef.current = intent;
    setUnresolvedIntent(intent);
    setHasUnresolvedRecord(true);
    return intent;
  }, [acknowledgmentKey, activateCurrentIdentity, applyRecord, options, scope, storageKey, surface]);

  const getIdempotencyKey = useCallback((): string => {
    activateCurrentIdentity(true);
    if (
      recordRef.current
      && (recordRef.current.status !== 'pending'
        || recordRef.current.surface !== surface
        || recordRef.current.scope !== scope)
    ) {
      throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT);
    }
    if (
      recordRef.current
      && attemptRecordRef.current?.requestVersion !== recordRef.current.requestVersion
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
    if (!options) {
      attemptRecordRef.current = null;
      applyRecord(null);
      return;
    }
    const attempt = attemptRecordRef.current;
    const resolved = await resolveCoordinatedRecord(
      storageKey,
      options,
      attempt?.requestVersion ?? null,
    );
    if (resolved) {
      if (storageKey) writeDurableRecord(storageKey, resolved);
      clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
      attemptRecordRef.current = null;
      applyRecord(resolved);
    } else if (attempt && storageKey) {
      // No coordinator row was left to resolve (IndexedDB lost it). This request
      // is known to have committed, so retire its pending mirror; beginIntent
      // would otherwise restore it as unresolved. A mirror that now belongs to a
      // different request is left alone.
      const mirror = readDurableRecord<T>(storageKey, options);
      let visibleRecord = mirror;
      if (!mirror || mirror.requestVersion === attempt.requestVersion) {
        const retired: DurableMutationIntentRecord<T> = {
          ...attempt,
          status: 'resolved',
          resolvedAtMs: Date.now(),
        };
        writeDurableRecord(storageKey, retired);
        visibleRecord = retired;
      }
      // This exact attempt is confirmed complete even if a newer mirror must
      // remain untouched. Retire only its acknowledgement, then show the newer
      // durable lock; otherwise a reload restores an already completed attempt.
      clearAcknowledgmentRecord(acknowledgmentKey, options, attempt.requestVersion);
      attemptRecordRef.current = null;
      applyRecord(visibleRecord);
    }
    attemptRecordRef.current = null;
  }, [acknowledgmentKey, applyRecord, options, storageKey]);

  const classifyFailure = useCallback(async (error: unknown): Promise<MutationFailureDisposition> => {
    const attempt = attemptRecordRef.current;
    if (
      error instanceof Error
      && (error.message === UNCERTAIN_MUTATION_RETRY_EXPIRED
        || error.message === UNCERTAIN_MUTATION_INTENT_CONFLICT)
    ) {
      return 'uncertain';
    }
    try {
      if (isDefinitiveRpcRejection(error)) {
        if (!options) {
          attemptRecordRef.current = null;
          applyRecord(null);
          return 'definitive';
        }
        const outcome = await deleteCoordinatedRecord(
          storageKey,
          options,
          attempt?.requestVersion ?? null,
          tabIdRef.current,
        );
        if (outcome.deleted) {
          clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
          attemptRecordRef.current = null;
          removeDurableRecord(storageKey);
          applyRecord(null);
        } else if (outcome.current) {
          if (storageKey) writeDurableRecord(storageKey, outcome.current);
          if (outcome.current.status === 'resolved') {
            clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
            attemptRecordRef.current = null;
          }
          applyRecord(outcome.current);
          if (outcome.current.status === 'resolved') {
            attemptRecordRef.current = null;
            return 'resolved';
          }
          // A peer still owns this pending request. Keep this tab's attempt and
          // acknowledgment so its eventual receipt remains an exact-key retry.
          return 'definitive';
        }
        clearAcknowledgmentRecord(acknowledgmentKey, options, attempt?.requestVersion ?? null);
        attemptRecordRef.current = null;
        return 'definitive';
      }
      const current = await readCoordinatedRecord(storageKey, options);
      if (current) {
        if (storageKey) writeDurableRecord(storageKey, current);
        if (
          attempt
          && current.requestVersion === attempt.requestVersion
          && current.status === 'resolved'
        ) {
          clearAcknowledgmentRecord(acknowledgmentKey, options, attempt.requestVersion);
          attemptRecordRef.current = null;
          applyRecord(current);
          return 'resolved';
        }
        applyRecord(current);
        return 'uncertain';
      }
      if (attempt && options && storageKey && attempt.status === 'pending') {
        const restored = await coordinateDurableRecord(
          storageKey,
          attempt,
          attempt.intent,
          options,
          tabIdRef.current ?? currentPageClaimId(),
        );
        writeDurableRecord(storageKey, restored.record);
        applyRecord(restored.record);
      }
      return 'uncertain';
    } catch {
      // Failure classification runs inside mutation catch paths. If durable
      // coordination is unavailable here, preserve the in-memory lock and
      // report an uncertain outcome instead of throwing past the caller.
      return 'uncertain';
    }
  }, [acknowledgmentKey, applyRecord, options, storageKey]);

  // Same value as `unresolvedIntent`, read from the ref instead of state.
  // `unresolvedIntent` is React state, so a caller that awaits classifyFailure()
  // and then reads it in the SAME tick still sees the render-time value — which
  // is null on the first failure, silently skipping any "an intent survived"
  // branch. applyRecord() writes intentRef synchronously, so this accessor is
  // correct immediately after classifyFailure()/beginIntent() resolve. Use the
  // state field for rendering; use this when branching inside an async handler.
  const getUnresolvedIntent = useCallback(() => intentRef.current, []);
  // A known resolved record cannot satisfy an opt-in pending-key retry, even
  // while this tab retains its original attempt for receipt reconciliation.
  // This accessor does not start or claim anything.
  const getPendingIdempotencyKey = useCallback(
    () => (intentRef.current !== null && recordRef.current?.status === 'pending'
      ? idempotencyKeyRef.current : null),
    [],
  );
  const getIsIntentResolved = useCallback(() => {
    const record = recordRef.current;
    const attempt = attemptRecordRef.current;
    return record?.status === 'resolved'
      && (!attempt || record.requestVersion === attempt.requestVersion);
  }, []);

  return {
    beginIntent,
    getIdempotencyKey,
    resolveIntent,
    classifyFailure,
    unresolvedIntent,
    getUnresolvedIntent,
    getPendingIdempotencyKey,
    isIntentResolved,
    getIsIntentResolved,
    isIntentLocked: hasUnresolvedRecord,
    isForeignIntentLocked,
    isRetryExpired: retryNotAfterMs !== null && Date.now() >= retryNotAfterMs,
  };
}
