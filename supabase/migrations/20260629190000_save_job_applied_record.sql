-- 20260629190000_save_job_applied_record.sql
--
-- FIELD-APP PARITY remediation (Wave 2b, FIX 4 — P2 non-atomic as-applied save).
--
-- THE BUG (AppliedRecordsManager.tsx handleSave): the as-applied entry save runs the
-- parent UPDATE/INSERT, the child job_applied_record_fields delete+insert, and the
-- child job_applied_record_crew delete+insert as 3-4 SEPARATE PostgREST requests. If
-- the insert fails AFTER the delete commits, the per-location / crew detail is lost
-- and the recompute trigger settles the parent's applied_acres to 0 (self-correcting
-- on retry, but a real robustness gap — and #21 crew rows share the same risk).
--
-- THE FIX: a SECURITY INVOKER RPC that does parent upsert + BOTH child replacements in
-- ONE transaction (a function body is a single transaction; any RAISE rolls the WHOLE
-- thing back, parent included). SECURITY INVOKER = the caller's own RLS applies — so:
--   * the parent job_applied_records insert/update policy (admin/sales/own-applicator),
--   * the job_applied_record_fields field-MEMBERSHIP policy (Wave 2a 20260629150000:
--     a foreign field_id fails WITH CHECK -> RAISE -> rollback),
--   * the job_applied_record_crew parent-auth policy,
-- ALL gate the writes exactly as the per-request path did. No SECURITY DEFINER means no
-- new authorization surface; this purely makes the EXISTING save atomic.
--
-- p_crew SEMANTICS (preserves the client's catalog-unavailable guard):
--   * p_crew IS NULL          -> SKIP the crew mutation entirely (the client passes
--                                NULL when the ground-crew catalog failed to load, so
--                                an edit never silently clears live crew on a stale UI).
--   * p_crew = '[]' or array  -> REPLACE the entry's live crew: delete only rows with
--                                member_id IS NOT NULL (PRESERVING member_id-NULL legal
--                                snapshots — the durable "who was on the crew that day"
--                                record), then insert the provided rows. Mirrors the
--                                component's `.delete().not('member_id','is',null)`.
-- p_fields is ALWAYS a replacement set (delete-all-then-insert); '[]' clears locations.
--
-- IDEMPOTENCY — DELIBERATELY OMITTED (and why no p_idempotency_key here): the
-- canonical idempotency table is RLS-locked to NO direct client access, and its
-- definer helpers check_idempotency / save_idempotency have authenticated EXECUTE
-- intentionally REVOKED (migration 20260526201319; the B10 guard in 20260527020457
-- RAISES if authenticated ever regains it). Those helpers are therefore usable ONLY
-- from a SECURITY DEFINER body. This RPC is SECURITY INVOKER BY DESIGN (so the caller's
-- own RLS — including the Wave-2a field-membership WITH CHECK — gates every write); it
-- consequently CANNOT touch idempotency_keys directly (RLS-denied) NOR call the definer
-- helpers (no EXECUTE). Accepting a p_idempotency_key it can't honor would be a broken
-- contract (Codex P2). The save is naturally re-runnable instead: an EDIT is a pure
-- upsert+replace (re-running yields the same state), and an ADD without a key just
-- creates another row on a duplicate submit — the same exposure the prior per-request
-- save path had, and the modal's `saving` flag already debounces the button. If true
-- insert-once semantics are ever needed, the idempotency must move to a thin SECURITY
-- DEFINER wrapper, not this invoker body.
--
-- Returns the saved record id as jsonb { record_id }. Single overload (verified: no
-- existing save_job_applied_record). Em-dashes below are real U+2014.

-- Keep exactly ONE overload: drop any prior 4-arg (…, p_idempotency_key text) draft
-- so a re-apply never leaves two signatures (overload-collision guard). No-op on a
-- clean DB.
DROP FUNCTION IF EXISTS public.save_job_applied_record(jsonb, jsonb, jsonb, text);

CREATE OR REPLACE FUNCTION public.save_job_applied_record(
  p_record jsonb,
  p_fields jsonb,
  p_crew jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record_id uuid;
  v_job_id uuid;
  v_result jsonb;
BEGIN
  v_record_id := NULLIF(p_record->>'id', '')::uuid;
  v_job_id    := (p_record->>'job_id')::uuid;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Parent upsert ─────────────────────────────────────────────────────────
  IF v_record_id IS NULL THEN
    INSERT INTO job_applied_records (
      job_id, applicator_id, vehicle_id, application_date, applied_acres, notes,
      start_weather_time, start_temp_f, start_wind_direction, start_wind_mph,
      start_humidity_pct, start_weather_source,
      end_weather_time, end_temp_f, end_wind_direction, end_wind_mph,
      end_humidity_pct, end_weather_source,
      beginning_tach, end_tach, created_by
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
      NULLIF(p_record->>'created_by', '')::uuid
    )
    RETURNING id INTO v_record_id;
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
    WHERE id = v_record_id AND job_id = v_job_id;

    -- 0 rows = the row is invisible/unauthorized to the caller (RLS) or wrong job.
    -- Treat as a hard failure so we never silently fall through to child writes.
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
  -- p_crew NULL = catalog unavailable on the client -> leave crew untouched.
  IF p_crew IS NOT NULL AND jsonb_typeof(p_crew) = 'array' THEN
    -- Delete ONLY live-member rows; a member_id-NULL row is the durable legal
    -- proof of who was present and must survive an edit (mirrors the component's
    -- `.delete().not('member_id','is',null)`).
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

REVOKE EXECUTE ON FUNCTION public.save_job_applied_record(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_job_applied_record(jsonb, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.save_job_applied_record(jsonb, jsonb, jsonb) IS
  'Field-app FIX 4 (Wave 2b): atomically upsert a job_applied_records entry plus its '
  'per-location field rows and ground-crew rows in ONE transaction (SECURITY INVOKER '
  '-> caller RLS, incl. the field-membership WITH CHECK, gates every write). p_crew '
  'NULL skips the crew mutation (catalog-unavailable guard); an array replaces live '
  'crew rows while preserving member_id-NULL legal snapshots. Replaces the prior '
  'non-atomic delete-then-insert save path.';
