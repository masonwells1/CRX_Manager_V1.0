-- 20260630120000_job_proof_data.sql
-- Beyond-parity §6 (2026-06-30): "Your Field Was Sprayed" proof notification.
-- ---------------------------------------------------------------------------
-- This section enriches the parity §41 post-application notice into a RICH PROOF
-- the office reviews and one-taps to the grower: field name + acres, products
-- applied, weather at application, applicator, a boundary-map representation, and
-- safe re-entry/harvest (REI/PHI) timing.
--
-- The SEND + LOG + idempotency infrastructure already exists and is REUSED VERBATIM
-- (NOT rebuilt here):
--   * table public.job_notifications            (#40 — per-recipient log, RLS, RPC-only writes)
--   * record_job_post_notifications(...)         (#41 — resolves billed customers, logs a row each,
--                                                 per-recipient deterministic idempotency key)
--   * confirm_job_notification_sent(...)         (#40 — flips a row failed->sent after the email goes out)
--   * email_type 'post_application_notice'       (allow-listed in the send-email edge fn; deploy GATED)
--   * post_application_notice_template app_setting (#41 — owner-editable wording)
--
-- This migration adds ONLY a READ-ONLY data gatherer:
--   get_job_proof_data(p_job_id) — returns, in ONE call, the proof inputs the
--   frontend assembles into the rich message body (proofNotification.ts):
--     job number / application date / applicator name,
--     fields (name, county, state, resolved effective acres, centroid + boundary
--       GeoJSON for the boundary-map representation, planned harvest date),
--     products applied (name, per-acre rate + unit, REI hours, PHI days, signal word),
--     weather at application (from job_applied_info, when captured).
--   Each block degrades gracefully — a job with no applied weather, no field
--   boundary, or no REI/PHI on a product still returns (those fields are NULL and
--   the frontend simply omits that block; it never crashes).
--
-- It is STABLE + read-only (NO mutation), so it carries NO idempotency key — there
-- is nothing to de-dupe. It is SECURITY DEFINER (it reads PostGIS centroid/boundary
-- the applicator-scoped RLS would otherwise filter), self-gates to admin/sales_rep
-- (the office roles that send the proof), and SETs search_path. anon is rejected.
--
-- ADDITIVE ONLY: one new read-only function. No existing object is dropped or
-- rewritten. Em-dashes below are real U+2014.

-- ── get_job_proof_data ───────────────────────────────────────────────────────
-- Single overload (verified: no existing get_job_proof_data). Drop a would-be prior
-- signature defensively before (re)creating.
DROP FUNCTION IF EXISTS public.get_job_proof_data(uuid);

CREATE OR REPLACE FUNCTION public.get_job_proof_data(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor   uuid;
  v_role    text;
  v_job     record;
  v_season  int;
  v_fields  jsonb := '[]'::jsonb;
  v_products jsonb := '[]'::jsonb;
  v_weather jsonb := NULL;
  v_result  jsonb;
BEGIN
  -- Role gate: the proof is an office sending tool (admin/sales_rep) — the same
  -- roles record_job_post_notifications allows. An applicator does NOT send proofs
  -- (and the boundary GeoJSON here would otherwise bypass their field-scoped RLS).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  -- Load the job header + the applicator's display name. Validates the job exists.
  SELECT j.id, j.job_number, j.status, j.job_date, j.season, j.applicator_id,
         pr.full_name AS applicator_name
  INTO v_job
  FROM jobs j
  LEFT JOIN profiles pr ON pr.id = j.applicator_id
  WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;
  v_season := v_job.season;

  -- ── Fields (in route order) with effective acres + boundary/centroid GeoJSON ──
  -- Effective acres precedence mirrors the per-acre billing engine: override_acres
  -- (hand-set) > measured_acres (from the drawn/imported boundary) > total_acres
  -- (the legacy hand-entered figure). The boundary-map representation uses the
  -- centroid (always) and the boundary polygon GeoJSON (when a boundary exists).
  -- The field's planned harvest date for THIS season feeds the PHI window.
  SELECT COALESCE(jsonb_agg(fr ORDER BY (fr->>'sort_order')::int NULLS LAST, fr->>'field_name'), '[]'::jsonb)
  INTO v_fields
  FROM (
    SELECT jsonb_build_object(
      'field_id',         f.id,
      'field_name',       f.field_name,
      'county',           f.county,
      'state',            f.state,
      'acres',            GREATEST(COALESCE(f.override_acres, f.measured_acres, f.total_acres, 0), 0),
      'acres_source',     CASE
                            WHEN f.override_acres IS NOT NULL THEN 'override'
                            WHEN f.measured_acres IS NOT NULL THEN 'measured'
                            WHEN f.total_acres   IS NOT NULL THEN 'total'
                            ELSE NULL END,
      'centroid_geojson', ST_AsGeoJSON(f.centroid)::text,
      'boundary_geojson', ST_AsGeoJSON(COALESCE(f.boundary_geom, f.boundary::geometry))::text,
      'harvest_date',     (
                            SELECT to_char(fch.harvest_date, 'YYYY-MM-DD')
                            FROM field_crop_history fch
                            WHERE fch.field_id = f.id
                              AND (v_season IS NULL OR fch.season = v_season)
                              AND fch.harvest_date IS NOT NULL
                            ORDER BY fch.season DESC NULLS LAST, fch.harvest_date DESC
                            LIMIT 1
                          ),
      'sort_order',       jf.sort_order
    ) AS fr
    FROM job_fields jf
    JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id
  ) s;

  -- ── Products applied, with REI/PHI + signal word for the safe-timing block ──
  -- Prefer the job line's own rei_hours/phi_days (captured at job time); fall back
  -- to the product master when the line is blank (a product with no REI/PHI on file
  -- yields NULL — the frontend renders "—" and the harvest warning is 'unknown',
  -- never an error).
  SELECT COALESCE(jsonb_agg(pr ORDER BY (pr->>'sort_order')::int NULLS LAST, pr->>'product_name'), '[]'::jsonb)
  INTO v_products
  FROM (
    SELECT jsonb_build_object(
      'product_name',     p.product_name,
      'rate_per_acre',    jc.rate_per_acre,
      'rate_unit',        jc.rate_unit,
      'rei_hours',        COALESCE(jc.rei_hours, p.rei_hours),
      'phi_days',         COALESCE(jc.phi_days, p.phi_days),
      'signal_word',      p.signal_word,
      'epa_registration', p.epa_registration,
      'sort_order',       jc.sort_order
    ) AS pr
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id
  ) s;

  -- ── Weather at application (job_applied_info) — graceful NULL when not captured ──
  -- A job whose applicator never recorded as-applied weather simply has no weather
  -- block in the proof (the frontend omits it). Only the most-recent applied-info row
  -- is used (one per job in practice).
  SELECT jsonb_build_object(
           'temperature',    ja.temperature,
           'wind_speed',     ja.wind_speed,
           'wind_direction', ja.wind_direction,
           'humidity',       ja.humidity,
           'actual_start',   ja.actual_start_time,
           'actual_end',     ja.actual_end_time
         )
  INTO v_weather
  FROM job_applied_info ja
  WHERE ja.job_id = p_job_id
    AND (ja.temperature IS NOT NULL
         OR ja.wind_speed IS NOT NULL
         OR ja.wind_direction IS NOT NULL
         OR ja.humidity IS NOT NULL)
  ORDER BY ja.updated_at DESC NULLS LAST, ja.created_at DESC
  LIMIT 1;

  v_result := jsonb_build_object(
    'job_id',           v_job.id,
    'job_number',       v_job.job_number,
    'status',           v_job.status,
    'application_date', to_char(v_job.job_date, 'YYYY-MM-DD'),
    'applicator_name',  v_job.applicator_name,
    'fields',           v_fields,
    'products',         v_products,
    'weather',          v_weather   -- NULL when no weather captured
  );

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_job_proof_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_proof_data(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_job_proof_data(uuid) IS
  'Beyond-parity §6: read-only gatherer for the "your field was sprayed" proof — '
  'returns job/applicator, fields (effective acres + centroid/boundary GeoJSON + harvest '
  'date), products (REI/PHI/signal word), and weather at application in one jsonb. '
  'Each block degrades gracefully (NULL when not on file). STABLE; SECURITY DEFINER; '
  'admin/sales_rep only; no mutation so no idempotency key.';

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_job_proof_data';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_job_proof_data overload count is % (expected 1)', v_count;
  END IF;

  -- search_path is set on the function
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'get_job_proof_data' AND pronamespace = 'public'::regnamespace
       AND array_to_string(proconfig, ',') ILIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'get_job_proof_data is missing SET search_path';
  END IF;

  -- anon must NOT have EXECUTE
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_name = 'get_job_proof_data' AND grantee = 'anon' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon still has EXECUTE on get_job_proof_data';
  END IF;
END $$;
