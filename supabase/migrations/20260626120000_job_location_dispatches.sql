-- Field-app parity #36 (2026-06-26): Per-location dispatch + assignment.
-- ---------------------------------------------------------------------------
-- Lets a dispatcher hand out INDIVIDUAL field locations (job_fields rows) on a
-- job to different applicators/crews, so two crews can split one big job. This
-- is the 3-step "Dispatch Jobs" wizard's persistence layer.
--
-- ADDITIVE ONLY: new table `job_location_dispatches` + commit RPC
-- `dispatch_job_locations`. No existing object is dropped or rewritten.
--
-- Design notes:
--   * One CURRENT dispatch per location (UNIQUE job_field_id) — re-dispatch is an
--     upsert/replace, never a duplicate.
--   * EXACTLY ONE of applicator_id / crew_id is set (CHECK) — a location is
--     dispatched to an applicator OR a crew, not both, not neither.
--   * job_id is denormalized (kept consistent with job_field_id's job by the RPC
--     and a WITH CHECK binding) for fast job-scoping/RLS without a join.
--   * The #12 billed-job-immutability trigger is on `jobs` only; this RPC inserts
--     into the NEW table (never UPDATEs jobs), so there is no conflict — and we
--     scope to dispatchable jobs (scheduled/in_progress) regardless.
-- ---------------------------------------------------------------------------

-- ── 1) Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_location_dispatches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_field_id    uuid NOT NULL REFERENCES public.job_fields(id) ON DELETE CASCADE,
  job_id          uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE (NOT SET NULL): a dispatch row exists ONLY to record that a
  -- location is assigned to this applicator/crew. SET NULL would try to null the
  -- sole assignee and violate the XOR CHECK, making the assignee delete fail
  -- unpredictably. Cascading removes the now-meaningless assignment cleanly
  -- (the location simply becomes undispatched). (Codex #36 P2.)
  applicator_id   uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  crew_id         uuid REFERENCES public.ground_crews(id) ON DELETE CASCADE,
  dispatched_at   timestamptz NOT NULL DEFAULT now(),
  dispatch_status text NOT NULL DEFAULT 'dispatched'
                    CHECK (dispatch_status IN ('dispatched', 'completed', 'cancelled')),
  dispatched_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Exactly one assignee: applicator XOR crew.
  CONSTRAINT job_location_dispatches_one_assignee_check
    CHECK ((applicator_id IS NOT NULL) <> (crew_id IS NOT NULL)),
  -- One current dispatch per location (re-dispatch upserts on this key).
  CONSTRAINT job_location_dispatches_job_field_id_key UNIQUE (job_field_id)
);

CREATE INDEX IF NOT EXISTS idx_job_location_dispatches_job
  ON public.job_location_dispatches(job_id);
CREATE INDEX IF NOT EXISTS idx_job_location_dispatches_applicator
  ON public.job_location_dispatches(applicator_id) WHERE applicator_id IS NOT NULL;

-- keep updated_at fresh on UPDATE (table has updated_at).
DROP TRIGGER IF EXISTS set_updated_at_job_location_dispatches ON public.job_location_dispatches;
CREATE TRIGGER set_updated_at_job_location_dispatches
  BEFORE UPDATE ON public.job_location_dispatches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 2) RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.job_location_dispatches ENABLE ROW LEVEL SECURITY;

-- RLS helper (#36, Codex re-review): "is the current user dispatched to any
-- location of this job — as the assigned applicator OR as a member of the assigned
-- crew?" SECURITY DEFINER so its reads of job_location_dispatches / ground_crew_members
-- BYPASS RLS. This is what breaks the jobs<->job_location_dispatches policy cycle:
-- the jobs SELECT policy calls this helper instead of querying job_location_dispatches
-- directly (which would re-trigger that table's policy, whose own job-applicator
-- branch reads jobs — an infinite recursion). STABLE so it's evaluated once per row
-- set, not per row.
CREATE OR REPLACE FUNCTION public._is_dispatched_to_me(p_job_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  -- The caller must be an ACTIVE profile — mirror is_applicator()/is_admin(), which
  -- re-check profiles.is_active, so a DEACTIVATED user with a still-valid token loses
  -- dispatch visibility immediately (Codex re-review-6 P2).
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
  AND EXISTS (
    SELECT 1 FROM public.job_location_dispatches d
     WHERE d.job_id = p_job_id
       -- Only an ACTIVE ('dispatched') assignment grants visibility — a cancelled
       -- dispatch must NOT keep granting the former assignee/crew read access to
       -- the parent job (Codex re-review P2).
       AND d.dispatch_status = 'dispatched'
       AND (
         d.applicator_id = (select auth.uid())
         OR (
           d.crew_id IS NOT NULL
           AND EXISTS (
             -- the CREW must still be active AND the caller an active member —
             -- deactivating the crew revokes visibility even if member rows linger
             -- (Codex re-review-9 P2).
             SELECT 1 FROM public.ground_crew_members gcm
              JOIN public.ground_crews gc ON gc.id = gcm.crew_id
              WHERE gcm.crew_id = d.crew_id
                AND gcm.profile_id = (select auth.uid())
                AND gcm.is_active
                AND gc.is_active
           )
         )
       )
  );
$$;
REVOKE EXECUTE ON FUNCTION public._is_dispatched_to_me(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_dispatched_to_me(uuid) TO authenticated, service_role;

-- SELECT: job viewers (admin / sales_rep / the parent job's whole-job applicator)
-- PLUS the applicator a location was dispatched TO, PLUS a member of the CREW a
-- location was dispatched to (so the actual assignee — applicator OR crew member —
-- sees their assignment even when they are not the job's whole-job applicator).
-- The whole-job-applicator branch reads jobs.applicator_id directly (a column read,
-- not a recursive policy: the jobs SELECT extension below calls the definer helper,
-- never this table, so there is no cycle).
DROP POLICY IF EXISTS "job_location_dispatches_select" ON public.job_location_dispatches;
CREATE POLICY "job_location_dispatches_select" ON public.job_location_dispatches
  FOR SELECT TO authenticated
  USING (
    -- dispatchers (and the whole-job applicator) see ALL rows incl. cancelled (audit);
    -- the per-location assignee / crew member only see their CURRENT ('dispatched')
    -- assignment, so a cancelled dispatch stops surfacing to a former assignee.
    is_admin()
    OR is_sales_rep()
    -- the per-location assignee / crew member must be an ACTIVE profile (a
    -- deactivated user with a live token loses visibility immediately — Codex
    -- re-review-6 P2). Admin/sales_rep above already re-check is_active via their
    -- helpers; the whole-job-applicator branch below uses is_applicator() (which
    -- also re-checks is_active).
    OR (
      dispatch_status = 'dispatched'
      AND applicator_id = (select auth.uid())
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
    )
    -- a member of the dispatched crew sees the crew's CURRENT dispatch rows
    OR (
      dispatch_status = 'dispatched'
      AND crew_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
      AND EXISTS (
        -- crew AND member must both be active (Codex re-review-9 P2).
        SELECT 1 FROM public.ground_crew_members gcm
         JOIN public.ground_crews gc ON gc.id = gcm.crew_id
         WHERE gcm.crew_id = job_location_dispatches.crew_id
           AND gcm.profile_id = (select auth.uid())
           AND gcm.is_active
           AND gc.is_active
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.jobs j
       WHERE j.id = job_location_dispatches.job_id
         AND is_applicator()
         AND j.applicator_id = (select auth.uid())
    )
  );

-- jobs SELECT extension (#36, Codex re-review P1): the existing jobs_select policy
-- only lets a field-app applicator read a job when they are the WHOLE-JOB applicator.
-- A per-location-only assignee (or a member of a crew dispatched to a location of
-- the job) must also be able to read the parent job, else their dispatched work is
-- invisible (the DispatchBoard job query returns nothing for them under RLS).
-- ADDITIVE: a SECOND permissive SELECT policy ORs in with jobs_select; the existing
-- policy is left untouched. Uses the SECURITY DEFINER helper to avoid recursion.
DROP POLICY IF EXISTS "jobs_select_location_dispatchee" ON public.jobs;
CREATE POLICY "jobs_select_location_dispatchee" ON public.jobs
  FOR SELECT TO authenticated
  USING ( public._is_dispatched_to_me(jobs.id) );

-- job_fields SELECT extension (#36, Codex re-review-3 P2): the board embeds
-- job_fields to render each dispatched location's field name; the existing
-- job_fields_select policy only allows admin/sales or the whole-job applicator, so
-- a per-location-only assignee would see the job header but NOT the location rows.
-- Mirror the jobs extension with the same recursion-safe helper. ADDITIVE: a second
-- permissive policy ORs in with the existing job_fields_select.
DROP POLICY IF EXISTS "job_fields_select_location_dispatchee" ON public.job_fields;
CREATE POLICY "job_fields_select_location_dispatchee" ON public.job_fields
  FOR SELECT TO authenticated
  USING ( public._is_dispatched_to_me(job_fields.job_id) );

-- customers SELECT extension (#36, Codex re-review-4 P2): the board embeds
-- customer:customers(farm_name) on each job; the existing customers_select only
-- covers admin/sales/whole-job applicator, so a per-location-only assignee would
-- see the job with a NULL customer ('Unknown'). Let them read the customers they
-- have a live dispatch to. Uses the SECURITY DEFINER helper (its job_location_dispatches
-- read bypasses RLS), so no recursion with customers/jobs policies. ADDITIVE.
DROP POLICY IF EXISTS "customers_select_location_dispatchee" ON public.customers;
CREATE POLICY "customers_select_location_dispatchee" ON public.customers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs j
       WHERE j.customer_id = customers.id
         AND public._is_dispatched_to_me(j.id)
    )
  );

-- WRITES ARE RPC-ONLY (no client INSERT/UPDATE/DELETE policy). Dispatching MUST
-- go through dispatch_job_locations(), which is SECURITY DEFINER (so it bypasses
-- RLS) and enforces the full guard set the policy layer can't: the dispatchable
-- lifecycle gate (scheduled/in_progress only), the active-applicator / active-crew
-- check, the XOR assignee rule, strict-actor, and the upsert-on-conflict. With RLS
-- enabled and NO permissive write policy, a direct PostgREST INSERT/UPDATE/DELETE
-- by any role is denied — closing the bypass where an admin/sales_rep client could
-- otherwise dispatch a completed/cancelled job or assign an inactive profile
-- around those checks. (Mirrors application_record_lots: RPC-only writes,
-- SELECT-only client policy. Codex #36 P2.)
-- Defense-in-depth grants: SELECT for the read path (per-location 'Assigned To');
-- the RPC runs as definer so it does not need a client write grant/policy.
GRANT SELECT ON public.job_location_dispatches TO authenticated;

-- ── 3) Commit RPC: dispatch_job_locations ───────────────────────────────────
-- p_assignments = [{ "job_field_id": uuid, "applicator_id": uuid|null,
--                    "crew_id": uuid|null }, ...]
-- Each assignment dispatches one location to an applicator OR a crew. Upserts on
-- job_field_id (re-dispatch replaces). Returns { dispatched: <count> }.
-- A prior (4-arg-less) overload must not linger — keep exactly one signature.
DROP FUNCTION IF EXISTS public.dispatch_job_locations(jsonb, uuid, text);

CREATE OR REPLACE FUNCTION public.dispatch_job_locations(
  p_assignments     jsonb,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_license_override boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid;
  v_role         text;
  v_existing     jsonb;
  v_assignment   jsonb;
  v_job_field    uuid;
  v_applicator   uuid;
  v_crew         uuid;
  v_job_id       uuid;
  v_job_status   text;
  v_has_licenses boolean;
  v_latest_expiry date;
  v_count        int := 0;
  v_override_used int := 0;   -- # of expired-license applicators dispatched via override
  v_this_override boolean := false;  -- did THIS location use the license override?
  v_job_cust     uuid;
  v_assignee_label text;
  v_field_label  text;
  v_result       jsonb;
BEGIN
  -- actor / strict-actor / role gate (mirrors jobs_update RLS)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;
  -- The license-override hatch is admin-only (mirrors assign_job_applicator).
  IF p_license_override AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'OVERRIDE_REQUIRES_ADMIN';
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'dispatch_job_locations');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PAYLOAD: p_assignments must be a JSON array';
  END IF;
  IF jsonb_array_length(p_assignments) = 0 THEN
    RAISE EXCEPTION 'NO_ASSIGNMENTS: at least one assignment required';
  END IF;

  -- Reject a payload that lists the same location twice: each job_field_id maps to
  -- exactly ONE current dispatch, so a duplicate would upsert the same row twice and
  -- over-count the {dispatched} total + write a duplicate activity row (Codex
  -- re-review-9 P3). The wizard already de-dups via a selection Set; this guards a
  -- direct RPC caller.
  IF (SELECT count(*) FROM jsonb_array_elements(p_assignments) e) <>
     (SELECT count(DISTINCT nullif(e->>'job_field_id','')) FROM jsonb_array_elements(p_assignments) e) THEN
    RAISE EXCEPTION 'DUPLICATE_LOCATION: each job_field_id may appear at most once per dispatch';
  END IF;

  FOR v_assignment IN SELECT * FROM jsonb_array_elements(p_assignments)
  LOOP
    v_job_field  := nullif(v_assignment->>'job_field_id', '')::uuid;
    v_applicator := nullif(v_assignment->>'applicator_id', '')::uuid;
    v_crew       := nullif(v_assignment->>'crew_id', '')::uuid;

    IF v_job_field IS NULL THEN
      RAISE EXCEPTION 'INVALID_ASSIGNMENT: job_field_id is required';
    END IF;

    -- EXACTLY ONE assignee.
    IF (v_applicator IS NOT NULL) = (v_crew IS NOT NULL) THEN
      RAISE EXCEPTION 'ONE_ASSIGNEE_REQUIRED: each location needs exactly one of applicator_id / crew_id (job_field %)', v_job_field;
    END IF;

    -- Derive the real job for this location (never trust a client job_id).
    SELECT jf.job_id INTO v_job_id FROM job_fields jf WHERE jf.id = v_job_field;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'LOCATION_NOT_FOUND: job_field % does not exist', v_job_field;
    END IF;

    -- Only dispatch locations of a DISPATCHABLE job: a LIVE (not soft-deleted)
    -- job in scheduled/in_progress. This RPC is SECURITY DEFINER and bypasses RLS,
    -- so it must enforce deleted_at IS NULL itself — the board filters deleted_at,
    -- but a direct caller would otherwise dispatch a soft-deleted job (Codex #36 P2).
    -- FOR UPDATE locks the job row so a concurrent complete/cancel can't slip the
    -- job into a non-dispatchable status between this check and the upsert — the
    -- status-transition enforcer takes the same row lock, so they serialize and we
    -- never leave a dispatch row on a job that just became completed/cancelled
    -- (Codex re-review-8 P2 TOCTOU).
    SELECT status INTO v_job_status FROM jobs WHERE id = v_job_id AND deleted_at IS NULL FOR UPDATE;
    IF v_job_status IS NULL THEN
      RAISE EXCEPTION 'JOB_NOT_FOUND: job % missing or deleted', v_job_id;
    END IF;
    IF v_job_status NOT IN ('scheduled', 'in_progress') THEN
      RAISE EXCEPTION 'JOB_NOT_DISPATCHABLE: job % is % (must be scheduled or in_progress)', v_job_id, v_job_status;
    END IF;

    -- Validate the assignee.
    IF v_applicator IS NOT NULL THEN
      PERFORM 1 FROM profiles
        WHERE id = v_applicator AND is_active = true AND role = 'applicator';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_APPLICATOR: % is not an active applicator', v_applicator;
      END IF;

      -- LICENSE GATE (Codex re-review P1): dispatching a location to an applicator
      -- whose tracked active licenses are ALL expired is blocked, mirroring the
      -- enforce_applicator_license trigger that guards jobs.applicator_id (this RPC
      -- writes the new table, never jobs, so that trigger does NOT fire — replicate
      -- it here). No license on file = allowed (gate only applies once licenses are
      -- tracked). p_license_override is the admin-only hatch (checked above) and any
      -- ACTUAL override (expired license dispatched anyway) is logged below (P2).
      SELECT count(*) > 0, max(expiry_date)
        INTO v_has_licenses, v_latest_expiry
        FROM applicator_licenses
       WHERE profile_id = v_applicator
         AND is_active = true;
      v_this_override := false;
      IF v_has_licenses AND v_latest_expiry < CURRENT_DATE THEN
        IF NOT p_license_override THEN
          RAISE EXCEPTION 'LICENSE_EXPIRED: applicator % license expired %', v_applicator, v_latest_expiry;
        END IF;
        v_this_override := true;          -- override actually exercised on this loc
        v_override_used := v_override_used + 1;
      END IF;
    ELSE
      v_this_override := false;
      PERFORM 1 FROM ground_crews WHERE id = v_crew AND is_active = true;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_CREW: % is not an active crew', v_crew;
      END IF;
    END IF;

    -- UPSERT: one current dispatch per location; re-dispatch replaces assignee.
    INSERT INTO job_location_dispatches
      (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
    VALUES
      (v_job_field, v_job_id, v_applicator, v_crew, now(), 'dispatched', v_actor)
    ON CONFLICT (job_field_id) DO UPDATE
      SET applicator_id   = EXCLUDED.applicator_id,
          crew_id         = EXCLUDED.crew_id,
          job_id          = EXCLUDED.job_id,
          dispatched_at   = now(),
          dispatch_status = 'dispatched',
          dispatched_by   = v_actor;

    -- ACTIVITY LOG (Codex re-review-5 P2): every location dispatch lands on the
    -- job/customer timeline (the replaced assign_job_applicator flow logged each
    -- assignment; keep that audit trail). One row per location, with the assignee
    -- name, the field, and an override note when applicable.
    SELECT customer_id INTO v_job_cust FROM jobs WHERE id = v_job_id;
    IF v_applicator IS NOT NULL THEN
      SELECT full_name INTO v_assignee_label FROM profiles WHERE id = v_applicator;
      v_assignee_label := 'applicator ' || coalesce(v_assignee_label, v_applicator::text);
    ELSE
      SELECT name INTO v_assignee_label FROM ground_crews WHERE id = v_crew;
      v_assignee_label := 'crew ' || coalesce(v_assignee_label, v_crew::text);
    END IF;
    SELECT f.field_name INTO v_field_label
      FROM job_fields jf JOIN fields f ON f.id = jf.field_id WHERE jf.id = v_job_field;
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES (
      'job_location_dispatched',
      'Location ' || coalesce(v_field_label, '') || ' dispatched to ' || v_assignee_label
        || CASE WHEN v_this_override
                THEN ' with EXPIRED license (' || v_latest_expiry || ') — admin license override'
                ELSE '' END,
      v_actor, 'job', v_job_id, v_job_cust
    );

    v_count := v_count + 1;
  END LOOP;

  v_result := jsonb_build_object('dispatched', v_count, 'license_overrides', v_override_used);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'dispatch_job_locations', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dispatch_job_locations(jsonb, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_job_locations(jsonb, uuid, text, boolean) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload of the RPC
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'dispatch_job_locations';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'dispatch_job_locations overload count is % (expected 1)', v_count;
  END IF;

  -- table + RLS enabled
  IF to_regclass('public.job_location_dispatches') IS NULL THEN
    RAISE EXCEPTION 'job_location_dispatches table missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_class
   WHERE oid = 'public.job_location_dispatches'::regclass AND relrowsecurity = true;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'RLS not enabled on job_location_dispatches';
  END IF;

  -- the XOR + unique constraints exist
  SELECT count(*) INTO v_count FROM pg_constraint
   WHERE conrelid = 'public.job_location_dispatches'::regclass
     AND conname IN ('job_location_dispatches_one_assignee_check',
                     'job_location_dispatches_job_field_id_key');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected XOR + unique constraints on job_location_dispatches (found %)', v_count;
  END IF;

  -- the recursion-breaking helper + the additive jobs SELECT policy exist
  IF to_regprocedure('public._is_dispatched_to_me(uuid)') IS NULL THEN
    RAISE EXCEPTION '_is_dispatched_to_me(uuid) helper missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policy
   WHERE polrelid = 'public.jobs'::regclass AND polname = 'jobs_select_location_dispatchee';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'jobs_select_location_dispatchee policy missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policy
   WHERE polrelid = 'public.job_fields'::regclass AND polname = 'job_fields_select_location_dispatchee';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'job_fields_select_location_dispatchee policy missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policy
   WHERE polrelid = 'public.customers'::regclass AND polname = 'customers_select_location_dispatchee';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'customers_select_location_dispatchee policy missing';
  END IF;

  -- assignee FKs must be ON DELETE CASCADE (NOT SET NULL) so an assignee delete
  -- cannot violate the XOR check (Codex re-review-3 P2). confdeltype 'c' = CASCADE.
  SELECT count(*) INTO v_count FROM pg_constraint
   WHERE conrelid = 'public.job_location_dispatches'::regclass AND contype = 'f'
     AND conname IN ('job_location_dispatches_applicator_id_fkey',
                     'job_location_dispatches_crew_id_fkey')
     AND confdeltype = 'c';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'assignee FKs must be ON DELETE CASCADE (found % cascade FKs)', v_count;
  END IF;
END $$;
