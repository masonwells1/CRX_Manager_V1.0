import { useCallback, useEffect, useRef, useState } from 'react';
import { generateIdempotencyKey, isDefinitiveRpcRejection } from '../lib/idempotency';

export type MutationFailureDisposition = 'definitive' | 'uncertain';

export type DurableMutationIntentOptions = {
  operation: string;
  userId: string;
  surface: string;
  scope?: string;
};

type DurableMutationIntentRecord<T> = {
  version: 1;
  operation: string;
  userId: string;
  surface: string;
  scope: string;
  idempotencyKey: string;
  intent: T;
};

const DURABLE_INTENT_PREFIX = 'crx:uncertain-mutation:v1:';

function durableStorageKey(options: DurableMutationIntentOptions | undefined): string | null {
  if (!options || !options.operation || !options.userId || !options.surface) return null;
  return `${DURABLE_INTENT_PREFIX}${JSON.stringify([
    options.operation,
    options.userId,
    options.surface,
    options.scope || '',
  ])}`;
}

function readDurableRecord<T>(
  storageKey: string | null,
  options: DurableMutationIntentOptions | undefined,
): DurableMutationIntentRecord<T> | null {
  if (!storageKey || !options || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Partial<DurableMutationIntentRecord<T>>;
    const scope = options.scope || '';
    if (
      candidate.version !== 1
      || candidate.operation !== options.operation
      || candidate.userId !== options.userId
      || candidate.surface !== options.surface
      || candidate.scope !== scope
      || typeof candidate.idempotencyKey !== 'string'
      || !candidate.idempotencyKey.startsWith(`${options.operation}:${options.userId}:`)
      || candidate.intent === null
      || typeof candidate.intent !== 'object'
    ) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return candidate as DurableMutationIntentRecord<T>;
  } catch {
    return null;
  }
}

function writeDurableRecord<T>(storageKey: string, record: DurableMutationIntentRecord<T>): void {
  if (typeof window === 'undefined') {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE');
  }
}

function removeDurableRecord(storageKey: string | null): void {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // The in-memory lock still clears after a definitive result. Storage
    // failures before a mutation fail closed in writeDurableRecord().
  }
}

/**
 * Freezes the exact payload of a mutation whose outcome is not yet known.
 *
 * A transport failure can arrive after PostgreSQL committed. Until an exact
 * retry replays that receipt (or the server proves it rejected the request),
 * callers must not accept edited input or mint a new idempotency key.
 */
export function useUncertainMutationIntent<T>(options?: DurableMutationIntentOptions) {
  const storageKey = durableStorageKey(options);
  const initialRecord = readDurableRecord<T>(storageKey, options);
  const activeStorageKeyRef = useRef<string | null>(storageKey);
  const idempotencyKeyRef = useRef<string | null>(initialRecord?.idempotencyKey ?? null);
  const intentRef = useRef<T | null>(initialRecord?.intent ?? null);
  const [unresolvedIntent, setUnresolvedIntent] = useState<T | null>(initialRecord?.intent ?? null);

  const activateCurrentIdentity = useCallback(() => {
    if (activeStorageKeyRef.current === storageKey) return;
    activeStorageKeyRef.current = storageKey;
    const record = readDurableRecord<T>(storageKey, options);
    idempotencyKeyRef.current = record?.idempotencyKey ?? null;
    intentRef.current = record?.intent ?? null;
    setUnresolvedIntent(record?.intent ?? null);
  }, [options, storageKey]);

  useEffect(() => {
    activateCurrentIdentity();
  }, [activateCurrentIdentity]);

  const beginIntent = useCallback((intent: T): T => {
    activateCurrentIdentity();
    if (intentRef.current !== null) return intentRef.current;

    if (options) {
      if (!storageKey) throw new Error('DURABLE_MUTATION_INTENT_IDENTITY_MISSING');
      const idempotencyKey = generateIdempotencyKey(options.operation, options.userId);
      writeDurableRecord(storageKey, {
        version: 1,
        operation: options.operation,
        userId: options.userId,
        surface: options.surface,
        scope: options.scope || '',
        idempotencyKey,
        intent,
      });
      idempotencyKeyRef.current = idempotencyKey;
    }

    intentRef.current = intent;
    setUnresolvedIntent(intent);
    return intent;
  }, [activateCurrentIdentity, options, storageKey]);

  const getIdempotencyKey = useCallback((): string => {
    activateCurrentIdentity();
    if (intentRef.current === null || idempotencyKeyRef.current === null) {
      throw new Error('DURABLE_MUTATION_INTENT_NOT_STARTED');
    }
    return idempotencyKeyRef.current;
  }, [activateCurrentIdentity]);

  const resolveIntent = useCallback(() => {
    activateCurrentIdentity();
    removeDurableRecord(activeStorageKeyRef.current);
    idempotencyKeyRef.current = null;
    intentRef.current = null;
    setUnresolvedIntent(null);
  }, [activateCurrentIdentity]);

  const classifyFailure = useCallback((error: unknown): MutationFailureDisposition => {
    activateCurrentIdentity();
    if (isDefinitiveRpcRejection(error)) {
      removeDurableRecord(activeStorageKeyRef.current);
      idempotencyKeyRef.current = null;
      intentRef.current = null;
      setUnresolvedIntent(null);
      return 'definitive';
    }
    return 'uncertain';
  }, [activateCurrentIdentity]);

  return {
    beginIntent,
    getIdempotencyKey,
    resolveIntent,
    classifyFailure,
    unresolvedIntent,
    isIntentLocked: unresolvedIntent !== null,
  };
}
