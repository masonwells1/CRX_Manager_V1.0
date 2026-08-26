import { useCallback, useRef, useState } from 'react';
import { isDefinitiveRpcRejection } from '../lib/idempotency';

export type MutationFailureDisposition = 'definitive' | 'uncertain';

/**
 * Freezes the exact payload of a mutation whose outcome is not yet known.
 *
 * A transport failure can arrive after PostgreSQL committed. Until an exact
 * retry replays that receipt (or the server proves it rejected the request),
 * callers must not accept edited input or mint a new idempotency key.
 */
export function useUncertainMutationIntent<T>() {
  const intentRef = useRef<T | null>(null);
  const [unresolvedIntent, setUnresolvedIntent] = useState<T | null>(null);

  const beginIntent = useCallback((intent: T): T => {
    if (intentRef.current !== null) return intentRef.current;
    intentRef.current = intent;
    setUnresolvedIntent(intent);
    return intent;
  }, []);

  const resolveIntent = useCallback(() => {
    intentRef.current = null;
    setUnresolvedIntent(null);
  }, []);

  const classifyFailure = useCallback((error: unknown): MutationFailureDisposition => {
    if (isDefinitiveRpcRejection(error)) {
      intentRef.current = null;
      setUnresolvedIntent(null);
      return 'definitive';
    }
    return 'uncertain';
  }, []);

  return {
    beginIntent,
    resolveIntent,
    classifyFailure,
    unresolvedIntent,
    isIntentLocked: unresolvedIntent !== null,
  };
}
