-- Final release-gate correction: public retry-sensitive money and lifecycle
-- RPCs must reject an omitted or blank idempotency key. The already-live,
-- behaviorally proven implementations are preserved byte-for-byte behind
-- private names; thin public wrappers enforce the required key and delegate.

DO $preflight$
DECLARE
  v record;
  v_proc pg_proc%ROWTYPE;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('public.create_invoice_from_order(uuid,uuid,text,text)',
       '_create_invoice_from_order_idem_impl_20260721',
       '7cbf7aef577c10b16c45070da68edb33'),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)',
       '_create_invoice_for_unbilled_delivery_idem_impl_20260721',
       '01c173eaddbf78224b5e1603b3326256'),
      ('public.post_invoice(uuid,text)',
       '_post_invoice_idem_impl_20260721',
       '29fae02d163e6ef4e5f1f647af641090'),
      ('public.cancel_order(uuid,uuid,text)',
       '_cancel_order_idem_impl_20260721',
       'a2f78a473eca08d8ee932892f1c2d263'),
      ('public.generate_finance_charges(date,uuid,uuid[],text)',
       '_generate_finance_charges_idem_impl_20260721',
       '49496e51d0d3ee07e57f3afdc7c033ff')
    ) AS expected(signature, private_name, prosrc_md5)
  LOOP
    SELECT p.* INTO v_proc
      FROM pg_proc p
     WHERE p.oid = to_regprocedure(v.signature);

    IF NOT FOUND
       OR md5(v_proc.prosrc) <> v.prosrc_md5
       OR NOT v_proc.prosecdef
       OR ('search_path=public, pg_temp' = ANY (
            COALESCE(v_proc.proconfig, ARRAY[]::text[])
          )) IS NOT TRUE
       OR has_function_privilege('anon', v_proc.oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_proc.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PRECONDITION: reviewed public RPC drifted: %', v.signature;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = v.private_name
    ) THEN
      RAISE EXCEPTION 'PRECONDITION: private wrapper target already exists: %', v.private_name;
    END IF;
  END LOOP;

  SELECT p.* INTO v_proc
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.batch_post_invoices(uuid[],text)');
  IF NOT FOUND
     OR md5(v_proc.prosrc) <> '35f97d0c80edcfab5c03fffee981ab87'
     OR NOT v_proc.prosecdef
     OR ('search_path=public, pg_temp' = ANY (
          COALESCE(v_proc.proconfig, ARRAY[]::text[])
        )) IS NOT TRUE
     OR has_function_privilege('anon', v_proc.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_proc.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_proc.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION: reviewed public RPC drifted: public.batch_post_invoices(uuid[],text)';
  END IF;
  IF to_regprocedure('public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION: bound idempotency helpers are missing';
  END IF;
END;
$preflight$;

-- The legacy one-argument overload was removed in 20260311200000. Repeat the
-- removal here so this migration remains fail-safe if an older environment
-- retained it and so one-argument calls cannot bypass the governed wrapper.
DROP FUNCTION IF EXISTS public.batch_post_invoices(uuid[]);

ALTER FUNCTION public.create_invoice_from_order(uuid, uuid, text, text)
  RENAME TO _create_invoice_from_order_idem_impl_20260721;
ALTER FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  RENAME TO _create_invoice_for_unbilled_delivery_idem_impl_20260721;
ALTER FUNCTION public.post_invoice(uuid, text)
  RENAME TO _post_invoice_idem_impl_20260721;
ALTER FUNCTION public.cancel_order(uuid, uuid, text)
  RENAME TO _cancel_order_idem_impl_20260721;
ALTER FUNCTION public.generate_finance_charges(date, uuid, uuid[], text)
  RENAME TO _generate_finance_charges_idem_impl_20260721;

REVOKE ALL ON FUNCTION public._create_invoice_from_order_idem_impl_20260721(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._post_invoice_idem_impl_20260721(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cancel_order_idem_impl_20260721(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._generate_finance_charges_idem_impl_20260721(date, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_invoice_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_order'
      USING ERRCODE = '22023';
  END IF;
  RETURN public._create_invoice_from_order_idem_impl_20260721(
    p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.create_invoice_for_unbilled_delivery(
  p_delivery_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_for_unbilled_delivery'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN public._create_invoice_for_unbilled_delivery_idem_impl_20260721(
    p_delivery_id, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.post_invoice(
  p_invoice_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_invoice'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._post_invoice_idem_impl_20260721(
    p_invoice_id, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.cancel_order(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_order'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN public._cancel_order_idem_impl_20260721(
    p_order_id, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.generate_finance_charges(
  p_as_of_date date,
  p_performed_by uuid,
  p_customer_ids uuid[] DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: generate_finance_charges'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN public._generate_finance_charges_idem_impl_20260721(
    p_as_of_date, p_performed_by, p_customer_ids, p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.batch_post_invoices(
  p_invoice_ids uuid[],
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id uuid; v_count int := 0; v_total bigint := 0; v_actor uuid;
  v_actor_role text; v_existing jsonb; v_failures jsonb := '[]'::jsonb;
  v_first_posted uuid; v_posted_ids uuid[] := '{}'; v_err text;
  v_result jsonb; v_index int := 0;
  v_contract CONSTANT text := 'batch_post_invoices_v2';
  v_request jsonb; v_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'Not authorized to batch post invoices'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor;
  IF array_length(p_invoice_ids, 1) IS NULL THEN RAISE EXCEPTION 'No invoice IDs provided'; END IF;
  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'invoice_ids', to_jsonb(p_invoice_ids)
  );
  v_fingerprint := md5(v_request::text);
  v_existing := public._claim_bound_lifecycle_idempotency(
    p_idempotency_key, 'batch_post_invoices', v_contract,
    v_fingerprint, v_request
  );
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  FOREACH v_id IN ARRAY p_invoice_ids LOOP
    v_index := v_index + 1;
    BEGIN
      PERFORM public.post_invoice(
        v_id, p_idempotency_key || ':post:' || v_index::text
      );
      v_count := v_count + 1;
      IF v_first_posted IS NULL THEN v_first_posted := v_id; END IF;
      v_posted_ids := array_append(v_posted_ids, v_id);
      v_total := v_total + COALESCE((
        SELECT total_amount_cents FROM public.invoices WHERE id = v_id
      ), 0);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      v_failures := v_failures || jsonb_build_object('invoice_id', v_id, 'error', v_err);
    END;
  END LOOP;

  IF v_count > 0 THEN
    INSERT INTO public.financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_posted', 'invoice', v_first_posted, v_actor_role,
      jsonb_build_object('batch_count', v_count,
        'failed_count', jsonb_array_length(v_failures),
        'invoice_ids', to_jsonb(v_posted_ids)),
      v_total,
      'Batch posted ' || v_count || ' invoice(s) totaling $' ||
        (v_total / 100.0)::numeric(12,2) ||
        CASE WHEN jsonb_array_length(v_failures) > 0
          THEN ' (' || jsonb_array_length(v_failures) || ' failed)' ELSE '' END
    );
  END IF;
  v_result := jsonb_build_object('success', jsonb_array_length(v_failures) = 0,
    'count', v_count, 'total_cents', v_total, 'failed', v_failures);
  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key, 'batch_post_invoices', v_contract,
    v_fingerprint, v_request, v_result
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_invoice_from_order(uuid, uuid, text, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_invoice(uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_order(uuid, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.batch_post_invoices(uuid[], text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_invoice_from_order(uuid, uuid, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.batch_post_invoices(uuid[], text)
  TO authenticated, service_role;

DO $postflight$
DECLARE
  v record;
  v_public pg_proc%ROWTYPE;
  v_private pg_proc%ROWTYPE;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('public.create_invoice_from_order(uuid,uuid,text,text)',
       'public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)',
       '7cbf7aef577c10b16c45070da68edb33'),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)',
       'public._create_invoice_for_unbilled_delivery_idem_impl_20260721(uuid,uuid,text)',
       '01c173eaddbf78224b5e1603b3326256'),
      ('public.post_invoice(uuid,text)',
       'public._post_invoice_idem_impl_20260721(uuid,text)',
       '29fae02d163e6ef4e5f1f647af641090'),
      ('public.cancel_order(uuid,uuid,text)',
       'public._cancel_order_idem_impl_20260721(uuid,uuid,text)',
       'a2f78a473eca08d8ee932892f1c2d263'),
      ('public.generate_finance_charges(date,uuid,uuid[],text)',
       'public._generate_finance_charges_idem_impl_20260721(date,uuid,uuid[],text)',
       '49496e51d0d3ee07e57f3afdc7c033ff')
    ) AS expected(public_signature, private_signature, private_md5)
  LOOP
    SELECT p.* INTO v_public FROM pg_proc p
     WHERE p.oid = to_regprocedure(v.public_signature);
    SELECT p.* INTO v_private FROM pg_proc p
     WHERE p.oid = to_regprocedure(v.private_signature);

    IF v_public.oid IS NULL
       OR v_private.oid IS NULL
       OR position('IDEMPOTENCY_KEY_REQUIRED' IN v_public.prosrc) = 0
       OR (
            v.public_signature IN (
              'public.create_invoice_for_unbilled_delivery(uuid,uuid,text)',
              'public.cancel_order(uuid,uuid,text)',
              'public.generate_finance_charges(date,uuid,uuid[],text)'
            )
            AND position('ACTOR_MISMATCH' IN v_public.prosrc) = 0
          )
       OR NOT v_public.prosecdef
       OR ('search_path=public, pg_temp' = ANY (
            COALESCE(v_public.proconfig, ARRAY[]::text[])
          )) IS NOT TRUE
       OR has_function_privilege('anon', v_public.oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_public.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_public.oid, 'EXECUTE')
       OR md5(v_private.prosrc) <> v.private_md5
       OR has_function_privilege('anon', v_private.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_private.oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_private.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT: idempotency wrapper contract drifted: %', v.public_signature;
    END IF;
  END LOOP;

  SELECT p.* INTO v_public FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.batch_post_invoices(uuid[],text)');
  IF v_public.oid IS NULL
     OR position('IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices' IN v_public.prosrc) = 0
     OR position('batch_post_invoices_v2' IN v_public.prosrc) = 0
     OR position('public._claim_bound_lifecycle_idempotency' IN v_public.prosrc) = 0
     OR position('public._bind_completed_lifecycle_idempotency' IN v_public.prosrc) = 0
     OR position('p_idempotency_key || '':post:'' || v_index::text' IN v_public.prosrc) = 0
     OR NOT v_public.prosecdef
     OR ('search_path=public, pg_temp' = ANY (
          COALESCE(v_public.proconfig, ARRAY[]::text[])
        )) IS NOT TRUE
     OR has_function_privilege('anon', v_public.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: batch_post_invoices contract drifted';
  END IF;
END;
$postflight$;
