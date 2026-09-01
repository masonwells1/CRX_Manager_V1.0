-- predicate: quote-versions-rpc-owned
-- CRX-SEC-1 (found 2026-08-13 by the exact-SHA adversarial review of PR #389).
-- public.quote_versions.snapshot_data is an AUTHORITATIVE cost source: since
-- 20260812115236, restoring a version stamps quote_items.cost_at_quote_cents
-- from snapshot_data.sections[].items[].current_cost, convert_quote_to_order copies that
-- into order_items.cost_per_unit / cost_at_time_cents, and canonical profit and
-- commissions derive from there. So any client-writable path into this table is
-- a path into commission money, and the below-cost approval trigger does not
-- catch it — that trigger compares SALE PRICE to LIVE cost and understating the
-- historical cost basis only raises apparent margin.
--
-- The write boundary this predicate defends, installed by 20260813080000:
--   * no INSERT/UPDATE/DELETE/FOR ALL policy on quote_versions;
--   * no direct INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES privilege for
--     anon/authenticated — six, which is the full write-capable set minus
--     MAINTAIN, deliberately kept and explained at the migration's REVOKE.
--     (TRUNCATE matters independently — RLS policies do not apply to it at all);
--   * SELECT and qversions_select preserved, because version history must keep
--     rendering and this predicate must not pass by having broken reads;
--   * the owner-side writer _create_quote_version_owner_impl stays a
--     search_path-pinned SECURITY DEFINER owned by an RLS-bypassing role and
--     stays uncallable by anon/authenticated — it is the ONLY routine in the
--     database that INSERTs quote_versions, so it is the sole author of the
--     snapshot_data that the restore path later trusts as a cost basis.
--     (It does NOT hold crx.quote_cost_snapshot_passthrough — an earlier draft
--     said so and was wrong. That flag is armed by save_quote and by
--     _restore_quote_version_owner_impl, both in 20260812115236. Chasing the
--     passthrough from here would lead a reader to the wrong function.);
--   * the two public entry points stay authenticated-only.
--
-- SCOPE: this is a BROWSER-role boundary. service_role keeps full write access,
-- as it does on every table; "RPC-owned" means no anon/authenticated path.
--
-- Historical catch: CRX-SEC-1, 2026-08-13. No evidence of exploitation: every
-- existing snapshot cost line parsed as a number, resolved to a real product,
-- and carried a stored basis EXACTLY equal to that product's catalog cost
-- (3 version rows, 5 lines, re-measured read-only 2026-08-14). The first
-- revision of that check used a below-half band and was rejected by review
-- finding CRX-QV-001 — a basis forged at 60% of cost clears a 50% band, and a
-- percentage cannot prove provenance. Even exact, this is a check against
-- TODAY's cost, not proof no forged row was ever written and later reverted.
-- Contract: EXPECT ZERO rows. Any row means the forged-version path is open
-- again, or that it was "closed" by breaking the legitimate one.

SELECT 'quote_versions:external-mutation-policy' AS violation_key,
       'public.quote_versions must not have an INSERT/UPDATE/DELETE/FOR ALL policy; versions are created only by create_quote_version' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_policy p
    WHERE p.polrelid = 'public.quote_versions'::regclass
      AND p.polcmd IN ('a', 'w', 'd', '*')
 )

UNION ALL

SELECT 'quote_versions:browser-mutation-privilege' AS violation_key,
       'anon/authenticated must not hold direct INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, or REFERENCES on public.quote_versions' AS reason
 WHERE has_table_privilege('authenticated', 'public.quote_versions', 'INSERT')
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
    OR has_table_privilege('anon', 'public.quote_versions', 'REFERENCES')

UNION ALL

-- has_table_privilege reports only the TABLE-level ACL, so a column grant on
-- snapshot_data alone reopens the whole money path while every check above
-- still passes. Note the reason this branch exists is a LATER grant, not a
-- leftover: PostgreSQL's REVOKE reference states that revoking a privilege on
-- a table automatically revokes the corresponding column privileges on each of
-- its columns, so 20260813080000 cleared any that existed at apply time.
-- has_any_column_privilege supports INSERT/UPDATE/REFERENCES (and SELECT);
-- DELETE/TRUNCATE/TRIGGER are table-only privileges, already covered above.
SELECT 'quote_versions:column-mutation-privilege' AS violation_key,
       'anon/authenticated must not hold a COLUMN-level INSERT, UPDATE or REFERENCES on public.quote_versions — table-level checks do not see a column grant' AS reason
 WHERE has_any_column_privilege('authenticated', 'public.quote_versions', 'INSERT')
    OR has_any_column_privilege('authenticated', 'public.quote_versions', 'UPDATE')
    OR has_any_column_privilege('authenticated', 'public.quote_versions', 'REFERENCES')
    OR has_any_column_privilege('anon', 'public.quote_versions', 'INSERT')
    OR has_any_column_privilege('anon', 'public.quote_versions', 'UPDATE')
    OR has_any_column_privilege('anon', 'public.quote_versions', 'REFERENCES')

UNION ALL

SELECT 'quote_versions:read-path-regressed' AS violation_key,
       'authenticated lost SELECT or qversions_select was removed — the write boundary must not be satisfied by breaking version history' AS reason
 WHERE NOT has_table_privilege('authenticated', 'public.quote_versions', 'SELECT')
    OR NOT EXISTS (
      SELECT 1
        FROM pg_policy p
       WHERE p.polrelid = 'public.quote_versions'::regclass
         AND p.polname = 'qversions_select'
         AND p.polcmd = 'r'
    )

UNION ALL

SELECT 'quote_versions:rls-disabled' AS violation_key,
       'row level security must remain enabled on public.quote_versions' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_class c
    WHERE c.oid = 'public.quote_versions'::regclass
      AND c.relrowsecurity
 )

UNION ALL

-- 20260813080000 asserted FORCE ROW LEVEL SECURITY was OFF when it applied, and
-- this branch holds that state steady. Be precise about WHY, because the obvious
-- reading is wrong and an earlier draft of this comment stated it: turning FORCE
-- on does NOT break the owner-side writer. FORCE removes only the table owner's
-- implicit exemption; the definer owner here carries the rolbypassrls ROLE
-- ATTRIBUTE, which bypasses policies with or without FORCE. Version creation
-- would keep working.
-- The branch earns its place as a drift tripwire instead: FORCE appearing here
-- means somebody deliberately reshaped this table's security model after the
-- boundary was reasoned about, and every other branch in this predicate was
-- written against the un-forced table. Investigate the reshape; do not go
-- looking for a production outage that is not happening.
SELECT 'quote_versions:force-rls-enabled' AS violation_key,
       'FORCE ROW LEVEL SECURITY was turned on for public.quote_versions after 20260813080000 sealed the write boundary. This is NOT breaking version creation (the definer owner bypasses policies via rolbypassrls regardless) — it means this table''s security model was deliberately reshaped, and the rest of this predicate was written against the un-forced table. Find out who changed it and re-review the boundary.' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_class c
    WHERE c.oid = 'public.quote_versions'::regclass
      AND c.relforcerowsecurity
 )

UNION ALL

SELECT '_create_quote_version_owner_impl(uuid, uuid, text, text)' AS violation_key,
       'the owner-side version writer must remain exactly one search_path-pinned SECURITY DEFINER owned by an RLS-bypassing role, at the pinned signature' AS reason
 WHERE (
   SELECT count(*)
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = '_create_quote_version_owner_impl'
 ) <> 1
    -- Counting by proname alone is not enough. Adding an argument (say
    -- p_below_cost_reason) keeps the count at 1 while moving the routine to a
    -- signature none of the EXECUTE branches below name — and the new signature
    -- inherits the database's default EXECUTE grant to anon/authenticated. Pin
    -- the signature here so a re-signature reports as drift rather than sliding
    -- through every branch in this file.
    OR to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)') IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = '_create_quote_version_owner_impl'
         AND p.prosecdef
         AND r.rolbypassrls
         AND EXISTS (
           SELECT 1
             FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
            WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
         )
    )

UNION ALL

-- rolbypassrls bypasses POLICIES, not GRANTS. Dropping qversions_insert removed
-- the policy the owner never needed; a future blanket "revoke writes on
-- quote_versions" that catches the owner role too would silently remove the LAST
-- write path, with every other branch here still returning zero rows.
SELECT '_create_quote_version_owner_impl:lost-insert-grant' AS violation_key,
       'the role that owns the version writer must still hold INSERT on public.quote_versions — bypassing RLS does not grant privileges' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = '_create_quote_version_owner_impl'
      AND NOT has_table_privilege(r.rolname, 'public.quote_versions', 'INSERT')
 )

UNION ALL

-- Every EXECUTE branch below resolves its routine with to_regprocedure FIRST.
-- has_function_privilege() raises undefined_function on a dropped or renamed
-- routine, and run-sweeps.mjs would then report this whole predicate as ERROR —
-- which does fail the sweep (it is not fail-open), but it replaces a named,
-- actionable violation_key with an opaque Postgres error and hides every other
-- branch in the same run. (Stated without a number on purpose: an earlier
-- revision said "the ten other branches" and the count was stale within two
-- rounds of edits.) Resolve first, then decide, so a drop reports as
-- drift instead of as a crash. Note SQL has no short-circuit guarantee, so this
-- has to be a CASE, not an `AND` in front of the call.
--
-- Role existence is deliberately NOT guarded the same way: `anon` and
-- `authenticated` disappearing from a Supabase project is not a drift this
-- predicate could usefully survive, and the sweep already fails loudly if it
-- happens.
--
-- Every one of these branches resolves to `true` when the routine is missing.
-- An earlier version returned `false` here on the theory that the
-- exactly-one-writer branch above already reports absence — that was wrong, and
-- it was the one fail-OPEN hole in this file: a re-signature kept that branch's
-- count at 1 while nulling the lookup here, so the sweep reported clean on a
-- routine that had just inherited a default EXECUTE grant. Unresolvable means
-- unverifiable; unverifiable reports as drift. Duplicate noise on a genuine drop
-- is the correct trade against a silent pass.
SELECT '_create_quote_version_owner_impl:external-execute' AS violation_key,
       'anon/authenticated must not hold EXECUTE on the owner-side version writer — it is the sole author of the snapshot_data the restore path trusts as a cost basis' AS reason
 WHERE CASE
         WHEN to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)') IS NULL
           THEN true
         ELSE has_function_privilege(
                'authenticated', 'public._create_quote_version_owner_impl(uuid,uuid,text,text)', 'EXECUTE')
           OR has_function_privilege(
                'anon', 'public._create_quote_version_owner_impl(uuid,uuid,text,text)', 'EXECUTE')
       END

UNION ALL

-- The two entry points get the same exactly-one-overload pin the owner-side
-- writer got above, and for a sharper reason. 20260813080000 asserts this at
-- apply time (PRECOND, both names) because its REVOKEs each name ONE signature.
-- After the apply nothing re-checked it, and a NEW overload of either name is
-- not a hypothetical drift: a freshly created function is born with EXECUTE to
-- PUBLIC, and this project's pg_default_acl grants the API roles on top of
-- that. So `create_quote_version(uuid, uuid, text, text, bigint, text)` added
-- next month is browser-callable the moment it exists, while the signature-
-- pinned branch below still reports clean on the old one. That is the B9 shape
-- this repo has already been bitten by once.
--
-- BEFORE DELETING THIS OR ANY OTHER EXACTLY-ONE-OVERLOAD BRANCH IN THIS FILE AS
-- REDUNDANT — the global `overloads.sql` predicate in this same sweep does flag
-- any public function name carrying more than one signature, so at a glance they
-- look like duplicates. They are not, in two ways. First, these test `<> 1`, so
-- they also fire when the count is ZERO;
-- overloads.sql tests `> 1` and stays silent on a routine that has been dropped
-- or renamed out from under this boundary, which is the drift that actually
-- breaks it. Second, a hit here arrives with a violation_key naming this
-- boundary and a reason explaining what it costs, instead of a bare function
-- name a reader then has to trace back. Cheap duplication, deliberately kept.
SELECT 'create_quote_version:overload-count' AS violation_key,
       'public.create_quote_version must have exactly one overload — a new signature is born EXECUTE-able by the API roles and is not covered by the signature-pinned branches here' AS reason
 WHERE (
   SELECT count(*)
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'create_quote_version'
 ) <> 1

UNION ALL

SELECT 'create_quote_version(uuid, uuid, text, text, bigint)' AS violation_key,
       'create_quote_version must exist and stay authenticated-callable and never anon-callable — it is the only remaining way to create a version' AS reason
 WHERE CASE
         WHEN to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL
           -- A dropped entry point IS the violation: with direct writes revoked,
           -- losing this signature means version creation is simply gone.
           THEN true
         ELSE NOT has_function_privilege(
                'authenticated', 'public.create_quote_version(uuid,uuid,text,text,bigint)', 'EXECUTE')
           OR has_function_privilege(
                'anon', 'public.create_quote_version(uuid,uuid,text,text,bigint)', 'EXECUTE')
       END

UNION ALL

SELECT 'restore_quote_version:overload-count' AS violation_key,
       'public.restore_quote_version must have exactly one overload — same reasoning as the create_quote_version count above' AS reason
 WHERE (
   SELECT count(*)
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'restore_quote_version'
 ) <> 1

UNION ALL

SELECT 'restore_quote_version(uuid, uuid, uuid, text, bigint, text)' AS violation_key,
       'restore_quote_version must exist and stay authenticated-callable and never anon-callable' AS reason
 WHERE CASE
         WHEN to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NULL
           THEN true
         ELSE NOT has_function_privilege(
                'authenticated', 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE')
           OR has_function_privilege(
                'anon', 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE')
       END

UNION ALL

-- The owner-side restore implementation gets the same exactly-one-overload pin
-- the two entry points and the owner-side WRITER got, for the identical reason
-- and closing the identical gap: the branch that follows names ONE signature,
-- so a second overload of this name is unwatched by it. On this project a newly
-- created function is born EXECUTE-able by the API roles, so that second
-- overload is browser-callable from the moment it exists — and this is the
-- routine that stamps a stored snapshot back onto a quote as its cost basis.
-- Without this count, the signature-pinned branch below would keep reporting
-- clean while the cost-basis hole this whole file exists to close was reopened
-- one signature over.
SELECT '_restore_quote_version_owner_impl:overload-count' AS violation_key,
       'public._restore_quote_version_owner_impl must have exactly one overload — a new signature is born EXECUTE-able by the API roles and is not covered by the signature-pinned branch below' AS reason
 WHERE (
   SELECT count(*)
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = '_restore_quote_version_owner_impl'
 ) <> 1

UNION ALL

-- The restore path has an owner-side implementation too, and nothing anywhere
-- pinned its EXECUTE. It is the routine that READS a snapshot back onto the
-- quote as a cost basis, so a browser role calling it directly skips
-- restore_quote_version's gating entirely — the write half of this boundary is
-- guarded above, and this is the read-back half.
--
-- Checked before adding, and stated precisely because an earlier revision
-- claimed more than it had checked. Two other predicates come near this routine
-- and neither one catches it:
--
--   anon-exec-secdef — tests the `anon` role only. `authenticated`, the role an
--     ordinary logged-in browser session actually carries, is outside it
--     entirely, and this routine appears in no allowlist entry.
--
--   ungated-secdef-mutators — looks for SECURITY DEFINER routines that mutate
--     without an authorization reference, and excludes any body matching
--     `auth\.uid` (alongside require_admin / is_admin / is_sales_rep). This
--     routine's body references auth.uid, so it is excluded there by
--     construction. That exclusion is right for what that predicate is for —
--     it hunts for MISSING authorization logic — but "the body mentions
--     auth.uid" says nothing about who holds EXECUTE, which is what this branch
--     tests.
--
-- So: not unwatched by every predicate in the sweep, but unwatched on the
-- privilege question by both of the ones that look at it.
SELECT '_restore_quote_version_owner_impl:external-execute' AS violation_key,
       'anon/authenticated must not hold EXECUTE on the owner-side restore implementation — calling it directly stamps a stored snapshot back onto a quote as its cost basis, bypassing restore_quote_version entirely' AS reason
 WHERE CASE
         WHEN to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)') IS NULL
           -- Unresolvable means unverifiable; unverifiable reports as drift.
           -- Same trade as the create-side branch above.
           THEN true
         ELSE has_function_privilege(
                'authenticated', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE')
           OR has_function_privilege(
                'anon', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE')
       END

UNION ALL

-- The below-cost implementation gets the exactly-one-overload pin for the same
-- reason the four routines above it got one, and it is the last routine in this
-- chain that was still missing it. The branch that follows names ONE signature
-- — `(uuid, uuid, uuid, text, bigint)` — so a SECOND overload of this name is
-- invisible to it. On this project a newly created function is born
-- EXECUTE-able by the API roles, so that second overload would be callable from
-- a browser session the moment it existed, and it would sit BELOW the
-- below-cost approval gate exactly as the pinned one does. Without this count
-- the whole sweep would keep reporting clean while the deepest layer of the
-- boundary was reopened one signature over. That is the B9 shape verbatim.
SELECT '_restore_quote_version_below_cost_impl_20260810:overload-count' AS violation_key,
       'public._restore_quote_version_below_cost_impl_20260810 must have exactly one overload — a new signature is born EXECUTE-able by the API roles, sits below the below-cost approval gate, and is not covered by the signature-pinned branch below' AS reason
 WHERE (
   SELECT count(*)
     FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = '_restore_quote_version_below_cost_impl_20260810'
 ) <> 1

UNION ALL

-- One layer FURTHER IN than the branch above, and the reason it earns its own
-- pin rather than being folded into it. 20260812115237 renamed the pre-existing
-- restore_quote_version out of the way to
-- `_restore_quote_version_below_cost_impl_20260810(uuid, uuid, uuid, text,
-- bigint)` and rebuilt the public entry point as a thin wrapper that calls
-- `_begin_below_cost_money_write` FIRST and then delegates to it. So the
-- below-cost approval gate lives in the wrapper, not in the implementation:
-- anything that can call the implementation directly performs a restore with
-- the approval check skipped entirely. That migration revokes it from PUBLIC,
-- anon, authenticated and service_role and grants only postgres — this branch
-- makes that standing instead of one-shot.
SELECT '_restore_quote_version_below_cost_impl_20260810:external-execute' AS violation_key,
       'anon/authenticated must not hold EXECUTE on the renamed below-cost restore implementation — it is the layer BELOW the approval gate, so calling it directly restores a stored cost basis without the below-cost check the public wrapper performs' AS reason
 WHERE CASE
         WHEN to_regprocedure('public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)') IS NULL
           -- Unresolvable means unverifiable; unverifiable reports as drift.
           -- Same trade as the two branches above. A rename or a signature
           -- change here also means the wrapper above it no longer resolves,
           -- which is worth a look regardless of privileges.
           THEN true
         ELSE has_function_privilege(
                'authenticated', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE')
           OR has_function_privilege(
                'anon', 'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE')
       END

UNION ALL

-- The six branches below mirror assertions that 20260813080000 makes exactly
-- ONCE, at apply time. Everything above this line describes the table and its
-- five named routines; nothing above notices a NEW writer or a NEW rewrite path
-- appearing afterwards, which is precisely how this boundary would be reopened
-- without touching anything the earlier branches watch. A one-shot POSTCOND is
-- not a guard, it is a receipt; these make the same claims standing.

SELECT 'quote_versions:rewrite-path-writable' AS violation_key,
       'a relation carrying a rewrite rule over public.quote_versions (a view, or a rule on an ordinary table) is writable by anon/authenticated — a rewritten write is permission-checked as the OWNER of the rewriting relation, so the table-level revoke does not cover it' AS reason
-- RECURSIVE, matching the postcondition in 20260813080000 rather than the
-- single hop this branch originally used. One hop finds only relations that
-- rewrite DIRECTLY onto quote_versions. A view B defined over view A over
-- quote_versions carries its dependency on A, not on the table, so a one-hop
-- scan skips B entirely — while B can still be auto-updatable, and a write
-- through it is permission-checked as B's owner. That is this branch's own hole,
-- one level further out. UNION (not UNION ALL) deduplicates against everything
-- already produced, so the walk terminates even if a pair of rules on ordinary
-- tables points at each other.
--
-- No relkind filter, deliberately: a RULE on an ordinary table reaches this
-- table exactly as a view does. Column-granular for the same reason the
-- base-table branch above is.
--
-- TRIGGER and TRUNCATE are omitted on purpose, matching 20260813080000's copy of
-- this branch — change them together or the two will disagree. TRUNCATE is not
-- rewritten by rules and cannot be aimed at a view, so it has no route here.
-- TRIGGER is the false-positive trap: this project's default privileges grant it
-- to authenticated on every new relation in schema public, so testing it would
-- fire on relations that cannot write anything, and it is not a write path on
-- its own.
--
-- EXPECT THIS BRANCH TO FIRE THE DAY SOMEBODY ADDS A REPORTING VIEW over
-- quote_versions, even a strictly read-only one, and do not read that as a false
-- alarm. Under this project's default privileges a newly created relation in
-- schema public is born with the full authenticated=arwdDxtm grant, so a view
-- intended for reading arrives holding INSERT and UPDATE, and an auto-updatable
-- one is then genuinely writable — permission-checked as the view's owner, which
-- is exactly the hole this branch watches. The fix is to revoke the write
-- privileges on the new view, not to carve it out of this predicate.
 WHERE EXISTS (
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
 )

UNION ALL

-- KNOWN LIMIT of the two writer branches below, stated where it is checked: both
-- read prosrc, which is BLANK for a BEGIN ATOMIC routine rather than NULL. A
-- writer with such a body is invisible to them and would scan clean. This branch
-- is what keeps that failure closed instead of open.
SELECT 'quote_versions:writer-scan-blinded' AS violation_key,
       'a routine with a BEGIN ATOMIC body exists, so the two prosrc-based writer scans below cannot see every writer of public.quote_versions — re-review those routines by hand' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND p.prosqlbody IS NOT NULL
 )

UNION ALL

-- Scope, anchoring and the schema-qualified carve-out are all copied verbatim
-- from 20260813080000's PRECOND scans, and must stay that way: an unanchored
-- LIKE matches `updated_at`, and a bare proname carve-out excuses a same-named
-- impostor parked in another schema.
SELECT 'quote_versions:non-bypassing-writer' AS violation_key,
       'another routine writes public.quote_versions without bypassing RLS — with the mutation policies dropped it is either already broken, or it is reaching the table by a path this boundary did not account for' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND NOT (p.prosecdef AND r.rolbypassrls)
      AND NOT (n.nspname = 'public' AND p.proname = '_create_quote_version_owner_impl')
      AND p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
 )

UNION ALL

SELECT 'quote_versions:second-authoritative-writer' AS violation_key,
       'an unpinned RLS-bypassing routine writes public.quote_versions — snapshot_data is an authoritative cost basis; the only allowed second writer is the exact create_quote_version trust-marker update guarded immediately above' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND p.prosecdef
      AND r.rolbypassrls
      AND NOT (n.nspname = 'public' AND p.proname = '_create_quote_version_owner_impl')
      -- 20260826220000 adds a deliberately narrow second writer: after the
      -- owner-only implementation has constructed a fresh snapshot, the public
      -- create wrapper can set only that row's null trust marker. Do not exempt
      -- by name: any signature, definer, owner, search_path, browser-grant, or
      -- body drift makes it an authoritative writer again and reports here.
      AND NOT (
        p.oid = to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)')
        AND EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
          WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
        )
        AND CASE
          WHEN to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL THEN true
          ELSE NOT has_function_privilege('anon', to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)'), 'EXECUTE')
        END
        AND CASE
          WHEN to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL THEN true
          ELSE has_function_privilege('authenticated', to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)'), 'EXECUTE')
        END
        AND p.prosrc LIKE '%_create_quote_version_owner_impl%'
        -- CodeRabbit 2026-08-25 (P2): the checks around this one prove the
        -- marker UPDATE EXISTS with the reviewed spelling and that it is the
        -- only quote_versions write, but NOT that it runs AFTER the owner-side
        -- writer. A later re-emission could select an arbitrary legacy row into
        -- v_version_id, run this exact UPDATE before calling the owner
        -- implementation, and still leave this sweep green while blessing an
        -- untrusted snapshot. Pin the ordering positionally, the same way the
        -- restore-side contract further down already does: the owner impl must
        -- be called first, v_version_id must be derived from THAT call's
        -- result, and only then may the marker be set.
        AND strpos(lower(p.prosrc), 'v_result := public._create_quote_version_owner_impl') > 0
        AND strpos(lower(p.prosrc), 'v_version_id := nullif(v_result->>''version_id'', '''')::uuid') > 0
        AND strpos(lower(p.prosrc), 'update public.quote_versions') > 0
        AND strpos(lower(p.prosrc), 'v_result := public._create_quote_version_owner_impl')
            < strpos(lower(p.prosrc), 'v_version_id := nullif(v_result->>''version_id'', '''')::uuid')
        AND strpos(lower(p.prosrc), 'v_version_id := nullif(v_result->>''version_id'', '''')::uuid')
            < strpos(lower(p.prosrc), 'update public.quote_versions')
        -- CodeRabbit round 3 (2026-08-25) found two REAL gaps the positional
        -- checks above still left open. Both are closed here rather than
        -- accepted. NOTE the four-argument regexp_count form: the third
        -- parameter is a START POSITION, not flags. Every call in this file
        -- originally passed 'i' as the third argument, which raises
        -- `invalid input syntax for type integer: "i"` at runtime — the sweep
        -- would have CRASHED rather than reported. Verified against live
        -- PostgreSQL 17.6 on 2026-08-25 and corrected throughout.
        --
        -- Gap 1 (Major): the strpos ordering proves only that ONE matching owner
        -- call appears before the marker. It does not require exactly one. A
        -- re-emitted wrapper could mark the first snapshot, create a SECOND
        -- unmarked snapshot, and return that second version_id while this sweep
        -- stayed green.
        AND regexp_count(p.prosrc, '_create_quote_version_owner_impl\s*\(', 1, 'i') = 1
        --
        -- Gap 2 (P2) — REOPENED TWICE. Round 3 counted `v_version_id :=` and
        -- `v_result :=` inside the region; round 4 walked past that with
        -- `SELECT ... INTO`, so the count became a closed allowlist pinned to
        -- the exact reviewed text. Round 5 then showed the allowlist itself was
        -- anchored in the wrong place: it began at the `v_version_id`
        -- assignment, leaving the interval BETWEEN the owner impl returning and
        -- that assignment completely unchecked. A re-emission could put
        --
        --   v_result := jsonb_build_object('status','created','version_id', <legacy id>);
        --
        -- in that gap. The sole-owner-call check, the ordering check, the
        -- region fingerprint and the exact marker-UPDATE check ALL still
        -- passed, and the wrapper stamped an arbitrary legacy row as trusted.
        -- Verified against live PostgreSQL 17.6 on 2026-08-26: that body passed
        -- the round-4 guard.
        --
        -- The region now starts at the owner call itself, so there is no
        -- unguarded interval left between the writer and the marker. This also
        -- pins the owner call's ARGUMENTS, which nothing checked before — a
        -- re-emission passing NULL for p_idempotency_key is now rejected too.
        --
        -- Lesson worth keeping: a closed allowlist only closes what is INSIDE
        -- it. Choosing its boundaries is the whole security argument, and
        -- "nothing unexpected can appear here" is worth nothing if the
        -- interesting statement sits just outside. Collapse whitespace BEFORE
        -- btrim — the reverse order leaves a trailing space and the real body
        -- fails its own guard.
        AND btrim(
              regexp_replace(
                substring(
                  lower(p.prosrc)
                  FROM strpos(lower(p.prosrc), 'v_result := public._create_quote_version_owner_impl')
                  FOR  strpos(lower(p.prosrc), 'update public.quote_versions')
                       - strpos(lower(p.prosrc), 'v_result := public._create_quote_version_owner_impl')
                ),
                '\s+', ' ', 'g'
              )
            ) = 'v_result := public._create_quote_version_owner_impl'
             || '( p_quote_id, p_performed_by, p_method, p_idempotency_key ); '
             || 'v_version_id := nullif(v_result->>''version_id'', '''')::uuid; '
             || 'if v_result->>''status'' is distinct from ''created'' or v_version_id is null then '
             || 'raise exception ''quote_version_trust_mark_failed''; end if;'
        AND regexp_count(
          p.prosrc,
          'update\s+public\.quote_versions\s+set\s+restore_trusted_at\s*=\s*clock_timestamp\(\)\s+where\s+id\s*=\s*v_version_id\s+and\s+quote_id\s*=\s*p_quote_id\s+and\s+restore_trusted_at\s+is\s+null\s*;',
            1, 'i'
        ) = 1
        AND regexp_count(
          p.prosrc,
          '\mupdate\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M',
            1, 'i'
        ) = 1
        AND p.prosrc !~* '(insert\s+into|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
        -- Codex round 8 (2026-08-26): everything after the marker UPDATE was
        -- unpinned, so an appended EXCEPTION handler slid past this exemption.
        -- Pin the ENTIRE normalized body, same as the named contract below —
        -- the two must not drift apart, or a weakened contract branch would
        -- leave this exemption silently blessing the drifted body.
        AND length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 3972
        AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '3723acbbf1821e9d5d212c3aea983f86'
      )
      AND p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
 )

UNION ALL

-- The exception above is intentionally checked as its own named contract too.
-- It may UPDATE only the freshly returned owner-written row, only from NULL to
-- clock_timestamp(), and only through the existing authenticated public
-- wrapper. If this exact shape drifts, the writer scan must stop exempting it
-- before a broadened marker update can bless arbitrary legacy snapshots.
SELECT 'create_quote_version:trusted-marker-writer-contract' AS violation_key,
       'create_quote_version may be the sole additional RLS-bypassing quote_versions writer only as the pinned SECURITY DEFINER, authenticated-only, search_path-pinned marker update after _create_quote_version_owner_impl' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)')
      AND p.prosecdef
      AND r.rolbypassrls
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
        WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
      )
       AND CASE
         WHEN to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL THEN true
         ELSE NOT has_function_privilege('anon', to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)'), 'EXECUTE')
       END
       AND CASE
         WHEN to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL THEN true
         ELSE has_function_privilege('authenticated', to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)'), 'EXECUTE')
       END
      AND p.prosrc LIKE '%_create_quote_version_owner_impl%'
      AND regexp_count(
        p.prosrc,
        'update\s+public\.quote_versions\s+set\s+restore_trusted_at\s*=\s*clock_timestamp\(\)\s+where\s+id\s*=\s*v_version_id\s+and\s+quote_id\s*=\s*p_quote_id\s+and\s+restore_trusted_at\s+is\s+null\s*;',
          1, 'i'
      ) = 1
      AND regexp_count(
        p.prosrc,
        '\mupdate\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M',
          1, 'i'
      ) = 1
      AND p.prosrc !~* '(insert\s+into|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
      -- Codex round 8 (2026-08-26): the pinned region above runs from the owner
      -- call to the marker UPDATE, so text after the UPDATE was open — an
      -- appended EXCEPTION handler could catch quote_version_trust_mark_failed
      -- and report success for a version that was never marked. Fail-closed on
      -- the trust side (the row stays untrusted), but a silent contract break.
      -- Same fix as the restore side: pin the ENTIRE normalized body.
      AND length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 3972
      AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '3723acbbf1821e9d5d212c3aea983f86'
 )

UNION ALL

-- Restoring is the point where a trusted snapshot becomes authoritative money
-- again. Pin both the marker read and the rejection before the owner-side
-- restore call, so re-emitting this private implementation cannot silently
-- remove or move the trust check while preserving its signature and grants.
SELECT '_restore_quote_version_below_cost_impl_20260810:trust-check-contract' AS violation_key,
       'the private restore implementation must read restore_trusted_at for the requested quote/version, reject NULL with QUOTE_VERSION_LEGACY_UNTRUSTED, and do so before its sole owner-side restore call' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = to_regprocedure('public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)')
      AND p.prosecdef
      AND r.rolbypassrls
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
        WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
      )
      AND regexp_count(
        p.prosrc,
        'select\s+restore_trusted_at\s+into\s+v_restore_trusted_at\s+from\s+public\.quote_versions\s+where\s+id\s*=\s*p_version_id\s+and\s+quote_id\s*=\s*p_quote_id\s+for\s+key\s+share\s*;',
          1, 'i'
      ) = 1
      AND regexp_count(
        p.prosrc,
        'if\s+v_restore_trusted_at\s+is\s+null\s+then\s+raise\s+exception\s+''QUOTE_VERSION_LEGACY_UNTRUSTED''\s*;\s+end\s+if\s*;',
          1, 'i'
      ) = 1
      AND regexp_count(p.prosrc, '_restore_quote_version_owner_impl\s*\(', 1, 'i') = 1
      AND strpos(lower(p.prosrc), 'raise exception ''quote_version_legacy_untrusted''')
          < strpos(lower(p.prosrc), 'v_result := public._restore_quote_version_owner_impl')
      -- The owner call is not the only possible write shape. Keep the entire
      -- prefix before the rejection read-only. The normalized length + digest
      -- deliberately fingerprints the entire reviewed prefix instead of trying
      -- to tokenize every legal PL/pgSQL identifier spelling. Any statement,
      -- helper call, quoted identifier, dollar identifier, or reordered guard
      -- changes the fingerprint and fails the standing gate closed.
      AND substring(
            p.prosrc FROM 1 FOR greatest(
              strpos(lower(p.prosrc), 'raise exception ''quote_version_legacy_untrusted''') - 1,
              0
            )
          ) !~* '(insert\s+into|update\s+(only\s+)?[a-z_\"]|delete\s+from|merge\s+into|truncate\s+(table\s+)?[a-z_\"]|execute\s+|perform\s+|call\s+)'
      AND length(
            btrim(regexp_replace(
              substring(
                p.prosrc FROM 1 FOR greatest(
                  strpos(lower(p.prosrc), 'raise exception ''quote_version_legacy_untrusted''') - 1,
                  0
                )
              ),
              '\s+',
              ' ',
              'g'
            ))
          ) = 2730
      AND md5(
            btrim(regexp_replace(
              substring(
                p.prosrc FROM 1 FOR greatest(
                  strpos(lower(p.prosrc), 'raise exception ''quote_version_legacy_untrusted''') - 1,
                  0
                )
              ),
              '\s+',
              ' ',
              'g'
            ))
          ) = '62440ea5c855d1366808c5a2098177d7'
      -- Codex round 8 (2026-08-26): the prefix pin above ends at the rejection,
      -- so everything AFTER it was open. A re-emission could keep the prefix
      -- byte-identical, move the sole owner call into an appended EXCEPTION
      -- handler, and deliberately raise into that handler — catching
      -- QUOTE_VERSION_LEGACY_UNTRUSTED restores legacy snapshots while the
      -- prefix pin, the exact-IF count, the sole-owner-call count and the
      -- ordering check all still pass. Same boundary-choice lesson as round 5:
      -- the region must leave NO unpinned interval, on either side. So pin the
      -- ENTIRE normalized body. This subsumes the prefix pin logically; the
      -- prefix pin stays for diagnostic granularity when only the tail drifts.
      AND length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 3720
      AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 'b864c261854b760ff22f1f24e87ae22f'
 )

UNION ALL

-- Codex round 9/10 (2026-08-26): the two branches above pin the WRAPPER bodies,
-- but the chain they guard runs deeper. Three more routines' results are
-- trusted without their bodies being pinned anywhere:
--   * _create_quote_version_owner_impl — a re-emission keeping its signature,
--     owner, search_path and grants could return
--     {'status':'created','version_id':<legacy id>} and the pinned wrapper
--     would stamp that legacy row trusted, every check green;
--   * _restore_quote_version_owner_impl — a re-emission could restore a
--     DIFFERENT (unmarked) version than the one whose marker was checked;
--   * restore_quote_version (public) — a re-emission could route around the
--     below-cost impl (whose name merely appearing in prosrc proved nothing)
--     and reach the owner impl with the trust check skipped.
-- So pin all three normalized bodies, measured read-only from live on
-- 2026-08-26. This closes the SET deliberately: these five routines (two
-- wrappers above, three here) are exactly the chain whose results become an
-- authoritative cost source; helpers they call (check_idempotency, auth.uid)
-- affect replay/identity, not what gets trusted as money. Any legitimate
-- re-emission of one of the five must update its pin here in the same change.
SELECT 'restore_quote_version:route-pinned' AS violation_key,
       'the public restore wrapper body drifted from the reviewed below-cost route — expected 311/97da0cdfa0f90ff87b5e48d9aedf9f33, measured '
         || coalesce((SELECT length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))::text || '/' || md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
                        FROM pg_proc p
                       WHERE p.oid = to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)')), 'signature unresolvable')
         || ' — an intentionally reviewed re-emission must update this pin, the 20260826220000 migration pins, and quoteVersionWriteBoundary.test.ts in the same change' AS reason
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)')
     AND length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 311
     AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '97da0cdfa0f90ff87b5e48d9aedf9f33'
 )

UNION ALL

SELECT '_create_quote_version_owner_impl:body-pinned' AS violation_key,
       'the owner-side snapshot writer body drifted from the reviewed text — the create wrapper trusts its returned version_id enough to stamp it restore_trusted_at; expected 3362/4ecb8accbaf6be4fb64aadbc79e492e3, measured '
         || coalesce((SELECT length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))::text || '/' || md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
                        FROM pg_proc p
                       WHERE p.oid = to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)')), 'signature unresolvable')
         || ' — an intentionally reviewed re-emission must update this pin, the 20260826220000 migration pins, and quoteVersionWriteBoundary.test.ts in the same change' AS reason
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)')
     AND length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 3362
     AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '4ecb8accbaf6be4fb64aadbc79e492e3'
 )

UNION ALL

SELECT '_restore_quote_version_owner_impl:body-pinned' AS violation_key,
       'the owner-side restore writer body drifted from the reviewed text — the trust check runs in its caller, so this body must keep restoring exactly the version whose marker was checked; expected 13566/6972f2d6b76b2d8872b0a027e7f9ee93, measured '
         || coalesce((SELECT length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))::text || '/' || md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
                        FROM pg_proc p
                       WHERE p.oid = to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)')), 'signature unresolvable')
         || ' — an intentionally reviewed re-emission must update this pin, the 20260826220000 migration pins, and quoteVersionWriteBoundary.test.ts in the same change' AS reason
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)')
     AND length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 13566
     AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '6972f2d6b76b2d8872b0a027e7f9ee93'
 )

UNION ALL

-- Inheritance, BOTH directions — the migration asserts both, once.
--
-- As a CHILD: quote_versions inheriting from another table means a write aimed
-- at the parent lands here, permission-checked against the parent.
--
-- As a PARENT: a child of quote_versions is a brand-new table in schema public,
-- and under this project's pg_default_acl every new table there is BORN
-- writable by authenticated. A direct INSERT into that child produces a row
-- that reads back through quote_versions — the forged cost basis this whole
-- boundary exists to prevent — with every other branch in this file still
-- returning zero rows. Live has neither today; this keeps that measured.
SELECT 'quote_versions:inheritance-path' AS violation_key,
       'public.quote_versions is now part of an inheritance or partition hierarchy — a parent lets writes reach it under the parent''s permissions, and a child in schema public is born browser-writable and reads back through this table' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_inherits i
    WHERE i.inhrelid = 'public.quote_versions'::regclass
       OR i.inhparent = 'public.quote_versions'::regclass
 )

UNION ALL

-- The migration's SCOPE claim is that this is a BROWSER-role boundary and the
-- service key keeps full write access. Asserted once at apply time; standing
-- here because the way it breaks is silent. A later blanket REVOKE that catches
-- service_role — or a role that ends up holding its privilege through PUBLIC —
-- surfaces weeks afterwards as a bare permission-denied inside an edge function
-- or a backfill, with no migration anywhere in the blame path.
SELECT 'quote_versions:service-role-write-lost' AS violation_key,
       'service_role no longer holds INSERT, UPDATE and DELETE on public.quote_versions — this boundary is scoped to the browser roles and must never cost the service key its writes; edge functions and backfills that write version rows are now broken' AS reason
 WHERE NOT has_table_privilege('service_role', 'public.quote_versions', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.quote_versions', 'UPDATE')
    OR NOT has_table_privilege('service_role', 'public.quote_versions', 'DELETE');
