import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  // save_purchase_order — global bulk-import claim identity guards
  BULK_PO_VENDOR_REQUIRED: 'BULK_PO_VENDOR_REQUIRED',
  BULK_PO_INTENT_VENDOR_CONFLICT: 'BULK_PO_INTENT_VENDOR_CONFLICT',
  // draw_down_quote / convert_quote_to_order booking guards (sell-side roadmap #1)
  BOOKING_CLOSED: 'BOOKING_CLOSED',
  BOOKING_OVERDRAWN: 'BOOKING_OVERDRAWN',
  BOOKING_PARTIALLY_DRAWN: 'BOOKING_PARTIALLY_DRAWN',
  BOOKING_FULLY_DRAWN: 'BOOKING_FULLY_DRAWN',
  BOOKING_DRAW_ORDER_LOCKED: 'BOOKING_DRAW_ORDER_LOCKED',
  EMPTY_DRAW: 'EMPTY_DRAW',
  // close_quote_as_short — refuses while scheduled/in-progress jobs still exist (U5 #1)
  BOOKING_HAS_ACTIVE_JOBS: 'BOOKING_HAS_ACTIVE_JOBS',
  // create_job_from_quote_section — an accepted booking is a chemical sale; make a standalone job (U5 #103)
  QUOTE_ALREADY_CONVERTED: 'QUOTE_ALREADY_CONVERTED',
  // post_invoice / post_invoice_group ship-now-price-later gate (sell-side roadmap #2)
  PRICING_INCOMPLETE: 'PRICING_INCOMPLETE',
  // price_order (sell-side roadmap #2 v2)
  INVALID_PRICE: 'INVALID_PRICE',
  ALREADY_PRICED: 'ALREADY_PRICED',
  ORDER_NOT_ACTIVE: 'ORDER_NOT_ACTIVE',
  // (booking-prepay earmark tokens PREPAY_CREDIT_NOT_FOUND / BOOKING_NOT_FOUND /
  // PREPAY_BOOKING_CUSTOMER_MISMATCH / PREPAY_CREDIT_IN_USE removed 2026-06-14 — the
  // earmark engine is shelved: docs/roadmap/shelved-earmark-engine/. They return with it.)
  // log_customer_interaction (CRM final-gauntlet retry-safety, 2026-07-17)
  INTERACTION_TYPE_INVALID: 'INTERACTION_TYPE_INVALID',
  INTERACTION_DIRECTION_INVALID: 'INTERACTION_DIRECTION_INVALID',
  INTERACTION_OCCURRED_AT_REQUIRED: 'INTERACTION_OCCURRED_AT_REQUIRED',
  INTERACTION_SUMMARY_REQUIRED: 'INTERACTION_SUMMARY_REQUIRED',
  INTERACTION_DURATION_INVALID: 'INTERACTION_DURATION_INVALID',
  INTERACTION_OUTCOME_INVALID: 'INTERACTION_OUTCOME_INVALID',
  INTERACTION_CONTACT_INVALID: 'INTERACTION_CONTACT_INVALID',
  INTERACTION_ACCESS_DENIED: 'INTERACTION_ACCESS_DENIED',
  INTERACTION_REPLAY_PAYLOAD_MISMATCH: 'INTERACTION_REPLAY_PAYLOAD_MISMATCH',
  FOLLOW_UP_TITLE_REQUIRED: 'FOLLOW_UP_TITLE_REQUIRED',
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
  // save_quote / save_customer whole-record optimistic concurrency.
  QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE',
  CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE',
  COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT',
  IDEMPOTENCY_PAYLOAD_CONFLICT: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
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
  // record_job_pre_notifications — field-app #40 pre-application customer notice
  INVALID_SUBJECT: 'INVALID_SUBJECT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  NO_RECIPIENTS: 'NO_RECIPIENTS',
  JOB_NOT_PRE_NOTIFIABLE: 'JOB_NOT_PRE_NOTIFIABLE',
  // record_job_post_notifications — field-app #41 post-application customer notice
  JOB_NOT_POST_NOTIFIABLE: 'JOB_NOT_POST_NOTIFIABLE',
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  // save_field_crop_history — A12 crop-history editor (structure-fix loop, 2026-07-02)
  FIELD_NOT_FOUND: 'FIELD_NOT_FOUND',
  CROP_TYPE_REQUIRED: 'CROP_TYPE_REQUIRED',
  // U6 blend<->job double-bill cross-guards (2026-07-06)
  // create_invoice_from_blend_ticket — ticket's job already has a live invoice
  JOB_ALREADY_INVOICED: 'JOB_ALREADY_INVOICED',
  // transfer_job_to_invoice — a blend ticket for this job is already billed
  BLEND_TICKET_ALREADY_BILLED: 'BLEND_TICKET_ALREADY_BILLED',
  // transfer_job_to_invoice (U7 multi-owner split) — a job whose fields carry per-field
  // $/acre price overrides cannot be split by percentage (bill it as a single invoice)
  SPLIT_OVERRIDE_UNSUPPORTED: 'SPLIT_OVERRIDE_UNSUPPORTED',
  // transfer_job_to_invoice (U7) — a billed field's splits do not total 100%
  FIELD_SPLIT_NOT_100: 'FIELD_SPLIT_NOT_100',
  // transfer_job_to_invoice (U7) — a multi-owner job with zero billable acres
  SPLIT_NO_ACRES: 'SPLIT_NO_ACRES',
  // transfer_invoice_to_job (U7) — this invoice is one member of a multi-owner group;
  // return the job to scheduling by voiding each owner invoice instead
  JOB_BILLED_AS_GROUP: 'JOB_BILLED_AS_GROUP',
  // Permanent offline receipt staging/review guards (Stage 1B).
  OFFLINE_STAGE_RATE_LIMIT: 'OFFLINE_STAGE_RATE_LIMIT',
  OFFLINE_STAGE_DAILY_CAP: 'OFFLINE_STAGE_DAILY_CAP',
  OFFLINE_STAGE_REVIEW_BACKLOG: 'OFFLINE_STAGE_REVIEW_BACKLOG',
  OFFLINE_ACTION_NEEDS_REVIEW: 'OFFLINE_ACTION_NEEDS_REVIEW',
  OFFLINE_RESOLUTION_INVALID: 'OFFLINE_RESOLUTION_INVALID',
  OFFLINE_ACTION_NOT_REVIEWABLE: 'OFFLINE_ACTION_NOT_REVIEWABLE',
  OFFLINE_ACTION_ALREADY_RESOLVED: 'OFFLINE_ACTION_ALREADY_RESOLVED',
  IDEMPOTENCY_ARGUMENT_MISMATCH: 'IDEMPOTENCY_ARGUMENT_MISMATCH',
  // check_idempotency (20260714230000_gauntlet_core_guards.sql) — raised when a
  // key already on file was minted for a DIFFERENT operation string. RPCs whose
  // operation scope includes the payload (admin_set_application_service_cost,
  // and the EDIT path of admin_save_application_service) hit this on a legitimate
  // corrected resubmit, so callers detect it to rotate the key and retry rather
  // than surfacing it as a dead end. The CREATE path of
  // admin_save_application_service scopes on a CONSTANT operation string instead,
  // so one key creates at most one service — callers must NOT rotate there, or a
  // lost response plus any edited field manufactures a duplicate service.
  IDEMPOTENCY_CROSS_OP_KEY_REUSE: 'IDEMPOTENCY_CROSS_OP_KEY_REUSE',
  // CRM relationship-intelligence loop (2026-07-16/17)
  CONTACT_NOT_FOUND: 'CONTACT_NOT_FOUND',
  FACT_NOT_FOUND: 'FACT_NOT_FOUND',
  FACT_ACCESS_DENIED: 'FACT_ACCESS_DENIED',
  FACT_ALREADY_REVIEWED: 'FACT_ALREADY_REVIEWED',
  FACT_VERDICT_INVALID: 'FACT_VERDICT_INVALID',
  FACT_VALUE_INVALID: 'FACT_VALUE_INVALID',
  FACT_NOT_CURRENT_VERIFIED: 'FACT_NOT_CURRENT_VERIFIED',
  FACT_EXPIRY_INVALID: 'FACT_EXPIRY_INVALID',
  PURCHASE_INTELLIGENCE_ACCESS_DENIED: 'PURCHASE_INTELLIGENCE_ACCESS_DENIED',
  CALL_LIST_ACCESS_DENIED: 'CALL_LIST_ACCESS_DENIED',
  CALL_LIST_INVALID_DAYS: 'CALL_LIST_INVALID_DAYS',
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
  // A raised RPC error reaches the client in two shapes: a real `Error`, OR a
  // plain Supabase/PostgREST error OBJECT `{ code, message, details, hint }`
  // (NOT an Error instance) when the caller `throw`s the `{ error }` from
  // `supabase.rpc(...)`. Read `.message` off either; only fall back to String()
  // for genuinely message-less values (so a plain object never stringifies to
  // "[object Object]" and silently fails the token match).
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    message = (err as { message: string }).message;
  } else {
    message = String(err ?? '');
  }
  // Match: exact "TOKEN", "TOKEN:rest", or "TOKEN rest"
  return message === code
    || message.startsWith(`${code}:`)
    || message.startsWith(`${code} `);
}

/**
 * Converts save-RPC session/identity failures into a safe, useful message for
 * end users. Raw database tokens remain available to logs and tests through
 * `hasRpcCode`, but should not be shown directly in field workflows.
 */
export function rpcAuthErrorMessage(err: unknown): string | null {
  if (
    hasRpcCode(err, RpcErrorCodes.AUTH_REQUIRED)
    || hasRpcCode(err, RpcErrorCodes.ACTOR_MISMATCH)
  ) {
    return 'Your sign-in could not be verified. Refresh the page and try again.';
  }
  return null;
}

/**
 * Untyped Supabase client alias for tables/RPCs not yet in the generated
 * `src/types/supabase.ts` (e.g., newly migrated tables applied only locally).
 * Cast to the plain SupabaseClient to bypass the Database type constraints
 * while still using the same underlying connection and auth session.
 * Use this ONLY for new tables/RPCs; prefer the typed `supabase` everywhere else.
 */
export const supabaseUntyped: SupabaseClient = supabase as unknown as SupabaseClient;
