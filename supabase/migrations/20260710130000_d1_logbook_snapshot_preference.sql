-- D1: Prefer completion-time applicator snapshots in logbook and reporting reads,
-- with live profiles retained as the legacy fallback for older records.
-- The four get_logbook_* bases below are VERIFIED LIVE definitions because their
-- disk emit drifted; get_field_dashboard and get_lot_application_trace use their
-- byte-identical disk emits. Signatures, RETURNS, and ACLs are unchanged.

CREATE OR REPLACE FUNCTION public.get_logbook_by_customer(p_customer_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, field_name text, field_legal_description text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_type text, vehicle_registration text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, source_type text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), f.field_name, f.legal_description, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.vehicle_type, v.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.customer_id = p_customer_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION public.get_logbook_by_applicator(p_applicator_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, field_name text, field_legal_description text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_type text, vehicle_registration text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, source_type text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), f.field_name, f.legal_description, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.vehicle_type, v.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.applicator_id = p_applicator_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION public.get_logbook_by_field(p_field_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, field_name text, field_legal_description text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_type text, vehicle_registration text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, source_type text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), f.field_name, f.legal_description, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.vehicle_type, v.registration,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.source_type, ar.created_at
  FROM public.application_records ar
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.vehicles v ON v.id = ar.vehicle_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.field_id = p_field_id
    AND ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION public.get_logbook_faa(p_start_date date, p_end_date date)
 RETURNS TABLE(record_id uuid, record_number text, application_date date, application_time time without time zone, customer_name text, applicator_name text, applicator_license text, faa_certificate text, field_name text, field_legal_description text, field_county text, field_state text, total_acres numeric, total_volume numeric, total_volume_unit text, vehicle_name text, vehicle_registration text, vehicle_category text, weather_conditions jsonb, product_data jsonb, invoice_number text, season integer, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    ar.id, ar.record_number, ar.application_date, ar.application_time,
    c.farm_name, COALESCE(ar.applicator_name, p.full_name), COALESCE(ar.applicator_license_number, p.applicator_license_number), p.faa_certificate_number, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    f.field_name, f.legal_description, f.county, f.state,
    ar.total_acres, ar.total_volume, ar.total_volume_unit,
    v.vehicle_name, v.registration, v.category,
    ar.weather_conditions, ar.product_data, inv.invoice_number,
    ar.season, ar.created_at
  FROM public.application_records ar
  INNER JOIN public.vehicles v ON v.id = ar.vehicle_id AND v.vehicle_type = 'air'
  LEFT JOIN public.customers c ON c.id = ar.customer_id
  LEFT JOIN public.profiles p ON p.id = ar.applicator_id
  LEFT JOIN public.fields f ON f.id = ar.field_id
  LEFT JOIN public.invoices inv ON inv.id = ar.invoice_id
  WHERE ar.application_date >= p_start_date
    AND ar.application_date <= p_end_date
  ORDER BY ar.application_date DESC, ar.application_time DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION public.get_field_dashboard(p_field_id uuid, p_season integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_season integer;
  v_field jsonb;
  v_summary jsonb;
  v_records jsonb;
  v_activity jsonb;
BEGIN
  v_season := COALESCE(p_season, current_season());

  SELECT jsonb_build_object(
    'id', f.id,
    'customer_id', f.customer_id,
    'field_name', f.field_name,
    'legal_description', f.legal_description,
    'county', f.county,
    'state', f.state,
    'total_acres', f.total_acres,
    'crop_type', f.crop_type,
    'soil_type', f.soil_type,
    'irrigation', f.irrigation,
    'fsa_farm_number', f.fsa_farm_number,
    'fsa_tract_number', f.fsa_tract_number,
    'fsa_field_number', f.fsa_field_number,
    'notes', f.notes,
    'is_active', f.is_active,
    'centroid_geojson', ST_AsGeoJSON(f.centroid)::text,
    'boundary_geojson', ST_AsGeoJSON(f.boundary)::text,
    'created_at', f.created_at,
    'updated_at', f.updated_at,
    'customer_name', c.farm_name,
    'billing_defaults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', bd.id,
        'customer_id', bd.customer_id,
        'split_pct', bd.split_pct,
        'is_primary', bd.is_primary,
        'notes', bd.notes,
        'price_override_cents', bd.price_override_cents,
        'pricing_note', bd.pricing_note,
        'customer_name', bc.farm_name
      ) ORDER BY bd.is_primary DESC, bc.farm_name)
      FROM field_billing_defaults bd
      JOIN customers bc ON bc.id = bd.customer_id
      WHERE bd.field_id = f.id
    ), '[]'::jsonb)
  ) INTO v_field
  FROM fields f
  LEFT JOIN customers c ON c.id = f.customer_id
  WHERE f.id = p_field_id;

  IF v_field IS NULL THEN
    RAISE EXCEPTION 'Field not found: %', p_field_id;
  END IF;

  SELECT jsonb_build_object(
    'total_applications', count(*)::integer,
    'total_acres_treated', COALESCE(sum(ar.total_acres), 0),
    'distinct_products', COALESCE((
      SELECT count(DISTINCT elem->>'product_name')::integer
      FROM application_records ar2,
           jsonb_array_elements(ar2.product_data) elem
      WHERE ar2.field_id = p_field_id AND ar2.season = v_season
    ), 0),
    'season', v_season
  ) INTO v_summary
  FROM application_records ar
  WHERE ar.field_id = p_field_id AND ar.season = v_season;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ar.id,
    'record_number', ar.record_number,
    'application_date', ar.application_date,
    'application_time', ar.application_time,
    'total_acres', ar.total_acres,
    'total_volume', ar.total_volume,
    'total_volume_unit', ar.total_volume_unit,
    'product_data', ar.product_data,
    'weather_conditions', ar.weather_conditions,
    'notes', ar.notes,
    'source_type', ar.source_type,
    'source_id', ar.source_id,
    'applicator_name', COALESCE(ar.applicator_name, p.full_name, 'Unknown'), -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    'vehicle_name', v.vehicle_name
  ) ORDER BY ar.application_date DESC, ar.application_time DESC), '[]'::jsonb)
  INTO v_records
  FROM application_records ar
  LEFT JOIN profiles p ON p.id = ar.applicator_id
  LEFT JOIN vehicles v ON v.id = ar.vehicle_id
  WHERE ar.field_id = p_field_id AND ar.season = v_season;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', af.id,
    'event_type', af.event_type,
    'description', af.description,
    'performed_by_name', COALESCE(p.full_name, 'System'),
    'created_at', af.created_at
  ) ORDER BY af.created_at DESC), '[]'::jsonb)
  INTO v_activity
  FROM (
    SELECT * FROM activity_feed
    WHERE related_entity_type = 'field' AND related_entity_id = p_field_id
    ORDER BY created_at DESC
    LIMIT 10
  ) af
  LEFT JOIN profiles p ON p.id = af.performed_by;

  RETURN jsonb_build_object(
    'field', v_field,
    'season_summary', v_summary,
    'application_records', v_records,
    'recent_activity', v_activity
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_lot_application_trace(p_lot_number text)
RETURNS TABLE (
  application_record_id uuid,
  record_number text,
  product_id uuid,
  product_name text,
  lot_number text,
  quantity_from_lot numeric,
  unit text,
  application_date date,
  customer_id uuid,
  customer_name text,
  applicator_id uuid,
  applicator_name text,
  field_names text,
  invoice_id uuid,
  source_receiving_record_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required';
  END IF;

  RETURN QUERY
  SELECT
    arl.application_record_id,
    ar.record_number,
    arl.product_id,
    p.product_name,
    arl.lot_number,
    arl.quantity_from_lot,
    arl.unit,
    ar.application_date,
    ar.customer_id,
    c.farm_name AS customer_name,
    ar.applicator_id,
    COALESCE(ar.applicator_name, pr.full_name) AS applicator_name, -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
    -- prefer the per-field acres rows; fall back to the legacy single application_records.field_id
    -- so single-field / legacy records (and blend records with no blend_ticket_fields) still answer
    -- "which field received this lot" (Codex P2).
    COALESCE(
      (SELECT string_agg(f.field_name, ', ' ORDER BY arf.sort_order)
         FROM application_record_fields arf
         JOIN fields f ON f.id = arf.field_id
        WHERE arf.application_record_id = ar.id),
      (SELECT f2.field_name FROM fields f2 WHERE f2.id = ar.field_id)
    ) AS field_names,
    -- Invoiced status — report "invoiced" ONLY when an ACTIVE invoice still exists.
    --   * Job-sourced records stamp application_records.invoice_id (transfer_job_to_invoice),
    --     but void_invoice flips invoices.status WITHOUT clearing ar.invoice_id — so returning
    --     ar.invoice_id raw would show Invoiced=Yes for a voided/cancelled/soft-deleted invoice
    --     on a recall trace. Filter it through invoices with the active predicate (Codex P2).
    --   * Blend-sourced records never stamp ar.invoice_id (create_invoice_from_blend_ticket
    --     links via invoices.blend_ticket_id), so fall back to the most recent ACTIVE blend
    --     invoice so a billed blend ticket isn't misreported as not-invoiced (Codex P2).
    COALESCE(
      (SELECT i.id FROM invoices i
         WHERE i.id = ar.invoice_id
           AND i.status NOT IN ('voided', 'cancelled')
           AND i.deleted_at IS NULL),
      CASE WHEN ar.source_type = 'blend_ticket' THEN (
        SELECT i.id FROM invoices i
        WHERE i.blend_ticket_id = ar.source_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND i.deleted_at IS NULL
        ORDER BY i.created_at DESC
        LIMIT 1
      ) END
    ) AS invoice_id,
    arl.source_receiving_record_id
  FROM application_record_lots arl
  JOIN application_records ar ON ar.id = arl.application_record_id
  LEFT JOIN products p ON p.id = arl.product_id
  LEFT JOIN customers c ON c.id = ar.customer_id
  LEFT JOIN profiles pr ON pr.id = ar.applicator_id
  WHERE lower(btrim(arl.lot_number)) = lower(btrim(p_lot_number))
  ORDER BY ar.application_date DESC, ar.record_number, p.product_name;
END;
$$;

DO $$
DECLARE
  v_name text;
  v_overload_count integer;
  v_prosrc text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'get_logbook_by_customer',
    'get_logbook_by_applicator',
    'get_logbook_by_field',
    'get_logbook_faa',
    'get_field_dashboard',
    'get_lot_application_trace'
  ]
  LOOP
    SELECT count(*)
      INTO v_overload_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name;

    IF v_overload_count <> 1 THEN
      RAISE EXCEPTION 'D1 post-check: expected exactly one public.% overload, found %',
        v_name, v_overload_count;
    END IF;

    SELECT p.prosrc
      INTO v_prosrc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name;

    IF v_prosrc NOT LIKE '%COALESCE(ar.applicator_name%' THEN
      RAISE EXCEPTION 'D1 post-check: public.% does not prefer the applicator-name snapshot',
        v_name;
    END IF;
  END LOOP;

  SELECT p.prosrc
    INTO v_prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_logbook_faa';

  IF v_prosrc NOT LIKE '%COALESCE(ar.applicator_license_number%' THEN
    RAISE EXCEPTION 'D1 post-check: public.get_logbook_faa does not prefer the applicator-license snapshot';
  END IF;
END;
$$;
