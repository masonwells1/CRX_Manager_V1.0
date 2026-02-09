import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Check a Supabase mutation result for silent RLS failures.
 * RLS-blocked updates/deletes return { data: null, count: 0 } with no error.
 * Call this after any .update() or .delete() to verify rows were affected.
 */
export function checkMutationResult(
  result: { error: any; data: any; count?: number | null },
  operation: string
): void {
  if (result.error) throw result.error;
  if (result.data !== null && Array.isArray(result.data) && result.data.length === 0) {
    throw new Error(`${operation} failed: no rows were affected. You may not have permission.`);
  }
}
