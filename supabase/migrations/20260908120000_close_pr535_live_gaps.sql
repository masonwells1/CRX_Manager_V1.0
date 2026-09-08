-- PARKED - NOT APPLIED LIVE. PR #535 follow-up. Requires Mason's explicit approval
-- immediately before it is applied.
--
-- The exact shape of that first line is load-bearing, not styling. The repository's
-- parked-migration recognizer accepts "PARKED" followed directly by NOT APPLIED / DO
-- NOT APPLY (separated only by /, - or an em dash), and every LOCAL CANDIDATE row in
-- docs/reference/migration-history.md must map one-to-one onto a file whose header it
-- recognizes. An earlier version of this header read "PARKED - PR #535 follow-up. NOT
-- APPLIED LIVE.", which put the PR reference between the two halves the recognizer
-- pairs, so this file was invisible to it and the guard-hook regression suite failed
-- with "parked marker and LOCAL CANDIDATE history registry are not one-to-one".
-- Keep NOT APPLIED LIVE immediately after PARKED.
--
-- idempotency-body-check: exempt
-- complete_cycle_count is a WRAPPER. It performs the CHECKING half of idempotency
-- inline (public.check_idempotency at the replay gate below) and delegates the
-- RECORDING half to public._complete_cycle_count_impl, which calls save_idempotency.
-- It does not trust that delegation: it then UPDATEs its own idempotency_keys row and
-- raises IDEMPOTENCY_CACHE_WRITE_FAILED when that UPDATE matches no row, so a run
-- whose impl failed to record the key aborts the transaction instead of returning a
-- success with no receipt. Verified against the live catalog on 2026-09-08. This file
-- does not introduce that pattern; the body is already live.
--
-- WHAT THIS CHANGES
-- Closes Codex P1 on 20260831212415:248, whose subject is ALREADY APPLIED to the live
-- database (2026-09-03), so it is a live defect rather than a branch defect. The
-- migration that introduced it must not be edited, hence this new file.
--
-- Both revision checks are guarded by IS NOT NULL, so a caller that omits
-- p_expected_item_revision skips the staleness protection completely and can apply an
-- unseen variance to inventory. The current TypeScript caller always sends it; a
-- cached pre-change client would not. NULL is now rejected outright rather than
-- keeping the bypass.
--
-- Two hunks change, both described above: the new NULL refusal, and the removal of the
-- IS NOT NULL guard on the staleness comparison. Everything else is byte-identical to
-- the live body.
--
-- FIDELITY PROOF
-- The body below was taken from 20260831212415_guard_cycle_count_completion_revision.sql
-- and md5(pg_proc.prosrc) of the live function was compared against it on 2026-09-08:
-- both are 6d1cab7c4298de34341d517265499896. The precondition block re-checks that
-- hash inside the transaction, so if anything has replaced the function since, this
-- migration refuses to run rather than silently reverting someone else's work.
--
-- NOT INCLUDED, deliberately
--   * create_vendor_bill / update_vendor_bill. Two findings claimed a nullable
--     purchase_orders.total_cost_cents lets a positive vendor bill bypass the
--     cumulative-overage confirmation. Checked live 2026-09-08: total_cost_cents is
--     GENERATED ALWAYS AS (round(total_cost * 100))::bigint STORED over total_cost,
--     which is numeric NOT NULL DEFAULT 0. It can never be NULL, the existing
--     v_po_total <= 0 arm already fires for a zero-cost PO, and the proposed COALESCE
--     would have been a no-op. Re-emitting two live SECURITY DEFINER money functions
--     for no behavioural change is exposure without benefit.
--   * get_commission_balance_report. A finding covers the browser-clock as-of date
--     that src/pages/Reports.tsx sends it. That is a client concern and is tracked
--     separately; it is not a body change and must not ride along here.
--
-- No REVOKE/GRANT anywhere in this file, deliberately. CREATE OR REPLACE FUNCTION does
-- not touch ownership or privileges, and the signature replaced here is identical to
-- the one already installed, so the grants 20260831212415 established carry over
-- untouched. Re-issuing them would turn a body-only change into a privilege change
-- needing its own caller analysis, for no behavioural gain. The proof block VERIFIES
-- the resulting grants instead of assuming them.
--
-- NO TRANSACTION CONTROL IN THIS FILE, deliberately. scripts/apply-migration-file.mjs
-- wraps the migration AND its schema_migrations ledger row in ONE transaction so the
-- two commit together, and it REFUSES any file containing a top-level BEGIN/COMMIT --
-- a file that manages its own transaction can leave the schema changed with no ledger
-- row. An earlier draft of this file carried BEGIN;/COMMIT; and was rejected outright
-- by that guard (observed, not assumed). Atomicity is unchanged: the statements below
-- still run inside the apply path's single transaction, so a failing precondition or
-- postcondition still rolls the whole thing back.
--
-- Non-destructive: no data is written, moved or removed. One function body only.

-- Precondition. Asserted BEFORE the replace, so it describes the database as found
-- rather than as this file just left it. A postcondition alone would be circular: it
-- would only confirm that the text this migration wrote is the text this migration
-- wrote.
DO $precond$
DECLARE
  v_src text;
BEGIN
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'complete_cycle_count') <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly one public.complete_cycle_count before replacing it';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_cycle_count';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'PRECOND: could not read the installed complete_cycle_count body';
  END IF;
  IF md5(v_src) <> '6d1cab7c4298de34341d517265499896' THEN
    RAISE EXCEPTION
      'PRECOND: complete_cycle_count is not the body this migration was written against (found md5 %). Someone else has changed it; re-derive the change before applying.',
      md5(v_src);
  END IF;
END
$precond$;

-- ---------------------------------------------------------------------------
-- complete_cycle_count: refuse an omitted expected revision instead of skipping
-- the staleness checks.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_cycle_count(
  p_cycle_count_id uuid,
  p_completed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_expected_item_revision bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_current_item_revision bigint;
  v_cache_rows integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_completed_by IS NOT NULL AND p_completed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_cycle_count requires p_idempotency_key';
  END IF;
  -- The parameter keeps its DEFAULT so the four-argument signature is unchanged, but
  -- omitting it is now REFUSED rather than silently skipping both revision checks.
  -- Every shipped caller already sends it; a cached pre-change tab is the caller this
  -- refusal is for, and stopping it is the fail-closed direction.
  IF p_expected_item_revision IS NULL THEN
    RAISE EXCEPTION 'CYCLE_COUNT_REVISION_REQUIRED: complete_cycle_count requires p_expected_item_revision';
  END IF;
  IF p_expected_item_revision < 0 THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;

  v_existing := public.check_idempotency(p_idempotency_key, 'complete_cycle_count');
  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_cycle_count_id' IS DISTINCT FROM p_cycle_count_id::text
       OR v_existing->>'_actor_id' IS DISTINCT FROM v_actor::text
       OR (v_existing->>'_expected_item_revision') IS DISTINCT FROM p_expected_item_revision::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    RETURN;
  END IF;

  -- Lock item rows first, in a stable order. Item writers take one of these
  -- before the parent row, so an already-started save commits or fails before
  -- this completion observes the revision and finalizes inventory.
  PERFORM 1
    FROM public.cycle_count_items
   WHERE cycle_count_id = p_cycle_count_id
   ORDER BY id
   FOR UPDATE;

  SELECT item_revision INTO v_current_item_revision
    FROM public.cycle_counts
   WHERE id = p_cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_current_item_revision IS DISTINCT FROM p_expected_item_revision THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;

  -- Preserve the pre-existing inventory serialization contract after the new
  -- item and parent locks. The private implementation reads current on-hand
  -- values before writing inventory and its ledger, so these rows must remain
  -- locked in stable order across that entire operation.
  PERFORM 1
    FROM public.inventory i
    JOIN public.cycle_count_items cci ON cci.inventory_id = i.id
   WHERE cci.cycle_count_id = p_cycle_count_id
   ORDER BY i.id
   FOR UPDATE OF i;

  PERFORM public._complete_cycle_count_impl(p_cycle_count_id, v_actor, p_idempotency_key);

  UPDATE public.idempotency_keys
     SET result = jsonb_build_object(
       '_cycle_count_id', p_cycle_count_id,
       '_actor_id', v_actor,
       '_expected_item_revision', p_expected_item_revision,
       '_completed_item_revision', v_current_item_revision
     )
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'complete_cycle_count';
  GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
  IF v_cache_rows <> 1 THEN RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED'; END IF;
END;
$function$;

-- Proof the installed body really carries the fix, checked inside the transaction so a
-- miss rolls the whole migration back rather than reporting a false success.
--
-- Reads pg_proc.prosrc, the stored body text. Assembling a full definition is forbidden
-- in this repository, and is not needed for a verification read.
DO $postcond$
DECLARE
  v_src text;
  v_oid oid;
BEGIN
  -- Count first. An exact-signature lookup would always resolve, because the statement
  -- above just created that signature; only a count can show that the replace did not
  -- quietly become a second overload alongside an unfixed sibling.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'complete_cycle_count') <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: complete_cycle_count overload drift';
  END IF;

  SELECT oid INTO v_oid FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_cycle_count';

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF v_src IS NULL OR position('CYCLE_COUNT_REVISION_REQUIRED' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCOND: complete_cycle_count does not refuse a null expected revision';
  END IF;
  -- Presence of the refusal is not enough on its own: the old bypass must be GONE, or a
  -- body carrying both would pass the check above while still skipping the comparison
  -- for a null argument.
  IF position('p_expected_item_revision IS NOT NULL' in v_src) <> 0 THEN
    RAISE EXCEPTION 'POSTCOND: the IS NOT NULL revision bypass is still present';
  END IF;

  -- Grants must be exactly what they already were: EXECUTE for authenticated, and no
  -- EXECUTE reachable by an unauthenticated caller. Read straight from the ACL rather
  -- than via has_function_privilege('anon', ...): that form silently passes when the
  -- anon role is absent, which is exactly the database where it most needs to fail.
  -- grantee 0 is PUBLIC, which is how an accidental exposure usually arrives.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: authenticated lost EXECUTE on complete_cycle_count';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE p.oid = v_oid
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) = 'anon')
  ) THEN
    RAISE EXCEPTION 'POSTCOND: complete_cycle_count is executable by PUBLIC or anon';
  END IF;
  -- aclexplode lists DIRECT grants only. A grant to some third role that anon is a
  -- MEMBER of does not appear there at all, so the check above can pass while anon
  -- still reaches EXECUTE by inheritance. has_function_privilege resolves membership
  -- and is the right tool for that case -- but it passes vacuously on a database where
  -- the anon role does not exist, which is why it is GUARDED on pg_roles here instead
  -- of replacing the ACL scan. The two checks cover different holes; both are needed.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: anon can EXECUTE complete_cycle_count through role membership';
  END IF;
END
$postcond$;
