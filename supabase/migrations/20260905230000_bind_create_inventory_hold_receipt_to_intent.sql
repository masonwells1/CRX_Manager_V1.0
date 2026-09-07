-- ============================================================================
-- Serialize create_inventory_hold on its idempotency key and bind the receipt to
-- the signed-in actor and the exact hold request.
-- STATUS: NOT APPLIED — DO NOT APPLY. LOCAL CANDIDATE; forward-only wrapper over
-- the live create_inventory_hold body; no data rewrite.
--
-- idempotency-body-check: exempt — the public function below is a wrapper that
-- delegates its receipt handling: it calls public.check_idempotency_intent
-- (advisory lock + actor/intent comparison) BEFORE any mutation, the renamed
-- live body writes the receipt row, and the wrapper then binds that row with an
-- UPDATE. Neither half of the hook's direct or helper pattern appears verbatim.
--
-- caller-analysis: create_inventory_hold :: the only caller is the browser
--   (src/pages/InventoryPage.tsx callCreateHoldRpc, signed in as authenticated,
--   always sends p_idempotency_key). This file REVOKEs only PUBLIC and anon and
--   re-issues GRANT EXECUTE TO authenticated, service_role on the same
--   signature, so that callsite keeps EXECUTE. The postflight asserts it.
-- caller-analysis: _create_inventory_hold_intent_impl_20260905 :: new private
--   name for the renamed live body; no caller anywhere but the public wrapper,
--   which runs as its owner postgres. Revoking every role but postgres is the
--   point: the unserialized body must not be reachable directly.
--
-- DEFECT (Codex push-proof HIGH, 2026-09-05, on the inventory frozen-retry
-- branch): the live create_inventory_hold reads its idempotency receipt with a
-- plain SELECT, takes the stock lock (FOR UPDATE on inventory) only afterwards,
-- inserts the hold, and only then writes the receipt with ON CONFLICT DO
-- NOTHING. Two overlapping calls with the SAME key (a double-click, or a retry
-- racing the original) both miss the receipt and both insert a hold. What
-- happens next was measured on the real schema (see PROOF): the live BEFORE
-- INSERT guard on idempotency_keys (20260714230000 / 20260716160000) rolls the
-- loser back with IDEMPOTENCY_CONCURRENT_REPLAY_RETRY, so the table ends with
-- ONE hold — but the losing caller is told its hold FAILED although the winner
-- created exactly that hold. A browser that reads that as a definitive
-- refusal releases its key, and the operator's next click mints a new key and
-- a second hold. The fix is to make the loser WAIT and REPLAY the winner's
-- receipt instead of erroring, which is what a per-key lock taken before any
-- work does. adjust_inventory already behaves that way (check_idempotency
-- holds the per-key advisory lock) and is not touched.
--
-- SOURCE: the installed body is the one in
-- 20260630173022_parked_010_create_inventory_hold_auth_first.sql. Evidence: the
-- checked-in production schema dump supabase/baselines/20260727174805_public_schema.sql.br
-- (pg_dump of public, 2026-07-27) contains exactly ONE definition of
-- create_inventory_hold, SECURITY DEFINER, search_path=public, pg_temp, whose
-- body (the text between the dollar quotes, exactly what pg_proc.prosrc stores)
-- hashes to sha256
--   3c86421e62db4cd51b86f62b9345155c12df2696e6956e751dd97883bf684d09
-- — the parked_010 body — and the baseline migration ledger lists
-- 20260630173022 as applied. No migration after the 2026-07-27 baseline
-- redefines the function. The only other body ever shipped for this signature,
-- 20260507200000_fix_create_inventory_hold_force_reason_guard.sql (sha256
--   a5cc7fcc729039f067bbfd570928d8b20989a9ae6d44ae5f69c6bda1e53de2d6),
-- has the same defect and the same argument list, so the preflight accepts
-- EITHER hash and refuses anything else. Both candidate bodies keep the
-- browser-visible contract: same ten arguments and defaults, RETURNS jsonb
-- {hold_id, todays_free_before, forced}, and the same error tokens
-- (AUTH_REQUIRED, ACTOR_MISMATCH, INSUFFICIENT_ROLE, INVALID_HOLD_TYPE,
-- INVALID_QUANTITY, FORCE_REQUIRES_ADMIN, FORCE_REQUIRES_REASON,
-- INSUFFICIENT_HOLD_INVENTORY).
--
-- CHANGE (same shape as 20260826221000 for receive_po_items and 20260811130000
-- for the commission payouts):
--   1. Rename the live body to public._create_inventory_hold_intent_impl_20260905
--      unchanged, executable only by postgres.
--   2. Install a public wrapper with the IDENTICAL signature and defaults that
--      (a) requires auth.uid(), refuses a forged p_performed_by (ACTOR_MISMATCH,
--      same rule as the live body), and gates on an ACTIVE admin/sales_rep
--      profile with a NULL-safe predicate — the live body's `v_role NOT IN`
--      fails OPEN when the profile row is missing (H1 class) and ignores
--      is_active; (b) REQUIRES p_idempotency_key (every browser caller already
--      sends one — src/pages/InventoryPage.tsx callCreateHoldRpc); (c) hashes
--      the hold request into a fingerprint and calls check_idempotency_intent,
--      which takes the per-key advisory lock and either replays the bound
--      receipt, refuses a changed request / other actor / pre-migration receipt,
--      or reports no receipt; (d) only then calls the renamed body, which does
--      the stock check, the hold insert, the activity row and the receipt
--      insert exactly as before; (e) binds the new receipt to the actor and
--      fingerprint, refusing to commit if the receipt is missing.
--   The second of two racing same-key calls now waits on the advisory lock and
--   replays the first call's result: one hold, one receipt, BOTH callers get
--   the same hold_id.
--   Pre-migration receipts (no binding columns) would be refused by
--   check_idempotency_intent with IDEMPOTENCY_INTENT_MISMATCH for the rest of
--   their 24h life, and the Inventory page treats that as an UNCERTAIN outcome
--   and keeps the frozen intent locked (src/lib/idempotency.ts
--   isDefinitiveRpcRejection returns false for it), so an operator holding such
--   a key could not create ANY hold until it expired. The helper's legacy branch
--   also discloses the committed result before comparing actors. Therefore the
--   preflight ABORTS (PREFLIGHT_LEGACY_RECEIPTS) while any unexpired unbound
--   create_inventory_hold receipt exists — the same rule 20260826221000 applies
--   (SECTION9_ACTIVE_LEGACY_IDEMPOTENCY_RECEIPTS). Apply in a quiet window; if
--   it refuses, wait for the receipts to expire (<= 24h) and re-run.
--   No post-apply path can write an unbound create_inventory_hold receipt: the
--   impl is executable only by postgres, no migration calls
--   create_inventory_hold from SQL, and the wrapper binds the receipt in the
--   same transaction or rolls back (IDEMPOTENCY_RECEIPT_MISSING). That is why
--   this file does not add a BEFORE INSERT binding trigger arm like
--   _section9_bind_idempotency_receipt_20260826; in-flight callers that
--   resolved the old body before the rename are drained by the ACCESS EXCLUSIVE
--   lock below (the old body reads idempotency_keys first, so it holds ACCESS
--   SHARE for the rest of its transaction).
--   Atomicity: this file carries no BEGIN/COMMIT of its own. Apply it ONLY
--   through scripts/apply-migration-file.mjs (or psql -1), which wraps the whole
--   file in one transaction, so the rename, the wrapper, the grants and both
--   checks commit together or not at all. A half-applied state (impl present,
--   public function absent) is refused by PREFLIGHT_MISSING on purpose.
--   The ACCESS EXCLUSIVE lock queues every receipt-writing RPC for the few
--   milliseconds of the swap, bounded by lock_timeout = 10s.
--
-- PREFLIGHT: check_idempotency_intent(text,text,uuid,text),
-- extensions.digest(bytea,text) and pg_catalog.trim_scale(numeric) installed;
-- exactly one overload of create_inventory_hold in public; the private impl name
-- absent (or, on a re-run, present with the pinned body while the public
-- function is already this wrapper); owner postgres, plpgsql, SECURITY DEFINER,
-- search_path=public, pg_temp; prosrc sha256 in the two pinned values; the
-- public function's full argument list INCLUDING DEFAULTS equals the pinned
-- string (prosrc does not contain defaults, so the hash cannot cover them);
-- both receipt binding columns present; ZERO unexpired unbound
-- create_inventory_hold receipts (else PREFLIGHT_LEGACY_RECEIPTS).
-- POSTFLIGHT: one overload each for the public wrapper and the impl, both with
-- the pinned argument list and defaults; wrapper calls check_idempotency_intent,
-- the impl, and binds the receipt; ACL — impl executable by nobody but postgres;
-- wrapper executable by authenticated and service_role, not anon, not PUBLIC;
-- check_idempotency_intent itself still not executable by anon, authenticated
-- or service_role (the serialization guarantee rests on that).
-- ROLLBACK: a NEW forward migration that drops the wrapper and renames
-- _create_inventory_hold_intent_impl_20260905 back to create_inventory_hold
-- (or re-emits the pinned body), then restores GRANT EXECUTE TO authenticated.
-- PROOF: scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs
-- (network-disabled throwaway Supabase PostgreSQL 17 image on the checked-in
-- 2026-07-27 baseline plus every later migration; two-session same-key race
-- BEFORE the candidate leaves one hold and an ERROR for the loser, AFTER it
-- leaves one hold and the same hold_id for both) and the rolled-back chain
-- scripts/smoke/smoke-create-inventory-hold-intent-binding.sql.
-- ============================================================================

-- The whole file runs in one transaction (psql -1 / the apply script). Holding
-- the receipt table exclusively for the few milliseconds of the swap means no
-- hold can be created between "old body renamed" and "wrapper installed".
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_public_sig text := 'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)';
  v_impl_sig   text := 'public._create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)';
  v_public_oid oid;
  v_impl_oid   oid;
  v_count      integer;
  v_owner      text;
  v_lang       text;
  v_secdef     boolean;
  v_config     text[];
  v_sha        text;
  v_src        text;
  v_legacy     integer;
  v_body_oid   oid;
  v_body_label text;
  v_args       text;
  v_args_pin   text := 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text';
BEGIN
  -- Helpers first: the body hash below calls extensions.digest, so a missing
  -- helper must be reported by name, not by a raw "does not exist" error.
  IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: public.check_idempotency_intent(text, text, uuid, text) is not installed (20260811130000).';
  END IF;
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: extensions.digest(bytea, text) is not installed (pgcrypto).';
  END IF;
  IF to_regprocedure('pg_catalog.trim_scale(numeric)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: pg_catalog.trim_scale(numeric) is not installed (PostgreSQL 13+).';
  END IF;

  v_public_oid := to_regprocedure(v_public_sig);
  v_impl_oid   := to_regprocedure(v_impl_sig);

  IF v_public_oid IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING: % is not installed. This migration wraps an existing body; it does not create one.',
      v_public_sig;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'create_inventory_hold';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload of create_inventory_hold in public, found %. Reconcile before applying.',
      v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = '_create_inventory_hold_intent_impl_20260905';
  IF v_count > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: found % overloads of _create_inventory_hold_intent_impl_20260905; expected at most 1.',
      v_count;
  END IF;

  -- First run: the public function must still be the live body. Re-run: the
  -- public function is already this wrapper and the impl must be the live body.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_public_oid;
  IF v_impl_oid IS NULL THEN
    IF position('check_idempotency_intent' IN v_src) > 0 THEN
      RAISE EXCEPTION
        'PREFLIGHT_STATE: create_inventory_hold already calls check_idempotency_intent but % is missing. The swap is half done; investigate before re-running.',
        v_impl_sig;
    END IF;
    v_body_oid := v_public_oid;
    v_body_label := v_public_sig;
  ELSE
    IF position('check_idempotency_intent' IN v_src) = 0 THEN
      RAISE EXCEPTION
        'PREFLIGHT_STATE: % exists but create_inventory_hold is not the intent wrapper. Investigate before re-running.',
        v_impl_sig;
    END IF;
    v_body_oid := v_impl_oid;
    v_body_label := v_impl_sig;
  END IF;

  SELECT r.rolname, l.lanname, p.prosecdef, p.proconfig,
         encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
    INTO v_owner, v_lang, v_secdef, v_config, v_sha
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_body_oid;

  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'PREFLIGHT_OWNER: % is owned by %, expected postgres.', v_body_label, v_owner;
  END IF;
  IF v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'PREFLIGHT_LANGUAGE: % is %, expected plpgsql.', v_body_label, v_lang;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PREFLIGHT_SECURITY: % is not SECURITY DEFINER.', v_body_label;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'PREFLIGHT_SEARCH_PATH: % has proconfig %, expected {search_path=public, pg_temp}.',
      v_body_label, v_config;
  END IF;
  IF v_sha NOT IN (
    '3c86421e62db4cd51b86f62b9345155c12df2696e6956e751dd97883bf684d09',  -- 20260630173022 (baseline dump 2026-07-27)
    'a5cc7fcc729039f067bbfd570928d8b20989a9ae6d44ae5f69c6bda1e53de2d6'   -- 20260507200000 (previous body)
  ) THEN
    RAISE EXCEPTION
      'PREFLIGHT_BODY: % has prosrc sha256 %, which is neither pinned body. Re-verify the live definition before wrapping it.',
      v_body_label, v_sha;
  END IF;

  -- prosrc excludes argument defaults, and to_regprocedure matches types only.
  -- PostgREST callers omit p_force_reason / p_force, so the defaults are part
  -- of the live contract and must be pinned separately.
  SELECT pg_get_function_arguments(v_public_oid) INTO v_args;
  IF v_args <> v_args_pin THEN
    RAISE EXCEPTION
      'PREFLIGHT_ARGS: % has argument list "%", expected "%".',
      v_public_sig, v_args, v_args_pin;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_attribute
   WHERE attrelid = 'public.idempotency_keys'::regclass
     AND attname IN ('request_actor_id', 'request_fingerprint')
     AND NOT attisdropped;
  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_COLUMNS: idempotency_keys needs request_actor_id and request_fingerprint (20260803010917); found % of 2.',
      v_count;
  END IF;

  -- Live receipts written by the pre-migration body carry no binding. After the
  -- swap, check_idempotency_intent would refuse them for the rest of their 24h
  -- life, the Inventory page would keep that operator's intent locked, and the
  -- helper's legacy branch discloses the committed result before comparing
  -- actors. Refuse to apply while any exist (same rule as 20260826221000).
  SELECT count(*) INTO v_legacy
    FROM public.idempotency_keys
   WHERE operation = 'create_inventory_hold'
     AND request_actor_id IS NULL
     AND request_fingerprint IS NULL
     AND expires_at >= now();
  IF v_legacy > 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_LEGACY_RECEIPTS: % unexpired unbound create_inventory_hold receipt(s) exist. Apply in a quiet window after they expire (<= 24h); do not delete live receipts.',
      v_legacy;
  END IF;
  RAISE NOTICE 'create_inventory_hold: no unexpired pre-migration receipts; safe to swap.';
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- Step 1: keep the live body, under a private name.
-- ---------------------------------------------------------------------------
DO $rename$
BEGIN
  IF to_regprocedure('public._create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)') IS NULL THEN
    ALTER FUNCTION public.create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text)
      RENAME TO _create_inventory_hold_intent_impl_20260905;
  END IF;
END;
$rename$;

REVOKE ALL ON FUNCTION public._create_inventory_hold_intent_impl_20260905(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._create_inventory_hold_intent_impl_20260905(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text)
  TO postgres;

COMMENT ON FUNCTION public._create_inventory_hold_intent_impl_20260905(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text) IS
  'Pre-20260905 create_inventory_hold body, renamed unchanged. Only public.create_inventory_hold may call it; that wrapper holds the per-key advisory lock and binds the receipt.';

-- ---------------------------------------------------------------------------
-- Step 2: the public wrapper. Same signature, same defaults, same result shape.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_inventory_hold(
  p_product_id uuid,
  p_customer_id uuid,
  p_quantity numeric,
  p_hold_type text,
  p_expires_at date,
  p_notes text,
  p_performed_by uuid,
  p_force boolean DEFAULT false,
  p_force_reason text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- Same rule as the wrapped body: the caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- NULL-safe and active-only. A missing or deactivated profile is refused
  -- here; the wrapped body's own gate runs again afterwards and can only be
  -- stricter than a pass.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- A key is required so every hold is a receipt that a retry can find. Blank,
  -- whitespace-only, or non-printable keys are refused before any work.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_inventory_hold requires p_idempotency_key';
  END IF;

  -- Everything that shapes the hold. p_performed_by is not included: the
  -- guard above constrains it to {NULL, actor} and the wrapped body stamps
  -- created_by from auth.uid(), so it cannot change the outcome. That omission
  -- DEPENDS on the ACTOR_MISMATCH guard; if that guard is ever relaxed,
  -- p_performed_by must join the fingerprint (same warning as 20260811130000).
  -- trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'customer_id', p_customer_id,
    'quantity', trim_scale(p_quantity),
    'hold_type', p_hold_type,
    'expires_at', p_expires_at,
    'notes', p_notes,
    'force', COALESCE(p_force, false),
    'force_reason', p_force_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction.
  -- A racing same-key call waits here until this one commits, then replays.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_inventory_hold', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Stock check under FOR UPDATE, hold insert, activity row, receipt insert —
  -- unchanged from the live body.
  v_result := public._create_inventory_hold_intent_impl_20260905(
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, p_performed_by, p_force, p_force_reason, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_inventory_hold';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text) IS
  'Creates a manual/crop_program inventory hold. Requires p_idempotency_key; serializes on the key (check_idempotency_intent) and binds the receipt to the actor and the exact request before delegating to the pre-20260905 body.';

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_public_sig text := 'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)';
  v_impl_sig   text := 'public._create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)';
  v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';
  v_args_pin   text := 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text';
  v_count integer;
  v_src   text;
  v_args  text;
  v_role  text;
  v_sig   text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[v_public_sig, v_impl_sig] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'POSTFLIGHT_MISSING: % is not installed.', v_sig;
    END IF;
    SELECT pg_get_function_arguments(to_regprocedure(v_sig)) INTO v_args;
    IF v_args <> v_args_pin THEN
      RAISE EXCEPTION 'POSTFLIGHT_ARGS: % has argument list "%", expected "%".', v_sig, v_args, v_args_pin;
    END IF;
    SELECT count(*) INTO v_count
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = (SELECT proname FROM pg_proc WHERE oid = to_regprocedure(v_sig));
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: % has % overloads, expected 1.', v_sig, v_count;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = to_regprocedure(v_sig)
         AND r.rolname = 'postgres'
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'POSTFLIGHT_SHAPE: % is not a postgres-owned SECURITY DEFINER function with search_path=public, pg_temp.', v_sig;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_public_sig);
  IF position('public.check_idempotency_intent(' IN v_src) = 0
     OR position('IDEMPOTENCY_KEY_REQUIRED: create_inventory_hold requires p_idempotency_key' IN v_src) = 0
     OR position('public._create_inventory_hold_intent_impl_20260905(' IN v_src) = 0
     OR position('IDEMPOTENCY_RECEIPT_MISSING' IN v_src) = 0
     OR position('ACTOR_MISMATCH' IN v_src) = 0
     OR position('IDEMPOTENCY_RESULT_INVALID' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: the installed create_inventory_hold is not the intent wrapper.';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_impl_sig);
  IF position('check_idempotency_intent' IN v_src) > 0
     OR position('INSERT INTO inventory_holds' IN v_src) = 0
     OR position('FOR UPDATE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: the impl is not the pre-20260905 hold body.';
  END IF;

  -- The impl must be reachable only through the wrapper.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_impl_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_impl_sig;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('postgres', v_impl_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: postgres cannot execute %.', v_impl_sig;
  END IF;

  IF has_function_privilege('anon', v_public_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: anon can execute %.', v_public_sig;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_public_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % cannot execute %.', v_role, v_public_sig;
    END IF;
  END LOOP;

  -- The serialization guarantee rests on the helper being reachable only from
  -- postgres-owned SECURITY DEFINER wrappers (20260811130000).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_helper_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_helper_sig;
    END IF;
  END LOOP;
END;
$verify$;
