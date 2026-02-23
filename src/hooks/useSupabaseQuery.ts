import { useState, useEffect, useCallback, useRef } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';

type QueryError = PostgrestError | Error | null;

interface UseSupabaseQueryOptions<T> {
  /** The async function that performs the Supabase query */
  queryFn: (signal: AbortSignal) => Promise<{ data: T | null; error: QueryError }>;
  /** Whether to run the query immediately (default: true) */
  enabled?: boolean;
  /** Callback on error */
  onError?: (error: QueryError) => void;
}

interface UseSupabaseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: QueryError;
  refetch: () => void;
}

/**
 * Hook that wraps Supabase queries with:
 * - AbortController cleanup on unmount (prevents state updates after unmount)
 * - Loading state management
 * - Error handling with optional callback
 * - Refetch capability
 *
 * Usage:
 * ```ts
 * const { data: customers, loading, refetch } = useSupabaseQuery({
 *   queryFn: async (signal) => {
 *     return supabase.from('customers').select('*').order('farm_name').limit(500).abortSignal(signal);
 *   },
 *   onError: (err) => toast('error', err.message),
 * });
 * ```
 */
export function useSupabaseQuery<T>({
  queryFn,
  enabled = true,
  onError,
}: UseSupabaseQueryOptions<T>): UseSupabaseQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<QueryError>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const execute = useCallback(async () => {
    // Abort any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await queryFn(controller.signal);

      // Don't update state if unmounted or aborted
      if (!mountedRef.current || controller.signal.aborted) return;

      if (result.error) {
        setError(result.error);
        onError?.(result.error);
      } else {
        setData(result.data);
      }
    } catch (err: unknown) {
      const caughtError = err instanceof Error ? err : new Error(String(err));
      if (!mountedRef.current || caughtError.name === 'AbortError') return;
      setError(caughtError);
      onError?.(caughtError);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [queryFn, onError]);

  useEffect(() => {
    mountedRef.current = true;

    if (enabled) {
      execute();
    }

    return () => {
      mountedRef.current = false;
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [enabled, execute]);

  const refetch = useCallback(() => {
    execute();
  }, [execute]);

  return { data, loading, error, refetch };
}
