import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import { Sentry } from './sentry';
export { sanitizeError } from './errorSanitizer';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing required environment variables: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set'
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
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
  // Audit #14: `data: null` is a silent RLS denial when `.select()` was used.
  // `.select()` returns `[]` (no match) or `[...rows]`; `.select().single()`
  // returns the row or null. In both cases, `data === null` after a mutation
  // means the row wasn't visible to the caller — treat as denied.
  if (result.data === null || result.data === undefined) {
    throw new Error(`${operation} failed: no rows were affected. You may not have permission.`);
  }
  if (Array.isArray(result.data) && result.data.length === 0) {
    throw new Error(`${operation} failed: no rows were affected. You may not have permission.`);
  }
}

/**
 * Canonical machine-readable error tokens raised by SECURITY DEFINER RPCs.
 *
 * Convention: SQL raises `'<TOKEN>'` or `'<TOKEN>: <human readable suffix>'`.
 * TS callers detect the token with `hasRpcCode(err, RpcErrorCodes.X)` rather
 * than substring matching the human suffix (which is fragile if the SQL
 * message text ever changes).
 *
 * Add new tokens here when you create a new RPC that uses this pattern. The
 * `as const` + indexed access type below makes the union exhaustive — a typo
 * at any callsite (`hasRpcCode(err, 'INSUFFICIENT_HOLD_INVENORY')`) becomes a
 * compile error.
 */
export const RpcErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  ACTOR_MISMATCH: 'ACTOR_MISMATCH',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_HOLD_TYPE: 'INVALID_HOLD_TYPE',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  FORCE_REQUIRES_ADMIN: 'FORCE_REQUIRES_ADMIN',
  FORCE_REQUIRES_REASON: 'FORCE_REQUIRES_REASON',
  INSUFFICIENT_HOLD_INVENTORY: 'INSUFFICIENT_HOLD_INVENTORY',
  INVENTORY_NOT_FOUND: 'INVENTORY_NOT_FOUND',
  // draw_down_quote / convert_quote_to_order booking guards (sell-side roadmap #1)
  BOOKING_CLOSED: 'BOOKING_CLOSED',
  BOOKING_OVERDRAWN: 'BOOKING_OVERDRAWN',
  BOOKING_PARTIALLY_DRAWN: 'BOOKING_PARTIALLY_DRAWN',
  BOOKING_FULLY_DRAWN: 'BOOKING_FULLY_DRAWN',
  BOOKING_DRAW_ORDER_LOCKED: 'BOOKING_DRAW_ORDER_LOCKED',
  EMPTY_DRAW: 'EMPTY_DRAW',
  // post_invoice / post_invoice_group ship-now-price-later gate (sell-side roadmap #2)
  PRICING_INCOMPLETE: 'PRICING_INCOMPLETE',
  // price_order (sell-side roadmap #2 v2)
  INVALID_PRICE: 'INVALID_PRICE',
  ALREADY_PRICED: 'ALREADY_PRICED',
  ORDER_NOT_ACTIVE: 'ORDER_NOT_ACTIVE',
  // (booking-prepay earmark tokens PREPAY_CREDIT_NOT_FOUND / BOOKING_NOT_FOUND /
  // PREPAY_BOOKING_CUSTOMER_MISMATCH / PREPAY_CREDIT_IN_USE removed 2026-06-14 — the
  // earmark engine is shelved: docs/roadmap/shelved-earmark-engine/. They return with it.)
  // create_rebate_claim / transition_rebate_claim (audit #33)
  PROGRAM_REQUIRED: 'PROGRAM_REQUIRED',
  QUANTITY_INVALID: 'QUANTITY_INVALID',
  CLAIM_AMOUNT_INVALID: 'CLAIM_AMOUNT_INVALID',
  CLAIM_ID_REQUIRED: 'CLAIM_ID_REQUIRED',
  STATUS_REQUIRED: 'STATUS_REQUIRED',
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  PAID_AMOUNT_INVALID: 'PAID_AMOUNT_INVALID',
  // create_delivery_with_items / bulk_import_order / save_blend_recipe (audits #10, #31, #34)
  ORDER_ID_REQUIRED: 'ORDER_ID_REQUIRED',
  CUSTOMER_ID_REQUIRED: 'CUSTOMER_ID_REQUIRED',
  SCHEDULED_DATE_REQUIRED: 'SCHEDULED_DATE_REQUIRED',
  ITEMS_REQUIRED: 'ITEMS_REQUIRED',
  ITEMS_INVALID: 'ITEMS_INVALID',
  ITEM_INVALID: 'ITEM_INVALID',
  ORDER_NUMBER_REQUIRED: 'ORDER_NUMBER_REQUIRED',
  NAME_REQUIRED: 'NAME_REQUIRED',
  RECIPE_TYPE_INVALID: 'RECIPE_TYPE_INVALID',
  RECIPE_NOT_FOUND: 'RECIPE_NOT_FOUND',
  // create_delivery_with_items hardening (Codex 2026-05-17/18)
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  CUSTOMER_ORDER_MISMATCH: 'CUSTOMER_ORDER_MISMATCH',
  ORDER_NOT_SCHEDULABLE: 'ORDER_NOT_SCHEDULABLE',
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  ADDRESS_CUSTOMER_MISMATCH: 'ADDRESS_CUSTOMER_MISMATCH',
  ITEM_DUPLICATE_IN_REQUEST: 'ITEM_DUPLICATE_IN_REQUEST',
  ITEM_OVER_REMAINING_INCL_ACTIVE: 'ITEM_OVER_REMAINING_INCL_ACTIVE',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  ITEM_ORDER_MISMATCH: 'ITEM_ORDER_MISMATCH',
  ITEM_PRODUCT_MISMATCH: 'ITEM_PRODUCT_MISMATCH',
  // 2026-05-25 ultra-review RPC hardening
  COMMISSION_SPLIT_INVALID: 'COMMISSION_SPLIT_INVALID',
  SIGNATURE_REQUIRED: 'SIGNATURE_REQUIRED',
  REASON_REQUIRED: 'REASON_REQUIRED',
  INVALID_INVOICE_STATUS: 'INVALID_INVOICE_STATUS',
  INVALID_ORDER_STATUS: 'INVALID_ORDER_STATUS',
  INVALID_RETURN_STATUS: 'INVALID_RETURN_STATUS',
  INVALID_COMMISSION_PAYMENT_STATUS: 'INVALID_COMMISSION_PAYMENT_STATUS',
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  RETURN_NOT_FOUND: 'RETURN_NOT_FOUND',
  DELIVERY_NOT_FOUND: 'DELIVERY_NOT_FOUND',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_EXCEEDS_BALANCE: 'AMOUNT_EXCEEDS_BALANCE',
  RETURN_CREDIT_EMPTY: 'RETURN_CREDIT_EMPTY',
  NO_PENDING_REMAINDERS: 'NO_PENDING_REMAINDERS',
  COMMISSION_PAYMENT_NOT_FOUND: 'COMMISSION_PAYMENT_NOT_FOUND',
  // assign_job_applicator / license gates (2026-06-10 deep-dive H1 B5)
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
  OVERRIDE_REQUIRES_ADMIN: 'OVERRIDE_REQUIRES_ADMIN',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  // B1 lot capture & trace — set_application_record_lots (2026-06-22)
  APPLICATION_RECORD_NOT_FOUND: 'APPLICATION_RECORD_NOT_FOUND',
  INVALID_LOTS_PAYLOAD: 'INVALID_LOTS_PAYLOAD',
  LOT_MISSING_PRODUCT: 'LOT_MISSING_PRODUCT',
  LOT_MISSING_NUMBER: 'LOT_MISSING_NUMBER',
  PRODUCT_NOT_ON_RECORD: 'PRODUCT_NOT_ON_RECORD',
  SOURCE_RECEIPT_MISMATCH: 'SOURCE_RECEIPT_MISMATCH',
  DUPLICATE_LOT: 'DUPLICATE_LOT',
  // save_field_app_invoice / post_invoice_group — per-acre billing guard (field-acre billing)
  ZERO_APPLIED_ACRES: 'ZERO_APPLIED_ACRES',
} as const;

export type RpcErrorCode = (typeof RpcErrorCodes)[keyof typeof RpcErrorCodes];

/**
 * Returns true if the error message matches the given RPC error token.
 *
 * SQL raises `'TOKEN'` or `'TOKEN: human suffix'` — both shapes match. The
 * token must be at the START of the message (post any trailing punctuation
 * the database adds), so we look for `'TOKEN'` as either the whole message,
 * a prefix followed by `:`, or a prefix followed by whitespace.
 *
 * Prefer this over `message.includes(token)` because the latter false-
 * positives if the token appears inside a user-supplied note or another
 * error's text.
 */
export function hasRpcCode(err: unknown, code: RpcErrorCode): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // Match: exact "TOKEN", "TOKEN:rest", or "TOKEN rest"
  return message === code
    || message.startsWith(`${code}:`)
    || message.startsWith(`${code} `);
}
