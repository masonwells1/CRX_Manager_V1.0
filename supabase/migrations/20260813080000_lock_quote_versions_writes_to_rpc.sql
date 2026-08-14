-- STATUS: NOT APPLIED
-- CRX-SEC-1 — close the client-writable path that turns a forged quote version
-- into an authoritative cost snapshot. Found by the exact-SHA adversarial review
-- of PR #389 on 2026-08-13, which is the first time the SQL applied live on
-- 2026-08-12 was reviewable at all.
--
-- THE DEFECT (live in production since 2026-08-12, not introduced by that PR)
-- public.quote_versions is an append-only snapshot table. Its RLS INSERT policy
-- checks WHO owns the quote and nothing else:
--
--   qversions_insert WITH CHECK (
--     is_admin() OR (is_sales_rep() AND EXISTS (
--       SELECT 1 FROM quotes q
--        WHERE q.id = quote_versions.quote_id
--          AND q.created_by = (SELECT auth.uid()))))
--
-- It does not validate snapshot_data and does not bind sent_by to the caller.
-- `authenticated` also still holds the raw table grants, so a sales rep can
-- PostgREST-INSERT a version row of their own construction onto their own quote.
--
-- That became a money problem when 20260812115236 made snapshot_data an
-- AUTHORITATIVE COST SOURCE. _restore_quote_version_owner_impl arms
-- crx.quote_cost_snapshot_passthrough and writes
--
--   ROUND((v_item->>'current_cost')::numeric * 100)::bigint
--
-- straight into the immutable quote_items.cost_at_quote_cents. The only check on
-- that value is `<= 0` (COST_BASIS_REQUIRED), so 0.01 is accepted. Then
-- convert_quote_to_order copies it into order_items.cost_per_unit and
-- cost_at_time_cents, and canonical profit and commissions derive from there.
--
-- The below-cost approval trigger installed by 20260812115237 does NOT stop it:
-- that trigger compares the SALE PRICE against the LIVE product cost and returns
-- when price >= cost. Understating the historical cost basis raises apparent
-- margin, so the trigger never fires.
--
-- Net effect: a sales rep could understate COGS on their own quote and inflate
-- quote/order profit, margin reporting, and their own commission, with no admin
-- approval anywhere in the path.
--
-- EXPLOITATION CHECK — CLEAN, re-confirmed against live 2026-08-14 UTC
-- (read-only; UTC throughout this header, which is the business clock on live
-- and is one calendar day ahead of local evening — the dates are not typos):
-- five snapshot cost lines across three quote_versions rows. Every one carries a
-- numeric cost, resolves to a real product with a usable catalog cost, and its
-- stored basis equals that product's live catalog cost EXACTLY — the measured
-- stored-to-catalog ratio is 1.0000 at both ends of the range. Nothing is
-- understated by any amount.
--
-- The test is exact equality, not a tolerance band, and that is a deliberate
-- correction. An earlier revision of this file compared against half the catalog
-- cost, and the independent review of 2026-08-14 (CRX-QV-001, High) was right to
-- reject it: a basis forged at 60% of a $100 cost clears a 50% threshold, and a
-- percentage band cannot prove provenance. Exact equality can. The only writer
-- that can reach this table today is _create_quote_version_owner_impl, which
-- copies quote_items.current_cost, which is itself copied from the catalog — so
-- a legitimate line equals the catalog cost, and any line that does not is
-- either forged or a stale snapshot taken before a catalog price move. Both
-- deserve a human read before the boundary seals over them, and neither is
-- something this file may decide on its own.
--
-- The exact test can therefore abort on a perfectly innocent cause: if a product
-- cost legitimately changes between this measurement and the apply, the
-- corresponding line stops matching and the migration refuses to run. That is
-- fail-closed and correct. Re-measure, read the differing line, and re-apply.
--
-- Sealing the boundary is not deferrable on the strength of a clean result. A
-- clean result is the reason to seal it NOW, while there is nothing to
-- quarantine.
--
-- That read is a point-in-time observation, so it is ALSO re-run as a hard
-- precondition below. The hole stays open until this file applies, and a row
-- inserted in the gap would remain permanently restorable into
-- quote_items.cost_at_quote_cents. The precondition makes the migration abort
-- rather than quietly seal a forged snapshot inside the new boundary.
--
-- THE FIX, AND WHY IT CANNOT BREAK THE APP
-- Versions become RPC-owned, the same shape 20260715203911 used for returns:
--   * drop the ownership-only INSERT policy;
--   * revoke the direct INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES table
--     grants from the browser roles — six privileges, the full write-capable
--     set minus MAINTAIN, which is deliberately kept and explained at the
--     REVOKE itself;
--   * leave qversions_select and the authenticated SELECT grant untouched, so
--     version history keeps rendering;
--   * re-state the intended callable boundary on create_quote_version and
--     restore_quote_version.
--
-- Verified live on 2026-08-13 before this file was written:
--   * public.quote_versions has relrowsecurity = true and relforcerowsecurity =
--     FALSE, and is owned by `postgres`, whose rolbypassrls is true;
--   * the ONLY function in `public` that inserts into quote_versions is
--     _create_quote_version_owner_impl — SECURITY DEFINER, owned by `postgres`,
--     with no authenticated EXECUTE (postgres and service_role only);
--   * therefore the legitimate server-side write runs as a role that bypasses
--     RLS and holds its own grants. Dropping the policy and revoking the
--     browser grants cannot reach it.
--   * exactly ONE overload exists of each of the five functions named below,
--     so every REVOKE/GRANT here hits the whole surface of that name;
--   * the RESTORE side was read live too, because the precondition below now
--     asserts its shape and an assertion whose premise was never observed is
--     just a guess written in SQL. Read read-only from pg_proc, five rows, one
--     per name, no overload of any of them, every one SECURITY DEFINER with
--     proconfig `search_path=public, pg_temp`:
--       _create_quote_version_owner_impl(4 args)            postgres, service_role
--       _restore_quote_version_owner_impl(4 args)           postgres, service_role
--       _restore_quote_version_below_cost_impl_20260810(5)  postgres ONLY
--       create_quote_version(5 args)         postgres, authenticated, service_role
--       restore_quote_version(6 args)        postgres, authenticated, service_role
--     So neither browser role can execute either restore-side implementation
--     today, and the precondition below is pinning an observed state rather
--     than establishing a new one. Note the below-cost implementation is the
--     one routine here that service_role cannot reach either; that asymmetry is
--     intentional (see 20260812115237) and is called out again in the caller
--     analysis below.
--   * no routine in ANY non-system schema has a BEGIN ATOMIC body, so the source
--     scan in the precondition is not blind. (The precondition really does scan
--     every non-system schema, not just `public`, and applies no prokind filter,
--     so procedures are covered too. An earlier revision of this line said
--     `public`, which understated the check it was describing.)
--   * no OTHER routine in any non-system schema writes this table either — the
--     one legitimate writer named above is of course excluded from that claim;
--   * the browser never writes this table: the only two `.from('quote_versions')`
--     call sites in src/ are `.select('*')` reads in src/pages/QuoteBuilder.tsx, and
--     src/lib/quoteLifecycleRpc.ts creates versions through the RPC.
--   * `anon` and `authenticated` are members of NO other role. Read live
--     read-only from pg_auth_members before writing this line: the result is
--     empty for both. That closes a gap the ACL checks below cannot see on
--     their own — has_table_privilege does not report a privilege reachable
--     only by SET ROLE through a NOINHERIT membership, so if either API role
--     were a member of something, the revokes could look complete while a
--     write path survived. They are not, and PostgREST never issues SET ROLE
--     for browser traffic in any case. Re-check this if role membership ever
--     changes.
--
-- CALLER ANALYSIS FOR THE EXECUTE RE-STATEMENTS BELOW (B10 rule). Read the
-- five statements individually rather than as one pattern; an earlier draft of
-- this paragraph claimed every REVOKE is followed by a GRANT and that is not
-- true of the last three. For the two PUBLIC entry points -- create_quote_version and
-- restore_quote_version -- the REVOKE from PUBLIC/anon IS immediately followed by
-- a GRANT to authenticated + service_role, which is a no-op re-assertion of the
-- ACL read from live on 2026-08-13 (postgres=X, authenticated=X, service_role=X
-- on both; anon absent from both). The browser calls these through PostgREST as
-- the `authenticated` role, which keeps EXECUTE. The third statement, on
-- _create_quote_version_owner_impl, revokes from PUBLIC, anon AND authenticated
-- with NO following GRANT -- deliberately, because that is the owner-side writer
-- and nothing outside the definer chain may call it. Auditing the ACL delta from
-- the blanket sentence alone would have missed that asymmetry. The fourth and
-- fifth statements are the restore-side mirror of the third and follow the same
-- revoke-without-grant shape for the same reason.
--
-- caller-analysis: create_quote_version :: two callers, both in
--   src/lib/quoteLifecycleRpc.ts:54 (5-arg current signature) and :65 (the
--   legacy-signature retry). Both run as `authenticated` via supabaseUntyped.rpc
--   and retain EXECUTE; only PUBLIC/anon are revoked and anon never held it.
--   Live has exactly one overload, (uuid,uuid,text,text,bigint), whose
--   p_expected_row_version carries a DEFAULT — so the :65 retry, which drops
--   only that named argument, resolves back to the SAME function rather than to
--   a separate 4-arg overload. Either way it is covered by this REVOKE/GRANT
--   pair, and this migration changes neither path.
-- caller-analysis: restore_quote_version :: two callers, both in
--   src/lib/quoteLifecycleRpc.ts:113 and :124 (the legacy-signature retry).
--   Same disposition — `authenticated` keeps EXECUTE and there is one live
--   overload. Note the arity, because an earlier draft of this comment called
--   :113 the "6-arg current signature" and that is not what the caller sends:
--   restoreQuoteVersionWithRowVersion passes FIVE named arguments
--   (p_quote_id, p_version_id, p_performed_by, p_idempotency_key,
--   p_expected_row_version) and never p_below_cost_reason, while the :124 retry
--   drops p_expected_row_version and passes four. Live confirms both resolve to
--   the single (uuid,uuid,uuid,text,bigint,text) overload: pronargs = 6 with
--   pronargdefaults = 3, so the trailing three all carry defaults. The REVOKE
--   /GRANT pair below names that one signature and therefore covers both call
--   shapes; this migration changes neither path.
-- caller-analysis: _create_quote_version_owner_impl :: no callers in src/ and
--   none possible — live ACL is postgres=X, service_role=X with no
--   authenticated grant. The REVOKE is a defensive re-assertion so a future
--   default-grant sweep cannot expose the owner-side writer, and it carries no
--   matching GRANT by design.
--   Do NOT describe this function as the holder of the cost-snapshot
--   passthrough; an earlier draft did, and it is wrong in a way that would
--   misdirect the next person hardening this area. `crx.quote_cost_snapshot_
--   passthrough` is armed by exactly two routines, both in
--   20260812115236: save_quote (line 573) and _restore_quote_version_owner_impl
--   (line 1096). This create-side impl never sets it. What makes THIS function
--   worth sealing is narrower and sufficient: it is the only routine in the
--   database that INSERTs into quote_versions, so it is the sole author of the
--   snapshot_data that the restore path later trusts as a cost basis.
-- caller-analysis: _restore_quote_version_owner_impl :: no callers in src/ and
--   none possible from a browser — live ACL is postgres=X, service_role=X with
--   no authenticated grant. Its only legitimate caller is the public
--   restore_quote_version wrapper, inside the definer chain. Same defensive
--   revoke-without-grant as the create-side impl above; service_role is left
--   untouched because it holds EXECUTE today and this file's scope is the
--   browser roles. This is the routine that arms
--   crx.quote_cost_snapshot_passthrough (20260812115236 line 1096), which is
--   precisely why a direct browser path to it would be a cost-basis hole.
-- caller-analysis: _restore_quote_version_below_cost_impl_20260810 :: no callers
--   in src/ and none possible — live ACL is postgres=X ONLY, the single routine
--   in this chain that service_role cannot reach either. 20260812115237 renamed
--   the pre-existing restore_quote_version to this name and rebuilt the public
--   entry point as a thin wrapper that runs _begin_below_cost_money_write FIRST
--   and then delegates here, so the below-cost approval gate lives in the
--   wrapper and NOT in this routine. Anything that could call this directly
--   would perform a restore with that approval check skipped entirely. Same
--   defensive revoke-without-grant; no GRANT is added to anyone, including
--   service_role, because it holds none today.
--
-- TRUNCATE is revoked as well, deliberately. RLS policies do not apply to
-- TRUNCATE at all, so the grant alone let an authenticated caller empty the
-- table regardless of any policy. It is unused by every code path. TRIGGER and
-- REFERENCES go with it: both are latent write vectors on a table whose
-- contents are now trusted, and neither is reachable today only because
-- `authenticated` happens to hold no CREATE on schema public.
--
-- KNOWN LIMIT OF THE WRITER SCAN. It reads routine source text, so it cannot
-- see a write assembled at runtime with EXECUTE format(...) or one performed by
-- a COPY outside a routine. It is a defence-in-depth check on top of the live
-- ACL read above, not the primary evidence. Three further blind spots, stated
-- rather than left for the next reader to discover:
--   * a write that reaches the table through a VIEW names the view, not
--     quote_versions, so the source regex never matches it. The rewrite-path
--     postcondition below covers PART of that shape — it fires when a browser
--     role holds a write privilege on the rewriting relation. A SECURITY DEFINER
--     routine writing through a view that no browser role can touch escapes both
--     the scan and the postcondition. That is an accepted residual limit, not a
--     covered case: the routine would already need to be owner-side, and every
--     owner-side routine that touches this table is enumerated by name above.
--     An earlier revision of this line claimed the postcondition covered the
--     whole shape, which was too strong.
--   * a comment or a line break between the DML keyword and the table name
--     (`INSERT INTO /* ... */ quote_versions`) defeats the regex. Nothing live
--     is written that way, and tightening the pattern to survive arbitrary
--     comment placement costs more false positives than it buys.
--   * a routine with a BEGIN ATOMIC body has BLANK prosrc rather than NULL, so
--     it scans clean. The standing predicate carries an explicit branch that
--     reports when any such routine exists, which converts that silent miss
--     into a visible one. Measured read-only 2026-08-13: zero such routines in
--     any non-system schema on this project. Expect that to change on a future
--     platform upgrade — when the branch starts firing on a Supabase-owned
--     schema, re-scope it there rather than deleting it.
--
-- KNOWN LIMIT OF THE FORGERY SCAN. The precondition inspects ONE field,
-- `current_cost`, because that is the field the restore path stamps into
-- quote_items.cost_at_quote_cents and therefore the one that moves canonical
-- profit and commission money. A snapshot is a whole quote, and restore also
-- writes price_per_unit, profit, total_price and the quote-level totals back
-- more or less verbatim. So this scan is a targeted detector for a forged COST
-- BASIS, not a full audit of snapshot integrity. Do not read a clean precond as
-- "every stored snapshot is trustworthy".
--
-- AND IT RUNS EXACTLY ONCE. Every STRUCTURAL assertion this file makes — the
-- policy shape, the table privileges, the function EXECUTE grants and the
-- overload counts — has a mirror in the standing sweep predicate that ships with
-- it, so drift in any of those is re-detected. Two assertions in this file are
-- deliberately apply-time only and have no standing counterpart: this forgery
-- scan, and the SECURITY DEFINER check on the two public entry points. Each
-- carries its own note saying why. Do not read the sentence above as "every line
-- in this file is watched forever".
-- The forgery scan is the first of the two: it is a pre-apply data gate whose job
-- is to refuse to seal a forged basis inside the new boundary, not a standing
-- watch. After the apply the only remaining writers are service_role and
-- postgres — no browser role can reach the table at all — so the population it
-- guards is closed by the boundary itself rather than by re-scanning. If that
-- ever stops being true, this needs a standing counterpart.
--
-- AND READ A 'no_basis' ABORT CAREFULLY. That bucket means the product's
-- catalog cost is missing, non-positive or non-finite TODAY, which makes the
-- exact-equality comparison unevaluable — it is not itself evidence of forgery. An
-- ordinary discontinued product with its cost zeroed out lands there. The abort
-- is deliberate (unevaluable means unverified, and this file's whole purpose is
-- to avoid sealing a bad basis in place), but the first move on seeing one is to
-- read the flagged rows, not to assume an attack.
--
-- TRANSACTION SHAPE. This file relies on the applier wrapping the whole thing in
-- one transaction, so a failing postcondition rolls the REVOKEs back. The
-- Supabase apply path does that. Every precondition that can be checked before
-- the first write is therefore stated as a PRECOND, not left to POSTCOND.
--
-- Nothing IN this file enforces that, and it cannot: a migration cannot open its
-- own transaction on this path. So state the consequence rather than assume the
-- shape holds. On a hypothetical statement-at-a-time applier, a failing
-- POSTCOND would leave the DROP POLICY and the REVOKEs in place while no ledger
-- row is written at all — the applier records a migration only after it
-- succeeds, so a failure leaves no "failed" row behind, just an absence. That
-- direction is safe — the boundary ends up tighter, never looser — but the
-- repository would then disagree with the database about whether this applied.
--
-- If that ever happens, re-running is the intended recovery and the PRECONDs are
-- built for it: the policy check treats an already-absent qversions_insert as an
-- explicit replay branch and proceeds as a no-op re-assertion, and the remaining
-- assertions pin things this migration does not change (RLS on, the read policy
-- present, one overload each, the definer owner still holding INSERT and
-- rolbypassrls), all of which still hold afterwards. Read the live ACL first
-- anyway, to confirm the partial state is the one described here rather than a
-- third party's change.
--
-- OUT OF SCOPE, REPORTED SEPARATELY: this blanket-grant shape is not unique to
-- this table. Most public tables still grant TRUNCATE to `authenticated`, and
-- about two thirds grant INSERT. That is a project-wide ACL review, not
-- something to fold into a targeted security fix.
--
-- SCOPE: this is a BROWSER-role boundary. service_role and postgres keep full
-- write access to quote_versions, exactly as they do on every other table.
-- "RPC-owned" means no anon/authenticated path, not that no role can write.
--
-- NO BUSINESS DATA IS WRITTEN OR DELETED BY THIS MIGRATION. It changes
-- privileges and one policy only. It does READ quote_versions.snapshot_data in
-- the precondition, to prove no forged snapshot is already sitting there.

-- SET LOCAL, not SET: this runs on a pooled connection, and a session-level
-- value would leak onto whatever unrelated work reuses that connection next.
-- LOCAL is scoped to the wrapping transaction and needs no RESET. (It relies on
-- the TRANSACTION SHAPE noted above; outside a transaction PostgreSQL would warn
-- and ignore it, which is the safe direction to fail.)
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';

-- Block concurrent row writes while the precondition scans existing snapshots
-- and until the policy/grant boundary below has been sealed. EXCLUSIVE conflicts
-- with the ROW EXCLUSIVE lock taken by INSERT, UPDATE and DELETE.
LOCK TABLE public.quote_versions IN EXCLUSIVE MODE;

DO $precond$
DECLARE
  v_count int;
  v_unrestorable int;
  v_exotic int;
  v_unchecked int;
  v_forced boolean;
  v_enabled boolean;
  v_check text;
  v_polcmd "char";
  v_missing_roles text;
  v_policy_exists boolean;
  v_owner name;
BEGIN
  -- Fail early and legibly on a replay target that lacks Supabase's API roles.
  -- Every REVOKE/GRANT below names anon, authenticated or service_role, and a
  -- plain-Postgres restore would abort on the first of them with a bare
  -- `role "anon" does not exist` — 400 lines after the last thing this file
  -- printed, and with no hint that the cause is the target rather than the
  -- table. The postconditions cannot carry this check: they all run AFTER those
  -- statements, so they are unreachable on such a target.
  SELECT string_agg(r.expected, ', ' ORDER BY r.expected) INTO v_missing_roles
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(expected)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles pr WHERE pr.rolname = r.expected);
  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'PRECOND: this database is missing the API role(s): %. This migration is a grant boundary for Supabase''s API roles and cannot be replayed onto a target that does not have them.', v_missing_roles;
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class c
   WHERE c.oid = 'public.quote_versions'::regclass;

  IF NOT v_enabled THEN
    RAISE EXCEPTION 'PRECOND: RLS is not enabled on public.quote_versions. Something else changed this table; re-review before applying.';
  END IF;

  -- Drift tripwire, NOT the load-bearing safety argument. An earlier draft of
  -- this comment claimed FORCE ROW LEVEL SECURITY would break the owner-side
  -- write once the policy is dropped. That is wrong and worth stating plainly so
  -- nobody re-derives it: FORCE only strips the *table owner's* implicit
  -- exemption, while the `rolbypassrls` ROLE ATTRIBUTE bypasses policies whether
  -- or not FORCE is set. The definer owner here holds rolbypassrls (asserted
  -- below), so FORCE alone would not close the write path.
  -- The check earns its place anyway: FORCE appearing on this table means
  -- somebody deliberately reshaped its security model after this file was
  -- written, and every judgement below — the pinned policy shapes, the
  -- exactly-one-writer scan — was made against the un-forced table. Abort and
  -- re-review rather than apply a reviewed-elsewhere conclusion.
  IF v_forced THEN
    RAISE EXCEPTION 'PRECOND: public.quote_versions now has FORCE ROW LEVEL SECURITY, which it did not when this migration was written and reviewed. This does NOT mean the owner-side RPC write is about to break — the definer owner bypasses policies via rolbypassrls whether or not FORCE is set. It means somebody deliberately reshaped this table''s security model, so the pinned policy shapes and the exactly-one-writer scan below were judged against a table that no longer exists. Re-review before applying.';
  END IF;

  -- The read path must survive untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.quote_versions'::regclass
       AND p.polname = 'qversions_select'
       AND p.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'PRECOND: qversions_select is missing. This migration must not be the thing that removes read access.';
  END IF;

  -- Accepted states: the vulnerable baseline (first apply), or already-closed
  -- (replay). Anything else means a third party reshaped the policy and the
  -- reasoning above no longer describes what is live.
  --
  -- "Row absent" and "row present with a NULL WITH CHECK" are NOT the same
  -- thing: a FOR ALL policy carrying only a USING clause also yields NULL from
  -- pg_get_expr, and treating that as "already closed" would silently drop a
  -- reshaped policy. Distinguish them explicitly.
  SELECT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.quote_versions'::regclass
       AND p.polname = 'qversions_insert'
  ) INTO v_policy_exists;

  SELECT pg_get_expr(p.polwithcheck, p.polrelid), p.polcmd INTO v_check, v_polcmd
    FROM pg_policy p
   WHERE p.polrelid = 'public.quote_versions'::regclass
     AND p.polname = 'qversions_insert';

  IF NOT v_policy_exists THEN
    RAISE NOTICE 'PRECOND: qversions_insert is already absent — replay may proceed as a no-op re-assertion';
  ELSIF v_polcmd <> 'a' THEN
    -- Matching on polname alone is not enough. A policy widened from FOR INSERT
    -- to FOR ALL while keeping both q.created_by and is_sales_rep() in its WITH
    -- CHECK would satisfy the baseline branch below and be dropped unreviewed,
    -- taking its USING side with it. The NULL-WITH-CHECK guard above catches
    -- only the USING-only shape, not one carrying both clauses.
    RAISE EXCEPTION 'PRECOND: qversions_insert is no longer a FOR INSERT policy (polcmd = %). It has been widened since this migration was written; re-review before applying.', v_polcmd;
  ELSIF v_check IS NULL THEN
    RAISE EXCEPTION 'PRECOND: qversions_insert exists but has no WITH CHECK expression. It has been reshaped since this migration was written; re-review before applying.';
  ELSIF position('q.created_by' in v_check) > 0 AND position('is_sales_rep()' in v_check) > 0 THEN
    RAISE NOTICE 'PRECOND: qversions_insert matches the pinned ownership-only baseline — first application may proceed';
  ELSE
    RAISE EXCEPTION 'PRECOND: qversions_insert has been rewritten since this migration was written [%]. Re-review before applying.', v_check;
  END IF;

  -- The postcondition refuses ANY surviving mutation policy, but this migration
  -- only drops qversions_insert. Catch a second mutation policy here, before
  -- the REVOKEs run, instead of after.
  SELECT count(*) INTO v_count
    FROM pg_policy p
   WHERE p.polrelid = 'public.quote_versions'::regclass
     AND p.polcmd IN ('a', 'w', 'd', '*')
     AND p.polname <> 'qversions_insert';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'PRECOND: % mutation policy/policies other than qversions_insert exist on public.quote_versions. This migration does not know about them; re-review before applying.', v_count;
  END IF;

  -- Every REVOKE/GRANT below names ONE signature. If a second overload of any
  -- of these names exists live, the statements silently miss it and a
  -- browser-callable writer survives while the postcondition still passes.
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'create_quote_version';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 overload of create_quote_version, found %. The REVOKE below would not cover them all.', v_count;
  END IF;
  IF to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'PRECOND: create_quote_version does not have signature (uuid,uuid,text,text,bigint); the statements below would not match.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'restore_quote_version';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 overload of restore_quote_version, found %. The REVOKE below would not cover them all.', v_count;
  END IF;
  IF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECOND: restore_quote_version does not have signature (uuid,uuid,uuid,text,bigint,text); the statements below would not match.';
  END IF;

  -- The restore side's two implementations must not be callable by a browser
  -- role. This file is a WRITE boundary for quote_versions, and restore is the
  -- routine that reads a stored snapshot back out and stamps its cost basis onto
  -- the quote — so sealing the table while leaving that path open would close the
  -- front door and leave the back one ajar.
  --
  -- The reason it has to be checked HERE and not only in the standing sweep: the
  -- public restore_quote_version above is a thin wrapper that runs the below-cost
  -- approval check and then delegates. The gate therefore lives in the wrapper,
  -- and anything able to reach an implementation directly performs the restore
  -- with that check skipped. On this project a newly created function is born
  -- callable by the API roles, so this is the default state, not an exotic one.
  --
  -- Overload counts first: the EXECUTE assertions below name one signature each,
  -- so a second overload of either name would sit outside them entirely.
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_restore_quote_version_owner_impl',
                       '_restore_quote_version_below_cost_impl_20260810');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 2 restore-side implementations (one _restore_quote_version_owner_impl and one _restore_quote_version_below_cost_impl_20260810), found %. An overload would be unwatched by the EXECUTE assertions below; re-review before applying.', v_count;
  END IF;

  IF to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'PRECOND: a restore-side implementation is missing at its pinned signature. Re-review before applying — the EXECUTE assertions below cannot be evaluated.';
  END IF;

  IF has_function_privilege('authenticated', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECOND: a browser role can execute a restore-side implementation directly, skipping the below-cost approval check that lives in the public wrapper. Sealing the quote_versions write boundary while that path is open would give a false sense of closure. Revoke it and re-review before applying.';
  END IF;

  -- Both PUBLIC entry points must still be SECURITY DEFINER *and* still carry a
  -- pinned search_path. This is the hinge the whole fix swings on and nothing
  -- else in this file or in the standing sweep states it. After the REVOKEs
  -- below, `authenticated` holds no direct write privilege on quote_versions at
  -- all, so the only remaining way a version gets created or restored is these
  -- two wrappers running as their privileged owner.
  --
  -- Two ways that hinge can break, and this asserts both:
  --   * rebuilt as SECURITY INVOKER — the default, and therefore what an
  --     incomplete CREATE OR REPLACE silently produces — it would execute with
  --     the caller's own privileges, find them revoked, and version create and
  --     restore would stop working for every user. Loud.
  --   * rebuilt as DEFINER but WITHOUT `SET search_path` — the same incomplete
  --     replace, one clause further along. That one is quiet and worse: the
  --     wrapper keeps running as an RLS-bypassing owner while resolving its own
  --     unqualified references through whatever schema the caller put first.
  --     Asserting DEFINER alone would wave that through. An earlier revision of
  --     this block did exactly that; the owner-side check twenty lines down has
  --     always asserted both, and there is no reason the two routines that
  --     become the ONLY write path should be held to the weaker half.
  -- Checked live before writing this: both are prosecdef = true and both carry
  -- proconfig `search_path=public, pg_temp` today, so this precondition passes
  -- against the database as it stands.
  --
  -- Deliberately an apply-time assertion and not a sweep branch: it needs to be
  -- true at the moment this file removes the fallback path.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('create_quote_version', 'restore_quote_version')
       AND (
         NOT p.prosecdef
         OR NOT EXISTS (
           SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
            WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
         )
       )
  ) THEN
    RAISE EXCEPTION 'PRECOND: create_quote_version and/or restore_quote_version is not a search_path-pinned SECURITY DEFINER. This file revokes the browser roles direct write access to quote_versions, so these two wrappers become the only write path: a SECURITY INVOKER rebuild would run with the caller''s revoked privileges and break create/restore for every user, and a DEFINER rebuild without SET search_path would resolve its unqualified references through the caller''s search_path while running as an RLS-bypassing owner. Restore both and re-review before applying.';
  END IF;

  -- The privileged writer must exist and must be the owner-side definer, or
  -- revoking the browser grants would leave NO way to create a version.
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = '_create_quote_version_owner_impl';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _create_quote_version_owner_impl, found %.', v_count;
  END IF;

  IF to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PRECOND: _create_quote_version_owner_impl exists but not with signature (uuid,uuid,text,text); the REVOKE below would not match. Re-review before applying.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = '_create_quote_version_owner_impl'
       AND p.prosecdef
       AND r.rolbypassrls
       AND EXISTS (
         SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
          WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
       )
  ) THEN
    RAISE EXCEPTION 'PRECOND: _create_quote_version_owner_impl is no longer a search_path-pinned SECURITY DEFINER owned by an RLS-bypassing role. Revoking the browser grants would close the last write path.';
  END IF;

  SELECT r.rolname INTO v_owner
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)');

  -- rolbypassrls bypasses POLICIES, not GRANTS, so the definer's INSERT has to
  -- be proven separately. Note what this particular call can and cannot show:
  -- has_table_privilege reports the EFFECTIVE privilege, which INCLUDES
  -- anything held via PUBLIC. Run here — before the REVOKE — it therefore
  -- cannot distinguish "the owner holds INSERT itself" from "the owner holds
  -- INSERT only because PUBLIC does". It is an early smoke test that catches a
  -- wholly unprivileged owner. The load-bearing proof is the identical call in
  -- the POSTCOND block, after PUBLIC has been stripped.
  --
  -- One more way this check could be decoration rather than proof:
  -- has_table_privilege returns TRUE unconditionally for a rolsuper role, so if
  -- the definer owner were a superuser both this call and the POSTCOND copy
  -- would pass no matter what the grants said. Checked live 2026-08-13 UTC: the
  -- owner is `postgres` with rolsuper = FALSE and rolbypassrls = TRUE, which is
  -- the standard Supabase shape. The assertion is therefore real here. If a
  -- future platform change makes that owner a superuser, this pair of checks
  -- goes quietly vacuous — re-derive it rather than trusting the green.
  IF NOT has_table_privilege(v_owner, 'public.quote_versions', 'INSERT') THEN
    RAISE EXCEPTION 'PRECOND: the definer owner (%) does not hold INSERT on public.quote_versions at all. Revoking PUBLIC would close version creation entirely.', v_owner;
  END IF;

  -- The writer scan below reads routine source text. A BEGIN ATOMIC body is
  -- stored parsed rather than as text, so such a routine would be invisible to
  -- the scan and the scan would pass for the wrong reason. Test for it with
  -- prosqlbody, which is the actual marker — and do NOT filter on prokind, or
  -- a BEGIN ATOMIC *procedure* slips through both this guard and the scan.
  -- No schema has one today; assert that, so the scan fails closed rather than
  -- open if that ever changes.
  --
  -- The all-schema scope is deliberate and must stay matched to the writer scan
  -- below, which is also all-schema. Narrowing this blindness check to `public`
  -- while the scan it protects reads every non-system schema would rebuild the
  -- exact blind spot it exists to close. The cost of the wide scope is that a
  -- Supabase platform upgrade shipping a BEGIN ATOMIC routine in `vault` or
  -- `graphql` would abort this apply — a false stop, but a loud, safe and
  -- one-read-to-diagnose one. Measured live 2026-08-13 UTC: ZERO routines with a
  -- non-null prosqlbody across every non-system schema, so this passes today.
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND p.prosqlbody IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'PRECOND: % routine(s) have a BEGIN ATOMIC body. The writer scan below reads source text and cannot see them; re-review by hand before applying.', v_count;
  END IF;

  -- No OTHER routine may be relying on RLS policies to write this table; such a
  -- routine would silently start failing after the policy drop and the revoke.
  --
  -- The scan covers every non-system schema, not just `public`: a writer parked
  -- in another schema is still a writer. It has no prokind filter, so
  -- procedures are covered as well as functions.
  --
  -- The match is anchored on statement shape, not on `%UPDATE%quote_versions%`:
  -- an unanchored LIKE also matches the substring `updated_at` anywhere earlier
  -- in the body, which would abort the apply on a routine that merely READS
  -- this table. \M anchors the end of the word so quote_versions_archive and
  -- similar names do not match either. MERGE and the ONLY/quoted-identifier
  -- spellings are included because each is a real write this scan would
  -- otherwise miss.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND NOT (p.prosecdef AND r.rolbypassrls)
       -- Schema-qualified on purpose. The scan itself is all-schema (see the
       -- nspname filter above), so a bare `proname <> ...` carve-out would also
       -- excuse a routine of that name living in staging, crx, or a schema
       -- restored from a backup — the one hole a same-named impostor needs.
       AND NOT (n.nspname = 'public' AND p.proname = '_create_quote_version_owner_impl')
       AND p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
  ) THEN
    RAISE EXCEPTION 'PRECOND: another routine writes public.quote_versions without bypassing RLS and would break under this change. Re-review before applying.';
  END IF;

  -- A SECURITY DEFINER routine owned by an RLS-bypassing role never depended on
  -- qversions_insert, so this change cannot break it — but it IS an additional
  -- authoritative writer of a table whose contents are about to become trusted,
  -- and this migration's reasoning only accounts for one. There are none today
  -- besides the owner impl; refuse rather than assume a new one is benign.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND p.prosecdef
       AND r.rolbypassrls
       -- Schema-qualified for the same reason as the scan above: this carve-out
       -- must excuse exactly one function, not every function wearing its name.
       AND NOT (n.nspname = 'public' AND p.proname = '_create_quote_version_owner_impl')
       AND p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
  ) THEN
    RAISE EXCEPTION 'PRECOND: a second RLS-bypassing routine writes public.quote_versions. This migration assumes exactly one authoritative writer; re-review before applying.';
  END IF;

  -- -------------------------------------------------------------------------
  -- APPLY-TIME EXPLOITATION CHECK (fails closed).
  -- The header records a clean read taken on 2026-08-13. Between that read and
  -- this apply the hole is still open, and a forged snapshot inserted in the
  -- gap would stay permanently restorable into quote_items.cost_at_quote_cents
  -- (restore's only validation is current_cost <= 0). So re-run the check here
  -- and refuse to seal a bad snapshot inside the new boundary.
  --
  -- Snapshot shape, built by _create_quote_version_owner_impl:
  --   { sections: [ { items: [ { product_id, current_cost, ... } ] } ] }
  --
  -- Extraction deliberately mirrors the restore path, which reads
  -- (v_item->>'current_cost')::numeric. That is TEXT extraction, so a forged
  -- "current_cost": "0.01" — a quoted string rather than a JSON number —
  -- restores exactly the same way. Filtering on jsonb_typeof = 'number' would
  -- skip precisely the payload an attacker would send.
  --
  -- Lines with no cost at all are ignored: restore refuses them outright
  -- (COST_BASIS_REQUIRED), so they can never become a cost basis.
  --
  -- Threshold: a snapshot cost below HALF the product's live cost. Because the
  -- comparison is snapshot < live/2, it also fires when the CATALOG cost has
  -- more than doubled since the quote — a legitimate movement, just a large
  -- one. This deliberately stops rather than guesses. If it fires, review the
  -- row and re-issue this migration with that version id named and justified.
  -- -------------------------------------------------------------------------
  WITH lines AS MATERIALIZED (
    SELECT nullif(itm.value ->> 'product_id', '')   AS product_id_text,
           nullif(itm.value ->> 'current_cost', '') AS cost_text
      FROM public.quote_versions qv
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(qv.snapshot_data -> 'sections') = 'array'
                  THEN qv.snapshot_data -> 'sections'
                  ELSE '[]'::jsonb END) AS sec
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(sec.value -> 'items') = 'array'
                  THEN sec.value -> 'items'
                  ELSE '[]'::jsonb END) AS itm
  ),
  -- The casts are guarded and materialised so a malformed value yields NULL
  -- (routed to a bucket below) instead of aborting the apply with a bare cast
  -- error that says nothing about what was wrong.
  parsed AS MATERIALIZED (
    -- Matches the DECIMAL forms ::numeric accepts, minus NaN/Infinity. An
    -- earlier, narrower pattern rejected exponent form (1e-5, 1E+2), a bare
    -- leading dot (.5) and a leading plus (+3) — all of which the restore path's
    -- own (v_item->>'current_cost')::numeric accepts happily. Reporting those as
    -- "unevaluable" described a legitimate serialisation as corruption, and
    -- described a genuinely forged '1e-5' as unreadable rather than as the
    -- forgery it is. NaN and Infinity stay excluded on purpose: both survive a
    -- <= 0 test but die at ROUND(...)::bigint, so neither is a restorable cost
    -- basis. The exponent is bounded to 4 digits: an unbounded one matches
    -- '1e300000', which then raises 22003 out of the cast below and aborts the
    -- apply with a numeric-overflow error instead of the diagnosis this scan
    -- exists to print. Such a string breaks restore too, so bounding it loses
    -- no coverage — it only keeps the failure legible.
    SELECT cost_text,
           CASE WHEN cost_text ~ '^\s*[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]{1,4})?\s*$'
                THEN btrim(cost_text)::numeric
           END AS cost_num,
           -- PostgreSQL 16 extended numeric_in to accept non-decimal integer
           -- literals and digit-group underscores, and this database is 17.6.
           -- Verified read-only on live before writing this:
           --   '0x64'::numeric = 100, '0o10'::numeric = 8, '0b101'::numeric = 5,
           --   '1_0'::numeric = 10, '0.0_1'::numeric = 0.01.
           -- Every one of those is accepted by the restore path's own cast and
           -- rejected by the decimal pattern above, so without this branch a
           -- forged one-cent basis written as '0.0_1' would land in the
           -- unreadable bucket rather than the forged one. Treated as blocking
           -- in its own right, and the reason is stronger than a claim about
           -- the browser. snapshot_data is not serialised by the client at all:
           -- _create_quote_version_owner_impl builds it SERVER-side with
           -- jsonb_build_object, taking 'current_cost' straight from the typed
           -- quote_items.current_cost column (20260611211058:1194-1250). So this
           -- field is whatever PostgreSQL's own numeric output renders, which is
           -- plain decimal — 0x64 goes in as the numeric 100 and comes back out
           -- as "100". There is no path through the legitimate writer that can
           -- put '0x64' or '1_0' in this field, whatever the client sent. Its
           -- presence therefore means the row was written around that function.
           (cost_text !~ '^\s*[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]{1,4})?\s*$'
            AND (cost_text ~ '_' OR cost_text ~* '^\s*[-+]?0[xob]')) AS cost_exotic,
           CASE WHEN product_id_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN product_id_text::uuid
           END AS product_uuid,
           -- The SAME stricter-scan-than-restore-path mismatch the cost branch
           -- above exists to close, one field over — and the round that fixed
           -- the cost branch did not carry the reasoning across to this one.
           --
           -- The restore path casts this field with a bare
           -- (v_item->>'product_id')::uuid (20260812115236:1128), and uuid_in
           -- accepts far more than the canonical dashed form: brace-wrapped,
           -- hyphen-free and irregularly-hyphenated all parse, and all compare
           -- EQUAL to the canonical value. Verified read-only on live 17.6
           -- before writing this:
           --   'a0eebc999c0b4ef8bb6d6bb9bd380a11'::uuid
           --     = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid  -> true
           --   '{a0eebc99-...}'::uuid and 'a0ee-bc99-9c0b-...'::uuid likewise,
           -- while the canonical pattern above returns false for every one.
           --
           -- So a forged line naming a REAL product in a non-canonical form
           -- would leave product_uuid NULL, fall into 'unrestorable' — the one
           -- ADVISORY bucket, whose NOTICE the Supabase apply channel does not
           -- surface — and be sealed in permanently, while restore would have
           -- resolved it, satisfied the quote_items FK, and stamped its cost
           -- basis into canonical profit and commission money.
           --
           -- Blocking in its own right, for the cost_exotic reason and by the
           -- same server-side argument: _create_quote_version_owner_impl builds
           -- snapshot_data with jsonb_build_object from the typed
           -- quote_items.product_id UUID column, and PostgreSQL renders a uuid
           -- in exactly one form — lowercase, dashed, canonical. A brace-wrapped
           -- or hyphen-free spelling cannot come out of that function no matter
           -- what a client sent in, so its presence here means the row was
           -- written around the legitimate writer, whatever it resolves to.
           --
           -- The two case-sensitivity choices below are deliberate and OPPOSITE.
           -- An earlier revision had the canonical pattern case-INsensitive, so
           -- an uppercase 'A0EEBC99-...' was read as canonical, resolved, and
           -- treated as legitimately written — even though the invariant stated
           -- three paragraphs up is lowercase-only, and uuid_out can no more
           -- emit uppercase than it can emit braces.
           --   * canonical test: `~` / `!~`, case-SENSITIVE. Uppercase is not
           --     canonical, so it must fail this and stay a candidate.
           --   * 32-hex-digit test: `~*`, case-INsensitive, and it must stay
           --     that way. It is what CATCHES the uppercase spelling and routes
           --     it to the blocking 'exotic' bucket. Tightening this one too
           --     would make an uppercase id fail both tests, leaving it in the
           --     ADVISORY 'unrestorable' bucket whose NOTICE the Supabase apply
           --     channel does not surface — strictly worse than before.
           (product_id_text IS NOT NULL
            AND product_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND replace(replace(replace(btrim(product_id_text), '{', ''), '}', ''), '-', '')
                  ~* '^[0-9a-f]{32}$') AS product_id_exotic
      FROM lines
     WHERE cost_text IS NOT NULL
  ),
  -- One bucket per line, evaluated in priority order, so the counts below are
  -- provably disjoint and no line can be double-reported or quietly reclassified
  -- between two FILTER clauses.
  classified AS MATERIALIZED (
    SELECT p.cost_num,
           pr.current_cost,
           CASE
             WHEN p.cost_exotic OR p.product_id_exotic            THEN 'exotic'
             WHEN p.product_uuid IS NULL OR pr.id IS NULL         THEN 'unrestorable'
             WHEN p.cost_num IS NULL                              THEN 'unparseable'
             -- NaN and +Infinity must be routed here EXPLICITLY. In PostgreSQL
             -- numeric, NaN sorts ABOVE every finite value, so `NaN <= 0` is
             -- false and a non-finite catalog cost would fall through to
             -- 'evaluable' — where `cost_num <> NaN` is TRUE for every finite
             -- line naming that product (in numeric, NaN equals only NaN), so
             -- the apply would abort with a confident and wrong forged-snapshot
             -- diagnosis. Note this arm is still required under the exact test:
             -- switching from `<` to `<>` changed which comparison misfires, not
             -- whether one does.
             --
             -- CORRECTION, checked against the applied source rather than
             -- carried forward: an earlier revision of this comment said no
             -- finiteness CHECK on products.current_cost exists anywhere. That
             -- is false. `products_current_cost_cent_scale_chk` is live, added
             -- by 20260812115237_enforce_below_cost_admin_approval.sql, and it
             -- rejects NaN and both infinities (NaN < 'Infinity' is false). It
             -- was added without NOT VALID, so existing rows were validated
             -- too. These two arms are therefore belt-and-braces for a state
             -- the database now prevents, kept because the cost of an
             -- unnecessary WHEN is one comparison and the cost of the wrong
             -- diagnosis is a confidently aborted security fix.
             -- (-Infinity needs no clause; it is caught by `<= 0`.)
             WHEN pr.current_cost IS NULL
               OR pr.current_cost = 'NaN'::numeric
               OR pr.current_cost = 'Infinity'::numeric
               OR pr.current_cost <= 0                            THEN 'no_basis'
             ELSE 'evaluable'
           END AS bucket
      FROM parsed p
      LEFT JOIN public.products pr ON pr.id = p.product_uuid
  )
  SELECT count(*) FILTER (WHERE bucket = 'unrestorable'),
         count(*) FILTER (WHERE bucket = 'exotic'),
         count(*) FILTER (WHERE bucket IN ('unparseable', 'no_basis')),
         -- EXACT equality, not a tolerance band. See CRX-QV-001 in the header:
         -- a percentage threshold cannot prove provenance, and the only writer
         -- that can reach this table copies the catalog cost verbatim, so an
         -- unforged line matches to the last digit. `<>` on numeric is safe here
         -- because the non-finite and NULL cases were already routed to
         -- 'no_basis'/'unparseable' above and cannot reach this arm.
         count(*) FILTER (WHERE bucket = 'evaluable'
                            AND cost_num <> current_cost)
    INTO v_unrestorable, v_exotic, v_unchecked, v_count
    FROM classified;

  -- A LEFT JOIN, not an inner one, and no positive-cost filter on the product:
  -- an inner join would silently DROP a snapshot line pointing at a deleted or
  -- zero-cost product, which is exactly where a forged line would hide.
  --
  -- Only ONE of the four buckets is advisory, and the split is what makes that
  -- safe. An earlier revision downgraded the whole unevaluable set to a NOTICE
  -- on the argument that an aged catalog produces such lines routinely. That
  -- argument holds for exactly one of its members:
  --
  --   unrestorable (ADVISORY) — the product_id cannot be read as a uuid AT ALL,
  --     or it resolves but names a row that no longer exists. quote_items
  --     .product_id is NOT NULL REFERENCES products(id), so restoring such a
  --     line dies on the foreign key. The line is not a forgery vector because
  --     it cannot be restored at all, and a deleted product really is an
  --     ordinary state of an old catalog.
  --
  --     READ THE product_id_exotic NOTE ABOVE BEFORE WIDENING THIS BUCKET. What
  --     makes the advisory treatment safe is that this bucket now holds only
  --     genuinely uncastable ids. An earlier revision classified on the
  --     canonical dashed pattern alone, which is STRICTER than the uuid_in the
  --     restore path actually uses — so a real product id written without
  --     hyphens landed here, was reported by a NOTICE the apply channel does
  --     not surface, and would then have been restored perfectly happily. That
  --     case is now routed to the blocking 'exotic' bucket instead.
  --
  --   unparseable (BLOCKING) — the product resolves and the line is fully
  --     restorable, but this scan cannot read the stored cost string, so it is
  --     completely unverified. Sealing over it would freeze a cost basis nobody
  --     checked.
  --
  --   no_basis (BLOCKING, and read the correction below) — the product resolves
  --     but its live catalog cost is NULL, non-positive or non-finite, so there
  --     is nothing to compare the stored basis against.
  --
  --     An earlier revision justified this by saying restore never consults the
  --     catalog. Checked against the applied source rather than assumed, that is
  --     wrong. The live BEFORE trigger on quote_items
  --     (20260812115237_enforce_below_cost_admin_approval.sql) does read the
  --     catalog row FOR SHARE and raises COST_BASIS_REQUIRED on exactly this
  --     condition. It carries TWO early returns, not one — one on the INSERT
  --     path for save_quote's own transient write, and a second on the UPDATE
  --     path — and neither covers restore, which reaches the table by a
  --     different route. So these lines are already un-restorable in practice.
  --
  --     The block stays anyway, for a different and narrower reason than the one
  --     originally given: this file's contract is that nothing unverified gets
  --     sealed inside the new boundary, and a catalog cost can be repaired later
  --     while a version row's stored basis cannot. Treat a hit as data hygiene
  --     to resolve, not as a restore-safety emergency — and note it costs
  --     nothing today, since the live measurement below found this bucket empty.
  --
  --   exotic (BLOCKING) — a cost literal, or a product_id, in a form the app
  --     cannot emit but the restore path would still accept. See the cost_exotic
  --     and product_id_exotic notes above; the reasoning is the same one field
  --     apart, and both amount to hand-crafted JSON.
  --
  -- Measured read-only against live before this split was written: 5 snapshot
  -- lines exist in total and every one of these buckets is empty, so blocking
  -- costs nothing at apply time today and buys a real assertion tomorrow.
  --
  -- The advisory count is reported via NOTICE, which the Supabase apply channel
  -- does not surface. That is acceptable only because this bucket is now the
  -- one class that cannot be restored; the classes that carry risk raise
  -- instead, and an EXCEPTION does come back through the apply channel.
  IF v_unrestorable > 0 THEN
    RAISE NOTICE 'PRECOND (advisory, not blocking): % existing quote_versions snapshot line(s) carry a product_id that cannot be read as a uuid at all, or one that reads fine but names a product row that no longer exists. quote_items.product_id is NOT NULL REFERENCES products(id), so restore would fail on the foreign key rather than stamp a cost basis — these lines are not a forgery vector. A product_id in an unusual but still castable form does NOT land here; it is treated as hand-crafted and blocks below. Sealing the boundary anyway.', v_unrestorable;
  END IF;

  IF v_exotic > 0 THEN
    RAISE EXCEPTION 'PRECOND: % existing quote_versions snapshot line(s) carry a cost or a product_id in a form the legitimate writer cannot produce. Cost side: a non-decimal or underscore-grouped numeric literal (0x.., 0o.., 0b.., or 1_0), which PostgreSQL 16+ accepts and restore would stamp. Product side: an id that is not in canonical dashed form but is 32 hex digits once braces and hyphens are stripped — deliberately a SUPERSET of what uuid_in accepts, so some flagged spellings (a doubled or trailing hyphen, an unmatched brace) would in fact fail the restore cast rather than resolve; the scan does not narrow to the accepted subset because the point is that NO such spelling can come from the writer. snapshot_data is built server-side by _create_quote_version_owner_impl with jsonb_build_object from the typed quote_items.current_cost and quote_items.product_id columns, so PostgreSQL renders plain decimal and canonical lowercase-dashed uuid respectively; anything else means the row was written around that function. Investigate those rows before applying.', v_exotic;
  END IF;

  IF v_unchecked > 0 THEN
    RAISE EXCEPTION 'PRECOND: % existing quote_versions snapshot line(s) are unverifiable — either the cost string is not a finite decimal number this scan can read, or the product resolves but carries no usable catalog cost to compare against. Neither case can be cleared by this scan, and the two fail differently: an unreadable cost string is fully restorable and would be stamped into quote_items.cost_at_quote_cents with nobody having checked it, while a missing catalog cost is already refused in practice by the live below-cost trigger on quote_items. Both block for the same contract reason — nothing unverified gets sealed inside the new boundary, and a catalog cost can be repaired later while a version row''s stored basis cannot. Review them by hand before applying.', v_unchecked;
  END IF;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'PRECOND: % existing quote_versions snapshot line(s) carry a stored cost basis that is not EXACTLY the live products.current_cost for that product. Every legitimate line matches to the last digit, because the only writer that can reach this table is _create_quote_version_owner_impl, which copies quote_items.current_cost, which is itself copied from the catalog. A mismatch is therefore either the forged-snapshot path this migration closes, or a stale snapshot taken before a legitimate catalog price move. Both need a human read; neither may be decided by this file. Note this test is deliberately EXACT rather than a percentage band — a band cannot prove provenance, and a basis forged at 60%% of a $100 cost would clear a 50%% one (independent review CRX-QV-001, 2026-08-14). Read the differing rows before applying — sealing the boundary would freeze an unverified cost basis in place permanently.', v_count;
  END IF;
END;
$precond$;

-- ---------------------------------------------------------------------------
-- The fix.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS qversions_insert ON public.quote_versions;

-- If this REVOKE ever appears to do nothing, the cause is almost certainly the
-- grantor: REVOKE only removes grants made by the executing role or a role it is
-- a member of. A grant issued by some other role is left in place and the
-- statement succeeds silently. The POSTCOND block below is what turns that
-- silent no-op into a failed apply.
--
-- SIX privileges, not seven: MAINTAIN is deliberately left alone, so read the
-- live ACL after this applies expecting to still see it. PostgreSQL 17 added
-- MAINTAIN, and it survives the list below — authenticated goes from arwdDxtm to
-- rm, and anon (which holds only m on this table today) is unchanged.
--
-- That is a deliberate scope call, not an oversight, and the reason is narrower
-- than "it is harmless". MAINTAIN carries VACUUM, ANALYZE, CLUSTER, REINDEX,
-- REFRESH MATERIALIZED VIEW and LOCK TABLE. None of those change a row VALUE, so
-- MAINTAIN is outside the forged-snapshot integrity path this file closes, and
-- the POSTCOND block below correspondingly does not test for it. The EXCLUSIVE
-- lock above is a separate migration-time integrity guard, not an API-role
-- privilege retained by this scope decision. But MAINTAIN is not nothing: LOCK
-- TABLE ... ACCESS EXCLUSIVE, CLUSTER, VACUUM FULL and REINDEX can
-- all make the table unavailable while they run, so what is being accepted here
-- is an AVAILABILITY residual, not a null one. Three things make that
-- acceptable rather than merely convenient:
--   * there is no reachable caller. Browser traffic arrives through PostgREST,
--     which issues no LOCK/CLUSTER/VACUUM/REINDEX statements, and the one RPC
--     that could run arbitrary SQL, execute_sql_readonly(text), had its EXECUTE
--     revoked from authenticated, anon and PUBLIC by 20260614153000 lines 31-34;
--   * the residual is denial-of-service at worst, self-inflicted, and visible —
--     unlike the integrity failures this file exists to prevent, which are
--     silent and permanent once a forged snapshot is restorable;
--   * revoking it would be a project-wide ACL decision affecting every table, of
--     the same kind as the blanket TRUNCATE grants noted in the header. Folding
--     that into a targeted security fix is how unrelated breakage gets shipped.
-- If the project ever does sweep MAINTAIN off the API roles, this table needs no
-- special handling — it just stops being an exception.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.quote_versions
  FROM PUBLIC, anon, authenticated;

-- Re-state the intended callable boundary; see the caller analysis in the
-- header. Both RPCs are SECURITY DEFINER and perform their own authorization.
REVOKE EXECUTE ON FUNCTION public.create_quote_version(uuid, uuid, text, text, bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quote_version(uuid, uuid, text, text, bigint)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.restore_quote_version(uuid, uuid, uuid, text, bigint, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_quote_version(uuid, uuid, uuid, text, bigint, text)
  TO authenticated, service_role;

-- The owner-side implementation must never be callable from the browser: it is
-- the only routine in the database that INSERTs into quote_versions, so it is
-- the sole author of the snapshot_data the restore path later trusts as a cost
-- basis. It does NOT hold the cost-snapshot passthrough — see the header, which
-- names the two routines in 20260812115236 that actually arm it.
REVOKE EXECUTE ON FUNCTION public._create_quote_version_owner_impl(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- The two RESTORE-side implementations get the same defensive revoke the create
-- side has, so the file governs all three implementation routines in the same
-- shape rather than two-thirds of them.
--
-- Be precise about what these do and do not buy, because an earlier revision of
-- this comment was not. They do NOT "correct" a live browser grant: the PRECOND
-- roughly five hundred lines above raises unconditionally if either browser role
-- holds EXECUTE on either routine, and it runs before the first write. If there
-- were something here to correct, the apply would already have aborted and these
-- statements would never be reached. They are unreachable-as-a-fix by
-- construction, and that is the intended design — this file's stated posture is
-- that an unexpected browser grant on a cost-basis writer is a thing a human
-- looks at, not a thing a migration quietly launders.
--
-- What they buy is that the revoked state is written down as an executable
-- statement and not only as an assertion, so if the PRECOND is ever narrowed or
-- this file is ever used as the pattern for the next one, the restore side
-- carries its own guarantee instead of inheriting one from a check that may not
-- travel with it.
--
-- Note both statements name PUBLIC, anon and authenticated ONLY. service_role
-- is left alone deliberately: it holds EXECUTE on the owner-side routine (not
-- on the below-cost one) and this file's declared scope is the browser roles.
--
-- These revokes are belt, not braces. The PRECOND above already hard-fails if
-- either routine is browser-executable, so nothing downstream depends on these
-- succeeding — which matters, because REVOKE silently no-ops on a grant issued
-- by a role the executing role is not a member of, the same grantor trap
-- documented at the table REVOKE above.
REVOKE EXECUTE ON FUNCTION public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public._restore_quote_version_below_cost_impl_20260810(uuid, uuid, uuid, text, bigint)
  FROM PUBLIC, anon, authenticated;

DO $postcond$
DECLARE
  v_owner name;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.quote_versions'::regclass
       AND p.polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'POSTCOND: public.quote_versions still has a direct mutation policy';
  END IF;

  IF has_table_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
     OR has_table_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_table_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'DELETE')
     OR has_table_privilege('anon', 'public.quote_versions', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.quote_versions', 'TRIGGER')
     OR has_table_privilege('anon', 'public.quote_versions', 'REFERENCES') THEN
    RAISE EXCEPTION 'POSTCOND: public.quote_versions remains directly mutable by an external API role';
  END IF;

  -- has_table_privilege reports only the TABLE-level ACL, so a column-level
  -- grant on snapshot_data alone would reopen the entire money path with every
  -- check above still passing. That is why this block exists.
  --
  -- What it is NOT: a catch for column grants the revoke above missed. An
  -- earlier draft of this comment said REVOKE ... ON TABLE strips table-level
  -- ACLs only. That is wrong, and worth correcting rather than deleting so the
  -- next person does not re-derive it — PostgreSQL's REVOKE reference states
  -- that revoking a privilege on a table automatically revokes the
  -- corresponding column privileges on every column of that table. So the
  -- statement above is STRONGER than advertised: it silently clears such a
  -- grant instead of leaving one for this block to find. This check is
  -- therefore a guard against a grant made concurrently or afterwards, and
  -- against a future narrowing of the revoke list — not against a leftover.
  -- has_any_column_privilege supports INSERT/SELECT/UPDATE/REFERENCES;
  -- DELETE, TRUNCATE and TRIGGER are table-only privileges, already covered.
  IF has_any_column_privilege('authenticated', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'INSERT')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.quote_versions', 'REFERENCES') THEN
    RAISE EXCEPTION 'POSTCOND: a COLUMN-level write privilege on public.quote_versions survives the table-level revoke — the forged-snapshot path is still open';
  END IF;

  -- Reads must be exactly as they were.
  IF NOT has_table_privilege('authenticated', 'public.quote_versions', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCOND: authenticated lost SELECT on public.quote_versions — version history would stop rendering';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.quote_versions'::regclass
       AND p.polname = 'qversions_select'
       AND p.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'POSTCOND: qversions_select was removed';
  END IF;

  -- The RPC path must still be reachable and still be the only writer.
  IF NOT has_function_privilege(
       'authenticated', 'public.create_quote_version(uuid,uuid,text,text,bigint)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public.create_quote_version(uuid,uuid,text,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: create_quote_version EXECUTE grants do not match the authenticated-only API contract';
  END IF;

  IF NOT has_function_privilege(
       'authenticated', 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: restore_quote_version EXECUTE grants do not match the authenticated-only API contract';
  END IF;

  IF has_function_privilege(
       'authenticated', 'public._create_quote_version_owner_impl(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public._create_quote_version_owner_impl(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: the owner-side version writer is directly callable by an external API role';
  END IF;

  -- Read back the two RESTORE-side revokes as well. The create-side revoke above
  -- has always been read back and the restore-side pair was not, which left the
  -- one failure mode those statements can actually have unobserved: REVOKE
  -- silently no-ops when the grant was issued by a role the executing role is
  -- not a member of, so a statement that "ran" proves nothing on its own. Both
  -- of these are expected to be no-ops today over an already-clean state; the
  -- assertion is what makes the difference between that and a silent no-op over
  -- a dirty one visible.
  IF has_function_privilege(
       'authenticated', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: the owner-side restore implementation is directly callable by an external API role, bypassing the below-cost approval check in the public wrapper';
  END IF;

  IF has_function_privilege(
       'authenticated', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE')
     OR has_function_privilege(
       'anon', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: the below-cost restore implementation is directly callable by an external API role, which would make the below-cost approval gate optional';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = '_create_quote_version_owner_impl'
       AND p.prosecdef
       AND r.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCOND: the owner-side version writer can no longer bypass RLS — version creation would be broken';
  END IF;

  -- The surviving writer must still hold the GRANT, not just the RLS bypass.
  -- This is the check that catches "we revoked PUBLIC and closed the last door".
  -- Unlike the PRECOND copy, this one runs AFTER PUBLIC has been stripped, so a
  -- true result here means the owner holds INSERT in its own right.
  SELECT r.rolname INTO v_owner
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)');

  -- HONEST ABOUT ITS STRENGTH, the same way the rolsuper note above is. This
  -- check is near-vacuous while the definer owner is also the table owner —
  -- and the header records that `postgres` owns quote_versions, so today it is.
  -- has_table_privilege returns true for a table's owner regardless of any
  -- explicit grant, so this cannot detect a revoked grant on the current owner.
  -- What it DOES catch is the case worth catching: the definer being changed to
  -- some other role that was never granted INSERT, which would break version
  -- creation silently. Keep it, but do not read a green result as proof that
  -- the owner's grants are intact.
  IF NOT has_table_privilege(v_owner, 'public.quote_versions', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCOND: the definer owner (%) no longer holds INSERT on public.quote_versions — version creation is broken', v_owner;
  END IF;

  -- The SCOPE claim in this file's header says service_role keeps full write
  -- access. That was prose; this makes it an assertion.
  --
  -- The risk it closes is specific. REVOKE ... FROM PUBLIC removes only what
  -- PUBLIC held, but a role whose privilege came THROUGH PUBLIC loses it as a
  -- side effect, with every other check in this block still green — the failure
  -- would surface weeks later as a bare permission-denied in an edge function or
  -- a backfill, with no migration in the blame path. Read live before writing
  -- this: quote_versions carries service_role=arwdDxtm/postgres as a direct
  -- grant and has no PUBLIC entry at all, so the REVOKE provably cannot reach
  -- it. Asserting it anyway costs one comparison and converts a fact that
  -- happens to be true today into one that cannot quietly stop being true.
  IF NOT has_table_privilege('service_role', 'public.quote_versions', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.quote_versions', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.quote_versions', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCOND: service_role lost a write privilege on public.quote_versions. This migration is a BROWSER-role boundary and must not touch the service key — any edge function or backfill that writes version rows is now broken.';
  END IF;

  -- KNOWN LIMIT, asserted rather than silently assumed: every check above is
  -- table- and routine-scoped. A write reaching quote_versions through the
  -- QUERY REWRITER would bypass all of them. Two shapes do that, and both are
  -- found by the same pg_rewrite dependency edge:
  --
  --   a VIEW (auto-updatable, or carrying an INSTEAD OF trigger) — without
  --     security_invoker, base-table permissions AND row-level security are
  --     evaluated as the VIEW OWNER, so authenticated holding INSERT on the view
  --     keeps the forged-snapshot path fully open with every check above green;
  --
  --   a RULE on an ORDINARY TABLE (relkind 'r'/'p') — e.g. CREATE RULE ... DO
  --     ALSO INSERT INTO quote_versions. Rule-expanded queries are permission-
  --     checked as the owner of the table carrying the rule, so a postgres-owned
  --     rule on any browser-writable table reopens the path identically. An
  --     earlier revision filtered relkind IN ('v','m') and threw this case away.
  --
  -- So: no relkind filter at all, only the self-exclusion. Materialized views
  -- accept no DML and are inert here, but cost nothing to leave in.
  --
  -- Privileges are tested at COLUMN granularity for the same reason the base
  -- table is (see the has_any_column_privilege block above): a grant on
  -- snapshot_data alone leaves has_table_privilege false and would have passed.
  -- DELETE has no column form and stays table-level.
  --
  -- TWO privileges the base-table block above DOES test are deliberately absent
  -- from this one, and the omissions are not oversights:
  --
  --   TRUNCATE — rules do not rewrite it and a view cannot be truncated, so it
  --     has no route from a rewriting relation to a quote_versions row. Direct
  --     TRUNCATE on the table itself is covered above.
  --
  --   TRIGGER — this is the false-positive trap. Per the pg_default_acl note
  --     below, this project's default privileges grant TRIGGER to authenticated
  --     on EVERY newly created relation in schema public, so testing it here
  --     would abort on the first ordinary reporting view somebody adds, whether
  --     or not it can write anything. It is also not a write path on its own:
  --     getting a row into quote_versions through a rewriting relation still
  --     requires one of the privileges tested above. The predicate copy of this
  --     branch carries the same exclusion for the same reason — change them
  --     together or they will disagree.
  --
  -- No such object exists today (no CREATE VIEW and no CREATE RULE over
  -- quote_versions anywhere in supabase/migrations/), so this is a gap in the
  -- proof rather than a known hole. Fail closed if one ever appears.
  --
  -- Still NOT covered, stated plainly: a view whose INSTEAD OF trigger writes
  -- quote_versions without the view definition referencing it leaves no
  -- pg_depend edge for this scan to find. At apply time the two PRECOND prosrc
  -- scans above do catch such a trigger function; afterwards, nothing here does.
  -- That is the standing sweep predicate's job, not this one-shot block's.
  -- The traversal is RECURSIVE on purpose. A single pg_depend hop finds only
  -- relations that rewrite DIRECTLY onto quote_versions. A view B defined over
  -- view A over quote_versions carries a dependency on A, not on the table, so
  -- a one-hop scan skips B entirely — while B can still be auto-updatable, and
  -- a write through it is permission-checked as B's owner. That is the same
  -- hole this block exists to close, one level further out. UNION (not UNION
  -- ALL) deduplicates against everything already produced, so the walk
  -- terminates even if a pair of rules on ordinary tables points at each other.
  IF EXISTS (
    WITH RECURSIVE rewrite_reachable AS (
      SELECT 'public.quote_versions'::regclass AS relid
      UNION
      SELECT v.oid
        FROM rewrite_reachable rr
        JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass
                        AND d.refobjid = rr.relid
                        AND d.classid = 'pg_rewrite'::regclass
        JOIN pg_rewrite w ON w.oid = d.objid
        JOIN pg_class v ON v.oid = w.ev_class
       WHERE v.oid <> rr.relid
    )
    SELECT 1
      FROM rewrite_reachable rr
     WHERE rr.relid <> 'public.quote_versions'::regclass
       AND (has_any_column_privilege('authenticated', rr.relid, 'INSERT')
         OR has_any_column_privilege('authenticated', rr.relid, 'UPDATE')
         OR has_any_column_privilege('authenticated', rr.relid, 'REFERENCES')
         OR has_table_privilege('authenticated', rr.relid, 'DELETE')
         OR has_any_column_privilege('anon', rr.relid, 'INSERT')
         OR has_any_column_privilege('anon', rr.relid, 'UPDATE')
         OR has_any_column_privilege('anon', rr.relid, 'REFERENCES')
         OR has_table_privilege('anon', rr.relid, 'DELETE'))
  ) THEN
    RAISE EXCEPTION 'POSTCOND: a relation carrying a rewrite rule over public.quote_versions (a view, or a rule on an ordinary table) is writable by an external API role. The table-level revoke does not cover it — a rewritten write is permission-checked as the OWNER of the rewriting relation, so this re-opens the forged-snapshot path.';
  END IF;

  -- quote_versions must not be a partition or an inheritance child: an INSERT
  -- aimed at the PARENT routes rows in while only the parent's privileges are
  -- checked, which every test above would miss. Verified read-only on live
  -- before writing this — pg_inherits has no row for it and relispartition is
  -- false — so this asserts a fact rather than fixing one.
  IF EXISTS (
    SELECT 1 FROM pg_inherits WHERE inhrelid = 'public.quote_versions'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCOND: public.quote_versions is now an inheritance/partition child. A write aimed at the parent bypasses every privilege check in this migration.';
  END IF;

  -- The PARENT direction matters just as much, and for a reason specific to this
  -- project. A child of quote_versions would be a brand-new table in schema
  -- public, and per the pg_default_acl note below it would be BORN writable by
  -- authenticated. A direct INSERT into that child lands a row that reads back
  -- through the parent, with every check in this migration and every branch of
  -- the standing sweep still green. Live has no children today.
  IF EXISTS (
    SELECT 1 FROM pg_inherits WHERE inhparent = 'public.quote_versions'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCOND: public.quote_versions now has an inheritance/partition child. A new child table in schema public is born browser-writable under this project default privileges, and rows inserted into it read back through the parent.';
  END IF;

  -- KNOWN LIMIT, deliberately NOT asserted here. Everything above constrains the
  -- table as it exists; none of it constrains what a re-created table would come
  -- back as. Read live read-only while writing this — pg_default_acl carries two
  -- entries for tables in schema public:
  --
  --   grantor supabase_admin:
  --     postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm,
  --     service_role=arwdDxtm
  --   grantor postgres:
  --     postgres=arwdDxtm, anon=rm, authenticated=arwdDxtm,
  --     service_role=arwdDxtm, metabase_ro=r
  --
  -- Transcribed in full on purpose. An earlier revision listed only the two
  -- browser roles, which reads as though the entries contain nothing else and
  -- invites a later reader to "complete" them from memory.
  --
  -- So a DROP + CREATE of quote_versions returns a table that authenticated can
  -- write in full (and anon too, if supabase_admin creates it), with every
  -- assertion in this block still green. 20260526151856 revoked the default
  -- table writes from anon under the postgres grantor only; authenticated was
  -- never covered, and the supabase_admin entry was never touched.
  --
  -- The FUNCTION side is the same shape and matters just as much here, so state
  -- it too rather than leaving a reader to assume tables are the whole story.
  -- Same live read, objtype 'f' in schema public:
  --
  --   grantor supabase_admin: postgres=X, anon=X, authenticated=X, service_role=X
  --   grantor postgres:       postgres=X, anon=X, authenticated=X, service_role=X
  --
  -- postgres=X is listed because it is there. An earlier revision of these two
  -- lines dropped it while the TABLE transcription above kept its equivalent —
  -- exactly the "complete them from memory" failure the note above warns about,
  -- committed three paragraphs later.
  --
  -- On top of PostgreSQL's own default EXECUTE to PUBLIC, that means every new
  -- function in schema public is born directly callable by both browser roles.
  -- This is precisely why the preconditions above pin an exact overload COUNT on
  -- each of the five routines and not merely their signatures: a SECOND overload
  -- of any of them, added later, is browser-callable the moment it is created,
  -- and every signature-scoped check in this file keeps passing on the old one.
  -- The counts are pinned at exactly 1, so the second one trips them, not the
  -- fourth. The standing predicate carries the same counts for the same reason.
  --
  -- Neither side is asserted, because both are project-wide defaults that govern
  -- every table and every function in public, not properties of quote_versions —
  -- raising on them here would abort a scoped security migration over a
  -- pre-existing global condition it neither caused nor can safely fix.
  -- Narrowing those defaults changes what every future object is born with and
  -- belongs in its own reviewed migration.
  --
  -- Be honest about containment: today it rests on the standing rule that a new
  -- table ships RLS and policies in the same migration, and on the invariant
  -- sweep catching a new anon-executable SECURITY DEFINER. Both are review-time
  -- and sweep-time controls, so the real containment window is "until the next
  -- sweep runs", not "always". That is defence in depth, not a substitute.
  -- Recorded here so the gap stays visible rather than assumed away.
END;
$postcond$;

-- No RESET needed: the timeouts above are SET LOCAL, so they end with the
-- transaction and never follow this connection back into the pool.
