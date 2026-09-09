-- APPLIED LIVE 2026-09-08 as ledger version 20260909023300 (authored stamp
-- 20260908120000, filename unchanged per the B7 rule -- the live ledger name preserves
-- close_pr535_live_gaps, and a differing apply-time version alone does not justify a
-- rename). PR #535 follow-up, applied with Mason's explicit in-chat approval through
-- scripts/apply-migration-file.mjs with all five gates satisfied.
--
-- Reviews on the exact applied bytes: rls-security-reviewer 0/0/0 and
-- migration-drift-reviewer CLEAN, both as gpt-5.6-sol high-effort machine verdicts from
-- scripts/write-apply-proofs.mjs, plus subagent rls-security (2 MED, both fixed below)
-- and migration-drift (0 findings at every severity).
--
-- Verified live post-apply from the catalog, NOT from the HTTP 201: exactly one
-- complete_cycle_count overload and it is the 4-argument one; body md5 is now
-- ad7249f15027bd75084cb0cfbf8b6bab; CYCLE_COUNT_REVISION_REQUIRED present and the
-- 'p_expected_item_revision IS NOT NULL' bypass absent; prosecdef true with
-- search_path=public, pg_temp; ACL {postgres, authenticated, service_role} with no anon
-- and no PUBLIC; trg_bump_cycle_count_item_revision still present and enabled; and no
-- cycle-count SECDEF function anywhere is anon-executable or missing its search_path.
--
-- ordering-guard: ahead-of-pending the seven 20260905* files are already stranded; this strands nothing new
--
-- WHY THAT MARKER IS HONEST, not a paste-over. The pending-set guard warns that applying
-- this file advances the live high-water past seven older tracked-but-unapplied migrations
-- (20260905090000 next-invoice-number, and the six 20260905200000-20260905210000 commission
-- files), and that they would then be refused permanently. Every word of that mechanism is
-- correct. It is the premise that no longer holds: those seven are ALREADY past saving in
-- place. 20260906120000_preview_field_app_season_follows_invoice_date was applied live on
-- 2026-09-08 (ledger version 20260908045843), and its stamp is above all seven, so the
-- high-water had already moved before this file was ever considered.
--
-- OBSERVED, not inferred: on 2026-09-08 the oldest of the seven,
-- 20260905200000_commission_history_report_replay_guard, was run through
-- scripts/apply-migration-file.mjs as a dry run. It was REFUSED by this same ordering guard
-- -- "its filename timestamp is 20260905200000, but 20260906120000 has ALREADY BEEN
-- APPLIED" -- with no contribution from this file. docs/reference/migration-history.md
-- records the same conclusion independently for 20260905090000: it "needs its own restamp
-- before it can be applied."
--
-- So the seven need a restamp either way, that restamp is owned by their own lanes and
-- gated on Mason's approval of their own money/date semantics, and holding this live
-- inventory fix behind that unrelated renumbering would leave the complete_cycle_count
-- staleness bypass open on production for no gain. Stepping over them costs them nothing.
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
-- THE HASH IS OVER THE LF-NORMALIZED BODY. core.autocrlf=true in this repository, so the
-- checked-out file is CRLF on Windows and hashing the body as it sits on disk yields
-- 1d8a95b5ca88348d415b96b08ea0f3fa instead -- a reviewer re-deriving the pin by hand from
-- the working tree will otherwise conclude it is wrong. LF is the correct form because
-- scripts/apply-migration-file.mjs:144 does `.replace(/\r\n/g, "\n")` on read, so the LF
-- body is what was transmitted for 20260831212415 and what is transmitted here.
-- (Raised as LOW by the migration-drift review, 2026-09-08.)
--
-- NO `SET LOCAL lock_timeout` / `statement_timeout`, and that IS a decision rather than
-- an oversight -- this file explains every other omission, so silence here would read as
-- one. 20260831212415:8-9 set both because it took an ACCESS EXCLUSIVE lock to ADD COLUMN
-- and a LOCK TABLE on idempotency_keys. This file does neither: CREATE OR REPLACE FUNCTION
-- rewrites one pg_proc tuple and is not blocked by in-flight executions of the function,
-- so there is no lock queue to bound. The apply path wraps the file in its own
-- transaction. (Raised as LOW by the migration-drift review, 2026-09-08.)
--
-- KNOWN, ACCEPTED, NOT A REGRESSION: an unexpired idempotency_keys receipt written before
-- this apply by a caller that omitted the revision stored `_expected_item_revision` as
-- JSON null, and can no longer be redeemed -- the new refusal fires before the replay
-- gate. Both reviewers raised this independently as LOW and neither recommends a fix:
-- refusing is the fail-closed direction, the refusal raises before any DML so there is no
-- money or inventory effect, and the only client that could have written such a receipt is
-- the cached pre-change tab this migration exists to stop. Recorded so it is not misread
-- as a regression if it appears in logs.
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

  -- The md5 above pins the BODY TEXT and nothing else. For a SECURITY DEFINER function
  -- the OWNER is the privilege boundary -- it is the role the body executes as -- and
  -- prosecdef/proconfig decide whether that boundary and a fixed search_path exist at
  -- all. CREATE OR REPLACE preserves all three, so a value that has drifted since
  -- 2026-09-03 would be PRESERVED by this migration, not repaired, and the md5 pin would
  -- still match. 20260831212415:339-344 pinned prosecdef and proconfig for exactly this
  -- reason; dropping that here would make this block weaker than the one it succeeds.
  -- Live values, read read-only 2026-09-08: owner postgres, prosecdef true,
  -- search_path=public, pg_temp.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'complete_cycle_count'
      AND p.prosecdef
      AND r.rolname = 'postgres'
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c(value)
        WHERE replace(c.value, ' ', '') = 'search_path=public,pg_temp'
      )
  ) THEN
    RAISE EXCEPTION 'PRECOND: complete_cycle_count SECURITY DEFINER privilege contract drifted (owner, prosecdef or search_path)';
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

  -- Everything above proves the ACL of the PUBLIC WRAPPER only. Two other SECURITY
  -- DEFINER functions reach the SAME inventory-writing code path and neither carries a
  -- revision check at all:
  --   * _complete_cycle_count_pre_revision_20260831(uuid,uuid,text) -- the OLD wrapper,
  --     still live under a rename, with no revision parameter in its signature;
  --   * _complete_cycle_count_impl(uuid,uuid,text) -- the raw implementation.
  -- If either were reachable by a browser role, a caller could invoke it straight through
  -- PostgREST and apply an unreviewed inventory variance -- this migration's entire
  -- purpose, bypassed, with every check above still green. 20260831212415:219-220 and
  -- 20260714221000:100-104 revoked them, and 20260831212415:358 asserted the first one at
  -- apply time. This file re-verifies rather than assumes, for exactly the reason it
  -- re-verifies the wrapper's own ACL: grants drift between migrations. Live values read
  -- read-only 2026-09-08 -- impl: {postgres, service_role}; pre-revision: {postgres}.
  -- service_role is DELIBERATELY NOT forbidden: it holds EXECUTE on the impl today and is
  -- not a browser-reachable role. anon, authenticated and PUBLIC are the ones that matter.
  IF EXISTS (
    SELECT 1
    FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('_complete_cycle_count_pre_revision_20260831', '_complete_cycle_count_impl')
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'))
  ) THEN
    RAISE EXCEPTION 'POSTCOND: a revision-less cycle-count sibling is directly executable by PUBLIC, anon or authenticated';
  END IF;
  -- Same pairing as above, and needed for the same reason: aclexplode lists DIRECT grants
  -- only, so a grant to some third role that anon or authenticated is a MEMBER of does not
  -- appear in it. has_function_privilege resolves membership but passes vacuously where the
  -- role does not exist, so it is guarded on pg_roles rather than used alone.
  IF EXISTS (
    SELECT 1
    FROM pg_proc p,
         unnest(ARRAY['anon', 'authenticated']) AS role_name
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('_complete_cycle_count_pre_revision_20260831', '_complete_cycle_count_impl')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
      AND has_function_privilege(role_name, p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTCOND: a revision-less cycle-count sibling is reachable through role membership';
  END IF;
END
$postcond$;
