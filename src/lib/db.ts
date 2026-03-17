import { createClient } from '@supabase/supabase-js';
import { Sentry } from './sentry';
export { sanitizeError } from './errorSanitizer';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing required environment variables: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Keep the session alive across page reloads and tab switches
    persistSession: true,
    // Automatically refresh the token before it expires — prevents
    // the user from being kicked out mid-workflow
    autoRefreshToken: true,
    // Detect OAuth/magic-link tokens in the URL after redirect
    detectSessionInUrl: true,
    // Use localStorage so the session survives tab switches and
    // browser restarts (default, but explicit for clarity)
    storage: window.localStorage,
  },
  global: {
    headers: {
      // Request correlation ID — links browser requests to Edge Function
      // and database logs for end-to-end tracing. Logged in Sentry breadcrumbs.
      'X-Request-ID': crypto.randomUUID(),
    },
    fetch: (url, options = {}) => {
      const requestId = crypto.randomUUID();
      const headers = new Headers(options.headers);
      headers.set('X-Request-ID', requestId);
      Sentry.addBreadcrumb({
        category: 'supabase',
        message: `${options.method || 'GET'} ${typeof url === 'string' ? url.replace(supabaseUrl, '') : url}`,
        data: { requestId },
        level: 'info',
      });
      return fetch(url, { ...options, headers });
    },
  },
});

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
