-- Migration: bind idempotency receipts to the exact mutation intent
--
-- A lost HTTP response can leave the browser unsure whether save_invoice or
-- create_quick_delivery committed. Their historical receipts identify only a
-- random key + operation, so reusing that key after the form changes can replay
-- a result for different data. Persist a PostgreSQL-derived fingerprint and
-- fail closed with the original receipt in DETAIL when a key is reused for a
-- different intent. The public signatures remain unchanged.
--
-- CHECK 6 live preflight (read-only Supabase execute_sql, 2026-08-02
-- 16:34:18 UTC): supabase_migrations.schema_migrations contained 932 rows;
-- max(version) = 20260731001654 and the ledger name was
-- 20260730233835_ap_period_close_boundary_hardening. This file's timestamp
-- 20260802162805 is strictly greater. No live schema or data was changed.

ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS request_actor_id uuid;

COMMENT ON COLUMN public.idempotency_keys.request_fingerprint IS
  'Server-derived SHA-256 of the exact mutation intent for payload-bound operations.';
COMMENT ON COLUMN public.idempotency_keys.request_actor_id IS
  'Authenticated actor that created a payload-bound idempotency receipt.';

ALTER FUNCTION public.save_invoice(jsonb, jsonb, text)
  RENAME TO _save_invoice_intent_impl_20260802;

REVOKE ALL ON FUNCTION public._save_invoice_intent_impl_20260802(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._save_invoice_intent_impl_20260802(jsonb, jsonb, text)
  TO postgres;

CREATE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_existing public.idempotency_keys%ROWTYPE;
  v_invoice_id uuid;
  v_cached_invoice_id uuid;
  v_cached_customer_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._save_invoice_intent_impl_20260802(p_invoice, p_items, NULL);
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'invoice', p_invoice,
        'items', COALESCE(p_items, '[]'::jsonb)
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.operation IS DISTINCT FROM 'save_invoice' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
    END IF;
    -- Deployment bridge: receipts written by the pre-migration implementation
    -- have neither binding column. Their original intent cannot be reconstructed,
    -- so validate entity scope and fail closed with the committed receipt. This
    -- avoids both duplicate creation and silently treating edited input as saved.
    IF v_existing.request_actor_id IS NULL
       AND v_existing.request_fingerprint IS NULL THEN
      v_cached_invoice_id := NULLIF(v_existing.result->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id INTO v_cached_customer_id
        FROM public.invoices
       WHERE id = v_cached_invoice_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND';
      END IF;
      IF v_actor_role = 'sales_rep'
         AND NOT EXISTS (
           SELECT 1 FROM public.customers
            WHERE id = v_cached_customer_id
              AND assigned_sales_rep = v_actor
         ) THEN
        RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    IF v_existing.request_actor_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
    END IF;
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      v_cached_invoice_id := NULLIF(v_existing.result->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id INTO v_cached_customer_id
        FROM public.invoices
       WHERE id = v_cached_invoice_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND';
      END IF;
      IF v_actor_role = 'sales_rep'
         AND NOT EXISTS (
           SELECT 1 FROM public.customers
            WHERE id = v_cached_customer_id
              AND assigned_sales_rep = v_actor
         ) THEN
        RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    RETURN public._save_invoice_intent_impl_20260802(
      p_invoice, p_items, p_idempotency_key
    );
  END IF;

  v_invoice_id := public._save_invoice_intent_impl_20260802(
    p_invoice, p_items, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'save_invoice';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_invoice_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  TO authenticated, service_role;

ALTER FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean)
  RENAME TO _create_quick_delivery_intent_impl_20260802;

REVOKE ALL ON FUNCTION public._create_quick_delivery_intent_impl_20260802(uuid, jsonb, uuid, date, text, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._create_quick_delivery_intent_impl_20260802(uuid, jsonb, uuid, date, text, uuid, text, boolean)
  TO postgres;

CREATE FUNCTION public.create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL::uuid,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_skip_invoice boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_existing public.idempotency_keys%ROWTYPE;
  v_result jsonb;
  v_cached_delivery_id uuid;
  v_cached_customer_id uuid;
  v_cached_driver_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'driver');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._create_quick_delivery_intent_impl_20260802(
      p_customer_id, p_items, p_driver_id, p_scheduled_date,
      p_delivery_notes, p_performed_by, NULL, p_skip_invoice
    );
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'customer_id', p_customer_id,
        'items', p_items,
        'driver_id', p_driver_id,
        'scheduled_date', p_scheduled_date,
        'delivery_notes', p_delivery_notes,
        'skip_invoice', p_skip_invoice
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.operation IS DISTINCT FROM 'create_quick_delivery' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
    END IF;
    -- Same fail-closed deployment bridge as save_invoice. Validate that the
    -- caller may see the committed delivery before returning its receipt.
    IF v_existing.request_actor_id IS NULL
       AND v_existing.request_fingerprint IS NULL THEN
      v_cached_delivery_id := NULLIF(v_existing.result->>'delivery_id', '')::uuid;
      IF v_cached_delivery_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id, assigned_driver
        INTO v_cached_customer_id, v_cached_driver_id
        FROM public.deliveries
       WHERE id = v_cached_delivery_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
      END IF;
      IF (v_actor_role = 'sales_rep' AND NOT EXISTS (
            SELECT 1 FROM public.customers
             WHERE id = v_cached_customer_id
               AND assigned_sales_rep = v_actor
          ))
         OR (v_actor_role = 'driver' AND v_cached_driver_id IS DISTINCT FROM v_actor) THEN
        RAISE EXCEPTION 'DELIVERY_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    IF v_existing.request_actor_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
    END IF;
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      v_cached_delivery_id := NULLIF(v_existing.result->>'delivery_id', '')::uuid;
      IF v_cached_delivery_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id, assigned_driver
        INTO v_cached_customer_id, v_cached_driver_id
        FROM public.deliveries
       WHERE id = v_cached_delivery_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
      END IF;
      IF (v_actor_role = 'sales_rep' AND NOT EXISTS (
            SELECT 1 FROM public.customers
             WHERE id = v_cached_customer_id
               AND assigned_sales_rep = v_actor
          ))
         OR (v_actor_role = 'driver' AND v_cached_driver_id IS DISTINCT FROM v_actor) THEN
        RAISE EXCEPTION 'DELIVERY_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    RETURN public._create_quick_delivery_intent_impl_20260802(
      p_customer_id, p_items, p_driver_id, p_scheduled_date,
      p_delivery_notes, p_performed_by, p_idempotency_key, p_skip_invoice
    );
  END IF;

  v_result := public._create_quick_delivery_intent_impl_20260802(
    p_customer_id, p_items, p_driver_id, p_scheduled_date,
    p_delivery_notes, p_performed_by, p_idempotency_key, p_skip_invoice
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_quick_delivery';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'save_invoice';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'save_invoice overload count = % (expected 1)', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'create_quick_delivery';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_quick_delivery overload count = % (expected 1)', v_count;
  END IF;

  IF has_function_privilege('anon', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anonymous execution must remain revoked';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated execution grant missing';
  END IF;

END;
$verify$;
