-- 20260729015706_application_service_cost_admin_only.sql
--
-- Close the last finding of the 2026-07-27 SECDEF pricing-bypass audit:
-- application_services.cost_per_acre_cents (our internal per-acre cost, i.e.
-- margin once you subtract it from default_rate_per_acre_cents) is readable by
-- EVERY active profile, drivers included.
--
-- The leak is a table grant, not a policy hole. application_services_select is
-- `is_active_profile()`, and PostgreSQL has no column-level RLS, so a policy
-- cannot hide one column. A column GRANT can -- but only per DB role, and every
-- app user shares `authenticated`, so a grant alone cannot discriminate by app
-- role either. Hence: revoke the column from `authenticated` outright, and put
-- the two admin surfaces that legitimately need it behind admin-gated RPCs.
--
-- Why NOT the companion-table design considered first: four SECURITY DEFINER
-- functions read this column --
--   create_invoice_from_blend_ticket, _save_field_app_invoice_impl_20260714,
--   _save_field_app_split_invoice_impl, compute_application_service_fee
-- -- three of them on the invoice/money path. Moving the column would mean
-- rewriting all four. All four are owned by `postgres`, so they read the column
-- as postgres and are completely unaffected by a grant change to
-- `authenticated`. Revoking the grant closes the same leak without touching the
-- money engine, and reverses with a single GRANT. Verified live 2026-07-28:
-- owner = postgres, prosecdef = true, for all four.
--
-- Exposure today is zero -- all 4 live rows have cost_per_acre_cents = 0 -- so
-- this is a control being put in place before the column is ever populated, not
-- an active breach being stopped.
--
-- Scope of the gate: `is_admin()` only, NOT `is_admin() OR is_sales_rep()`.
-- That matches what is already true rather than changing it -- both readers
-- (/application-services and /application-services/:id) are already
-- ProtectedRoute allowedRoles={['admin']}, and all three write policies on the
-- table (insert/update/delete) are already admin-only. No real user loses an
-- ability they have today.
--
-- Deliberately NOT touched:
--   * metabase_ro keeps SELECT. Reporting is an office-side tool and costing
--     reports are its job. It holds a DIRECT table grant, so a revoke aimed at
--     `authenticated` cannot reach it; asserted positively below.
--   * default_rate_per_acre_cents stays readable -- it is the CUSTOMER price and
--     the field-app picker needs it.
--   * quote_sections / rebate_programs / customer_application_rates policies.
--     Sales reps keep their access -- settled.
--
-- KNOWN RESIDUAL, deliberately out of scope -- two derived copies of cost survive
-- on the invoice side:
--   * invoice_items.cost_cents, carried next to `acres` on service lines, so a
--     reader of one line can divide cost/acre back out.
--   * invoices.total_cost_cents, the per-invoice roll-up.
-- Both are reachable under `invoices_select` / `invoice_items_select`, verified
-- live as `is_admin() OR created_by = auth.uid() OR salesman_id = auth.uid()` --
-- so a SALES REP can still recover cost for their own invoices. Drivers cannot:
-- they neither create invoices nor are salesman on them. The headline claim of
-- this migration -- drivers can no longer see internal cost -- therefore holds,
-- and the rep-side exposure is unchanged by this file, not introduced by it.
-- Narrowing a rep's visibility into their own invoices is a product decision for
-- Mason, not a grant fix, and it is tracked in docs/manual/KNOWN_ISSUES.md.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Column-level lockdown
--
-- Live ACL before this migration is table-level with no column ACLs at all
-- (authenticated=arwdDxtm/postgres, anon=rm/postgres). A table-level grant
-- implies every column, and REVOKE (col) does not subtract from it -- so the
-- only way to carve one column out is revoke-then-regrant the explicit list.
--
-- EVERY privilege carries its own column list. This is not style. Postgres
-- attaches a column list to the privilege it directly follows, so the shorter
-- spelling `GRANT SELECT, INSERT, UPDATE, REFERENCES (cols)` grants SELECT,
-- INSERT and UPDATE **table-wide** and column-scopes only REFERENCES -- i.e. it
-- silently leaves cost_per_acre_cents fully readable and writable, defeating
-- this entire migration. Proven on this database 2026-07-29 with a rolled-back
-- temp-table probe: under the short form
-- has_column_privilege(authenticated, secret, SELECT) came back TRUE; under the
-- per-privilege form below it came back FALSE. Verification 3c is the standing
-- proof that the spelling stayed correct.
--
-- DELETE, TRIGGER, TRUNCATE and MAINTAIN are intentionally left alone: they are
-- not column-scoped privileges, the bulk-delete admin flow needs DELETE, and RLS
-- still gates which rows any of it can reach.
--
-- STANDING CONSEQUENCE, for whoever adds the next column to this table: once the
-- grant is an explicit list, a NEW column is invisible and unwritable to
-- `authenticated` until someone adds it here. A table-level grant would have
-- covered it automatically; this one will not. The failure surfaces as a
-- PostgREST "permission denied for column ..." on a field that plainly exists,
-- which reads like a bug in the app rather than a missing grant. Any
-- `ALTER TABLE public.application_services ADD COLUMN` must ship alongside a
-- GRANT for that column -- unless it is a second internal-cost field, in which
-- case leaving it out is the point. Recorded in docs/reference/gotchas.md and
-- docs/reference/database-schema.md so it is findable from outside this file.
-- ---------------------------------------------------------------------------

REVOKE SELECT, INSERT, UPDATE, REFERENCES ON public.application_services FROM authenticated;

GRANT
  SELECT     (id, name, vehicle_id, default_rate_per_acre_cents, is_active, sort_order, created_by, created_at, updated_at),
  INSERT     (id, name, vehicle_id, default_rate_per_acre_cents, is_active, sort_order, created_by, created_at, updated_at),
  UPDATE     (id, name, vehicle_id, default_rate_per_acre_cents, is_active, sort_order, created_by, created_at, updated_at),
  REFERENCES (id, name, vehicle_id, default_rate_per_acre_cents, is_active, sort_order, created_by, created_at, updated_at)
ON public.application_services TO authenticated;

-- anon holds only SELECT here and has no RLS policy on this table, so it already
-- reads zero rows. Narrowed anyway so the grant matches the intent if a policy
-- is ever added. Single privilege, so one column list is correct here.
REVOKE SELECT ON public.application_services FROM anon;

GRANT SELECT (
  id,
  name,
  vehicle_id,
  default_rate_per_acre_cents,
  is_active,
  sort_order,
  created_by,
  created_at,
  updated_at
) ON public.application_services TO anon;

-- ---------------------------------------------------------------------------
-- 2. admin_get_application_service_costs -- the read path for the admin UI
--
-- SECURITY DEFINER because `authenticated` can no longer read the column at all;
-- the admin gate in the body is what re-opens it, and only for admins.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_get_application_service_costs(
  p_service_id uuid DEFAULT NULL
)
RETURNS TABLE (service_id uuid, cost_per_acre_cents bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: application service cost is admin-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id, s.cost_per_acre_cents
  FROM application_services s
  WHERE p_service_id IS NULL OR s.id = p_service_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_application_service_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_application_service_costs(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. admin_set_application_service_cost -- the write path for the admin UI
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_application_service_cost(
  p_service_id uuid,
  p_cost_per_acre_cents bigint,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_op       text;
  v_service  record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: application service cost is admin-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_cost_per_acre_cents IS NULL OR p_cost_per_acre_cents < 0 THEN
    RAISE EXCEPTION 'INVALID_COST: cost_per_acre_cents must be a non-negative integer number of cents';
  END IF;

  -- The idempotency scope is bound to the PAYLOAD, not just the operation name.
  -- useIdempotencyKey only rotates its key on success, so a commit whose response
  -- was lost leaves the same key live; if the admin then corrects the figure and
  -- retries, an operation-name-only scope would replay the stored result and
  -- report success while silently discarding the new value. Including the service
  -- id and the cents amount makes a corrected figure a different operation, so a
  -- genuine double-submit still dedupes.
  --
  -- What a corrected resubmit actually does, precisely: check_idempotency raises
  -- IDEMPOTENCY_CROSS_OP_KEY_REUSE on same-key/different-operation, so the
  -- correction FAILS LOUDLY rather than applying. That is the deliberate trade --
  -- a visible error beats silently discarding a money figure -- and it is why
  -- saveCost() in ApplicationServiceDetail.tsx rotates the key when the server
  -- returns that error, so the admin's next attempt carries a fresh key and does
  -- apply. Without that frontend rotation the admin stays wedged until reload,
  -- because useIdempotencyKey clears its ref only on success. The two halves are
  -- a pair: do not remove one without the other.
  v_op := 'admin_set_application_service_cost:' || p_service_id::text
          || ':' || p_cost_per_acre_cents::text;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, v_op);
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT id, name, cost_per_acre_cents INTO v_service
  FROM application_services
  WHERE id = p_service_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SERVICE_NOT_FOUND: %', p_service_id;
  END IF;

  IF v_service.cost_per_acre_cents IS DISTINCT FROM p_cost_per_acre_cents THEN
    UPDATE application_services
       SET cost_per_acre_cents = p_cost_per_acre_cents
     WHERE id = p_service_id;

    -- The FIGURES ARE DELIBERATELY ABSENT from this description. activity_feed's
    -- SELECT policy is `activity_select USING ((SELECT is_active_profile()))` --
    -- every active profile, drivers included (verified live 2026-07-29) -- and
    -- this INSERT runs as postgres, so it bypasses RLS on the way in and any
    -- driver reads it straight back out over PostgREST. Writing the old and new
    -- cents here would hand back, on the very first admin edit, the exact number
    -- the column carve-out above exists to hide: the table would be locked and
    -- the audit trail would publish it. Neither 3e (functions) nor 3f (views)
    -- can see a leak of this shape, so it is called out here instead.
    --
    -- financial_audit_log (SELECT policy `is_admin()`) would hold the figures
    -- safely, but its entity_type and operation_type CHECK constraints admit
    -- neither 'application_service' nor any cost-update operation, and widening
    -- two money-domain enums for a config field is a worse trade than forgoing
    -- value history this column has never had. The row still records WHO changed
    -- the cost and WHEN; the value itself is one admin-gated RPC away.
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'application_service_cost_updated',
      'Application service ' || v_service.name || ' cost/acre updated',
      v_actor, 'application_service', p_service_id
    );
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'service_id', p_service_id,
    'cost_per_acre_cents', p_cost_per_acre_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, v_op, v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_application_service_cost(uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_application_service_cost(uuid, bigint, text) TO authenticated, service_role;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count    integer;
  v_secdef   boolean;
  v_pathpin  boolean;
  v_src      text;
BEGIN
  -- 3a. Both RPCs exist, exactly once each, by exact identity signature. Counting
  --     by name alone would pass if one name carried two overloads and the other
  --     none -- and a stale overload keeps its own ACL, so that is a real hole.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND (proname || '(' || pg_get_function_identity_arguments(oid) || ')') IN (
           'admin_get_application_service_costs(p_service_id uuid)',
           'admin_set_application_service_cost(p_service_id uuid, p_cost_per_acre_cents bigint, p_idempotency_key text)'
         );
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'cost-gate verification: expected the 2 exact RPC signatures, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('admin_get_application_service_costs','admin_set_application_service_cost');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'cost-gate verification: % function(s) share these two names -- an overload exists', v_count;
  END IF;

  -- Both flags are boolean. v_count is an integer and bool_and() returns boolean;
  -- assigning one into the other is not an implicit cast in Postgres, it falls back
  -- to I/O conversion and dies with 22P02 invalid input syntax for integer: "t".
  -- Confirmed live 2026-07-28. Keep these two variables boolean.
  -- Both are coalesced: bool_and() over an empty set returns NULL and `IF NOT NULL`
  -- does not fire, so an unguarded flag would pass vacuously.
  SELECT bool_and(prosecdef),
         bool_and(EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=public, pg_temp'))
    INTO v_secdef, v_pathpin
  FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('admin_get_application_service_costs','admin_set_application_service_cost');
  IF NOT coalesce(v_secdef, false) THEN
    RAISE EXCEPTION 'cost-gate verification: both RPCs must be SECURITY DEFINER';
  END IF;
  IF NOT coalesce(v_pathpin, false) THEN
    RAISE EXCEPTION 'cost-gate verification: both RPCs must pin search_path = public, pg_temp';
  END IF;

  -- 3a-bis. The EXECUTE ACL on the two new RPCs. CREATE OR REPLACE PRESERVES a
  --     pre-existing ACL, so if either name had ever carried a stray grant, the
  --     REVOKE above is the only thing standing between anon and the column --
  --     and nothing else in this block proves it landed. has_function_privilege
  --     folds PUBLIC grants in, so the anon check covers PUBLIC too. The positive
  --     half matters just as much: losing `authenticated` EXECUTE takes the admin
  --     cost UI offline entirely, which is a worse outcome than the leak.
  IF has_function_privilege('anon', 'public.admin_get_application_service_costs(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_set_application_service_cost(uuid, bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cost-gate verification: anon (or PUBLIC) holds EXECUTE on a cost RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_get_application_service_costs(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_set_application_service_cost(uuid, bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cost-gate verification: authenticated lost EXECUTE on a cost RPC';
  END IF;

  -- 3b. Both bodies actually carry the admin gate (not just the label).
  --     The null-session test is matched in either spelling: the getter tests
  --     `auth.uid() IS NULL` inline, the setter captures the actor first (it needs
  --     it for activity_feed) and tests `v_actor IS NULL`. Both are the same check.
  --     This is a TEXT test and cannot prove enforcement -- a gate parked inside a
  --     comment would satisfy it. The real proof is the live negative test (call
  --     both RPCs as a real non-admin and observe SQLSTATE 42501), run against this
  --     database immediately after apply and recorded in migration-history.
  FOR v_src IN
    SELECT prosrc FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('admin_get_application_service_costs','admin_set_application_service_cost')
  LOOP
    IF v_src !~ '(auth\.uid\(\)|v_actor)\s+IS\s+NULL' OR v_src NOT LIKE '%NOT is_admin()%' THEN
      RAISE EXCEPTION 'cost-gate verification: an RPC body is missing the admin gate';
    END IF;
  END LOOP;

  -- 3c. THE POINT OF THE MIGRATION: authenticated and anon must NOT hold SELECT
  --     on cost_per_acre_cents, and MUST still hold it on the columns the app
  --     reads. Checked with has_column_privilege, which is what actually governs
  --     -- and which is what catches the GRANT-grammar trap described above.
  IF has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'SELECT') THEN
    RAISE EXCEPTION 'cost-gate verification: authenticated can still SELECT cost_per_acre_cents';
  END IF;
  IF has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'UPDATE') THEN
    RAISE EXCEPTION 'cost-gate verification: authenticated can still UPDATE cost_per_acre_cents';
  END IF;
  IF has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'INSERT') THEN
    RAISE EXCEPTION 'cost-gate verification: authenticated can still INSERT cost_per_acre_cents';
  END IF;
  -- REFERENCES is revoked alongside the other three. It is not a read path on its
  -- own, but leaving it granted would let anyone create a foreign key against the
  -- cost column, and a FK violation message is an oracle: it confirms whether a
  -- guessed value exists. It is revoked above, so assert it.
  IF has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'REFERENCES') THEN
    RAISE EXCEPTION 'cost-gate verification: authenticated can still REFERENCES cost_per_acre_cents';
  END IF;
  IF has_column_privilege('anon', 'public.application_services', 'cost_per_acre_cents', 'SELECT') THEN
    RAISE EXCEPTION 'cost-gate verification: anon can still SELECT cost_per_acre_cents';
  END IF;

  -- Availability half: every one of the nine re-granted columns against every one
  -- of the three privileges they were re-granted with -- the full 27, not a
  -- sample. A typo confined to ONE privilege's column list is exactly the failure
  -- mode this catches and a sampled check would miss: drop created_by from the
  -- INSERT list alone and new-service creation breaks at runtime (the detail page
  -- writes created_by on insert) with nothing here noticing. Cheap check, and the
  -- failure it prevents is a production outage on the admin pages.
  SELECT count(*), string_agg(priv || ' ' || col, ', ' ORDER BY priv, col)
    INTO v_count, v_src
  FROM unnest(ARRAY[
    'id','name','vehicle_id','default_rate_per_acre_cents',
    'is_active','sort_order','created_by','created_at','updated_at'
  ]) AS col
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) AS priv
  WHERE NOT has_column_privilege('authenticated', 'public.application_services', col, priv);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'cost-gate verification: % re-granted column/privilege pair(s) lost access: %', v_count, v_src;
  END IF;

  -- metabase_ro holds a DIRECT table grant, so revoking from `authenticated`
  -- cannot reach it -- but the header treats that as a requirement, so prove it.
  --
  -- Guarded on the role existing. has_column_privilege() raises 42704 for an
  -- unknown role, which would abort and roll back this whole migration on any
  -- database rebuilt from the migration set -- shadow DB, `supabase db reset`,
  -- a CI branch, a restore. metabase_ro is created by NO migration in this repo;
  -- it exists only on live, granted out of band. An unguarded call would make
  -- this file a one-way door. anon and authenticated are platform-created on
  -- every Supabase database and need no such guard.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
    IF NOT has_column_privilege('metabase_ro', 'public.application_services', 'cost_per_acre_cents', 'SELECT') THEN
      RAISE EXCEPTION 'cost-gate verification: metabase_ro lost SELECT on cost_per_acre_cents -- costing reports would break';
    END IF;
  ELSE
    RAISE NOTICE 'cost-gate verification: metabase_ro absent on this database -- reporting-grant assertion skipped';
  END IF;

  -- 3d. DELETE must survive (bulk-delete admin flow).
  IF NOT has_table_privilege('authenticated', 'public.application_services', 'DELETE') THEN
    RAISE EXCEPTION 'cost-gate verification: authenticated lost DELETE';
  END IF;

  -- 3e. Every function that touches application_services must be SECURITY DEFINER
  --     owned by postgres. That ownership is the entire reason this grant change
  --     is safe for the money engine: a postgres-owned SECDEF body reads the
  --     column as postgres, so revoking it from `authenticated` cannot reach it.
  --
  --     Matching on the column NAME alone is not enough. Verified live 2026-07-28:
  --     preview_field_app_invoice_split reads the table with SELECT * and never
  --     spells `cost_per_acre_cents` anywhere in its body, so a name match misses
  --     it entirely -- and SELECT * is exactly the shape the revoke breaks. So the
  --     test is "references the table at all", which is deliberately wider than
  --     "would actually break". Live at time of writing: all five matching
  --     functions are SECDEF/postgres, so the wider net costs nothing today.
  --
  --     Two arms, because neither alone is complete. prosrc catches plpgsql (whose
  --     body is opaque to the dependency tracker), and pg_depend catches a PG14+
  --     SQL-standard body (BEGIN ATOMIC), which leaves prosrc NULL and would slip
  --     through a text scan -- fail-open on an availability check. Every schema is
  --     scanned, not just public. Zero SQL-body functions exist live today; the arm
  --     is there so the first one added does not silently escape.
  SELECT count(*), string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY p.proname)
    INTO v_count, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND p.prokind IN ('f','p')
    AND (
          coalesce(p.prosrc, '') ~* '(^|[^a-z0-9_])"?application_services"?([^a-z0-9_]|$)'
          OR EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_proc'::regclass
                  AND d.objid = p.oid
                  AND d.refclassid = 'pg_class'::regclass
                  AND d.refobjid = 'public.application_services'::regclass)
        )
    AND (NOT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'postgres');
  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'cost-gate verification: % function(s) touch application_services without being SECDEF-owned-by-postgres and would break under the revoke: %', v_count, v_src;
  END IF;

  -- 3f. Views and matviews are the other way a reader reaches the column, and the
  --     function scan above cannot see them. A postgres-owned view WITHOUT
  --     security_invoker reads as its owner and hands the result to anyone holding
  --     SELECT on the view -- routing straight around the column carve-out.
  --     Resolved through pg_rewrite/pg_depend, which is exact rather than textual.
  --     Zero exist live 2026-07-29; this keeps it that way.
  SELECT count(*), string_agg(DISTINCT n.nspname || '.' || c.relname, ', ')
    INTO v_count, v_src
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_rewrite r ON r.ev_class = c.oid
  JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
  WHERE c.relkind IN ('v','m')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND d.refclassid = 'pg_class'::regclass
    AND d.refobjid = 'public.application_services'::regclass
    AND c.oid <> 'public.application_services'::regclass;
  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'cost-gate verification: % view(s)/matview(s) read application_services and can bypass the column carve-out: %', v_count, v_src;
  END IF;

  RAISE NOTICE 'cost-gate verification: PASS';
END;
$$;