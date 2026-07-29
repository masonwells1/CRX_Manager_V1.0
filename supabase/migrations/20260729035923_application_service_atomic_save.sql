-- ========
-- Application service save becomes atomic
--
-- WHY THIS EXISTS
--
-- Migration 20260729015706 revoked cost_per_acre_cents from `authenticated` at
-- the column-grant level and handed admins two RPCs to reach it. That closed the
-- leak, but it SPLIT THE SAVE: ApplicationServiceDetail.handleSave() wrote the
-- ordinary columns with a PostgREST insert/update and then made a SECOND,
-- SEPARATE call to admin_set_application_service_cost. Two round trips, two
-- transactions, no rollback between them. The adversarial cross-model review of
-- PR #267 called this out as a blocker and it is right:
--
--   * CREATE path -- if the first write commits and the cost call then fails
--     (network drop, tab close, error), a service exists with cost_per_acre_cents
--     at its column default of 0. Zero cost reads as infinite margin, so the
--     service silently understates cost and overstates profit on every job that
--     uses it. Worse, idx_application_services_active_name is NOT unique, so the
--     admin's natural response -- hit Create again -- produces a DUPLICATE
--     service rather than repairing the first one.
--
--   * EDIT path -- milder but the same shape: name/rate/active/sort_order commit
--     and the cost does not, so the form reports a save that only partly landed.
--
-- Neither is reachable by a non-admin (both writes are admin-gated) and neither
-- corrupts an existing figure on the create path -- but "the cost of a brand new
-- service is 0 when it should not be" is a money fact, and money facts do not get
-- to depend on the second of two network calls succeeding.
--
-- WHAT THIS CHANGES
--
-- One SECURITY DEFINER RPC, admin_save_application_service, writes the whole row
-- INCLUDING the cost. A single PL/pgSQL call is one transaction, so either every
-- field lands or none does -- which is the actual fix, not a retry wrapper around
-- the old shape.
--
-- WHAT THIS DELIBERATELY DOES *NOT* CHANGE
--
-- admin_set_application_service_cost stays. It is dead surface once the new
-- bundle is served -- nothing calls it -- and it should eventually go. But
-- dropping it HERE would be an outage: between this apply and the Vercel deploy
-- of the merged PR, the browser is still running the 20260729015706-era bundle,
-- which writes the ordinary columns over PostgREST and *then* calls that RPC. The
-- first write would still succeed (those column grants are untouched) and the
-- second would fail with "function does not exist" -- so during that window every
-- admin save would produce exactly the partial commit this migration exists to
-- prevent, deterministically rather than occasionally. Expand now, contract in a
-- follow-up migration once the new bundle is live. See docs/manual/KNOWN_ISSUES.md.
--
-- The column-privilege carve-out from 20260729015706 is UNTOUCHED and re-asserted
-- in the verification block below. This migration adds no grant on the table.
--
-- NOT DESTRUCTIVE: creates one function, drops nothing, touches zero rows.
-- ========

SET LOCAL lock_timeout = '10s';

-- --------
-- admin_save_application_service -- the single write path for the admin UI
--
-- SECURITY DEFINER for the same reason its cost-setting predecessor was:
-- `authenticated` holds no INSERT/UPDATE grant on cost_per_acre_cents at all, so
-- no amount of RLS policy can let an admin write it. The gate is the two checks
-- at the top of the body, and nothing else. Note that because the body runs as
-- postgres, the table's own admin-only INSERT/UPDATE policies are no longer in
-- the path for the ordinary columns either -- is_admin() below is now the whole
-- gate for the entire row. That is a slight TIGHTENING, not a wash: those policies
-- inline `profiles.role = 'admin'` with no is_active test, while is_admin() requires
-- role = 'admin' AND is_active = true, so a deactivated admin who could previously
-- still write the ordinary columns can now write nothing. The direction is safe --
-- but note a future tightening of the table's write policies will NOT reach this
-- RPC. Tighten here too if that day comes.
--
-- EVERY parameter except the idempotency key is REQUIRED, with no default. That
-- is deliberate: with `p_service_id uuid DEFAULT NULL`, omitting it would silently
-- mean "create", so one dropped field in a future caller would manufacture a
-- duplicate service instead of raising. Callers must say `null` out loud.
--
-- p_cost_per_acre_cents IS NULL means "leave the cost alone" -- it is not a
-- synonym for zero. That is what carries the frontend's costKnown write-lock into
-- the database: when the admin_get_application_service_costs read failed on load,
-- the form does not know the current cost, so it sends NULL rather than the 0 its
-- blank input would otherwise parse to. On the create path NULL leaves the column
-- at its default of 0.
-- --------

CREATE OR REPLACE FUNCTION public.admin_save_application_service(
  p_service_id                  uuid,     -- NULL = create a new service
  p_name                        text,
  p_default_rate_per_acre_cents bigint,
  p_cost_per_acre_cents         bigint,   -- NULL = leave the cost unchanged
  p_is_active                   boolean,
  p_sort_order                  integer,
  p_vehicle_id                  uuid,
  p_idempotency_key             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid;
  v_op           text;
  v_name         text;
  v_payload      jsonb;
  v_existing     jsonb;
  v_result       jsonb;
  v_service      record;
  v_service_id   uuid;
  v_created      boolean := false;
  v_cost_changed boolean := false;
  v_final_cost   bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: application services are admin-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate before touching anything. Every one of these columns is NOT NULL in
  -- the table, so a NULL here would otherwise surface as a constraint violation
  -- with a far less useful message.
  v_name := btrim(coalesce(p_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: service name is required';
  END IF;

  IF p_default_rate_per_acre_cents IS NULL OR p_default_rate_per_acre_cents < 0 THEN
    RAISE EXCEPTION 'INVALID_RATE: default_rate_per_acre_cents must be a non-negative integer number of cents';
  END IF;

  IF p_cost_per_acre_cents IS NOT NULL AND p_cost_per_acre_cents < 0 THEN
    RAISE EXCEPTION 'INVALID_COST: cost_per_acre_cents must be a non-negative integer number of cents';
  END IF;

  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'INVALID_IS_ACTIVE: is_active is required';
  END IF;

  IF p_sort_order IS NULL THEN
    RAISE EXCEPTION 'INVALID_SORT_ORDER: sort_order is required';
  END IF;

  -- Idempotency scope, and why the two paths are scoped DIFFERENTLY
  --
  -- useIdempotencyKey rotates its key only on success, so a commit whose response
  -- was lost leaves the same key live for the admin's next attempt. What should
  -- happen on that attempt is genuinely different for create and edit, so the
  -- operation string is built differently for each. Getting this wrong in either
  -- direction costs money, hence the length of this comment.
  --
  -- EDIT -- scoped to the WHOLE PAYLOAD. p_service_id is already in the string, so
  -- there is no duplicate-row risk; the danger here is the opposite one. If the
  -- scope ignored the payload, an admin who corrected a cost and retried under the
  -- live key would have the stored result replayed at them: "saved", while the new
  -- figure was silently discarded. Hashing the payload makes the correction a
  -- different operation, so check_idempotency raises IDEMPOTENCY_CROSS_OP_KEY_REUSE
  -- and it FAILS LOUDLY instead. A visible error beats a silently dropped money
  -- figure. handleSave() then rotates the key and retries once, which applies the
  -- correction -- without that rotation the admin stays wedged until reload. The
  -- two halves are a pair: do not remove one without the other.
  --
  -- CREATE -- a CONSTANT operation string. Nothing about the payload, not even the
  -- name, is mixed in. This looks inconsistent next to the edit path and is the
  -- whole reason the create path is safe. The invariant it buys is exactly the one
  -- that matters: ONE KEY CREATES AT MOST ONE SERVICE.
  --
  -- Anything payload-derived defeats itself here, and it took two review rounds to
  -- get this right, so the failure is worth spelling out. Lost response, row
  -- already committed, admin edits ANY field the scope depends on and clicks
  -- Create again -> different operation -> cross-op error -> the frontend rotates
  -- the key -> fresh key, no stored result -> a SECOND service, with nothing in the
  -- schema to stop it (idx_application_services_active_name is not unique). Scoping
  -- on the whole payload loses this to a corrected cost; scoping on the name loses
  -- it to a corrected typo -- which is, if anything, the likelier reaction to a
  -- save that appeared to fail. Only a constant survives an arbitrary edit.
  --
  -- "One key" is the right unit because useIdempotencyKey holds its key in a ref
  -- for the life of the mounted form and rotates it only on success: opening the
  -- new-service page is what mints a key, so it is already the natural identity of
  -- a single create attempt. A genuinely different second service is reached by
  -- navigating to the new-service page again, which remounts and mints a new key.
  --
  -- The cost of that choice is real but small and self-correcting: on a replay the
  -- adjusted figures in the resubmitted form are not applied. They are not lost
  -- silently, though -- handleSave navigates to the new service's detail page,
  -- which reads the true cost back through admin_get_application_service_costs, so
  -- the admin sees the actual saved values immediately and can fix them with an
  -- ordinary edit (which IS payload-scoped, and so cannot silently discard
  -- anything). A visible stale figure on a page you are already looking at beats a
  -- duplicate service that bills wrong forever.
  --
  -- Because the operation is constant, the frontend must NOT rotate-and-retry on
  -- the create path -- rotation is exactly the step that manufactures the
  -- duplicate. ApplicationServiceDetail.saveService() restricts its rotation to
  -- the edit path for this reason. The two halves are a pair.
  --
  -- And the key is MANDATORY on create: without one there is no replay protection
  -- at all, so any direct PostgREST call or future caller that omitted it could
  -- manufacture duplicates freely. Note this raises the bar for an ACCIDENTAL
  -- duplicate from the app; it is not a control against a caller that simply mints
  -- a fresh key per attempt, and it does not serialize two genuinely concurrent
  -- creates from two tabs. Only a unique partial index on the active name would do
  -- that, and adding one is deferred -- see docs/manual/KNOWN_ISSUES.md.
  IF p_service_id IS NULL THEN
    IF p_idempotency_key IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: creating an application service requires an idempotency key';
    END IF;
    v_op := 'admin_save_application_service:new';
  ELSE
    v_payload := jsonb_build_object(
      'name',       v_name,
      'rate',       p_default_rate_per_acre_cents,
      'cost',       p_cost_per_acre_cents,
      'is_active',  p_is_active,
      'sort_order', p_sort_order,
      'vehicle_id', p_vehicle_id
    );
    -- NOTE for anyone ever relaxing RLS on idempotency_keys: this md5 and the
    -- v_result below put the cost cents into that table's `operation` and `result`
    -- columns. It is safe today only because idempotency_keys carries a FOR ALL
    -- USING (false) policy, so no client can read it. The md5 is over a tiny value
    -- space and would be trivially brute-forceable if that ever changed.
    v_op := 'admin_save_application_service:' || p_service_id::text
            || ':' || md5(v_payload::text);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, v_op);
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_service_id IS NULL THEN
    -- CREATE. The cost is part of this single INSERT, which is the whole point:
    -- there is no window in which the row exists at cost 0 while a second call is
    -- still in flight.
    INSERT INTO application_services (
      name, vehicle_id, default_rate_per_acre_cents,
      cost_per_acre_cents, is_active, sort_order, created_by
    ) VALUES (
      v_name, p_vehicle_id, p_default_rate_per_acre_cents,
      coalesce(p_cost_per_acre_cents, 0), p_is_active, p_sort_order, v_actor
    )
    RETURNING id, cost_per_acre_cents INTO v_service_id, v_final_cost;

    v_created := true;
    v_cost_changed := coalesce(p_cost_per_acre_cents, 0) <> 0;
  ELSE
    -- EDIT. Lock first so a concurrent save cannot interleave between the read
    -- that decides whether the cost changed and the write that changes it.
    SELECT id, name, cost_per_acre_cents INTO v_service
    FROM application_services
    WHERE id = p_service_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'SERVICE_NOT_FOUND: %', p_service_id;
    END IF;

    v_service_id := v_service.id;
    v_cost_changed := p_cost_per_acre_cents IS NOT NULL
                      AND v_service.cost_per_acre_cents IS DISTINCT FROM p_cost_per_acre_cents;

    UPDATE application_services
       SET name                        = v_name,
           vehicle_id                  = p_vehicle_id,
           default_rate_per_acre_cents = p_default_rate_per_acre_cents,
           is_active                   = p_is_active,
           sort_order                  = p_sort_order,
           -- COALESCE, not a conditional branch: NULL means "leave the cost
           -- alone", so the unknown-cost form cannot blank a real figure.
           cost_per_acre_cents         = coalesce(p_cost_per_acre_cents, cost_per_acre_cents)
     WHERE id = p_service_id
    RETURNING cost_per_acre_cents INTO v_final_cost;
  END IF;

  IF v_cost_changed THEN
    -- The FIGURES ARE DELIBERATELY ABSENT from this description, carried over
    -- from 20260729015706 and for the same reason. activity_feed's SELECT policy
    -- is `activity_select USING ((SELECT is_active_profile()))` -- every active
    -- profile, drivers included -- and this INSERT runs as postgres, so it
    -- bypasses RLS on the way in and any driver reads it straight back out over
    -- PostgREST. Writing the cents here would publish, in the audit trail, the
    -- exact number the column carve-out exists to hide. The row still records WHO
    -- changed the cost and WHEN; the value is one admin-gated RPC away.
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'application_service_cost_updated',
      'Application service ' || v_name || ' cost/acre updated',
      v_actor, 'application_service', v_service_id
    );
  END IF;

  v_result := jsonb_build_object(
    'success',             true,
    'service_id',          v_service_id,
    'created',             v_created,
    'cost_changed',        v_cost_changed,
    'cost_per_acre_cents', v_final_cost
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, v_op, v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_application_service(uuid, text, bigint, bigint, boolean, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_application_service(uuid, text, bigint, bigint, boolean, integer, uuid, text) TO authenticated, service_role;

-- Verification

DO $$
DECLARE
  v_count   integer;
  v_secdef  boolean;
  v_pathpin boolean;
  v_owner   name;
  v_src     text;
  v_oid     oid;
BEGIN
  -- 1. The new RPC exists exactly once, by exact identity signature. Counting by
  --    name alone would pass with two overloads present, and a stale overload
  --    keeps its own ACL -- a real hole.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'admin_save_application_service';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'atomic-save verification: expected exactly 1 admin_save_application_service, found %', v_count;
  END IF;

  v_oid := to_regprocedure(
    'public.admin_save_application_service(uuid, text, bigint, bigint, boolean, integer, uuid, text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service is not present at the expected signature';
  END IF;

  SELECT prosecdef,
         proconfig @> ARRAY['search_path=public, pg_temp'],
         pg_get_userbyid(proowner),
         prosrc
    INTO v_secdef, v_pathpin, v_owner, v_src
    FROM pg_proc WHERE oid = v_oid;

  -- 2. SECURITY DEFINER with a pinned search_path. Without the pin, a caller-set
  --    search_path could resolve is_admin() to an attacker-owned function while
  --    the body runs with the definer's privileges.
  IF NOT v_secdef OR NOT coalesce(v_pathpin, false) THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service must be SECURITY DEFINER with search_path=public, pg_temp (secdef=%, pinned=%)',
      v_secdef, v_pathpin;
  END IF;

  -- 3. Ownership is the actual source of the privilege -- SECURITY DEFINER only
  --    means "run as the owner", and only postgres can write a column that
  --    `authenticated` has been revoked from. A replay of this file by a lesser
  --    role (restore, db reset, CI branch) would produce a function that passes
  --    every other check here and then fails at runtime with "permission denied
  --    for column cost_per_acre_cents" -- a total admin-save outage. Same
  --    dependency covers check_idempotency/save_idempotency, whose EXECUTE is
  --    revoked from authenticated outright.
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service must be owned by postgres, found %', v_owner;
  END IF;

  -- 4. THE POINT OF THIS MIGRATION: one function body performs both the row write
  --    and the cost write. If a later edit ever splits these back apart, this
  --    fails rather than silently restoring the partial-commit window. Checked
  --    BEFORE the gate-ordering test below, so that a missing INSERT reports
  --    itself rather than surfacing as a confusing strpos ordering failure.
  IF v_src !~ 'INSERT INTO application_services' OR v_src !~ 'UPDATE application_services' THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service must own both the create and the edit path';
  END IF;
  IF v_src !~ 'cost_per_acre_cents' THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service no longer writes the cost -- the save is split again';
  END IF;

  -- 5. Both gates are in the body, and the admin gate precedes the write. Note
  --    this is a TEXT SCAN and so cannot prove enforcement -- a gate parked inside
  --    a comment would satisfy it. The real proof is the post-apply live negative
  --    test (call as a real non-admin, observe SQLSTATE 42501) recorded in
  --    docs/reference/migration-history.md, exactly as 20260729015706 did.
  IF v_src !~ 'auth\.uid\(\)' OR v_src !~ 'AUTH_REQUIRED' THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service lost its authentication gate';
  END IF;
  IF v_src !~ 'NOT is_admin\(\)' OR v_src !~ 'INSUFFICIENT_ROLE' THEN
    RAISE EXCEPTION 'atomic-save verification: admin_save_application_service lost its admin gate';
  END IF;
  IF strpos(v_src, 'INSUFFICIENT_ROLE') > strpos(v_src, 'INSERT INTO application_services') THEN
    RAISE EXCEPTION 'atomic-save verification: the admin gate must precede the write';
  END IF;

  -- 6. Create cannot proceed without an idempotency key -- that mandate is what
  --    stops the app from manufacturing duplicate services, since
  --    idx_application_services_active_name is not unique.
  IF v_src !~ 'IDEMPOTENCY_KEY_REQUIRED' THEN
    RAISE EXCEPTION 'atomic-save verification: the create path must require an idempotency key';
  END IF;

  -- 6b. The create-path operation string is CONSTANT. This pins the entire
  --     one-key-one-service invariant, which nothing else here would catch: a
  --     future edit that "harmonizes" the two paths onto a single payload hash
  --     passes every other check in this block and silently reinstates the
  --     duplicate-create bug this migration exists to remove. The literal must
  --     have no concatenation after it.
  IF v_src !~ 'v_op := ''admin_save_application_service:new'';' THEN
    RAISE EXCEPTION 'atomic-save verification: the create path operation string must be constant -- a payload-derived scope reopens the duplicate-create hole';
  END IF;

  -- 6c. The idempotency helpers and the admin predicate resolve. plpgsql binds
  --     these at RUNTIME, so a rename or signature change elsewhere would leave
  --     this migration reporting "all checks passed" while every admin save fails
  --     later with "function does not exist". Their EXECUTE is revoked from
  --     authenticated, which is what makes check 3's ownership assertion
  --     load-bearing rather than cosmetic.
  IF to_regprocedure('public.check_idempotency(text, text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'atomic-save verification: the shared idempotency helpers are missing or changed signature';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'atomic-save verification: is_admin() is missing -- the RPC gate would fail at runtime';
  END IF;

  -- 6d. idempotency_keys is not client-readable. This body writes the cost cents
  --     into that table in cleartext (the `result` payload, and the md5 of the edit
  --     payload), which is only acceptable because no client can read it. That
  --     property lives in a 2026-02 migration and would otherwise be asserted
  --     nowhere near the code that depends on it -- so if it ever drifts, the exact
  --     figures the column carve-out exists to hide become readable by any
  --     authenticated user, and this migration would happily apply on top of that.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.idempotency_keys'::regclass) THEN
    RAISE EXCEPTION 'atomic-save verification: RLS is disabled on idempotency_keys -- this RPC stores cost cents there';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.idempotency_keys'::regclass
       AND p.polpermissive
       AND (p.polroles IS NULL
            OR p.polroles = '{0}'::oid[]
            OR 'authenticated'::regrole::oid = ANY (p.polroles))
       AND coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') <> 'false'
  ) THEN
    RAISE EXCEPTION 'atomic-save verification: idempotency_keys has a readable policy reaching authenticated -- stored cost cents would leak';
  END IF;

  -- 7. anon and PUBLIC hold no EXECUTE; authenticated still does. This is the
  --    shape of incidents B7/B8/B9 -- an anon-executable SECDEF DML helper.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'atomic-save verification: anon must not hold EXECUTE on admin_save_application_service';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'atomic-save verification: PUBLIC must not hold EXECUTE on admin_save_application_service';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'atomic-save verification: authenticated lost EXECUTE on admin_save_application_service -- the admin UI cannot save';
  END IF;

  -- 8. The two RPCs from 20260729015706 both survive. The read half is used by
  --    both admin pages; the setter is retained ON PURPOSE for one release so the
  --    currently-deployed bundle keeps working between this apply and the deploy
  --    (see the header). A follow-up migration retires it.
  IF to_regprocedure('public.admin_get_application_service_costs(uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic-save verification: admin_get_application_service_costs must survive -- it is the admin read path';
  END IF;
  IF to_regprocedure('public.admin_set_application_service_cost(uuid, bigint, text)') IS NULL THEN
    RAISE EXCEPTION 'atomic-save verification: admin_set_application_service_cost must survive this migration -- dropping it here strands the deployed bundle mid-save';
  END IF;

  -- 9. The column-privilege carve-out from 20260729015706 is UNCHANGED. This
  --    migration grants nothing on the table, so any drift here means something
  --    else re-opened the leak and this migration would be shipping on top of it.
  IF has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'SELECT')
     OR has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'INSERT')
     OR has_column_privilege('authenticated', 'public.application_services', 'cost_per_acre_cents', 'REFERENCES') THEN
    RAISE EXCEPTION 'atomic-save verification: authenticated regained a privilege on cost_per_acre_cents -- the carve-out is broken';
  END IF;
  IF has_column_privilege('anon', 'public.application_services', 'cost_per_acre_cents', 'SELECT') THEN
    RAISE EXCEPTION 'atomic-save verification: anon regained SELECT on cost_per_acre_cents';
  END IF;

  -- 10. The ordinary columns are still readable -- both admin pages and the field
  --     app select them directly, so a future over-narrowing must fail here.
  IF NOT has_column_privilege('authenticated', 'public.application_services', 'name', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.application_services', 'default_rate_per_acre_cents', 'SELECT') THEN
    RAISE EXCEPTION 'atomic-save verification: authenticated lost SELECT on an ordinary application_services column';
  END IF;

  RAISE NOTICE 'atomic-save verification: all checks passed';
END;
$$;
