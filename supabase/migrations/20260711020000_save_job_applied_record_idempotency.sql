-- 20260711020000_save_job_applied_record_idempotency.sql
--
-- (Renamed from 20260711010000 after a Codex-caught collision: a parallel session
--  landed 20260711010000_u18c_morning_cron_utc_fix.sql on origin/main mid-session.)
--
-- idempotency-body-check: exempt
--   WHY: save_job_applied_record is SECURITY INVOKER by design and therefore CANNOT
--   call the canonical check_idempotency / save_idempotency helpers (they are SECURITY
--   DEFINER with authenticated EXECUTE deliberately revoked + a B10 tripwire). Its
--   idempotency is implemented WITHOUT those helpers: a nullable idempotency_key column
--   on job_applied_records carrying a PARTIAL UNIQUE index, with a catch-unique-violation
--   replay in the create path. Full rationale in the block comment below.
--
-- LIVE FOUNDATION GAUNTLET — Section 6 HIGH-1: save_job_applied_record can create a
-- DUPLICATE legal applied-record on a double-submit / network-timeout retry.
--
-- THE BUG (confirmed against the LIVE function body + live catalog, 2026-07-10):
--   * save_job_applied_record has no p_idempotency_key. Its create path fires whenever
--     p_record->>'id' is empty.
--   * job_applied_records has ONLY a primary key on id — no natural uniqueness. Two
--     parent rows for the SAME real spray pass are structurally allowed.
--   * recompute_job_applied_acres SUMs applied_acres across ALL of a job's records into
--     jobs.applied_acres, which feeds the GENERATED jobs.remaining_acres
--     = GREATEST(total_acres - applied_acres, 0). A duplicate therefore DOUBLE-COUNTS
--     applied acres (a half-done field reads as fully applied) and pollutes the legal /
--     compliance proof record (RUP reporting, the "Your Field Was Sprayed" notice).
--   * The realistic trigger is a field network timeout: the save SUCCEEDS, the response
--     never arrives, the modal shows an error, `saving` resets to false, and the
--     applicator taps Save again. The modal's `saving` debounce does NOT cover this
--     (the first request already "finished" with an error) — so the prior design note
--     in 20260629190000 that leaned on the debounce does not close this path.
--   * NO money impact: transfer_job_to_invoice bills off billable_acres, not
--     applied_acres (verified) — so this is a compliance / operations bug, HIGH not
--     BLOCKER.
--
-- WHY THE CANONICAL IDEMPOTENCY HELPERS ARE NOT USED HERE:
--   save_job_applied_record is SECURITY INVOKER BY DESIGN so the caller's own RLS —
--   including the Wave-2a job_applied_record_fields field-MEMBERSHIP WITH CHECK — gates
--   every write. The canonical check_idempotency / save_idempotency helpers are
--   SECURITY DEFINER with authenticated EXECUTE deliberately REVOKED (20260526201319),
--   guarded by a tripwire that RAISES if authenticated ever regains it (B10,
--   20260527020457). A SECURITY INVOKER body therefore CANNOT call them, and flipping
--   this RPC to SECURITY DEFINER would bypass the field-membership WITH CHECK. So the
--   dedup is implemented WITHOUT touching those shared primitives: a nullable
--   idempotency_key column on job_applied_records carrying a PARTIAL UNIQUE index. A
--   retried create replays the SAME key; the second INSERT trips the unique index and we
--   return the FIRST record's id instead of creating a duplicate. RLS stays fully in
--   force. This is the "thin insert-once" path the 20260629190000 header left open.
--
-- STRICT-ACTOR PRESERVED: this re-emit is based on the CURRENT LIVE body, which carries
-- the PARKED-004 strict-actor binding (created_by := auth.uid(); client cannot forge the
-- audit identity). That fix was applied live via the `parked_004_...` migration whose
-- file is not on main; re-emitting the full body here also restores it to main.
--
-- Em-dashes below are real U+2014. Money is not touched. No CHECK/enum changes.

-- ── 1. Dedup key column + partial unique index ──────────────────────────────
-- Nullable so the EDIT path and any key-less caller are unaffected (NULLs are not
-- unique-constrained by a partial index). One live/non-null key => at most one row.
ALTER TABLE public.job_applied_records
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_applied_records_idempotency_key
  ON public.job_applied_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.job_applied_records.idempotency_key IS
  'Insert-once dedup token for the CREATE path of save_job_applied_record. Set only on '
  'a new record; a retried create replays the same key and the partial UNIQUE index '
  'collapses it to the first row (no duplicate applied-record / no double-counted '
  'applied_acres). NULL on legacy/key-less rows and never set on edit.';

-- ── 2. Re-emit save_job_applied_record with p_idempotency_key ───────────────
-- Keep exactly ONE overload: drop the current 3-arg and any prior 4-arg draft so the
-- re-apply never leaves two signatures (overload-collision guard).
DROP FUNCTION IF EXISTS public.save_job_applied_record(jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.save_job_applied_record(jsonb, jsonb, jsonb, text);

CREATE FUNCTION public.save_job_applied_record(
  p_record jsonb,
  p_fields jsonb,
  p_crew jsonb DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record_id uuid;
  v_job_id uuid;
  v_actor uuid;
  v_result jsonb;
BEGIN
  -- PARKED-004 (codex-driven cycle 3 #2 HIGH): strict-actor — created_by is bound to
  -- auth.uid(); the client cannot supply (or forge) the audit identity.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_record_id := NULLIF(p_record->>'id', '')::uuid;
  v_job_id    := (p_record->>'job_id')::uuid;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Parent upsert ─────────────────────────────────────────────────────────
  IF v_record_id IS NULL THEN
    -- Insert-once: stamp the dedup key on the new row. A network-timeout retry
    -- replays the SAME key; the second INSERT trips the partial UNIQUE index, we
    -- catch it and RETURN the first record instead of creating a duplicate. Only the
    -- idempotency_key index can raise unique_violation on this table (the PK is a
    -- server-defaulted uuid); if the recovered id is NULL the violation came from
    -- something else, so re-raise.
    BEGIN
      INSERT INTO job_applied_records (
        job_id, applicator_id, vehicle_id, application_date, applied_acres, notes,
        start_weather_time, start_temp_f, start_wind_direction, start_wind_mph,
        start_humidity_pct, start_weather_source,
        end_weather_time, end_temp_f, end_wind_direction, end_wind_mph,
        end_humidity_pct, end_weather_source,
        beginning_tach, end_tach, created_by, idempotency_key
      )
      VALUES (
        v_job_id,
        NULLIF(p_record->>'applicator_id', '')::uuid,
        NULLIF(p_record->>'vehicle_id', '')::uuid,
        (p_record->>'application_date')::date,
        NULLIF(p_record->>'applied_acres', '')::numeric,
        NULLIF(p_record->>'notes', ''),
        NULLIF(p_record->>'start_weather_time', '')::time,
        NULLIF(p_record->>'start_temp_f', '')::numeric,
        NULLIF(p_record->>'start_wind_direction', ''),
        NULLIF(p_record->>'start_wind_mph', '')::numeric,
        NULLIF(p_record->>'start_humidity_pct', '')::numeric,
        NULLIF(p_record->>'start_weather_source', ''),
        NULLIF(p_record->>'end_weather_time', '')::time,
        NULLIF(p_record->>'end_temp_f', '')::numeric,
        NULLIF(p_record->>'end_wind_direction', ''),
        NULLIF(p_record->>'end_wind_mph', '')::numeric,
        NULLIF(p_record->>'end_humidity_pct', '')::numeric,
        NULLIF(p_record->>'end_weather_source', ''),
        NULLIF(p_record->>'beginning_tach', '')::numeric,
        NULLIF(p_record->>'end_tach', '')::numeric,
        v_actor,               -- strict-actor: bound to auth.uid()
        NULLIF(p_idempotency_key, '')
      )
      RETURNING id INTO v_record_id;
    EXCEPTION WHEN unique_violation THEN
      -- Recover the first record for THIS job + key. Scoping to v_job_id (not key
      -- alone) means a key accidentally reused across a DIFFERENT job re-raises the
      -- unique_violation (surfaced as an error) instead of silently returning — and
      -- appearing to "succeed" as — another job's record. The frontend also resets
      -- the key per new-record intent (openAdd), so a legitimate same-job retry is
      -- the only path that matches here.
      SELECT id INTO v_record_id
        FROM job_applied_records
       WHERE idempotency_key = NULLIF(p_idempotency_key, '')
         AND job_id = v_job_id;
      IF v_record_id IS NULL THEN
        RAISE;  -- not a same-job dedup-key collision — surface the real error
      END IF;
      -- Replay: the record already exists from the first (successful) call. Return it
      -- WITHOUT re-running the child writes (true insert-once semantics).
      RETURN jsonb_build_object('record_id', v_record_id);
    END;
  ELSE
    UPDATE job_applied_records SET
      applicator_id        = NULLIF(p_record->>'applicator_id', '')::uuid,
      vehicle_id           = NULLIF(p_record->>'vehicle_id', '')::uuid,
      application_date     = (p_record->>'application_date')::date,
      applied_acres        = NULLIF(p_record->>'applied_acres', '')::numeric,
      notes                = NULLIF(p_record->>'notes', ''),
      start_weather_time   = NULLIF(p_record->>'start_weather_time', '')::time,
      start_temp_f         = NULLIF(p_record->>'start_temp_f', '')::numeric,
      start_wind_direction = NULLIF(p_record->>'start_wind_direction', ''),
      start_wind_mph       = NULLIF(p_record->>'start_wind_mph', '')::numeric,
      start_humidity_pct   = NULLIF(p_record->>'start_humidity_pct', '')::numeric,
      start_weather_source = NULLIF(p_record->>'start_weather_source', ''),
      end_weather_time     = NULLIF(p_record->>'end_weather_time', '')::time,
      end_temp_f           = NULLIF(p_record->>'end_temp_f', '')::numeric,
      end_wind_direction   = NULLIF(p_record->>'end_wind_direction', ''),
      end_wind_mph         = NULLIF(p_record->>'end_wind_mph', '')::numeric,
      end_humidity_pct     = NULLIF(p_record->>'end_humidity_pct', '')::numeric,
      end_weather_source   = NULLIF(p_record->>'end_weather_source', ''),
      beginning_tach       = NULLIF(p_record->>'beginning_tach', '')::numeric,
      end_tach             = NULLIF(p_record->>'end_tach', '')::numeric
      -- idempotency_key intentionally NOT rewritten on edit: an edit is a pure
      -- re-upsert (naturally idempotent) and the create-time token must persist.
    WHERE id = v_record_id AND job_id = v_job_id;

    -- 0 rows = the row is invisible/unauthorized to the caller (RLS) or wrong job.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Applied record % not found or not editable', v_record_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- ── Child: per-location fields (always a full replacement) ────────────────
  -- The job_applied_record_fields INSERT RLS (Wave 2a) enforces field MEMBERSHIP:
  -- a foreign field_id RAISES here and rolls back the parent too.
  DELETE FROM job_applied_record_fields WHERE application_record_id = v_record_id;

  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) = 'array' THEN
    INSERT INTO job_applied_record_fields (application_record_id, field_id, applied_acres)
    SELECT v_record_id, (e->>'field_id')::uuid, (e->>'applied_acres')::numeric
    FROM jsonb_array_elements(p_fields) AS e;
  END IF;

  -- ── Child: ground crew (replace, preserving NULL-member legal snapshots) ──
  IF p_crew IS NOT NULL AND jsonb_typeof(p_crew) = 'array' THEN
    DELETE FROM job_applied_record_crew
    WHERE application_record_id = v_record_id AND member_id IS NOT NULL;

    INSERT INTO job_applied_record_crew (
      application_record_id, member_id, member_name_snapshot,
      crew_id_snapshot, crew_name_snapshot
    )
    SELECT
      v_record_id,
      (e->>'member_id')::uuid,
      e->>'member_name_snapshot',
      NULLIF(e->>'crew_id_snapshot', '')::uuid,
      NULLIF(e->>'crew_name_snapshot', '')
    FROM jsonb_array_elements(p_crew) AS e;
  END IF;

  v_result := jsonb_build_object('record_id', v_record_id);
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_job_applied_record(jsonb, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_job_applied_record(jsonb, jsonb, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.save_job_applied_record(jsonb, jsonb, jsonb, text) IS
  'Atomically upsert a job_applied_records entry plus its per-location field rows and '
  'ground-crew rows in ONE transaction (SECURITY INVOKER -> caller RLS, incl. the '
  'field-membership WITH CHECK, gates every write). Strict-actor: created_by := '
  'auth.uid(). p_idempotency_key stamps a dedup token on a NEW record; a retried create '
  'replays the same key and the partial UNIQUE index collapses it to the first row '
  '(insert-once, no duplicate applied-record). p_crew NULL skips the crew mutation '
  '(catalog-unavailable guard); an array replaces live crew rows while preserving '
  'member_id-NULL legal snapshots.';

-- ── 3. Self-verification (rolled-back-friendly; asserts shape, mutates nothing) ─
DO $$
DECLARE
  v_n int;
  v_args text;
BEGIN
  -- Exactly one overload, and it is the 4-arg signature.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_job_applied_record';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'save_job_applied_record must have exactly ONE overload, found %', v_n;
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_job_applied_record';
  IF v_args NOT LIKE '%p_idempotency_key text%' THEN
    RAISE EXCEPTION 'save_job_applied_record is missing p_idempotency_key: %', v_args;
  END IF;

  -- Stays SECURITY INVOKER (RLS must keep gating every write).
  IF (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_job_applied_record') THEN
    RAISE EXCEPTION 'save_job_applied_record must remain SECURITY INVOKER';
  END IF;

  -- The dedup index exists and is unique + partial.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'job_applied_records'
       AND indexname = 'uq_job_applied_records_idempotency_key'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%idempotency_key IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'partial unique index uq_job_applied_records_idempotency_key missing';
  END IF;

  -- authenticated retains EXECUTE (the field UI calls it); anon does not.
  IF NOT has_function_privilege('authenticated',
        'public.save_job_applied_record(jsonb, jsonb, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must retain EXECUTE on save_job_applied_record';
  END IF;
  IF has_function_privilege('anon',
        'public.save_job_applied_record(jsonb, jsonb, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must NOT have EXECUTE on save_job_applied_record';
  END IF;
END $$;
