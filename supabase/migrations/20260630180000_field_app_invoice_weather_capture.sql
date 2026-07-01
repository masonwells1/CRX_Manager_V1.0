-- ChemMan Gap-Closeout #1 — Weather auto-fill on the field-application invoice.
--
-- Adds the structured START/END weather model (mirroring job_applied_records)
-- to the invoices table so a field-application invoice can capture one-tap
-- weather (Open-Meteo) per application, with a manual-override audit flag.
--
-- SAFETY: invoices is the MONEY table. Every column added here is ADDITIVE and
-- NULLABLE — no NOT NULL, no new CHECK (invoices already has 6 CHECK constraints;
-- these columns touch none of them). The existing manual free-text weather
-- columns (wind_direction, temperature_text) are PRESERVED untouched; the new
-- structured columns live alongside them for back-compat/legacy display. RLS on
-- invoices is unchanged.
--
-- Column types mirror job_applied_records EXACTLY:
--   *_temp_f / *_wind_mph / *_humidity_pct  -> numeric
--   *_wind_direction / *_weather_source     -> text
--   *_weather_time                          -> time without time zone
-- plus weather_manual_override boolean DEFAULT false (the audit flag).

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS start_temp_f          numeric,
  ADD COLUMN IF NOT EXISTS start_wind_mph        numeric,
  ADD COLUMN IF NOT EXISTS start_wind_direction  text,
  ADD COLUMN IF NOT EXISTS start_humidity_pct    numeric,
  ADD COLUMN IF NOT EXISTS start_weather_time    time without time zone,
  ADD COLUMN IF NOT EXISTS start_weather_source  text,
  ADD COLUMN IF NOT EXISTS end_temp_f            numeric,
  ADD COLUMN IF NOT EXISTS end_wind_mph          numeric,
  ADD COLUMN IF NOT EXISTS end_wind_direction    text,
  ADD COLUMN IF NOT EXISTS end_humidity_pct      numeric,
  ADD COLUMN IF NOT EXISTS end_weather_time      time without time zone,
  ADD COLUMN IF NOT EXISTS end_weather_source    text,
  ADD COLUMN IF NOT EXISTS weather_manual_override boolean DEFAULT false;

COMMENT ON COLUMN public.invoices.start_weather_source IS
  'Provenance of the START weather set: ''auto'' (fetched from Open-Meteo) or ''manual'' (hand-entered/edited). NULL when no START weather captured.';
COMMENT ON COLUMN public.invoices.end_weather_source IS
  'Provenance of the END weather set: ''auto'' or ''manual''. NULL when no END weather captured.';
COMMENT ON COLUMN public.invoices.weather_manual_override IS
  'TRUE when the user hand-edited any auto-filled weather value (compliance audit flag). Weather is modeled, not measured.';

-- ── Extend update_field_app_applied_info DRIFT-SAFE ──────────────────────────
-- Cloned VERBATIM from the live source (migration 20260622030000) with ONLY
-- additive DEFAULT NULL params + the new structured-weather column writes. The
-- strict-actor bind, the admin/sales gate, the idempotency lookup/insert, the
-- invoice_type='field_application' AND status IN ('draft','unposted') guard, and
-- SET search_path are all unchanged.
--
-- DRIFT GUARD: adding params changes the function's argument SIGNATURE, so a bare
-- CREATE OR REPLACE would leave the OLD 6-arg overload in place (and a 6-arg call
-- would then be AMBIGUOUS between the two). We DROP the exact old signature first,
-- then create the single new superset signature — exactly ONE overload remains.
-- (Also drop the 19-arg shape defensively so a re-apply after a partial run can't
-- leave two superset overloads — idempotent regardless of prior state.)
DROP FUNCTION IF EXISTS public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text
);
DROP FUNCTION IF EXISTS public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean
);

CREATE OR REPLACE FUNCTION public.update_field_app_applied_info(
  p_invoice_ids uuid[],
  p_wind_direction text DEFAULT NULL::text,
  p_temperature_text text DEFAULT NULL::text,
  p_applicator_name text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  -- New (additive) structured START/END weather. NULL-default so the existing
  -- 6-arg callers keep working unchanged; passing these writes the new columns.
  p_start_temp_f numeric DEFAULT NULL::numeric,
  p_start_wind_mph numeric DEFAULT NULL::numeric,
  p_start_wind_direction text DEFAULT NULL::text,
  p_start_humidity_pct numeric DEFAULT NULL::numeric,
  p_start_weather_time time DEFAULT NULL::time,
  p_start_weather_source text DEFAULT NULL::text,
  p_end_temp_f numeric DEFAULT NULL::numeric,
  p_end_wind_mph numeric DEFAULT NULL::numeric,
  p_end_wind_direction text DEFAULT NULL::text,
  p_end_humidity_pct numeric DEFAULT NULL::numeric,
  p_end_weather_time time DEFAULT NULL::time,
  p_end_weather_source text DEFAULT NULL::text,
  p_weather_manual_override boolean DEFAULT NULL::boolean,
  -- Sentinel: only TRUE callers (the new field-app invoice UI) intend to write the
  -- structured weather columns. A stale OLD-bundle tab calls the 6-arg form, where this
  -- defaults to FALSE, so its NULL weather params are NOT written — captured weather is
  -- preserved (NULL-param "omitted" must not erase compliance data). When TRUE, the
  -- weather columns are written exactly as passed (NULL there = an intentional clear).
  p_update_weather boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_expected int;
  v_updated  int;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save applied info';
  END IF;

  v_expected := COALESCE(array_length(p_invoice_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'At least one invoice id is required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'update_field_app_applied_info';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Validate the structured weather at the RPC layer (equivalent to job_applied_records'
  -- DB CHECKs, but kept OFF the invoices money table — invoices must not gain a new CHECK).
  -- Reject only physically-impossible values; NULLs (unentered) always pass. Wind speed and
  -- humidity cannot be negative; humidity is a 0-100 percentage; the source flag, when set,
  -- must be 'auto' or 'manual'. Temperature is left unbounded (legitimately can be sub-zero F).
  IF p_start_wind_mph IS NOT NULL AND p_start_wind_mph < 0
     OR p_end_wind_mph IS NOT NULL AND p_end_wind_mph < 0 THEN
    RAISE EXCEPTION 'Wind speed cannot be negative';
  END IF;
  IF p_start_humidity_pct IS NOT NULL AND (p_start_humidity_pct < 0 OR p_start_humidity_pct > 100)
     OR p_end_humidity_pct IS NOT NULL AND (p_end_humidity_pct < 0 OR p_end_humidity_pct > 100) THEN
    RAISE EXCEPTION 'Humidity must be between 0 and 100 percent';
  END IF;
  IF p_start_weather_source IS NOT NULL AND p_start_weather_source NOT IN ('auto', 'manual')
     OR p_end_weather_source IS NOT NULL AND p_end_weather_source NOT IN ('auto', 'manual') THEN
    RAISE EXCEPTION 'Weather source must be auto or manual';
  END IF;

  -- Only editable field-application invoices — never a posted/voided row or a non-field invoice.
  -- Structured weather columns are written ONLY when p_update_weather = TRUE (the new UI). A
  -- stale 6-arg caller leaves p_update_weather = FALSE, so each weather column keeps its current
  -- value (= column) — captured weather is never silently erased by an old-bundle save. When the
  -- new UI saves (TRUE), the weather columns are written exactly as passed (NULL there = an
  -- intentional clear, mirroring the legacy free-text "blank clears" behavior).
  UPDATE invoices SET
    wind_direction          = p_wind_direction,
    temperature_text        = p_temperature_text,
    applicator_name         = p_applicator_name,
    start_temp_f            = CASE WHEN p_update_weather THEN p_start_temp_f         ELSE start_temp_f         END,
    start_wind_mph          = CASE WHEN p_update_weather THEN p_start_wind_mph       ELSE start_wind_mph       END,
    start_wind_direction    = CASE WHEN p_update_weather THEN p_start_wind_direction ELSE start_wind_direction END,
    start_humidity_pct      = CASE WHEN p_update_weather THEN p_start_humidity_pct   ELSE start_humidity_pct   END,
    start_weather_time      = CASE WHEN p_update_weather THEN p_start_weather_time   ELSE start_weather_time   END,
    start_weather_source    = CASE WHEN p_update_weather THEN p_start_weather_source ELSE start_weather_source END,
    end_temp_f              = CASE WHEN p_update_weather THEN p_end_temp_f           ELSE end_temp_f           END,
    end_wind_mph            = CASE WHEN p_update_weather THEN p_end_wind_mph         ELSE end_wind_mph         END,
    end_wind_direction      = CASE WHEN p_update_weather THEN p_end_wind_direction   ELSE end_wind_direction   END,
    end_humidity_pct        = CASE WHEN p_update_weather THEN p_end_humidity_pct     ELSE end_humidity_pct     END,
    end_weather_time        = CASE WHEN p_update_weather THEN p_end_weather_time     ELSE end_weather_time     END,
    end_weather_source      = CASE WHEN p_update_weather THEN p_end_weather_source   ELSE end_weather_source   END,
    weather_manual_override = CASE WHEN p_update_weather THEN COALESCE(p_weather_manual_override, false) ELSE weather_manual_override END,
    updated_at              = now()
  WHERE id = ANY(p_invoice_ids)
    AND invoice_type = 'field_application'
    AND status IN ('draft', 'unposted');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'Applied info update affected % of % invoice(s) — some are not editable field-application invoices', v_updated, v_expected;
  END IF;

  v_result := jsonb_build_object('updated', v_updated);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'update_field_app_applied_info', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- DROP + recreate reset EXECUTE privileges to the Postgres PUBLIC default. Re-apply the
-- exact lockdown the original migration (20260622030000) established on the old signature
-- so the new 19-arg signature keeps the same least-privilege grant posture (authenticated
-- only; the body also self-gates on auth.uid() + admin/sales). Keyed to the NEW signature.
REVOKE ALL ON FUNCTION public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean, boolean
) TO authenticated;
