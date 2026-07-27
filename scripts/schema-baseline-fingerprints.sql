-- Canonical catalog fingerprints for supabase/baselines/.
--
-- Run this identical file against BOTH live production and the disposable
-- restored database. Every fingerprint must match, or the baseline does not
-- reproduce production and must not be published.
--
-- The July 2026-07-19 baseline computed equivalent digests ad hoc and did not
-- record the queries, which made a later refresh unreproducible. This file is
-- the recorded definition; manifest.json binds its SHA-256.
--
-- Output: one `name=md5` row per fingerprint (psql -At -F'=').
-- Every digest is taken over a deterministically ordered text aggregation, so
-- it is independent of catalog OIDs, row order, and client operating system.

-- `attidentity` and `attgenerated` are carried explicitly. Identity and generated
-- semantics live in pg_attribute, not in the type/not-null/default fields, so a restore
-- that dropped `GENERATED ALWAYS AS IDENTITY` would leave this digest untouched.
-- `backup_runs.id` and `backup_snapshots.id` are identity columns today and their insert
-- paths omit `id`, so that drift would pass every fingerprint and break the backup job at
-- runtime.
SELECT 'columns', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s.%s|%s|%s|%s|%s|%s',
                n.nspname, c.relname, a.attname,
                format_type(a.atttypid, a.atttypmod),
                a.attnotnull,
                COALESCE(pg_get_expr(d.adbin, d.adrelid), ''),
                a.attidentity,
                a.attgenerated) AS entry
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
) s

UNION ALL
SELECT 'constraints', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s|%s|%s|%s',
                n.nspname, c.relname, con.conname, con.contype,
                pg_get_constraintdef(con.oid)) AS entry
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
) s

UNION ALL
SELECT 'enums', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s|%s',
                n.nspname, t.typname,
                string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)) AS entry
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public'
  GROUP BY n.nspname, t.typname
) s

UNION ALL
-- `indisvalid` is carried because an invalid index renders an identical definition.
-- A failed `CREATE INDEX CONCURRENTLY` leaves the index in place, ignored by the planner
-- and — this is the part that matters — not enforcing its UNIQUE constraint. Read from
-- `pg_index` rather than the `pg_indexes` view, which projects the definition but not the
-- validity flag.
SELECT 'indexes', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s|%s|%s',
                n.nspname, ic.relname,
                pg_get_indexdef(x.indexrelid),
                x.indisvalid) AS entry
  FROM pg_index x
  JOIN pg_class ic ON ic.oid = x.indexrelid
  JOIN pg_namespace n ON n.oid = ic.relnamespace
  WHERE n.nspname = 'public'
) s

UNION ALL
-- `relforcerowsecurity` and `relpersistence` are carried alongside `relrowsecurity`.
-- RLS being enabled is not the whole contract: without FORCE, the table owner bypasses
-- every policy, so a restore that enabled RLS but dropped FORCE would match a digest
-- recording only `relrowsecurity` while widening what the owning role can read. And an
-- `UNLOGGED` restore of a logged table renders the same columns, constraints, and grants,
-- but its rows do not survive a crash.
SELECT 'relations_and_acl', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s|%s|%s|%s|%s|%s',
                n.nspname, c.relname, c.relkind, c.relrowsecurity,
                c.relforcerowsecurity, c.relpersistence,
                COALESCE(array_to_string(ARRAY(
                  SELECT unnest(c.relacl)::text ORDER BY 1
                ), ','), '')) AS entry
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
) s

UNION ALL
-- Column-level grants are invisible to `relations_and_acl`, which records only the
-- table-level `relacl`. Production relies on 27 column-only INSERT/UPDATE grants on
-- `public.products` for `authenticated`; losing one breaks product edits and adding one
-- widens write access, in both cases without moving any other digest.
SELECT 'column_acl', md5(COALESCE(string_agg(entry, E'\n' ORDER BY entry), ''))
FROM (
  SELECT format('%s.%s.%s|%s',
                n.nspname, c.relname, a.attname,
                array_to_string(ARRAY(
                  SELECT unnest(a.attacl)::text ORDER BY 1
                ), ',')) AS entry
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
) s

UNION ALL
-- The `columns` digest records a view's projected columns but not its query, and
-- `relations_and_acl` records neither the query nor `reloptions`. A view could therefore
-- lose a predicate, or lose `security_invoker`, with every other digest unchanged.
-- `public.view_unmigrated_products` carries `security_invoker='true'`; without it the view
-- would execute with owner privileges and bypass the caller's RLS.
SELECT 'view_definitions', md5(COALESCE(string_agg(entry, E'\n' ORDER BY entry), ''))
FROM (
  SELECT format('%s.%s|%s|%s',
                n.nspname, c.relname,
                COALESCE(array_to_string(ARRAY(
                  SELECT unnest(c.reloptions) ORDER BY 1
                ), ','), ''),
                pg_get_viewdef(c.oid, true)) AS entry
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
) s

UNION ALL
-- `tgenabled` is carried because activation mode lives in `pg_trigger`, not in the
-- definition `pg_get_triggerdef()` renders. A trigger that is disabled, or set to
-- `REPLICA`/`ALWAYS`, describes itself identically while no longer firing for ordinary
-- writes. This project puts its financial and inventory invariants in the database
-- deliberately — `trg_guard_audit_log_immutable` among them — so a restore that matched
-- every digest with a disabled trigger would look correct and enforce nothing.
SELECT 'triggers', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s|%s|%s|%s',
                n.nspname, c.relname, t.tgname, t.tgenabled,
                pg_get_triggerdef(t.oid)) AS entry
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal
) s

UNION ALL
-- Two argument renderings on purpose. The identity form is the key — it is what
-- PostgREST and `GRANT` address — but it omits argument defaults, so a restore that lost
-- `DEFAULT` on an optional parameter would leave both this digest and the source digest
-- unchanged while breaking every call site that relies on the default. That is not
-- hypothetical here: `p_idempotency_key text DEFAULT NULL` is a project-wide contract on
-- mutating RPCs, and callers such as `PurchaseOrders.handleCancel` omit `p_reason` from
-- `cancel_purchase_order`. `pg_get_function_arguments` carries the full contract.
--
-- The result type is carried for the same reason from the other side of the signature:
-- neither argument rendering mentions it and the source digest hashes only `prosrc`, so a
-- function restored with the same body but a different return type moves nothing.
-- `get_customer_summary` returns `jsonb` and the frontend consumes it as a
-- `CustomerSummary` object; the same body returning `text` would hand the UI a string.
-- `prokind`, `proisstrict`, and `proleakproof` are the remaining out-of-body behavior
-- flags: a procedure is invoked with `CALL` rather than `SELECT`, a strict function
-- returns NULL on any NULL argument without running its body at all, and a leakproof one
-- may be pushed below an RLS predicate by the planner — which is a read-access change, not
-- a performance one.
SELECT 'function_security', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s(%s)|%s|%s|%s|%s|%s|%s|%s|%s|%s',
                n.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid),
                pg_get_function_arguments(p.oid),
                COALESCE(pg_get_function_result(p.oid), ''),
                p.prokind,
                p.proisstrict,
                p.proleakproof,
                p.prosecdef,
                COALESCE(array_to_string(p.proconfig, ','), ''),
                p.provolatile,
                COALESCE(array_to_string(ARRAY(
                  SELECT unnest(p.proacl)::text ORDER BY 1
                ), ','), '')) AS entry
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
  WHERE n.nspname = 'public' AND d.objid IS NULL AND p.prokind IN ('f', 'p')
) s

UNION ALL
SELECT 'function_canonical_source', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s(%s)|%s',
                n.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid),
                md5(replace(p.prosrc, E'\r\n', E'\n'))) AS entry
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
  WHERE n.nspname = 'public' AND d.objid IS NULL AND p.prokind IN ('f', 'p')
) s

UNION ALL
SELECT 'policy_contracts', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s.%s|%s|%s|%s|%s|%s|%s',
                schemaname, tablename, policyname, permissive,
                array_to_string(roles, ','), cmd,
                COALESCE(qual, ''), COALESCE(with_check, '')) AS entry
  FROM pg_policies
  WHERE schemaname = 'public'
     OR (schemaname = 'storage' AND tablename = 'objects')
) s

UNION ALL
-- `active` and `username` are carried because a job that is present is not necessarily a
-- job that runs, or that runs as the right role. `cron.job` keeps both outside the
-- schedule/command pair, so a deactivated nightly job — or one restored under a different
-- database role, with whatever privileges that role happens to hold — renders identically.
SELECT 'cron_contracts', md5(string_agg(entry, E'\n' ORDER BY entry))
FROM (
  SELECT format('%s|%s|%s|%s|%s', jobname, schedule, active, username, command) AS entry
  FROM cron.job
) s;
