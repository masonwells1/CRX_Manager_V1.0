-- Bind draw_down_quote retries to the authenticated actor and exact draw intent.
--
-- IMPORTANT APPLY ORDER / PRODUCTION BOUNDARY
--   1. 20260816110000_draw_down_cutover_barrier.sql
--   2. 20260816120000_draw_down_split_order_lines_by_price_tier.sql
--   3. 20260817120000_carry_allocated_line_cents_through_lifecycle.sql
--   4. this migration
--
-- This file is written but NOT approved for live apply. It must remain pending
-- until a separate migration-review/apply session and Mason's explicit in-chat
-- approval. The repository PR may merge without applying it.
--
-- EMERGENCY REVERT PLAN (documentation only; do not run from this PR): create
-- a separately reviewed rollback migration and obtain live-apply approval.
-- Pause booking draws, then execute this sequence in one transaction so the
-- existing cutover key drains every draw that has reached its shared barrier
-- before either public body moves:
--
--   BEGIN;
--   SELECT pg_catalog.pg_advisory_xact_lock(20260816, 1);
--   DROP FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text);
--   ALTER FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)
--     RENAME TO draw_down_quote;
--   REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
--     FROM PUBLIC, anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
--     TO authenticated, service_role;
--   COMMIT;
--
-- Verify the restored body hash and ACL before resuming draws. This deliberately
-- restores the pre-intent retry behavior and its stale-receipt risk; keep draws
-- paused until every receipt created by this wrapper has expired unless the
-- separately approved incident plan explicitly accepts that temporary risk.
-- Never use CREATE OR REPLACE for this revert: the preserved private wrapper is
-- the reviewed cutover/below-cost body and must be renamed back byte-for-byte.
--
-- OPERATOR CONSEQUENCE: draw retry receipts live for 24 hours, and this file
-- refuses while any pre-wrapper draw_down_quote receipt remains retryable.
-- Before the eventual governed apply, plan a deliberate 24-hour freeze with no
-- successful booking draws (normally an off-season or weekend window), verify
-- the read-only receipt count is zero, and keep draws paused through commit.
-- A backend already inside a cached function plan but not yet at the first
-- shared-lock statement is outside the lock's drain guarantee. If that narrow
-- pre-lock case finishes after commit, check_idempotency_intent treats its
-- unbound receipt as an intent mismatch and returns the committed receipt in
-- DETAIL so the client opens the existing order instead of drawing twice.
--
-- Why a wrapper instead of rewriting the private money implementation:
-- 20260816120000 deliberately replaced weighted-average pricing with one line
-- per immutable quote-item tier. Copying that large body here would create a
-- second, stale source of truth for price allocation, cost snapshots,
-- commissions, inventory prebooking and draw-ledger math. This migration
-- instead RENAMES the current governed five-argument wrapper and places a
-- small intent-binding wrapper in front of it. The preserved inner wrapper
-- still owns the cutover barrier, below-cost approval and the exact tier-split
-- implementation call; this file changes no money or quantity calculation.
--
-- Cross-representative coverage is preserved deliberately. Any active admin
-- or sales_rep may draw any live booking, including a colleague's booking, per
-- Mason's decision re-confirmed 2026-08-16. Actor binding prevents one user
-- from replaying another user's receipt; it is not quote ownership.
--
-- The shared mismatch helper includes the prior receipt in PostgreSQL DETAIL.
-- The return lifecycle RPCs established this sales-rep-reachable precedent in
-- 20260812130145. The disclosure remains inside the same office boundary: the
-- key is high-entropy, and an active sales rep may already draw and view any
-- live booking/order. If either access decision changes, the DETAIL contract
-- must be revisited.
-- Reviewed check_idempotency_intent pg_proc.prosrc SHA-256:
-- 71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8
-- Read-only live catalog proof on 2026-08-20 also confirmed this exact body is
-- stored LF-only (no carriage returns); its defining migration is LF-pinned.
-- Reviewed cutover/below-cost draw_down_quote pg_proc.prosrc SHA-256:
-- be2570888281520c9aaba61280a456cdbd9b69b83dfeba106c7a324c3751e4bf
-- New actor/intent wrapper pg_proc.prosrc SHA-256:
-- ffdb9dce46503dceec0575a70096c4ee928a2595b572044309e359f0128faef7
-- The printable-key test deliberately uses COLLATE "C": the accepted alphabet
-- is exactly 1-200 stable ASCII [!-~] characters, independent of the database
-- or operating-system locale. Do not simplify it to a locale-sensitive range.
-- Lock ordering also assumes save_quote and convert_quote_to_order keep using
-- plain check_idempotency. Moving either onto check_idempotency_intent would
-- require a fresh cross-operation same-key deadlock review.

-- Drain every draw that has reached the committed 20260816110000 shared
-- barrier and refuse new barrier participants until this transaction commits.
-- A cached-plan backend paused before its first wrapper statement can still
-- arrive after commit; the 24-hour operator freeze minimizes that residual
-- window and the shared intent helper fails closed on any resulting unbound
-- receipt. The migration runner must keep this file in one transaction. The
-- ON COMMIT DROP temp-table insert below is the deliberate autocommit guard;
-- SET LOCAL bounds lock waiting and the transaction-scoped advisory lock
-- drains/barriers draws only after that guard proves transaction scope.
CREATE TEMP TABLE crx_draw_intent_transaction_guard (
  marker boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO crx_draw_intent_transaction_guard(marker) VALUES (true);
SET LOCAL lock_timeout = '15s';
SELECT pg_advisory_xact_lock(20260816, 1);

DO $preflight$
DECLARE
  v_wrapper regprocedure := to_regprocedure(
    'public.draw_down_quote(uuid,jsonb,uuid,text,text)'
  );
  v_private regprocedure := to_regprocedure(
    'public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)'
  );
  v_intent_helper regprocedure := to_regprocedure(
    'public.check_idempotency_intent(text,text,uuid,text)'
  );
  v_money_impl regprocedure := to_regprocedure(
    'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)'
  );
  v_alloc_cumulative regprocedure := to_regprocedure(
    'public._allocated_cumulative_cents(uuid,numeric)'
  );
  v_alloc_delivery regprocedure := to_regprocedure(
    'public._allocated_delivery_cents(uuid,numeric,uuid)'
  );
  v_complete_delivery regprocedure := to_regprocedure(
    'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  );
  v_backfill_invoice regprocedure := to_regprocedure(
    'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'
  );
  v_close_remainder regprocedure := to_regprocedure(
    'public._close_undelivered_order_remainder_20260718(uuid,uuid)'
  );
  v_src text;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: transaction isolation must be read committed so the post-drain receipt scan sees newly committed receipts';
  END IF;

  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'draw_down_quote') <> 1
     OR v_wrapper IS NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: expected exactly one public draw_down_quote(uuid,jsonb,uuid,text,text) wrapper';
  END IF;

  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_draw_down_quote_intent_impl_20260819') <> 0
     OR v_private IS NOT NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: private wrapper name already exists; refusing a second wrapping layer';
  END IF;

  IF v_intent_helper IS NULL
     OR v_money_impl IS NULL
     OR v_alloc_cumulative IS NULL
     OR v_alloc_delivery IS NULL
     OR v_complete_delivery IS NULL
     OR v_backfill_invoice IS NULL
     OR v_close_remainder IS NULL
     OR to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: intent helper, digest, reviewed tier-split money implementation, or allocated-cent lifecycle prerequisite is missing';
  END IF;

  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'check_idempotency_intent') <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = v_intent_helper
          AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
     ) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed intent helper overload, owner, security, search_path, or grants drifted';
  END IF;

  IF (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
        FROM pg_proc p WHERE p.oid = v_intent_helper)
       IS DISTINCT FROM '71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed intent helper or governed wrapper body drifted';
  END IF;

  -- These exact pg_proc.prosrc hashes bind the wrapper to the reviewed bodies
  -- installed by apply-order steps 2 and 3. Signature-only checks are unsafe:
  -- the pre-tier weighted-average implementation used the same signature, and
  -- a partial apply without allocated-cent lifecycle propagation could bill a
  -- tier-split order differently from its stored line totals.
  IF (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
        FROM pg_proc p WHERE p.oid = v_money_impl)
       IS DISTINCT FROM 'd676cb3121925c17ac38d5a651c5ee842743b3072ec4d32516cbf61b9650f06a'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_alloc_cumulative)
       IS DISTINCT FROM '5cb6b4e7683213d878d76f0a1dbfa99757780331142f01fb36147d4008ce8f2b'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_alloc_delivery)
       IS DISTINCT FROM '1df1d230c19e5d129038b1e5dfbca30db0b369ea5a91a22f19dd98cc53129142'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_complete_delivery)
       IS DISTINCT FROM '0e889bb6e0bc998d2833081e8e6f8e801e032595e7360e09d4f594e13ed7ad24'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_backfill_invoice)
       IS DISTINCT FROM '6543165d2c7cb6acbffd222adb28fee9b66278338ec401f6b2f19537c8aebcaa'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_close_remainder)
       IS DISTINCT FROM '17ee638cd57c97ec5f3bec0a33f8b7d6ebac7f99ccd93e83802b14007a62be9f' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed pricing/lifecycle prerequisite body drifted; refusing a partial or unreviewed apply';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_attribute
        WHERE attrelid = 'public.idempotency_keys'::regclass
          AND attname = 'request_fingerprint'
          AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_attribute
        WHERE attrelid = 'public.idempotency_keys'::regclass
          AND attname = 'request_actor_id'
          AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: idempotency receipt binding columns are missing';
  END IF;

  -- The exclusive barrier above drains legacy draws that reached the shared
  -- lock and refuses new lock participants. This scan covers every retryable
  -- legacy receipt visible now; it is not a proof that a cached-plan backend
  -- paused before its first lock statement cannot finish after commit. Such a
  -- late unbound receipt is handled fail-closed by check_idempotency_intent and
  -- the operator-facing recovery opens its committed order rather than retrying.
  -- Refuse cutover while any currently visible legacy receipt remains.
  IF EXISTS (
    SELECT 1
      FROM public.idempotency_keys
     WHERE operation = 'draw_down_quote'
       AND expires_at > now()
  ) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: unexpired legacy draw_down_quote receipts exist; wait for expiry and re-run the read-only precheck before applying';
  END IF;

  SELECT p.prosrc
    INTO v_src
    FROM pg_proc p
   WHERE p.oid = v_wrapper
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
     AND pg_get_userbyid(p.proowner) = 'postgres';

  IF v_src IS NULL
     OR encode(extensions.digest(convert_to(v_src, 'UTF8'), 'sha256'), 'hex')
          IS DISTINCT FROM 'be2570888281520c9aaba61280a456cdbd9b69b83dfeba106c7a324c3751e4bf' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed intent helper or governed wrapper body drifted';
  END IF;

  IF v_src IS NULL
     OR position('pg_try_advisory_xact_lock_shared' IN v_src) = 0
     OR position('DRAW_DOWN_CUTOVER_IN_PROGRESS' IN v_src) = 0
     OR position('_begin_below_cost_money_write' IN v_src) = 0
     OR position('_draw_down_quote_below_cost_impl_20260810' IN v_src) = 0
     OR position('p_idempotency_key' IN v_src) = 0
     OR position('pg_try_advisory_xact_lock_shared' IN v_src)
          > position('_begin_below_cost_money_write' IN v_src)
     OR position('_begin_below_cost_money_write' IN v_src)
          > position('_draw_down_quote_below_cost_impl_20260810' IN v_src) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: governed wrapper shape drifted; refusing to wrap an unreviewed boundary';
  END IF;

  IF has_function_privilege('anon', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE')
     OR has_function_privilege('anon', v_intent_helper, 'EXECUTE')
     OR has_function_privilege('authenticated', v_intent_helper, 'EXECUTE')
     OR has_function_privilege('service_role', v_intent_helper, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_intent_helper, 'EXECUTE')
     OR has_function_privilege('anon', v_money_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_money_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_money_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_money_impl, 'EXECUTE') THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_PREFLIGHT: wrapper/helper ACL boundary drifted';
  END IF;
END;
$preflight$;

-- Preserve the current cutover + below-cost wrapper byte-for-byte. It remains
-- SECURITY DEFINER and owned by postgres; only its public name and ACL change.
ALTER FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  RENAME TO _draw_down_quote_intent_impl_20260819;

REVOKE ALL ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)
  TO postgres;

CREATE FUNCTION public.draw_down_quote(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_canonical_draws jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  -- DRAW_DOWN_INTENT_BARRIER<<<
  -- Keep the cutover barrier first. The preserved private wrapper takes the
  -- same shared lock again, which is safe for the same transaction. This outer
  -- copy prevents intent work from starting while the tier cutover is active.
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_IN_PROGRESS: a draw-down maintenance change is being applied right now, so this draw was not recorded. Nothing was changed. Please try again in a moment.';
  END IF;
  -- >>>DRAW_DOWN_INTENT_BARRIER

  -- DRAW_DOWN_INTENT_AUTHZ<<<
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- >>>DRAW_DOWN_INTENT_AUTHZ

  -- DRAW_DOWN_INTENT_KEY_LOCK<<<
  -- Take the shared idempotency-key lock before the quote row lock. The helper
  -- below takes the same transaction-scoped lock again before reading the
  -- receipt; PostgreSQL advisory locks are re-entrant for the same session.
  -- This keeps lock order consistent with the helper's other money callers and
  -- prevents a same-key/cross-operation request from forming a key/row cycle.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key COLLATE "C" !~ '^[!-~]{1,200}$' THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );
  -- >>>DRAW_DOWN_INTENT_KEY_LOCK

  -- Canonicalize exactly the entries the implementation will execute. Array
  -- order and duplicates remain meaningful because they become separate draw
  -- inputs/order lines; numeric spelling does not (1, 1.0 and 1.00 are one
  -- intent). Invalid/non-positive entries are skipped exactly as the mature
  -- implementation skips them.
  IF p_draws IS NULL
     OR jsonb_typeof(p_draws) <> 'array'
     OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'product_id') IS NOT NULL
       AND NOT pg_input_is_valid(d.value ->> 'product_id', 'uuid')
  ) THEN
    RAISE EXCEPTION
      'BOOKING_PRODUCT_INVALID: draw product id must be a UUID';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'quantity') IS NOT NULL
       AND NOT pg_input_is_valid(d.value ->> 'quantity', 'numeric')
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_INVALID: draw quantity must be numeric';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'quantity') IS NOT NULL
       AND (d.value ->> 'quantity')::numeric IN (
         'NaN'::numeric,
         'Infinity'::numeric,
         '-Infinity'::numeric
       )
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_INVALID: draw quantity must be finite';
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'product_id', (d.value ->> 'product_id')::uuid,
               'quantity', trim_scale((d.value ->> 'quantity')::numeric)
             ) ORDER BY d.ordinality
           ),
           '[]'::jsonb
         )
    INTO v_canonical_draws
    FROM jsonb_array_elements(p_draws) WITH ORDINALITY AS d(value, ordinality)
   WHERE (d.value ->> 'product_id') IS NOT NULL
     AND COALESCE((d.value ->> 'quantity')::numeric, 0) > 0;

  IF jsonb_array_length(v_canonical_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          -- p_performed_by is deliberately absent: the strict ACTOR_MISMATCH
          -- guard above proves it is either NULL or exactly v_actor. If that
          -- guard is ever relaxed, p_performed_by MUST become fingerprint input.
          'actor_id', v_actor,
          'quote_id', p_quote_id,
          'draws', v_canonical_draws
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- The shared helper takes a transaction-scoped lock on the key. That closes
  -- same-key races even when two requests name different quote rows.
  -- DRAW_DOWN_INTENT_REPLAY<<<
  v_replay := public.check_idempotency_intent(
    p_idempotency_key,
    'draw_down_quote',
    v_actor,
    v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR NULLIF(v_replay -> 'result' ->> 'order_id', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  -- >>>DRAW_DOWN_INTENT_REPLAY

  -- DRAW_DOWN_INTENT_LIVE_QUOTE<<<
  -- A committed receipt is authoritative even if its quote was soft-deleted
  -- after the draw. For a first call, authorize and lock the live booking only
  -- after the exact actor/intent replay check. There is intentionally no
  -- created_by/customer-assignment predicate: active reps may cover one
  -- another's bookings. The inner money implementation takes the same row lock
  -- again before any business write.
  PERFORM 1
    FROM public.quotes
   WHERE id = p_quote_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  -- >>>DRAW_DOWN_INTENT_LIVE_QUOTE

  -- This preserved wrapper still owns below-cost approval and forwards to the
  -- tier-split money implementation. p_below_cost_reason is approval metadata,
  -- not mutation identity, so it is deliberately absent from the fingerprint.
  -- DRAW_DOWN_INTENT_FIRST_CALL<<<
  v_result := public._draw_down_quote_intent_impl_20260819(
    p_quote_id,
    p_draws,
    p_performed_by,
    p_idempotency_key,
    p_below_cost_reason
  );

  IF v_result IS NULL
     OR jsonb_typeof(v_result) IS DISTINCT FROM 'object'
     OR NULLIF(v_result ->> 'order_id', '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- >>>DRAW_DOWN_INTENT_FIRST_CALL

  -- DRAW_DOWN_INTENT_BIND<<<
  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'draw_down_quote';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;
  -- >>>DRAW_DOWN_INTENT_BIND

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text) IS
  'Draw a live booking through the governed below-cost/tier-split implementation. Idempotent retries are bound to actor, quote and canonical draw quantities.';

REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  TO authenticated;

DO $postflight$
DECLARE
  v_wrapper regprocedure := to_regprocedure(
    'public.draw_down_quote(uuid,jsonb,uuid,text,text)'
  );
  v_private regprocedure := to_regprocedure(
    'public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)'
  );
  v_intent_helper regprocedure := to_regprocedure(
    'public.check_idempotency_intent(text,text,uuid,text)'
  );
  v_money_impl regprocedure := to_regprocedure(
    'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)'
  );
  v_alloc_cumulative regprocedure := to_regprocedure(
    'public._allocated_cumulative_cents(uuid,numeric)'
  );
  v_alloc_delivery regprocedure := to_regprocedure(
    'public._allocated_delivery_cents(uuid,numeric,uuid)'
  );
  v_complete_delivery regprocedure := to_regprocedure(
    'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  );
  v_backfill_invoice regprocedure := to_regprocedure(
    'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'
  );
  v_close_remainder regprocedure := to_regprocedure(
    'public._close_undelivered_order_remainder_20260718(uuid,uuid)'
  );
  v_outer_src text;
  v_private_src text;
  v_helper_src text;
BEGIN
  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'draw_down_quote') <> 1
     OR (SELECT count(*)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = '_draw_down_quote_intent_impl_20260819') <> 1
     OR v_wrapper IS NULL
     OR v_private IS NULL
     OR v_intent_helper IS NULL
     OR v_money_impl IS NULL
     OR v_alloc_cumulative IS NULL
     OR v_alloc_delivery IS NULL
     OR v_complete_delivery IS NULL
     OR v_backfill_invoice IS NULL
     OR v_close_remainder IS NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: wrapper chain or reviewed pricing/lifecycle prerequisite is missing';
  END IF;

  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'check_idempotency_intent') <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = v_intent_helper
          AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
     ) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: reviewed intent helper overload, owner, security, search_path, or grants changed';
  END IF;

  IF (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
        FROM pg_proc p WHERE p.oid = v_money_impl)
       IS DISTINCT FROM 'd676cb3121925c17ac38d5a651c5ee842743b3072ec4d32516cbf61b9650f06a'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_alloc_cumulative)
       IS DISTINCT FROM '5cb6b4e7683213d878d76f0a1dbfa99757780331142f01fb36147d4008ce8f2b'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_alloc_delivery)
       IS DISTINCT FROM '1df1d230c19e5d129038b1e5dfbca30db0b369ea5a91a22f19dd98cc53129142'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_complete_delivery)
       IS DISTINCT FROM '0e889bb6e0bc998d2833081e8e6f8e801e032595e7360e09d4f594e13ed7ad24'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_backfill_invoice)
       IS DISTINCT FROM '6543165d2c7cb6acbffd222adb28fee9b66278338ec401f6b2f19537c8aebcaa'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_close_remainder)
       IS DISTINCT FROM '17ee638cd57c97ec5f3bec0a33f8b7d6ebac7f99ccd93e83802b14007a62be9f' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: reviewed pricing/lifecycle prerequisite body changed';
  END IF;

  SELECT p.prosrc
    INTO v_outer_src
    FROM pg_proc p
   WHERE p.oid = v_wrapper
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
     AND pg_get_userbyid(p.proowner) = 'postgres';

  SELECT p.prosrc
    INTO v_helper_src
    FROM pg_proc p
   WHERE p.oid = v_intent_helper
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
     AND pg_get_userbyid(p.proowner) = 'postgres';

  SELECT p.prosrc
    INTO v_private_src
    FROM pg_proc p
   WHERE p.oid = v_private
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
     AND pg_get_userbyid(p.proowner) = 'postgres';

  IF v_helper_src IS NULL
     OR encode(extensions.digest(convert_to(v_helper_src, 'UTF8'), 'sha256'), 'hex')
          IS DISTINCT FROM '71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8'
     OR v_private_src IS NULL
     OR encode(extensions.digest(convert_to(v_private_src, 'UTF8'), 'sha256'), 'hex')
          IS DISTINCT FROM 'be2570888281520c9aaba61280a456cdbd9b69b83dfeba106c7a324c3751e4bf'
     OR v_outer_src IS NULL
     OR encode(extensions.digest(convert_to(v_outer_src, 'UTF8'), 'sha256'), 'hex')
          IS DISTINCT FROM 'ffdb9dce46503dceec0575a70096c4ee928a2595b572044309e359f0128faef7' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: reviewed intent helper or wrapper body changed';
  END IF;

  IF v_outer_src IS NULL
     OR position('pg_try_advisory_xact_lock_shared' IN v_outer_src) = 0
     OR position('auth.uid()' IN v_outer_src) = 0
     OR position('deleted_at IS NULL' IN v_outer_src) = 0
     OR position('check_idempotency_intent' IN v_outer_src) = 0
     OR position('''actor_id'', v_actor' IN v_outer_src) = 0
     OR position('''quote_id'', p_quote_id' IN v_outer_src) = 0
     OR position('''draws'', v_canonical_draws' IN v_outer_src) = 0
     OR position('request_fingerprint = v_fingerprint' IN v_outer_src) = 0
     OR position('request_actor_id = v_actor' IN v_outer_src) = 0
     OR position('_draw_down_quote_intent_impl_20260819' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_BARRIER<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_AUTHZ<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_KEY_LOCK<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_REPLAY<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_LIVE_QUOTE<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_FIRST_CALL<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_BIND<<<' IN v_outer_src) = 0
     OR position('DRAW_DOWN_INTENT_BARRIER<<<' IN v_outer_src)
          > position('DRAW_DOWN_INTENT_AUTHZ<<<' IN v_outer_src)
     OR position('DRAW_DOWN_INTENT_AUTHZ<<<' IN v_outer_src)
          > position('DRAW_DOWN_INTENT_KEY_LOCK<<<' IN v_outer_src)
     OR position('DRAW_DOWN_INTENT_KEY_LOCK<<<' IN v_outer_src)
          > position('DRAW_DOWN_INTENT_REPLAY<<<' IN v_outer_src)
     OR position('DRAW_DOWN_INTENT_REPLAY<<<' IN v_outer_src)
          > position('DRAW_DOWN_INTENT_LIVE_QUOTE<<<' IN v_outer_src)
     OR position('DRAW_DOWN_INTENT_LIVE_QUOTE<<<' IN v_outer_src)
          > position('DRAW_DOWN_INTENT_FIRST_CALL<<<' IN v_outer_src)
     OR position('DRAW_DOWN_INTENT_FIRST_CALL<<<' IN v_outer_src)
          > position('DRAW_DOWN_INTENT_BIND<<<' IN v_outer_src) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: outer intent/authorization ordering changed';
  END IF;

  IF v_private_src IS NULL
     OR position('pg_try_advisory_xact_lock_shared' IN v_private_src) = 0
     OR position('_begin_below_cost_money_write' IN v_private_src) = 0
     OR position('_draw_down_quote_below_cost_impl_20260810' IN v_private_src) = 0
     OR position('pg_try_advisory_xact_lock_shared' IN v_private_src)
          > position('_begin_below_cost_money_write' IN v_private_src)
     OR position('_begin_below_cost_money_write' IN v_private_src)
          > position('_draw_down_quote_below_cost_impl_20260810' IN v_private_src) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: preserved cutover/below-cost wrapper changed';
  END IF;

  IF has_function_privilege('anon', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
     OR has_function_privilege('service_role', v_wrapper, 'EXECUTE')
     OR has_function_privilege('anon', v_private, 'EXECUTE')
     OR has_function_privilege('authenticated', v_private, 'EXECUTE')
     OR has_function_privilege('service_role', v_private, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_private, 'EXECUTE')
     OR has_function_privilege('anon', v_intent_helper, 'EXECUTE')
     OR has_function_privilege('authenticated', v_intent_helper, 'EXECUTE')
     OR has_function_privilege('service_role', v_intent_helper, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_intent_helper, 'EXECUTE')
     OR has_function_privilege('anon', v_money_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_money_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_money_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_money_impl, 'EXECUTE') THEN
    RAISE EXCEPTION
      'DRAW_DOWN_INTENT_POSTFLIGHT: wrapper ACL boundary changed';
  END IF;

  RAISE NOTICE
    'DRAW_DOWN_INTENT_BINDING_OK: exact retries are actor/quote/quantity-bound; tier-split money implementation preserved';
END;
$postflight$;
