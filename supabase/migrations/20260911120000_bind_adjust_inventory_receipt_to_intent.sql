-- ============================================================================
-- adjust_inventory: authenticate and role-check the caller BEFORE any receipt
-- replay, serialize on the idempotency key, and bind the receipt to the
-- signed-in admin and the exact adjustment.
-- STATUS: NOT APPLIED — DO NOT APPLY. LOCAL CANDIDATE; forward-only
-- CREATE OR REPLACE of the live adjust_inventory body plus one BEFORE INSERT
-- cutover trigger on idempotency_keys; no data rewrite.
--
-- idempotency-body-check: exempt — the body below DOES enforce
-- p_idempotency_key: it requires the key, calls public.check_idempotency_intent
-- (per-key advisory lock + actor/intent comparison + replay) BEFORE any
-- mutation, and writes the receipt with a direct INSERT INTO
-- public.idempotency_keys that carries request_actor_id and
-- request_fingerprint. The hook's helper pattern wants check_idempotency( plus
-- save_idempotency(, and save_idempotency cannot write the binding columns, so
-- neither of the hook's patterns fits a bound receipt.
--
-- caller-analysis: adjust_inventory :: only the browser calls it, signed in as authenticated (src/pages/InventoryPage.tsx handleAdjust and src/components/inventory/BatchAdjustModal.tsx, both always send p_idempotency_key); this file REVOKEs only PUBLIC and anon, which hold no EXECUTE on live today, and re-issues GRANT EXECUTE TO authenticated, service_role; no SQL function, cron job or edge function calls it
-- caller-analysis: _refuse_unbound_adjust_inventory_receipt_20260911 :: new trigger function created here; nothing calls it directly and a trigger fires it regardless of EXECUTE, so no role needs EXECUTE
--
-- DEFECT (gpt-5.6-sol exact-SHA review of PR #624, rule CRX-IDEM-01, Low): the
-- live adjust_inventory reads its idempotency receipt FIRST —
-- check_idempotency(p_idempotency_key, 'adjust_inventory') — and returns the
-- cached result before it calls auth.uid(), before the p_performed_by check,
-- and before the admin-role check. Anyone who can execute the function and
-- holds an unexpired adjustment key (a same-origin script, or someone reading
-- a shared browser's storage, where the Inventory page keeps its retained key)
-- is handed that adjustment's product_id and new_quantity, whatever role they
-- have and whatever delta they send. No new stock change is possible that way;
-- it is a read of someone else's result. Measured on the real schema (PROOF):
-- a sales rep calling with an admin's key receives the admin's receipt.
-- SECOND DEFECT, found while replacing the body: numeric accepts NaN and
-- +/-Infinity. The live body's only checks are `p_delta = 0` and
-- `v_new_qty < 0`, and PostgreSQL sorts NaN above every number, so a NaN delta
-- passes both and is written into inventory.quantity_available, which has no
-- CHECK constraint. An admin-only path, but it corrupts stock, so the new body
-- refuses NULL, NaN and infinite deltas (INVALID_ADJUSTMENT_QUANTITY).
--
-- SOURCE: the installed body (read-only from pg_proc on 2026-09-11) is
-- SECURITY DEFINER, owner postgres, plpgsql, search_path=public, pg_temp,
-- exactly one overload, prosrc 1916 characters, LF only, sha256
--   ef485890f3b9ef82359a95dda95d12a57ad633b86f841ead80e872d1eb71b4df
-- The checked-in 2026-07-27 production schema baseline carries the same body
-- (the prover asserts the hash) and no later migration redefines it.
--
-- CHANGE (same pattern as 20260908130000 for create_inventory_hold, done
-- inline because this body is small):
--   1. Order: auth.uid() (AUTH_REQUIRED) -> p_performed_by may name only the
--      caller (ACTOR_MISMATCH) -> the caller must have an ACTIVE admin profile,
--      NULL-safe (INSUFFICIENT_ROLE) -> a non-blank key is required
--      (IDEMPOTENCY_KEY_REQUIRED) -> the delta must be a finite non-zero
--      number -> ONLY THEN is any receipt looked at.
--   2. The request is fingerprinted (actor, inventory row, trim_scale(delta),
--      reason) and public.check_idempotency_intent takes the per-key advisory
--      lock and either replays a receipt bound to THIS actor and THIS request,
--      refuses another actor (IDEMPOTENCY_ACTOR_MISMATCH, no result attached),
--      refuses a changed request or a pre-migration receipt
--      (IDEMPOTENCY_INTENT_MISMATCH, 22023, committed result in DETAIL — only
--      reachable by the actor who wrote it), or reports no receipt.
--   3. The stock math, the inventory UPDATE and the 'adjusted' ledger row are
--      unchanged from the live body.
--   4. The receipt is written with a direct INSERT that carries
--      request_actor_id and request_fingerprint.
--   Browser-visible contract kept: same five arguments and defaults, RETURNS
--   jsonb {status:'adjusted', new_quantity, product_id}, same zero, not-found
--   and negative-stock messages. The three auth messages gain a machine token
--   prefix (hasRpcCode in src/lib/db.ts matches `TOKEN: text`); no src code
--   matches the old wording. They stay P0001, which src/lib/idempotency.ts
--   isDefinitiveRpcRejection already treats as a definitive refusal.
--   What this cannot do: someone using the SAME signed-in admin session is the
--   same actor, and can already see the inventory page. The binding stops
--   every OTHER account from redeeming a key.
--
-- CUTOVER: a keyed call of the OLD body touches idempotency_keys first
-- (check_idempotency deletes/reads it), so the ACCESS EXCLUSIVE lock below
-- drains every keyed call already under way. A keyed old-body call that
-- starts while the lock is held blocks inside check_idempotency and RESUMES
-- after this commits, still running the old body; it would then adjust stock
-- and write an UNBOUND receipt through save_idempotency. The BEFORE INSERT
-- trigger below, created before the body is replaced, refuses any
-- adjust_inventory receipt without both binding columns
-- (ADJUST_INVENTORY_UNBOUND_RECEIPT), so that call rolls back whole — stock
-- change and ledger row included. Only this body writes adjust_inventory
-- receipts; the trigger returns early for every other operation.
-- RESIDUAL, KNOWN AND ACCEPTED: (a) an old-body call with a NULL key never
-- touches idempotency_keys, so neither the lock nor the trigger sees it; it
-- can commit one unreceipted adjustment during the apply. The old body
-- authenticates and admin-checks before it mutates, so that is an authorised
-- admin adjustment, exactly what the live body allows on every keyless call
-- today; both browser callers always send a key. (b) a keyed old-body call
-- that blocks on the lock already holds that key's advisory lock (the old
-- check_idempotency takes it before its DELETE), so a new-body call with the
-- same key queues behind it and cannot write a receipt first. What remains is
-- an old-body call that had entered the old body but not yet reached
-- check_idempotency when this commits — a window of microseconds that needs
-- two callers holding one random key at that instant.
-- Post-apply detection for (a), read-only: compare the number of 'adjusted'
-- inventory_transactions rows written during the apply window with the number
-- of bound adjust_inventory receipts written in the same window. Any extra
-- ledger row is a keyless old-body adjustment by an active admin; inspect it,
-- do not reverse it blindly.
--
-- Pre-migration receipts (both binding columns NULL) would be refused by
-- check_idempotency_intent for the rest of their 24h life, and the Inventory
-- page treats IDEMPOTENCY_INTENT_MISMATCH as uncertain and freezes that
-- adjustment. The preflight therefore ABORTS (PREFLIGHT_LEGACY_RECEIPTS) while
-- any unexpired unbound adjust_inventory receipt exists; there were none on
-- 2026-09-11. If it refuses, wait for them to expire (<= 24h) and re-run;
-- never delete live receipts. A receipt with a NULL expires_at is never
-- cleaned up by check_idempotency_intent, so it counts too (none on
-- 2026-09-11). The drain can trip this refusal by itself: a keyed old-body
-- call the lock waits for commits an unbound receipt first, and the preflight
-- then refuses. Nothing changes in that case, but the apply must wait for that
-- receipt to expire, so apply when no one is adjusting stock.
-- Atomicity: no BEGIN/COMMIT of its own. Apply ONLY through
-- scripts/apply-migration-file.mjs (or psql -1), which wraps the whole file in
-- one transaction.
--
-- PREFLIGHT: check_idempotency_intent(text,text,uuid,text),
-- extensions.digest(bytea,text) and pg_catalog.trim_scale(numeric) installed;
-- exactly one overload of adjust_inventory; owner postgres, plpgsql, SECURITY
-- DEFINER, search_path=public, pg_temp; prosrc sha256 (CRLF-normalized) equal
-- to the pinned live body, or on a re-run to the body this file emits —
-- anything else (a later hotfix) is refused; the full argument list INCLUDING
-- DEFAULTS equals the pinned string; both receipt binding columns present;
-- ZERO unexpired (or NULL-expiry) unbound adjust_inventory receipts.
-- POSTFLIGHT: one overload, pinned argument list, postgres-owned SECURITY
-- DEFINER with the pinned search_path; installed body sha256 equals the body
-- this file emits; the role gate sits before the receipt lookup
-- (position-checked); ACL — anon cannot execute, authenticated and
-- service_role can; the cutover trigger is registered BEFORE INSERT FOR EACH
-- ROW and enabled on idempotency_keys and its function refuses unbound receipts and is not
-- executable by anon, authenticated or service_role; check_idempotency_intent
-- is still not executable by anon, authenticated or service_role.
-- ROLLBACK: a NEW forward migration that re-emits the pinned live body AND
-- drops trigger refuse_unbound_adjust_inventory_receipt_20260911 — leaving
-- the trigger while restoring the old body would make every keyed adjustment
-- fail closed, because save_idempotency writes unbound receipts.
-- PROOF: scripts/smoke/prove-adjust-inventory-intent-binding-real-schema.mjs
-- (network-disabled throwaway Supabase PostgreSQL 17 image on the checked-in
-- 2026-07-27 baseline plus every later migration) and the rolled-back chain
-- scripts/smoke/smoke-adjust-inventory-intent-binding.sql.
-- ============================================================================

-- The whole file runs in one transaction (psql -1 / the apply script).
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_sig      text := 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
  v_oid      oid;
  v_count    integer;
  v_owner    text;
  v_lang     text;
  v_secdef   boolean;
  v_config   text[];
  v_src      text;
  v_sha      text;
  v_args     text;
  v_legacy   integer;
  v_args_pin text := 'p_inventory_id uuid, p_delta numeric, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text';
  -- sha256 of the live body (read 2026-09-11) and of the body THIS file emits,
  -- both CRLF-normalized. The constants live here, not in the body, so
  -- declaring them does not change the value they pin.
  v_live_pin text := 'ef485890f3b9ef82359a95dda95d12a57ad633b86f841ead80e872d1eb71b4df';
  v_new_pin  text := '9a503e549f42ad54fd9309d4843bab18f646731e5896c015734a61f524ca0af3';
BEGIN
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

  v_oid := to_regprocedure(v_sig);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_MISSING: % is not installed. This migration replaces an existing body; it does not create one.', v_sig;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'adjust_inventory';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload of adjust_inventory in public, found %. Reconcile before applying.',
      v_count;
  END IF;

  SELECT r.rolname, l.lanname, p.prosecdef, p.proconfig, p.prosrc
    INTO v_owner, v_lang, v_secdef, v_config, v_src
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_oid;

  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'PREFLIGHT_OWNER: % is owned by %, expected postgres.', v_sig, v_owner;
  END IF;
  IF v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'PREFLIGHT_LANGUAGE: % is %, expected plpgsql.', v_sig, v_lang;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PREFLIGHT_SECURITY: % is not SECURITY DEFINER.', v_sig;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'PREFLIGHT_SEARCH_PATH: % has proconfig %, expected {search_path=public, pg_temp}.', v_sig, v_config;
  END IF;

  -- Only the reviewed live body (first run) or this file's own body (re-run)
  -- may be replaced. A later hotfix to either is refused, so replaying this
  -- file can never silently revert it.
  v_sha := encode(
    extensions.digest(convert_to(replace(v_src, E'\r\n', E'\n'), 'UTF8'), 'sha256'), 'hex');
  IF v_sha = v_live_pin THEN
    RAISE NOTICE 'adjust_inventory: installed body is the pinned live body; replacing it.';
  ELSIF v_sha = v_new_pin THEN
    RAISE NOTICE 'adjust_inventory: installed body is already this file''s body; re-running.';
  ELSE
    RAISE EXCEPTION
      'PREFLIGHT_BODY: % has prosrc sha256 %, which is neither the pinned live body nor the body this file emits. Re-verify the live definition before replacing it.',
      v_sig, v_sha;
  END IF;

  -- prosrc excludes argument defaults, so pin them separately.
  v_args := pg_get_function_arguments(v_oid);
  IF v_args <> v_args_pin THEN
    RAISE EXCEPTION 'PREFLIGHT_ARGS: % has argument list "%", expected "%".', v_sig, v_args, v_args_pin;
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

  SELECT count(*) INTO v_legacy
    FROM public.idempotency_keys
   WHERE operation = 'adjust_inventory'
     AND request_actor_id IS NULL
     AND request_fingerprint IS NULL
     AND (expires_at IS NULL OR expires_at >= now());
  IF v_legacy > 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_LEGACY_RECEIPTS: % unexpired unbound adjust_inventory receipt(s) exist. Apply in a quiet window after they expire (<= 24h); do not delete live receipts.',
      v_legacy;
  END IF;
  RAISE NOTICE 'adjust_inventory: no unexpired pre-migration receipts; safe to swap.';
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- Step 1: the cutover guard, BEFORE the body is replaced, so there is no
-- moment at which an old-body call can land an unbound receipt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._refuse_unbound_adjust_inventory_receipt_20260911()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Own ONLY this operation; every other receipt is somebody else's business.
  IF NEW.operation IS DISTINCT FROM 'adjust_inventory' THEN
    RETURN NEW;
  END IF;

  IF NEW.request_actor_id IS NULL OR COALESCE(NEW.request_fingerprint, '') = '' THEN
    RAISE EXCEPTION 'ADJUST_INVENTORY_UNBOUND_RECEIPT: an adjust_inventory receipt must carry request_actor_id and request_fingerprint. Only public.adjust_inventory may write one; a pre-cutover invocation of the old body cannot.';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._refuse_unbound_adjust_inventory_receipt_20260911() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._refuse_unbound_adjust_inventory_receipt_20260911()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS refuse_unbound_adjust_inventory_receipt_20260911
  ON public.idempotency_keys;
CREATE TRIGGER refuse_unbound_adjust_inventory_receipt_20260911
BEFORE INSERT ON public.idempotency_keys
FOR EACH ROW
EXECUTE FUNCTION public._refuse_unbound_adjust_inventory_receipt_20260911();

-- ---------------------------------------------------------------------------
-- Step 2: the new body. Same signature, same defaults, same result shape.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $adjust$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_inv record;
  v_new_qty numeric;
  v_result jsonb;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at, so
  -- holding someone else's key is not enough to read their result.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;
  -- The caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must be the signed-in user';
  END IF;
  -- NULL-safe and active-only: a missing or deactivated profile is refused.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins can adjust inventory';
  END IF;

  -- Every adjustment gets a receipt a retry can find. Blank, whitespace-only
  -- or non-printable keys are refused before any work.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: adjust_inventory requires p_idempotency_key';
  END IF;

  -- numeric accepts NaN and +/-Infinity. NaN sorts above every number, so it
  -- would pass the negative-stock check below and be written into
  -- quantity_available, which has no CHECK constraint.
  IF p_delta IS NULL
     OR p_delta IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT_QUANTITY: the adjustment must be a finite number';
  END IF;
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  -- Everything that shapes the adjustment. p_performed_by is left out: the
  -- guard above constrains it to {NULL, actor} and the ledger row is stamped
  -- from auth.uid(), so it cannot change the outcome. That omission DEPENDS on
  -- the ACTOR_MISMATCH guard; if it is ever relaxed, p_performed_by must join
  -- the fingerprint. trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'inventory_id', p_inventory_id,
    'delta', trim_scale(p_delta),
    'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction:
  -- a racing same-key call waits here, then replays. Replays only a receipt
  -- bound to THIS actor and THIS request.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'adjust_inventory', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- The adjustment itself, unchanged from the live body.
  SELECT * INTO v_inv FROM public.inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  v_new_qty := v_inv.quantity_available + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Adjustment would result in negative inventory (current: %, delta: %, result: %)',
      v_inv.quantity_available, p_delta, v_new_qty;
  END IF;

  UPDATE public.inventory SET
    quantity_available = v_new_qty,
    updated_at = now()
  WHERE id = p_inventory_id;

  INSERT INTO public.inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, v_actor,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'adjust_inventory', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$adjust$;

ALTER FUNCTION public.adjust_inventory(uuid, numeric, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.adjust_inventory(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory(uuid, numeric, text, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.adjust_inventory(uuid, numeric, text, uuid, text) IS
  'Admin-only manual stock adjustment. Authenticates and role-checks the caller before any receipt replay, requires p_idempotency_key, serializes on it (check_idempotency_intent) and binds the receipt to the actor and the exact request.';

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_sig        text := 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
  v_trg_sig    text := 'public._refuse_unbound_adjust_inventory_receipt_20260911()';
  v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';
  v_args_pin   text := 'p_inventory_id uuid, p_delta numeric, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text';
  v_new_pin    text := '9a503e549f42ad54fd9309d4843bab18f646731e5896c015734a61f524ca0af3';
  v_count integer;
  v_src   text;
  v_sha   text;
  v_role  text;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: % is not installed.', v_sig;
  END IF;
  IF pg_get_function_arguments(to_regprocedure(v_sig)) <> v_args_pin THEN
    RAISE EXCEPTION 'POSTFLIGHT_ARGS: % has argument list "%", expected "%".',
      v_sig, pg_get_function_arguments(to_regprocedure(v_sig)), v_args_pin;
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'adjust_inventory';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: adjust_inventory has % overloads, expected 1.', v_count;
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

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_sig);
  v_sha := encode(
    extensions.digest(convert_to(replace(v_src, E'\r\n', E'\n'), 'UTF8'), 'sha256'), 'hex');
  IF v_sha <> v_new_pin THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY_PIN: adjust_inventory body sha256 is %, expected the % this file emits.', v_sha, v_new_pin;
  END IF;

  -- The fix itself: the role gate must come before the receipt lookup, and
  -- the legacy key-only lookup must be gone. Position, not mere presence.
  IF position('public.check_idempotency_intent(' IN v_src) = 0
     OR position('INSUFFICIENT_ROLE' IN v_src) = 0
     OR position('INSUFFICIENT_ROLE' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('AUTH_REQUIRED' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('check_idempotency(' IN v_src) > 0
     OR position('save_idempotency(' IN v_src) > 0
     OR position('request_actor_id, request_fingerprint' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: the installed adjust_inventory does not authenticate and role-check before its bound receipt lookup.';
  END IF;

  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: anon can execute %.', v_sig;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % cannot execute %.', v_role, v_sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.idempotency_keys'::regclass
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
       AND t.tgtype = 7  -- FOR EACH ROW (1) | BEFORE (2) | INSERT (4)
       AND t.tgname = 'refuse_unbound_adjust_inventory_receipt_20260911'
       AND p.oid = to_regprocedure(v_trg_sig)
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_CUTOVER_TRIGGER: refuse_unbound_adjust_inventory_receipt_20260911 is not registered BEFORE INSERT FOR EACH ROW and enabled on public.idempotency_keys.';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_trg_sig);
  IF position('ADJUST_INVENTORY_UNBOUND_RECEIPT' IN v_src) = 0
     OR position('NEW.request_actor_id IS NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_CUTOVER_TRIGGER: the cutover trigger function does not refuse unbound receipts.';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_trg_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_trg_sig;
    END IF;
    -- The serialization guarantee rests on the helper being reachable only
    -- from postgres-owned SECURITY DEFINER functions (20260811130000).
    IF has_function_privilege(v_role, v_helper_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_helper_sig;
    END IF;
  END LOOP;
END;
$verify$;
