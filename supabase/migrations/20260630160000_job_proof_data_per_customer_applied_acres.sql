-- 20260630160000_job_proof_data_per_customer_applied_acres.sql
-- Beyond-parity §6 FOLLOW-UP (2026-06-30): per-customer scoping + APPLIED acres.
-- ---------------------------------------------------------------------------
-- Three customer-facing fixes to the §6 "your field was sprayed" proof, found by the
-- orchestrator's independent Codex pass:
--
--   P1 (CROSS-CUSTOMER LEAK): get_job_proof_data(uuid) returns EVERY field on the job.
--     On a split-billing job (different customers on different fields) the frontend send
--     loop sent that same full-job payload to every recipient — so customer A's proof
--     email named customer B's fields/maps/acres. FIX: this RPC now accepts an optional
--     p_customer_id; when supplied, it returns ONLY the fields that resolve to THAT
--     customer, using the SAME precedence the recipient resolver / get_job_billed_customers
--     uses (explicit job_field_shares -> field_billing_defaults -> the job's primary
--     customer). The frontend calls it once PER recipient with their customer_id, so a
--     proof email can never name another customer's field. p_customer_id = NULL keeps the
--     original whole-job behavior (the office preview before a recipient is chosen).
--
--   P2 (ACRES = SPRAYED, not the master field's billable acres): the proof reported
--     fields.override_acres/measured_acres/total_acres (the WHOLE field). A 40-ac
--     application on a 160-ac field showed 160. FIX: report the job's APPLIED acreage per
--     field from job_applied_record_fields.applied_acres (the same source §2 watchdog and
--     §5 guardrails use), joined via job_applied_records.job_id; fall back to the field's
--     effective acres only when there is NO applied record for that field (graceful — a
--     job that pre-dates as-applied capture still shows a sensible figure). acres_source
--     now distinguishes 'applied' from the master-acre fallbacks.
--
--   (P1 PHI earliest-harvest is a pure-frontend fix in proofNotification.ts — no DB change.)
--
-- DROP + recreate (the arity changes uuid -> uuid,uuid, so a plain CREATE OR REPLACE would
-- leave TWO overloads — the migration-drift bug class). Single overload preserved + asserted.
-- STABLE, read-only (NO mutation) -> no idempotency key. SECURITY DEFINER (reads PostGIS
-- centroid/boundary the applicator RLS would filter), search_path incl. extensions for
-- PostGIS, anon revoked, admin/sales_rep gate as the first executable statement.
-- ADDITIVE: only this one function changes. Em-dashes below are real U+2014.

-- Drop the old 1-arg signature so we never carry a stale overload alongside the new one.
DROP FUNCTION IF EXISTS public.get_job_proof_data(uuid);
-- Defensive: if a prior run of THIS migration already created the 2-arg form, drop it too.
DROP FUNCTION IF EXISTS public.get_job_proof_data(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_job_proof_data(
  p_job_id      uuid,
  p_customer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor               uuid;
  v_role                text;
  v_primary_customer_id uuid;
  v_job                 record;
  v_season              int;
  v_fields              jsonb := '[]'::jsonb;
  v_products            jsonb := '[]'::jsonb;
  v_weather             jsonb := NULL;
  v_result              jsonb;
BEGIN
  -- Role gate (office sending tool — admin/sales_rep). First executable statement.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  -- Job header + applicator display name. Validates the job exists.
  SELECT j.id, j.job_number, j.status, j.job_date, j.season, j.customer_id, j.applicator_id,
         pr.full_name AS applicator_name
  INTO v_job
  FROM jobs j
  LEFT JOIN profiles pr ON pr.id = j.applicator_id
  WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;
  v_season := v_job.season;
  v_primary_customer_id := v_job.customer_id;

  -- ── Resolve each job field to its OWNING customer (same precedence as the recipient
  -- resolver / get_job_billed_customers): explicit job_field_shares, else
  -- field_billing_defaults, else the job's primary customer. One row per (field) with the
  -- resolved customer_id, so we can filter to p_customer_id when scoping a recipient's proof.
  -- ── Per-field APPLIED acres come from job_applied_record_fields (the real sprayed acres,
  -- the §2/§5 source) joined via job_applied_records; fall back to the field's effective
  -- acres (override > measured > total) only when no applied record treated that field.
  SELECT COALESCE(jsonb_agg(fr ORDER BY (fr->>'sort_order')::int NULLS LAST, fr->>'field_name'), '[]'::jsonb)
  INTO v_fields
  FROM (
    SELECT jsonb_build_object(
      'field_id',         f.id,
      'field_name',       f.field_name,
      'county',           f.county,
      'state',            f.state,
      'acres',            CASE
                            WHEN applied.applied_acres IS NOT NULL
                              THEN GREATEST(applied.applied_acres, 0)
                            ELSE GREATEST(COALESCE(f.override_acres, f.measured_acres, f.total_acres, 0), 0)
                          END,
      'acres_source',     CASE
                            WHEN applied.applied_acres IS NOT NULL THEN 'applied'
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
    -- the customer this field bills to (precedence resolver)
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        (SELECT jfs.customer_id FROM job_field_shares jfs
          WHERE jfs.job_id = p_job_id AND jfs.field_id = f.id AND jfs.customer_id IS NOT NULL
          LIMIT 1),
        (SELECT fbd.customer_id FROM field_billing_defaults fbd
          WHERE fbd.field_id = f.id AND fbd.customer_id IS NOT NULL
          LIMIT 1),
        v_primary_customer_id
      ) AS owner_customer_id
    ) own
    -- the real sprayed acres for this field on this job (NULL when none recorded)
    LEFT JOIN LATERAL (
      SELECT SUM(rf.applied_acres) AS applied_acres
      FROM job_applied_records r
      JOIN job_applied_record_fields rf
        ON rf.application_record_id = r.id AND rf.field_id = f.id
      WHERE r.job_id = p_job_id AND rf.applied_acres IS NOT NULL
      HAVING SUM(rf.applied_acres) > 0
    ) applied ON true
    WHERE jf.job_id = p_job_id
      -- scope to ONE customer's fields when a recipient is given (P1 leak fix)
      AND (p_customer_id IS NULL OR own.owner_customer_id = p_customer_id)
  ) s;

  -- ── Products applied (job-wide — the same tank mix went on every field). REI/PHI prefer
  -- the job line's captured value, else the product master. Unchanged by the scoping fix.
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

  -- ── Weather at application (job-wide). Graceful NULL when not captured. Unchanged.
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
    'scoped_customer_id', p_customer_id,   -- echoes the scope (NULL = whole job)
    'fields',           v_fields,
    'products',         v_products,
    'weather',          v_weather
  );

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_job_proof_data(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_proof_data(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_job_proof_data(uuid, uuid) IS
  'Beyond-parity §6 (per-customer + applied acres): read-only gatherer for the "your field '
  'was sprayed" proof. p_customer_id scopes the returned fields to ONE billed customer '
  '(job_field_shares -> field_billing_defaults -> primary precedence) so a split-billed '
  'recipient never sees another customer''s field; NULL = whole job (office preview). '
  'Per-field acres = job_applied_record_fields.applied_acres (real sprayed acres) when '
  'present, else the field''s effective acres. STABLE; SECURITY DEFINER; admin/sales_rep only.';

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload (the new 2-arg form; the old 1-arg form is dropped)
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_job_proof_data';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_job_proof_data overload count is % (expected 1)', v_count;
  END IF;

  -- search_path set
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
