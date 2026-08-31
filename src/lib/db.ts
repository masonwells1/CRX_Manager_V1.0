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
  // restore_quote_version, once 20260816120000 is applied. A version restore
  // mints brand-new quote_items ids, so it cannot carry the per-line billing
  // provenance a draw stamps. Rather than drop that provenance (which was
  // proven to overbill across a restore that changes the line partition), the
  // server refuses the restore outright once the booking has been drawn.
  QUOTE_RESTORE_BLOCKED_BY_DRAW: 'QUOTE_RESTORE_BLOCKED_BY_DRAW',
  // draw_down_quote per-tier order lines (migration 20260816120000). A booked
  // line with no unit price cannot be billed, and the split lines must add back
  // up to the quantity requested.
  BOOKED_PRICE_REQUIRED: 'BOOKED_PRICE_REQUIRED',
  COST_BASIS_REQUIRED: 'COST_BASIS_REQUIRED',
  DRAW_ALLOCATION_MISMATCH: 'DRAW_ALLOCATION_MISMATCH',
  // Same migration: a draw line that matches no booked price tier, and a tier
  // asked to give up more units than were booked at it. Both are fail-closed
  // refusals with plain-English server messages, surfaced verbatim by the draw
  // modal's generic error branch — registered here so they are inside the typed
  // contract rather than only inside the SQL.
  DRAW_MIXED_TIER_UNMATCHED_LINE: 'DRAW_MIXED_TIER_UNMATCHED_LINE',
  DRAW_TIER_OVERCONSUMED: 'DRAW_TIER_OVERCONSUMED',
  // Same migration: a booked line carrying a negative or non-finite quantity
  // has no honest value to draw against. Runtime-reachable by the same draw
  // modal path as the two above, so it belongs in the typed contract too.
  BOOKING_QUANTITY_INVALID: 'BOOKING_QUANTITY_INVALID',
  // draw_down_quote intent wrapper: reject malformed product identifiers with
  // a governed token before PostgreSQL attempts the UUID cast.
  BOOKING_PRODUCT_INVALID: 'BOOKING_PRODUCT_INVALID',
  // draw_down_quote cutover barrier (migration 20260816110000). Raised only
  // while the tier-split cutover holds its advisory key; the draw is refused
  // instantly having written nothing, and retrying after the cutover succeeds.
  DRAW_DOWN_CUTOVER_IN_PROGRESS: 'DRAW_DOWN_CUTOVER_IN_PROGRESS',
  // close_quote_as_short — refuses while scheduled/in-progress jobs still exist (U5 #1)
  BOOKING_HAS_ACTIVE_JOBS: 'BOOKING_HAS_ACTIVE_JOBS',
  // create_job_from_quote_section — an accepted booking is a chemical sale; make a standalone job (U5 #103)
  QUOTE_ALREADY_CONVERTED: 'QUOTE_ALREADY_CONVERTED',
  // post_invoice / post_invoice_group ship-now-price-later gate (sell-side roadmap #2)
  PRICING_INCOMPLETE: 'PRICING_INCOMPLETE',
  // post_invoice / post_invoice_group deliver-before-billing gate (Wave A fix #5,
  // migration 20260813060000). A delivery-linked invoice cannot be posted until the
  // delivery is completed — the same click that corrects it to what actually went out.
  DELIVERY_NOT_COMPLETED: 'DELIVERY_NOT_COMPLETED',
  DELIVERY_MISSING: 'DELIVERY_MISSING',
  // return-credit COGS and year-end report guards (20260827041000/041100)
  RETURN_CREDIT_CUTOVER_IN_PROGRESS: 'RETURN_CREDIT_CUTOVER_IN_PROGRESS',
  CUSTOMER_SCOPE_DENIED: 'CUSTOMER_SCOPE_DENIED',
  PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED: 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED',
  RETURN_NOT_APPROVED: 'RETURN_NOT_APPROVED',
  RETURN_CREDIT_UNIT_MISMATCH: 'RETURN_CREDIT_UNIT_MISMATCH',
  RETURN_CREDIT_INVENTORY_UNIT_MISMATCH: 'RETURN_CREDIT_INVENTORY_UNIT_MISMATCH',
  RETURN_CREDIT_UNLINKED_COST_LINE: 'RETURN_CREDIT_UNLINKED_COST_LINE',
  RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED: 'RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED',
  RETURN_CREDIT_LEDGER_IMMUTABLE: 'RETURN_CREDIT_LEDGER_IMMUTABLE',
  RETURN_CREDIT_ISOLATION_UNSUPPORTED: 'RETURN_CREDIT_ISOLATION_UNSUPPORTED',
  RETURN_CREDIT_HEADER_RESULT_INVALID: 'RETURN_CREDIT_HEADER_RESULT_INVALID',
  RETURN_CREDIT_SOURCE_CONCURRENT: 'RETURN_CREDIT_SOURCE_CONCURRENT',
  RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE: 'RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE',
  RETURN_CREDIT_HEADER_IMMUTABLE: 'RETURN_CREDIT_HEADER_IMMUTABLE',
  RETURN_CREDIT_PARENT_IMMUTABLE: 'RETURN_CREDIT_PARENT_IMMUTABLE',
  RETURN_CREDIT_LINE_TOTAL_MISMATCH: 'RETURN_CREDIT_LINE_TOTAL_MISMATCH',
  RETURN_CREDIT_VOID_RELEASE_FAILED: 'RETURN_CREDIT_VOID_RELEASE_FAILED',
  RETURN_CREDIT_UNAPPLY_RELEASE_FAILED: 'RETURN_CREDIT_UNAPPLY_RELEASE_FAILED',
  ORDER_INVOICE_TERMINAL: 'ORDER_INVOICE_TERMINAL',
  ORDER_LIFECYCLE_BUSY_RETRY: 'ORDER_LIFECYCLE_BUSY_RETRY',
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
  // complete_team_note (Team Board delegation fix, 20260809130108)
  NOTE_ID_REQUIRED: 'NOTE_ID_REQUIRED',
  COMPLETED_FLAG_REQUIRED: 'COMPLETED_FLAG_REQUIRED',
  PROFILE_INACTIVE: 'PROFILE_INACTIVE',
  NOTE_NOT_FOUND: 'NOTE_NOT_FOUND',
  NOT_AUTHORIZED_TO_COMPLETE: 'NOT_AUTHORIZED_TO_COMPLETE',
  COMPLETE_REPLAY_PAYLOAD_MISMATCH: 'COMPLETE_REPLAY_PAYLOAD_MISMATCH',
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
  // restore_quote_version trust boundary (20260826220000). Legacy snapshots
  // remain visible, but cannot re-enter the quote write path as authoritative cost.
  QUOTE_VERSION_LEGACY_UNTRUSTED: 'QUOTE_VERSION_LEGACY_UNTRUSTED',
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
  // assign_customers_sales_rep — atomic Customer 360 ownership assignment.
  ASSIGNMENT_SALES_REP_INACTIVE: 'ASSIGNMENT_SALES_REP_INACTIVE',
  ASSIGNMENT_CUSTOMER_SET_CHANGED: 'ASSIGNMENT_CUSTOMER_SET_CHANGED',
  ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH: 'ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH',
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
// A raised RPC error reaches the client in two shapes: a real `Error`, OR a
// plain Supabase/PostgREST error OBJECT `{ code, message, details, hint }`
// (NOT an Error instance) when the caller `throw`s the `{ error }` from
// `supabase.rpc(...)`. Read `.message` off either; only fall back to String()
// for genuinely message-less values (so a plain object never stringifies to
// "[object Object]" and silently fails the token match).
function rpcErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err ?? '');
}

export function hasRpcCode(err: unknown, code: RpcErrorCode): boolean {
  return rpcCodeDetail(err, code) !== null;
}

/**
 * The human suffix the database attached to an RPC error token, `''` when the
 * token was raised bare, or `null` when this error is not that token at all.
 *
 * Same prefix rules as `hasRpcCode` — exact `TOKEN`, `TOKEN:rest`, or
 * `TOKEN rest` — so `hasRpcCode` is just "did this return a string".
 * Prefer this over `message.includes(token)`, which false-positives if the
 * token appears inside a user-supplied note or another error's text.
 */
export function rpcCodeDetail(err: unknown, code: RpcErrorCode): string | null {
  const message = rpcErrorMessage(err);
  if (message === code) return '';
  if (message.startsWith(`${code}:`) || message.startsWith(`${code} `)) {
    return message.slice(code.length + 1).trim();
  }
  return null;
}

/**
 * Plain-English reason a post_invoice / post_invoice_group call was refused by
 * one of the deliberate billing gates, or `null` if the failure was something
 * else (which the caller should surface through `sanitizeError`).
 *
 * These are expected refusals, not faults: the office sees what to do next
 * rather than a raw database token. Every posting UI routes through here —
 * Invoices, InvoiceDetail, OfficeCockpit, OrderDetail and the field panel — so
 * the wording cannot drift between them.
 *
 * The delivery gates raise a different instruction per case: an in-flight
 * delivery should be completed, but a deleted, cancelled or voided one can
 * never be completed and the invoice must be voided instead. So we pass the
 * database's own sentence through rather than collapsing every refusal to one
 * fixed phrase — advice the operator cannot act on reads as a broken screen and
 * invites them to retry forever. The short fallbacks apply only if the token
 * ever arrives bare.
 */
export function describePostInvoiceBlock(err: unknown): string | null {
  if (hasRpcCode(err, RpcErrorCodes.PRICING_INCOMPLETE)) return 'needs pricing first';

  const notCompleted = rpcCodeDetail(err, RpcErrorCodes.DELIVERY_NOT_COMPLETED);
  if (notCompleted !== null) return notCompleted || 'complete the delivery first';

  const missing = rpcCodeDetail(err, RpcErrorCodes.DELIVERY_MISSING);
  if (missing !== null) return missing || 'its delivery record is missing — void this draft';

  return null;
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
