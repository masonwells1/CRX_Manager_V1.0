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
-- EXPLOITATION CHECK — CLEAN, re-confirmed against live 2026-08-13 UTC
-- (read-only; UTC throughout this header, which is the business clock on live
-- and is one calendar day ahead of local evening — the dates are not typos):
-- five snapshot cost lines across three quote_versions rows. Every one carries a
-- numeric cost, resolves to a real product with a usable catalog cost, and sits
-- above half that cost. Nothing matches the forgery signature.
--
-- Read that as "no forgery of the shape this precondition detects", not as
-- "no forgery". The threshold is half the catalog cost, so a line understated by
-- a third — still real money on a large order — passes it silently. A clean
-- result here is the reason to seal the boundary now, not evidence that sealing
-- it can be deferred.
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
--   * revoke the direct INSERT/UPDATE/DELETE/TRUNCATE table grants from the
--     browser roles;
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
--   * exactly ONE overload exists of each of the three functions named below,
--     so every REVOKE/GRANT here hits the whole surface of that name;
--   * no routine in `public` has a BEGIN ATOMIC body, so the source scan in the
--     precondition is not blind;
--   * no routine in any non-system schema writes this table either;
--   * the browser never writes this table: the only two `.from('quote_versions')`
--     call sites in src/ are `.select('*')` reads in QuoteBuilder.tsx, and
--     src/lib/quoteLifecycleRpc.ts creates versions through the RPC.
--
-- CALLER ANALYSIS FOR THE EXECUTE RE-STATEMENTS BELOW (B10 rule). Read the
-- three statements individually rather than as one pattern; an earlier draft of
-- this paragraph claimed every REVOKE is followed by a GRANT and that is not
-- true of the third. For the two PUBLIC entry points -- create_quote_version and
-- restore_quote_version -- the REVOKE from PUBLIC/anon IS immediately followed by
-- a GRANT to authenticated + service_role, which is a no-op re-assertion of the
-- ACL read from live on 2026-08-13 (postgres=X, authenticated=X, service_role=X
-- on both; anon absent from both). The browser calls these through PostgREST as
-- the `authenticated` role, which keeps EXECUTE. The third statement, on
-- _create_quote_version_owner_impl, revokes from PUBLIC, anon AND authenticated
-- with NO following GRANT -- deliberately, because that is the owner-side writer
-- and nothing outside the definer chain may call it. Auditing the ACL delta from
-- the blanket sentence alone would have missed that asymmetry.
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
-- ACL read above, not the primary evidence.
--
-- TRANSACTION SHAPE. This file relies on the applier wrapping the whole thing in
-- one transaction, so a failing postcondition rolls the REVOKEs back. The
-- Supabase apply path does that. Every precondition that can be checked before
-- the first write is therefore stated as a PRECOND, not left to POSTCOND.
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

DO $precond$
DECLARE
  v_count int;
  v_unknown int;
  v_forced boolean;
  v_enabled boolean;
  v_check text;
  v_policy_exists boolean;
  v_owner name;
BEGIN
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

  SELECT pg_get_expr(p.polwithcheck, p.polrelid) INTO v_check
    FROM pg_policy p
   WHERE p.polrelid = 'public.quote_versions'::regclass
     AND p.polname = 'qversions_insert';

  IF NOT v_policy_exists THEN
    RAISE NOTICE 'PRECOND: qversions_insert is already absent — replay may proceed as a no-op re-assertion';
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
  -- (counted as unevaluable) instead of aborting the apply with a bare cast
  -- error that says nothing about what was wrong.
  parsed AS MATERIALIZED (
    SELECT CASE WHEN cost_text ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                THEN btrim(cost_text)::numeric
           END AS cost_num,
           CASE WHEN product_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN product_id_text::uuid
           END AS product_uuid
      FROM lines
     WHERE cost_text IS NOT NULL
  )
  SELECT
    count(*) FILTER (
      WHERE p.cost_num IS NULL
         OR p.product_uuid IS NULL
         OR pr.id IS NULL
         OR pr.current_cost IS NULL
         OR pr.current_cost <= 0),
    count(*) FILTER (
      WHERE p.cost_num IS NOT NULL
        AND pr.current_cost IS NOT NULL
        AND pr.current_cost > 0
        AND p.cost_num < pr.current_cost / 2)
    INTO v_unknown, v_count
    FROM parsed p
    LEFT JOIN public.products pr ON pr.id = p.product_uuid;

  -- A LEFT JOIN, not an inner one, and no positive-cost filter on the product:
  -- an inner join would silently DROP a snapshot line pointing at a deleted or
  -- zero-cost product, which is exactly where a forged line would hide. Restore
  -- never consults the product row at all, so an unevaluable line is still
  -- fully restorable. Refuse to seal what cannot be checked.
  IF v_unknown > 0 THEN
    RAISE EXCEPTION 'PRECOND: % existing quote_versions snapshot line(s) cannot be evaluated — a non-numeric cost, a malformed or unknown product_id, or a product with no usable catalog cost. Restore would still stamp them into quote_items.cost_at_quote_cents. Review them by hand before sealing the boundary.', v_unknown;
  END IF;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'PRECOND: % existing quote_versions snapshot line(s) carry a cost basis below half the product current cost. That is the signature of the forged-snapshot path this migration closes. Investigate those rows before applying — sealing the boundary would freeze the bad cost basis in place.', v_count;
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
-- what actually holds the passthrough that makes snapshot_data authoritative.
REVOKE EXECUTE ON FUNCTION public._create_quote_version_owner_impl(uuid, uuid, text, text)
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

  -- REVOKE ... ON TABLE strips table-level ACLs only, and has_table_privilege
  -- reports only table-level. A column-level grant on snapshot_data alone would
  -- reopen the entire money path with every check above still passing.
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

  IF NOT has_table_privilege(v_owner, 'public.quote_versions', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCOND: the definer owner (%) no longer holds INSERT on public.quote_versions — version creation is broken', v_owner;
  END IF;
END;
$postcond$;

-- No RESET needed: the timeouts above are SET LOCAL, so they end with the
-- transaction and never follow this connection back into the pool.
