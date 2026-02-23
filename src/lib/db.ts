import { createClient } from '@supabase/supabase-js';
export { sanitizeError } from './errorSanitizer';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Check a Supabase mutation result for silent RLS failures.
 * RLS-blocked updates/deletes return { data: null, count: 0 } with no error.
 * Call this after any .update() or .delete() to verify rows were affected.
 */
/**
 * Assert that an RPC call returned non-null data.
 * Supabase returns { data: null, error: null } when RLS denies access to
 * SECURITY DEFINER functions — this catches that silent failure.
 */
export function assertRpcResult<T>(data: unknown, rpcName: string): T {
  if (data === null || data === undefined) {
    throw new Error(`${rpcName} returned no data — operation may have been denied`);
  }
  return data as T;
}

export function checkMutationResult(
  result: { error: unknown; data: unknown; count?: number | null },
  operation: string
): void {
  if (result.error) throw result.error;
  if (result.data !== null && Array.isArray(result.data) && result.data.length === 0) {
    throw new Error(`${operation} failed: no rows were affected. You may not have permission.`);
  }
}
