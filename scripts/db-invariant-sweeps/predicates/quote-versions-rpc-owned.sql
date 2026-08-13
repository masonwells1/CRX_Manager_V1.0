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
--   * no direct INSERT/UPDATE/DELETE/TRUNCATE privilege for anon/authenticated
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
-- Historical catch: CRX-SEC-1, 2026-08-13. No evidence of exploitation: at
-- discovery every existing snapshot cost line parsed as a number and none sat
-- below half the product's current catalog cost. That is a check against
-- TODAY's cost, not proof no forged row was ever written.
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

-- REVOKE ... ON TABLE removes table-level ACLs only, and has_table_privilege
-- reports only table-level. A column grant on snapshot_data alone reopens the
-- whole money path while every check above still passes. has_any_column_privilege
-- supports INSERT/UPDATE/REFERENCES (and SELECT); DELETE/TRUNCATE/TRIGGER are
-- table-only privileges and are already covered above.
SELECT 'quote_versions:column-mutation-privilege' AS violation_key,
       'anon/authenticated must not hold a COLUMN-level INSERT, UPDATE or REFERENCES on public.quote_versions — a column grant survives REVOKE ... ON TABLE' AS reason
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
-- actionable violation_key with an opaque Postgres error and hides the ten other
-- branches in the same run. Resolve first, then decide, so a drop reports as
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

-- The four branches below mirror assertions that 20260813080000 makes exactly
-- ONCE, at apply time. Everything above this line describes the table and its
-- three named routines; nothing above notices a NEW writer or a NEW rewrite path
-- appearing afterwards, which is precisely how this boundary would be reopened
-- without touching anything the earlier branches watch. A one-shot POSTCOND is
-- not a guard, it is a receipt; these make the same claims standing.

SELECT 'quote_versions:rewrite-path-writable' AS violation_key,
       'a relation carrying a rewrite rule over public.quote_versions (a view, or a rule on an ordinary table) is writable by anon/authenticated — a rewritten write is permission-checked as the OWNER of the rewriting relation, so the table-level revoke does not cover it' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_depend d
     JOIN pg_rewrite w ON w.oid = d.objid
     JOIN pg_class v ON v.oid = w.ev_class
    WHERE d.refclassid = 'pg_class'::regclass
      AND d.refobjid = 'public.quote_versions'::regclass
      AND d.classid = 'pg_rewrite'::regclass
      -- No relkind filter, deliberately: a RULE on an ordinary table reaches
      -- this table exactly as a view does. Column-granular for the same reason
      -- the base-table branch above is.
      AND v.oid <> 'public.quote_versions'::regclass
      AND (has_any_column_privilege('authenticated', v.oid, 'INSERT')
        OR has_any_column_privilege('authenticated', v.oid, 'UPDATE')
        OR has_any_column_privilege('authenticated', v.oid, 'REFERENCES')
        OR has_table_privilege('authenticated', v.oid, 'DELETE')
        OR has_any_column_privilege('anon', v.oid, 'INSERT')
        OR has_any_column_privilege('anon', v.oid, 'UPDATE')
        OR has_any_column_privilege('anon', v.oid, 'REFERENCES')
        OR has_table_privilege('anon', v.oid, 'DELETE'))
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
       'a second RLS-bypassing routine writes public.quote_versions — snapshot_data is an authoritative cost basis and this boundary is reasoned around exactly one author of it' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND p.prosecdef
      AND r.rolbypassrls
      AND NOT (n.nspname = 'public' AND p.proname = '_create_quote_version_owner_impl')
      AND p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?quote_versions\M'
 );
