-- Section 1 security remediation: number-generator grants/role gates and
-- truthful field-save attribution. Re-emits the current function signatures
-- and business bodies with only the security deltas described below.

CREATE OR REPLACE FUNCTION public.next_application_record_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'applicator')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_application_record_number'));
  SELECT COALESCE(MAX(CASE
    WHEN record_number ~ ('^APP-' || v_year || '-\d+$')
    THEN CAST(split_part(record_number, '-', 3) AS int)
    ELSE 0
  END), 0)
  INTO v_max_num FROM application_records;
  v_next := 'APP-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_commission_payment_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_year text;
  v_seq integer;
  v_num text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission_payment_number'));
  v_year := to_char(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(regexp_replace(payment_number, '^CP-' || v_year || '-', '')::integer), 0) + 1
    INTO v_seq
    FROM public.commission_payments
   WHERE payment_number LIKE 'CP-' || v_year || '-%';
  v_num := 'CP-' || v_year || '-' || lpad(v_seq::text, 4, '0');
  RETURN v_num;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_cycle_count_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num integer;
  v_next_num integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::text;
  PERFORM pg_advisory_xact_lock(8675309);
  SELECT COALESCE(MAX(CASE
    WHEN count_number ~ ('^CC-' || v_year || '-\d+$')
    THEN (regexp_replace(count_number, '^CC-' || v_year || '-', ''))::integer
    ELSE 0
  END), 0)
  INTO v_max_num FROM cycle_counts
  WHERE count_number LIKE 'CC-' || v_year || '-%';
  v_next_num := v_max_num + 1;
  RETURN 'CC-' || v_year || '-' || LPAD(v_next_num::text, 5, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.next_delivery_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('next_delivery_number'));
  SELECT COALESCE(MAX(CASE
    WHEN delivery_number ~ '^DEL-\d+$'
    THEN CAST(split_part(delivery_number, '-', 2) AS int)
    ELSE 0
  END), 0)
  INTO v_max_num FROM deliveries;
  v_next := 'DEL-' || lpad((v_max_num + 1)::text, 5, '0');
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_job_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'applicator')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_job_number'));
  SELECT COALESCE(MAX(CASE
    WHEN job_number ~ ('^JOB-' || v_year || '-\d+$')
    THEN CAST(split_part(job_number, '-', 3) AS int)
    ELSE 0
  END), 0)
  INTO v_max_num FROM jobs;
  v_next := 'JOB-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_po_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));
  SELECT COALESCE(MAX(CASE
    WHEN po_number ~ ('^PO-' || v_year || '-\d+$')
    THEN CAST(split_part(po_number, '-', 3) AS int)
    ELSE 0
  END), 0)
  INTO v_max_num FROM purchase_orders;
  v_next := 'PO-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_field_id uuid;
  v_total_pct numeric;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'field_id')::uuid; END IF;
  END IF;

  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    SELECT COALESCE(SUM((elem->>'split_pct')::numeric), 0) INTO v_total_pct
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
    IF ABS(v_total_pct - 100) > 0.01 THEN
      RAISE EXCEPTION 'Billing splits must total 100%% (got %.2f%%)', v_total_pct;
    END IF;
  END IF;

  IF p_field_id IS NULL THEN
    INSERT INTO fields (
      customer_id, field_name, legal_description, county, state,
      total_acres, fsa_farm_number, fsa_tract_number, fsa_field_number,
      crop_type, soil_type, irrigation, notes, is_active
    )
    SELECT
      (p_field_payload->>'customer_id')::uuid,
      p_field_payload->>'field_name',
      p_field_payload->>'legal_description',
      p_field_payload->>'county',
      COALESCE(p_field_payload->>'state', 'IL'),
      (p_field_payload->>'total_acres')::numeric,
      p_field_payload->>'fsa_farm_number',
      p_field_payload->>'fsa_tract_number',
      p_field_payload->>'fsa_field_number',
      p_field_payload->>'crop_type',
      p_field_payload->>'soil_type',
      COALESCE((p_field_payload->>'irrigation')::boolean, false),
      p_field_payload->>'notes',
      COALESCE((p_field_payload->>'is_active')::boolean, true)
    RETURNING id INTO v_field_id;
  ELSE
    UPDATE fields SET
      customer_id = (p_field_payload->>'customer_id')::uuid,
      field_name = p_field_payload->>'field_name',
      legal_description = p_field_payload->>'legal_description',
      county = p_field_payload->>'county',
      state = COALESCE(p_field_payload->>'state', 'IL'),
      total_acres = (p_field_payload->>'total_acres')::numeric,
      fsa_farm_number = p_field_payload->>'fsa_farm_number',
      fsa_tract_number = p_field_payload->>'fsa_tract_number',
      fsa_field_number = p_field_payload->>'fsa_field_number',
      crop_type = p_field_payload->>'crop_type',
      soil_type = p_field_payload->>'soil_type',
      irrigation = COALESCE((p_field_payload->>'irrigation')::boolean, false),
      notes = p_field_payload->>'notes',
      is_active = COALESCE((p_field_payload->>'is_active')::boolean, true)
    WHERE id = p_field_id;
    v_field_id := p_field_id;
  END IF;

  DELETE FROM field_billing_defaults WHERE field_id = v_field_id;
  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    INSERT INTO field_billing_defaults (
      field_id, customer_id, split_pct, is_primary, notes,
      price_override_cents, pricing_note
    )
    SELECT
      v_field_id, (elem->>'customer_id')::uuid, (elem->>'split_pct')::numeric,
      COALESCE((elem->>'is_primary')::boolean, false), elem->>'notes',
      (elem->>'price_override_cents')::bigint, elem->>'pricing_note'
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_saved', 'Field saved: ' || (p_field_payload->>'field_name'),
    v_actor, 'field', v_field_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field', jsonb_build_object('field_id', v_field_id));
  END IF;
  RETURN v_field_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.next_application_record_number() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_commission_payment_number() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_cycle_count_number() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_delivery_number() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_job_number() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.next_po_number() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.next_application_record_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.next_commission_payment_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.next_cycle_count_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.next_delivery_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.next_job_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.next_po_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;
