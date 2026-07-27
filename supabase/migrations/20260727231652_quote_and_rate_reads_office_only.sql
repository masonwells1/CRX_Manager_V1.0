-- Restrict four pricing tables to office roles (admin + sales_rep).
--
-- Intent: drivers and applicators should not be able to read product cost,
-- margin, or quote pricing. Approval status for the live apply is recorded in
-- docs/reference/migration-history.md rather than asserted here.
--
-- The 2026-07-27 broad-read migration (20260727174657) narrowed 31 wide-open
-- SELECT policies to "any ACTIVE user". "Wide-open" was not one shape: 30 were
-- USING (true) granted to `authenticated`, and the 31st
-- (application_record_fields.arf_select) was granted to PUBLIC with
-- USING (auth.uid() IS NOT NULL). Calling all 31 "any authenticated user"
-- rounds the second one off; the distinction matters because a PUBLIC grantee
-- is the exact drift this migration's own postflight checks 1 and 2 exist to
-- catch. That migration deliberately did not change *which* role sees what.
-- This migration is the role-scoping follow-up, and it covers only the four
-- tables where scoping is provably safe.
--
-- Why only four. Of the eight pricing/margin tables, four are read by pages
-- that drivers and applicators legitimately open, so restricting them would
-- break the app rather than secure it:
--
--   products                -> Deliveries (driver) via QuickDeliveryModal, and
--                              JobDetail (applicator). Field staff need product
--                              names, units, and label rates. Hiding only the
--                              cost/margin COLUMNS from field roles is not
--                              expressible in RLS (every signed-in user shares
--                              the single `authenticated` grantee), so it needs
--                              a restricted view plus frontend changes. Tracked
--                              separately; NOT attempted here.
--   application_services    -> Jobs (applicator).
--   field_billing_defaults  -> JobDetail (applicator).
--   blend_recipe_items      -> JobDetail (applicator).
--
-- The four below are read by no driver- or applicator-reachable route. Verified
-- independently by migration-drift-reviewer, including transitively through
-- imported components, shared lib/ helpers, and report builders:
--
--   quote_items                 -> Quotes, QuoteBuilder      (admin/sales_rep)
--   quote_versions              -> QuoteBuilder              (admin/sales_rep)
--   customer_application_rates  -> ApplicationServiceDetail   (admin only)
--   rebate_programs             -> Rebates                    (admin only)
--
-- quote_items and quote_versions additionally correct a real inconsistency:
-- public.quotes already restricts SELECT to (is_admin() OR is_sales_rep()), so
-- until now a driver could read every quote's line items and pricing snapshots
-- while being unable to read the quote header they belong to.
--
-- DELIBERATE EXCEPTION -- public.quote_sections is the third child of quotes and
-- has the same wide-open is_active_profile() read, but it is NOT narrowed here.
-- JobDetail embeds quote_sections(section_name) through the
-- jobs_quote_section_id_fkey relationship (src/pages/JobDetail.tsx:1497), and
-- /jobs/:id is open to applicators (src/App.tsx:286). PostgREST applies the
-- embedded table's own RLS, so office-only scoping would blank that field for
-- every applicator. Its columns carry no money (id, quote_id, section_name,
-- sort_order, section_notes, section_header_notes, needed_by_date, field_id),
-- so the residual exposure is section names and notes, not pricing. Narrowing it
-- correctly means (is_admin() OR is_sales_rep() OR is_applicator()) and is
-- tracked separately.
--
-- is_admin() and is_sales_rep() each already require `profiles.is_active = true`,
-- so this strictly narrows the existing is_active_profile() predicate -- no
-- active office user loses access. That requirement is established by
-- 20260714185631_harden_is_admin_search_path.sql and
-- 20260720235246_qualify_sales_rep_authorization_helper.sql, which are the
-- migrations that actually CREATE OR REPLACE the two helper bodies. An earlier
-- revision of this comment cited 20260727145843 instead; that file re-emits no
-- helper body at all -- it fixes INLINE role checks in policy predicates and
-- then merely ASSERTS that both helpers still carry is_active. It is a standing
-- tripwire on the property, not its source. The distinction matters here because
-- this is the sentence the whole "no active office user loses access" claim
-- rests on, so it should point at the code that makes it true.
--
-- The predicates are wrapped in scalar sub-selects so PostgreSQL evaluates them
-- once per statement as an InitPlan rather than once per candidate row. This
-- matches 20260727174657 and matters most on quote_items, the largest of the
-- four (every line of every quote).
--
-- ALTER POLICY, never DROP + CREATE. Inside this transaction a DROP + CREATE
-- would not actually expose the table -- other sessions cannot see the
-- uncommitted gap, and a failure rolls back. ALTER is preferred because it is a
-- smaller edit that preserves every property not named here, so a mistake in
-- the CREATE cannot silently drop a qualifier that used to be enforced.
--
-- ORDERING -- 20260727174657 must never be replayed AFTER this migration, and
-- the failure mode is SILENT, not loud. That file re-runs 31 ALTER POLICY
-- statements -- 30 of which set is_active_profile(), including the four this
-- migration narrows -- and only THEN counts how many carry is_active_profile().
-- By the time it counts, its own ALTERs have restored the count to its expected
-- 30, so it commits cleanly and quietly
-- reverts quote line items, quote versions, per-customer rates, and rebate
-- programs to "any active user can read". Nothing aborts and nothing warns.
--
-- Nothing replays it today: it sits below the DR baseline high-water mark
-- (supabase/baselines/manifest.json), so scripts/list-post-baseline-migrations.mjs
-- excludes it from the restore set. This note exists because that fact is not
-- visible from either file, and because there is no automated guard against
-- someone re-ordering or re-running it later. Do not treat the postflight in
-- 20260727174657 as a tripwire -- it is not one.
--
-- KNOWN, DELIBERATELY OUT OF SCOPE -- two SECURITY DEFINER functions are granted
-- to `authenticated` with no role gate in the body, so a driver or applicator
-- can still reach some of this data through a direct PostgREST /rpc/ call after
-- this migration:
--
--   compute_application_service_fee -> returns rate_per_acre_cents and
--                                      cost_per_acre_cents (raised as M4 by
--                                      migration-drift-reviewer).
--   get_program_completion          -> returns figures derived from quote_items
--                                      (raised by the Codex adversarial review).
--
-- Both are pre-existing gaps in different objects. They are tracked separately
-- rather than widened into this change, and they are the reason the driver
-- exposure this migration closes is "no direct table read", not "no path to the
-- underlying numbers at all".

BEGIN;

-- ALTER POLICY takes ACCESS EXCLUSIVE on each table until COMMIT, which blocks
-- ordinary readers. Taking all four locks up front with NOWAIT removes the real
-- hazard of doing it one statement at a time: a WAITING ACCESS EXCLUSIVE
-- request blocks every reader that arrives behind it, so a slow reader on the
-- fourth table would stall the first three for the whole timeout. NOWAIT never
-- joins a lock queue.
--
-- This is a trade, not a free win. NOWAIT gives up all grace: a single in-flight
-- SELECT on any of the four aborts the apply instantly with 55P03. Locks are
-- also taken left to right, so a failure holds ACCESS EXCLUSIVE on the earlier
-- tables until the transaction actually ends. An earlier revision of this
-- comment said "for the microseconds before the rollback"; that understates it.
-- PostgreSQL holds every lock until COMMIT or ROLLBACK, and nothing forces the
-- client to issue that rollback promptly -- a client that errors and then stalls
-- keeps the earlier tables locked for as long as it stalls. Expect retries and
-- prefer a quiet window; it is safe to re-run.
--
-- lock_timeout is a net for anything NOWAIT does not cover, not the operative
-- guard -- every statement after the LOCK targets a table already held.
SET LOCAL lock_timeout = '2s';

-- The postflight below reads pg_policies.qual/with_check, which are deparsed by
-- ruleutils under the SESSION's settings, not under a fixed grammar. With
-- quote_all_identifiers = on, that deparse quotes every identifier, the LIKE
-- assertions stop matching, and the token whitelist is left holding `"` residue
-- -- so a correctly-applied migration would abort on a false red. Pinning it off
-- for this transaction makes the postflight depend on the policy shape alone and
-- not on how the applying session happens to be configured. off is the default;
-- this only defends against a session or role that set it otherwise.
SET LOCAL quote_all_identifiers = off;

LOCK TABLE
  public.quote_items,
  public.quote_versions,
  public.customer_application_rates,
  public.rebate_programs
IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Each statement states TO authenticated explicitly. Three of these policies
-- already carry that grantee on live, but rebate_programs_select does NOT get it
-- from the migration history: 20260213200000 created it with no TO clause (so a
-- replay grants it to PUBLIC), and every later migration only touched USING,
-- which does not change the grantee. Live is {authenticated} through an
-- out-of-band change that never landed on disk.
--
-- To be precise about the consequence: no CURRENT restore path replays these
-- files from zero. The disaster-recovery baseline restores a pg_dump of live
-- (supabase/baselines/ + manifest.json restore_order) and then replays only the
-- migrations newer than that snapshot, and scripts/verify-schema-baseline.mjs
-- compares artifact hashes without opening a database connection. So the
-- divergence was invisible to tooling and was caught by human/adversarial
-- review, not by a gate. Stating the grantee makes the file self-describing and
-- makes the postflight assertion below true by construction in both worlds.
ALTER POLICY qitems_select ON public.quote_items
  TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()));

ALTER POLICY qversions_select ON public.quote_versions
  TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()));

ALTER POLICY car_select ON public.customer_application_rates
  TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()));

ALTER POLICY rebate_programs_select ON public.rebate_programs
  TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()));

-- Same grantee drift, write side. 20260213200000 also created these three with
-- no TO clause, so they are {public} on disk AND on live -- rebate_programs is
-- the only one of the four tables with any PUBLIC-granteed policy. There is no
-- hole today (anon holds no INSERT/UPDATE/DELETE grant, and each predicate is
-- is_admin(), which is false for a NULL auth.uid()), but leaving them PUBLIC
-- means anon writes are refused by policy evaluation rather than refused
-- outright. Predicates are untouched; only the grantee is pinned.
ALTER POLICY rebate_programs_insert ON public.rebate_programs TO authenticated;
ALTER POLICY rebate_programs_update ON public.rebate_programs TO authenticated;
ALTER POLICY rebate_programs_delete ON public.rebate_programs TO authenticated;

-- Defence in depth. Every SELECT policy on these tables is granted TO
-- authenticated, so anon already reads zero rows -- but anon still holds the
-- table-level SELECT grant that Supabase's ALTER DEFAULT PRIVILEGES handed it.
-- Removing the grant makes "anon cannot read this" true by construction rather
-- than true only as long as nobody adds a PUBLIC-granted policy later.
--
-- Side effect, intended: a direct pre-auth PostgREST read of these tables now
-- fails with 42501 permission denied instead of returning an empty array.
-- `authenticated` and `service_role` are untouched; both hold their SELECT
-- grants explicitly, not via PUBLIC (verified live 2026-07-27), and the
-- postflight below asserts the authenticated grant survived.
REVOKE SELECT ON TABLE
  public.quote_items,
  public.quote_versions,
  public.customer_application_rates,
  public.rebate_programs
FROM anon;

-- ---------------------------------------------------------------------------
-- Postflight (no live data is mutated by this block).
-- ---------------------------------------------------------------------------
-- These assertions deliberately do NOT string-compare the deparsed qual against
-- one expected literal: pg_policies.qual is a deparse whose exact spacing is a
-- PostgreSQL implementation detail, and a version bump would turn a green gate
-- red for no reason. The predicate check below is token-based instead -- it is
-- as strict as an equality check about WHICH tokens may appear, while staying
-- indifferent to how they are spaced and parenthesised.
--
-- Properties asserted: both office checks present, the wider predicate gone,
-- nothing else OR-ed in, RLS still on, grantee pinned to authenticated only,
-- the three write policies pinned to their full admin-only shape (grantee,
-- command, permissiveness, predicate, and which clause carries it), no second
-- permissive policy able to OR the narrowing back open, no restrictive policy
-- able to AND it shut, office users still holding the table grant, and office
-- users still able to EXECUTE the two helpers their own read policy calls.
DO $verify$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(t.tbl || '.' || t.pol, ', ')
    INTO v_bad
    FROM (VALUES
            ('quote_items',                'qitems_select'),
            ('quote_versions',             'qversions_select'),
            ('customer_application_rates', 'car_select'),
            ('rebate_programs',            'rebate_programs_select')
         ) AS t(tbl, pol)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_policies pp
      WHERE pp.schemaname = 'public'
        AND pp.tablename  = t.tbl
        AND pp.policyname = t.pol
        AND pp.cmd        = 'SELECT'
        AND pp.permissive = 'PERMISSIVE'
        -- both office checks present
        AND pp.qual LIKE '%is_admin()%'
        AND pp.qual LIKE '%is_sales_rep()%'
        -- the wider predicate this migration replaces must be gone
        AND pp.qual NOT LIKE '%is_active_profile%'
        -- NOTHING ELSE is OR-ed alongside the office checks. The two LIKE
        -- assertions above only prove both office checks are PRESENT; on their
        -- own they go green on (is_admin() OR is_sales_rep() OR is_driver()),
        -- which is exactly the exposure this migration closes.
        --
        -- An earlier revision listed the widening predicates to reject
        -- (is_driver, is_applicator, auth.uid(), auth.role(), bare true). A
        -- blacklist cannot be exhaustive and that one was not: it passed
        -- `... OR current_user = 'authenticated'`, a predicate that restores
        -- the exact broad exposure. So this is a WHITELIST instead. Erase every
        -- token the intended predicate is allowed to contain, plus parentheses,
        -- dots and whitespace; whatever is left is by definition something this
        -- migration did not put there, and the check fails.
        --
        --   (( SELECT is_admin() AS is_admin)
        --     OR ( SELECT is_sales_rep() AS is_sales_rep))   -> '' , green
        --   ... OR (current_user = 'authenticated')   -> "current_user='...'" , red
        --   ... OR is_driver()                       -> "is_driver"           , red
        --   ... OR true                              -> "true"                , red
        --
        -- `public` and `.` are allowed because a schema-qualified deparse is
        -- legal; they cannot hide anything, since the qualified function name
        -- itself still has to survive the whitelist. This fails CLOSED: any
        -- future Postgres deparse that emits an unfamiliar token turns the
        -- check red, never green.
        AND btrim(
              regexp_replace(
                pp.qual,
                '\m(SELECT|AS|OR|public|is_admin|is_sales_rep)\M|[().[:space:]]',
                '',
                'g'
              )
            ) = ''
        -- grantee pinned to authenticated only, never public/anon
        AND pp.roles = ARRAY['authenticated']::name[]
   );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: policy not correctly scoped to office roles: %', v_bad;
  END IF;

  -- The three rebate_programs write policies pinned above. An earlier revision
  -- asserted ONLY the grantee, on the reasoning that this migration does not
  -- touch their predicates. Codex was right to call that a proof-coverage
  -- defect: asserting only the grantee is self-fulfilling -- it re-reads what
  -- the three ALTER statements just wrote and can never fail. Worse, because
  -- ALTER POLICY preserves every clause it does not name, a predicate that had
  -- already drifted to `WITH CHECK (true)` would be carried forward untouched,
  -- handed the `authenticated` grantee by this migration, and reported green.
  --
  -- So the shape is pinned in full: command, permissiveness, WHICH clause
  -- carries the predicate, that the other clause is NULL, and that the
  -- predicate is exactly is_admin() -- same whitelist technique as check 1,
  -- minus OR, because these three are admin-only and no disjunction belongs in
  -- them. Verified live 2026-07-27: INSERT carries with_check, UPDATE and
  -- DELETE carry qual, and all three are a bare is_admin(). UPDATE has a NULL
  -- WITH CHECK deliberately -- Postgres then applies USING to the proposed row
  -- as well, so the admin gate gets applied in both directions.
  SELECT string_agg(t.pol, ', ')
    INTO v_bad
    FROM (VALUES ('rebate_programs_insert', 'INSERT', 'w'),
                 ('rebate_programs_update', 'UPDATE', 'q'),
                 ('rebate_programs_delete', 'DELETE', 'q')
         ) AS t(pol, expected_cmd, clause)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_policies pp
      WHERE pp.schemaname = 'public'
        AND pp.tablename  = 'rebate_programs'
        AND pp.policyname = t.pol
        AND pp.roles      = ARRAY['authenticated']::name[]
        AND pp.cmd        = t.expected_cmd
        AND pp.permissive = 'PERMISSIVE'
        -- the clause that must carry is_admin(), and nothing but is_admin()
        AND btrim(
              regexp_replace(
                CASE t.clause WHEN 'w' THEN pp.with_check ELSE pp.qual END,
                '\m(SELECT|AS|public|is_admin)\M|[().[:space:]]',
                '',
                'g'
              )
            ) = ''
        AND (CASE t.clause WHEN 'w' THEN pp.with_check ELSE pp.qual END)
              LIKE '%is_admin()%'
        -- and the clause that must not exist, does not
        AND (CASE t.clause WHEN 'w' THEN pp.qual ELSE pp.with_check END) IS NULL
   );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: rebate_programs write policy not pinned to admin-only shape: %', v_bad;
  END IF;

  -- RLS must still be enabled, or every policy above is decorative.
  SELECT string_agg(c.relname, ', ')
    INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('quote_items', 'quote_versions',
                       'customer_application_rates', 'rebate_programs')
     AND NOT c.relrowsecurity;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: row level security is not enabled on: %', v_bad;
  END IF;

  -- No OTHER permissive read policy reaching authenticated may re-widen these
  -- tables: permissive policies are OR-ed, so one would silently undo the
  -- narrowing. Matched on (table, policy) pairs, not policy name alone. The
  -- pg_has_role arm catches the indirect case the array overlap misses -- a
  -- policy granted to some custom role that `authenticated` is a member of and
  -- therefore inherits. 'public' is not a real role and is excluded from that
  -- arm; it is already covered by the direct overlap.
  SELECT string_agg(pp.tablename || '.' || pp.policyname, ', ')
    INTO v_bad
    FROM pg_policies pp
   WHERE pp.schemaname = 'public'
     AND pp.tablename IN ('quote_items', 'quote_versions',
                          'customer_application_rates', 'rebate_programs')
     AND pp.cmd IN ('SELECT', 'ALL')
     AND pp.permissive = 'PERMISSIVE'
     AND (
           pp.roles && ARRAY['authenticated', 'public', 'anon']::name[]
           OR EXISTS (
                SELECT 1
                  FROM unnest(pp.roles) AS r(rolname)
                 WHERE r.rolname <> 'public'
                   AND EXISTS (SELECT 1 FROM pg_roles pr WHERE pr.rolname = r.rolname)
                   AND pg_has_role('authenticated', r.rolname, 'USAGE')
              )
         )
     AND (pp.tablename, pp.policyname) NOT IN (
           ('quote_items',                'qitems_select'),
           ('quote_versions',             'qversions_select'),
           ('customer_application_rates', 'car_select'),
           ('rebate_programs',            'rebate_programs_select')
         );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: unexpected permissive read policy re-widens a scoped table: %', v_bad;
  END IF;

  -- The mirror image: RESTRICTIVE policies are AND-ed with the permissive set,
  -- so an unexpected one would leave every assertion above green while office
  -- users silently see no rows. None exists on these four tables today
  -- (verified live 2026-07-27); assert that, rather than assume it.
  SELECT string_agg(pp.tablename || '.' || pp.policyname, ', ')
    INTO v_bad
    FROM pg_policies pp
   WHERE pp.schemaname = 'public'
     AND pp.tablename IN ('quote_items', 'quote_versions',
                          'customer_application_rates', 'rebate_programs')
     AND pp.cmd IN ('SELECT', 'ALL')
     AND pp.permissive = 'RESTRICTIVE';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: unexpected restrictive read policy on a scoped table: %', v_bad;
  END IF;

  -- anon must hold no table-level SELECT grant on any of the four.
  -- has_table_privilege follows privileges held via PUBLIC as well as direct
  -- grants, so this also catches a PUBLIC-granted SELECT. It does NOT see
  -- column-level grants; none exist on these tables (verified live 2026-07-27).
  SELECT string_agg(t.tbl, ', ')
    INTO v_bad
    FROM (VALUES ('quote_items'), ('quote_versions'),
                 ('customer_application_rates'), ('rebate_programs')
         ) AS t(tbl)
   WHERE has_table_privilege('anon', 'public.' || t.tbl, 'SELECT');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: anon still holds a SELECT grant on: %', v_bad;
  END IF;

  -- Positive check. Every assertion above is about who must NOT read. If the
  -- REVOKE above were ever widened, or the authenticated grant were lost to
  -- drift, all of them would still pass while admins and sales reps received
  -- "permission denied" -- a false green that takes the office offline.
  SELECT string_agg(t.tbl, ', ')
    INTO v_bad
    FROM (VALUES ('quote_items'), ('quote_versions'),
                 ('customer_application_rates'), ('rebate_programs')
         ) AS t(tbl)
   WHERE NOT has_table_privilege('authenticated', 'public.' || t.tbl, 'SELECT');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: authenticated lost its SELECT grant on: %', v_bad;
  END IF;

  -- The table grant is necessary but not sufficient. The new predicate CALLS
  -- is_admin() and is_sales_rep(); if authenticated cannot EXECUTE them, policy
  -- evaluation itself errors and the office gets "permission denied" on all four
  -- tables -- while every assertion above still passes, because every one of
  -- them is about table privileges and policy text. That is exactly the shape of
  -- false green the positive check exists to prevent, so it has to cover the
  -- functions the predicate depends on, not just the tables it protects.
  --
  -- This is not hypothetical bookkeeping: 20260720235246 deliberately REVOKEs
  -- EXECUTE on is_sales_rep() FROM PUBLIC, anon and re-grants it to authenticated
  -- and service_role. A future revoke that overshoots by one role would take the
  -- office offline, and until now nothing here would have caught it.
  SELECT string_agg(t.fn, ', ')
    INTO v_bad
    FROM (VALUES ('public.is_admin()'), ('public.is_sales_rep()')
         ) AS t(fn)
   WHERE NOT has_function_privilege('authenticated', t.fn, 'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT: authenticated cannot EXECUTE the helper(s) its own read policy calls: %', v_bad;
  END IF;

  RAISE NOTICE 'OK: quote line items/versions, per-customer rates, and rebate programs are office-only.';
END;
$verify$;

COMMIT;
