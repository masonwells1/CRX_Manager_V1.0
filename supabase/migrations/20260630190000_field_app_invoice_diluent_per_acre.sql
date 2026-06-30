-- ChemMan Gap-Closeout #2 — Diluent / carrier-water per acre on the field-application invoice.
--
-- Adds a diluent (carrier-water) RATE-PER-ACRE input on the field-application
-- invoice, mirroring the existing JOB-side gal/acre concept (jobs.carrier_rate_gpa
-- / job_chemicals.diluent_rate). The invoice can be engine-built with no source
-- job, so the rate is entered ON the invoice — it cannot always inherit the job's.
--
-- SAFETY: invoices is the MONEY table. The one column added here is ADDITIVE and
-- NULLABLE — no NOT NULL, no new CHECK (invoices already has 6 CHECK constraints;
-- this column touches none of them). Diluent is a QUANTITY (numeric gallons per
-- acre), NOT money — it is never cents. RLS on invoices is unchanged.
--
-- TOTAL is NOT a generated column (deliberate — see below):
--   The total diluent = rate x the invoice's applied-acres aggregate. The obvious
--   choice would be `diluent_total_gallons GENERATED ALWAYS AS (diluent_rate_gpa *
--   total_acres) STORED` mirroring invoices.balance_cents. BUT the live
--   save_field_app_invoice RPC does NOT write invoices.total_acres (verified
--   2026-06-30: its INSERT/UPDATE column lists omit total_acres; it writes
--   total_acres only to field_app_locations, and real-saved invoice rows carry
--   total_acres = NULL). A generated total tied to total_acres would therefore be
--   NULL even when a rate IS entered — failing the "computed total is shown and
--   persisted" criterion. So we persist the RATE ONLY here, and compute the total
--   (rate x the live applied-acres aggregate) for the on-screen display and the
--   printed PDF, where the aggregate is reliably available. No total column, no
--   generated column, no RPC total-write.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS diluent_rate_gpa numeric;

COMMENT ON COLUMN public.invoices.diluent_rate_gpa IS
  'Diluent / carrier-water rate in gallons per acre for this field-application invoice (mirrors jobs.carrier_rate_gpa). NULL = not recorded. A QUANTITY, never money/cents. The total diluent (rate x applied acres) is computed for display/PDF, not stored, because invoices.total_acres is not reliably written on save.';

-- ── Extend update_field_app_applied_info DRIFT-SAFE ──────────────────────────
-- Cloned VERBATIM from the live source (the 20-arg superset that Stage 1's
-- migration 20260630180000 established) with ONLY two additive params:
--   p_diluent_rate_gpa numeric DEFAULT NULL  -- the rate to write
--   p_update_diluent   boolean DEFAULT false -- sentinel (mirrors p_update_weather)
-- and the new diluent_rate_gpa column write. Everything else (strict-actor bind,
-- admin/sales gate, idempotency lookup/insert, weather validation + writes, the
-- invoice_type='field_application' AND status IN ('draft','unposted') guard, and
-- SET search_path) is byte-for-byte the live body.
--
-- DRIFT GUARD: adding params changes the function's argument SIGNATURE, so a bare
-- CREATE OR REPLACE would leave the OLD 20-arg overload in place (and a 20-arg call
-- would then be AMBIGUOUS between the two). We DROP the exact current signature
-- first, then create the single new 22-arg superset — exactly ONE overload remains.
-- (Also drop the 22-arg shape defensively so a re-apply after a partial run can't
-- leave two superset overloads — idempotent regardless of prior state.)
DROP FUNCTION IF EXISTS public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean, boolean
);
DROP FUNCTION IF EXISTS public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean, boolean,
  numeric, boolean
);

CREATE OR REPLACE FUNCTION public.update_field_app_applied_info(
  p_invoice_ids uuid[],
  p_wind_direction text DEFAULT NULL::text,
  p_temperature_text text DEFAULT NULL::text,
  p_applicator_name text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  -- Structured START/END weather (Stage 1). NULL-default so the original 6-arg
  -- callers keep working unchanged; written only when p_update_weather = TRUE.
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
  p_update_weather boolean DEFAULT false,
  -- New (additive) diluent / carrier-water rate per acre. NULL-default so the
  -- existing callers keep working unchanged; passing p_update_diluent = TRUE writes
  -- the column (NULL there = an intentional clear, mirroring the weather sentinel).
  p_diluent_rate_gpa numeric DEFAULT NULL::numeric,
  -- Sentinel: only TRUE callers (the field-app invoice UI) intend to write the
  -- diluent column. A stale OLD-bundle tab calls a shorter form where this defaults
  -- to FALSE, so its NULL diluent param is NOT written — the recorded rate is
  -- preserved (a NULL-param "omitted" must not erase a captured rate). When TRUE,
  -- the column is written exactly as passed (NULL there = an intentional clear).
  p_update_diluent boolean DEFAULT false
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

  -- Validate the diluent rate at the RPC layer (kept OFF the invoices money table — no new
  -- CHECK). A diluent rate is a non-negative quantity; NULL (unentered/cleared) always passes.
  -- Only enforced when this caller actually intends to write diluent (p_update_diluent),
  -- so an old-bundle caller can never trip a validation it does not even pass a value to.
  IF p_update_diluent AND p_diluent_rate_gpa IS NOT NULL AND p_diluent_rate_gpa < 0 THEN
    RAISE EXCEPTION 'Diluent rate cannot be negative';
  END IF;

  -- Only editable field-application invoices — never a posted/voided row or a non-field invoice.
  -- Structured weather columns are written ONLY when p_update_weather = TRUE (the new UI). A
  -- stale 6-arg caller leaves p_update_weather = FALSE, so each weather column keeps its current
  -- value (= column) — captured weather is never silently erased by an old-bundle save. When the
  -- new UI saves (TRUE), the weather columns are written exactly as passed (NULL there = an
  -- intentional clear, mirroring the legacy free-text "blank clears" behavior).
  -- diluent_rate_gpa follows the SAME sentinel rule with p_update_diluent.
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
    diluent_rate_gpa        = CASE WHEN p_update_diluent THEN p_diluent_rate_gpa     ELSE diluent_rate_gpa    END,
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
-- exact lockdown the original migration (20260622030000, carried by Stage 1) established
-- so the new 22-arg signature keeps the same least-privilege grant posture (authenticated
-- only; the body also self-gates on auth.uid() + admin/sales). Keyed to the NEW signature.
REVOKE ALL ON FUNCTION public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean, boolean,
  numeric, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_applied_info(
  uuid[], text, text, text, uuid, text,
  numeric, numeric, text, numeric, time, text,
  numeric, numeric, text, numeric, time, text, boolean, boolean,
  numeric, boolean
) TO authenticated;
