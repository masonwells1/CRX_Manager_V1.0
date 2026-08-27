-- Section 9 AP/receiving safety remediation (parts 2 and 3 of the 2026-08-26
-- Live Foundation Gauntlet refresh).
--
-- 1. `Due This Month` now means the remaining interval from the Chicago
--    business date through the final day of that calendar month.
-- 2. Every AP/receiving mutation receipt is bound to the authenticated actor
--    plus a SHA-256 fingerprint of every business-relevant input.
--
-- The mature money/inventory bodies are renamed, not copied. Public wrappers
-- authorize before reading a receipt, require a key, check exact intent, call
-- the owner-only implementation, and bind the receipt written by that body.
-- This preserves period locks, PO serialization, money math, inventory math,
-- audit rows, and existing return shapes byte-for-byte inside the implementations.

-- Drain every transaction that already touched the shared receipt table before
-- validating legacy receipts or renaming the public RPCs. PostgreSQL lock
-- queueing also holds callers that arrive during cutover behind this migration.
LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;

-- A caller that resolved an old function body before the rename can resume
-- after the migration commits. The old body has no binding context, so reject
-- its late receipt INSERT and roll its entire money/inventory statement back.
-- New wrappers provide the actor + fingerprint as transaction-local context;
-- the trigger stamps the receipt atomically at INSERT time.
CREATE OR REPLACE FUNCTION public._section9_bind_idempotency_receipt_20260826()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_context_text text;
  v_context jsonb;
BEGIN
  IF NEW.operation NOT IN (
    'create_vendor_bill', 'update_vendor_bill', 'record_vendor_payment',
    'void_vendor_payment', 'void_vendor_bill', 'receive_po_items'
  ) THEN
    RETURN NEW;
  END IF;

  v_context_text := current_setting('crx.section9_idempotency_intent', true);
  IF v_context_text IS NULL OR v_context_text = '' THEN
    RAISE EXCEPTION 'SECTION9_UNBOUND_IDEMPOTENCY_RECEIPT';
  END IF;

  BEGIN
    v_context := v_context_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SECTION9_INVALID_IDEMPOTENCY_CONTEXT';
  END;

  IF v_context ->> 'operation' IS DISTINCT FROM NEW.operation
     OR v_context ->> 'idempotency_key' IS DISTINCT FROM NEW.idempotency_key
     OR COALESCE(v_context ->> 'actor_id', '') = ''
     OR COALESCE(v_context ->> 'fingerprint', '') = '' THEN
    RAISE EXCEPTION 'SECTION9_IDEMPOTENCY_CONTEXT_MISMATCH';
  END IF;

  NEW.request_actor_id := (v_context ->> 'actor_id')::uuid;
  NEW.request_fingerprint := v_context ->> 'fingerprint';
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._section9_bind_idempotency_receipt_20260826() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._section9_bind_idempotency_receipt_20260826()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._section9_bind_idempotency_receipt_20260826() TO postgres;

DROP TRIGGER IF EXISTS section9_bind_idempotency_receipt_20260826
  ON public.idempotency_keys;
CREATE TRIGGER section9_bind_idempotency_receipt_20260826
BEFORE INSERT ON public.idempotency_keys
FOR EACH ROW
EXECUTE FUNCTION public._section9_bind_idempotency_receipt_20260826();

DO $preflight$
DECLARE
  v_name text;
  v_signature text;
  v_private_signature text;
  v_expected_hash text;
  v_source text;
  v_actual_hash text;
  v_owner text;
  v_language text;
  v_security_definer boolean;
  v_config text[];
  v_overload_count integer;
BEGIN
  FOR v_name, v_signature, v_private_signature, v_expected_hash IN
    SELECT * FROM (VALUES
      ('create_vendor_bill',
       'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)',
       'public._section9_create_vendor_bill_intent_impl_20260826(uuid,uuid,text,date,date,text,bigint,bigint,text,text)',
       '6dfb99167675963345fc815cd239cc93677e9cd536a32f532868a58c662c84ba'),
      ('update_vendor_bill',
       'public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text)',
       'public._section9_update_vendor_bill_intent_impl_20260826(uuid,bigint,bigint,date,date,text,text)',
       '342ca1c3266ea2f5249181ebae187c45fd9f149c56c07901d786bde349fac4c1'),
      ('record_vendor_payment',
       'public.record_vendor_payment(uuid,bigint,date,text,text,text,text)',
       'public._section9_record_vendor_payment_intent_impl_20260826(uuid,bigint,date,text,text,text,text)',
       '95bd3147506716bdad0206e205a00ddaa6a5227d3922b61870202ed26c0d23d4'),
      ('void_vendor_payment',
       'public.void_vendor_payment(uuid,text,text)',
       'public._section9_void_vendor_payment_intent_impl_20260826(uuid,text,text)',
       '8e7c192958debcb28d3ce040c57484bcc61243272ed40d5eae51dcf102c80493'),
      ('void_vendor_bill',
       'public.void_vendor_bill(uuid,text,text)',
       'public._section9_void_vendor_bill_intent_impl_20260826(uuid,text,text)',
       'af02eaf30178c365cf8acb67a1396f5b83bae1680121a2e53dcaccc854a5af47'),
      ('receive_po_items',
       'public.receive_po_items(jsonb,uuid,text,boolean)',
       'public._section9_receive_po_items_intent_impl_20260826(jsonb,uuid,text,boolean)',
       'ae1cc40fa18442c2deace8e931b2c116f571ede293046c9e2d9e7dbd5c1de3b7')
    ) AS expected(name, signature, private_signature, source_hash)
  LOOP
    SELECT count(*)
      INTO v_overload_count
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_overload_count <> 1 OR to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'SECTION9_UNEXPECTED_PUBLIC_OVERLOADS: % expected only % but found % overload(s)',
        v_name, v_signature, v_overload_count;
    END IF;
    IF to_regprocedure(v_private_signature) IS NOT NULL THEN
      RAISE EXCEPTION 'SECTION9_PRIVATE_IMPLEMENTATION_ALREADY_EXISTS: %', v_private_signature;
    END IF;

    SELECT p.prosrc,
           encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex'),
           r.rolname, l.lanname, p.prosecdef, p.proconfig
      INTO v_source, v_actual_hash, v_owner, v_language, v_security_definer, v_config
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = to_regprocedure(v_signature);

    IF v_owner IS DISTINCT FROM 'postgres'
       OR v_language IS DISTINCT FROM 'plpgsql'
       OR v_security_definer IS DISTINCT FROM true
       OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
      RAISE EXCEPTION 'SECTION9_PUBLIC_FUNCTION_SHAPE_DRIFT: %', v_signature;
    END IF;
    IF v_actual_hash IS DISTINCT FROM v_expected_hash THEN
      RAISE EXCEPTION 'SECTION9_REVIEWED_BODY_DRIFT: % expected SHA-256 % but found %',
        v_signature, v_expected_hash, v_actual_hash;
    END IF;
  END LOOP;

  SELECT count(*)
    INTO v_overload_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_ap_dashboard_summary';
  IF v_overload_count <> 1
     OR to_regprocedure('public.get_ap_dashboard_summary(text)') IS NULL THEN
    RAISE EXCEPTION 'SECTION9_UNEXPECTED_PUBLIC_OVERLOADS: get_ap_dashboard_summary expected only public.get_ap_dashboard_summary(text) but found % overload(s)',
      v_overload_count;
  END IF;
  SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex'),
         r.rolname, l.lanname, p.prosecdef, p.proconfig
    INTO v_actual_hash, v_owner, v_language, v_security_definer, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.get_ap_dashboard_summary(text)'::regprocedure;
  IF v_actual_hash IS DISTINCT FROM 'e265a3b0558a0f7937d4fd709e44bb8cf3fca68d70fc84878c40166cac88a99c'
     OR v_owner IS DISTINCT FROM 'postgres'
     OR v_language IS DISTINCT FROM 'plpgsql'
     OR v_security_definer IS DISTINCT FROM true
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'SECTION9_DASHBOARD_REVIEWED_CONTRACT_DRIFT';
  END IF;

  IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'check_idempotency_intent(text,text,uuid,text) is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.idempotency_keys k
     WHERE k.expires_at >= now()
       AND k.operation IN (
         'create_vendor_bill', 'update_vendor_bill', 'record_vendor_payment',
         'void_vendor_payment', 'void_vendor_bill', 'receive_po_items'
       )
       AND (k.request_actor_id IS NULL OR k.request_fingerprint IS NULL)
  ) THEN
    RAISE EXCEPTION 'SECTION9_ACTIVE_LEGACY_IDEMPOTENCY_RECEIPTS';
  END IF;
END;
$preflight$;

DO $rename$
BEGIN
  IF to_regprocedure('public._section9_create_vendor_bill_intent_impl_20260826(uuid,uuid,text,date,date,text,bigint,bigint,text,text)') IS NULL THEN
    ALTER FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text)
      RENAME TO _section9_create_vendor_bill_intent_impl_20260826;
  END IF;
  IF to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260826(uuid,bigint,bigint,date,date,text,text)') IS NULL THEN
    ALTER FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text)
      RENAME TO _section9_update_vendor_bill_intent_impl_20260826;
  END IF;
  IF to_regprocedure('public._section9_record_vendor_payment_intent_impl_20260826(uuid,bigint,date,text,text,text,text)') IS NULL THEN
    ALTER FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text)
      RENAME TO _section9_record_vendor_payment_intent_impl_20260826;
  END IF;
  IF to_regprocedure('public._section9_void_vendor_payment_intent_impl_20260826(uuid,text,text)') IS NULL THEN
    ALTER FUNCTION public.void_vendor_payment(uuid, text, text)
      RENAME TO _section9_void_vendor_payment_intent_impl_20260826;
  END IF;
  IF to_regprocedure('public._section9_void_vendor_bill_intent_impl_20260826(uuid,text,text)') IS NULL THEN
    ALTER FUNCTION public.void_vendor_bill(uuid, text, text)
      RENAME TO _section9_void_vendor_bill_intent_impl_20260826;
  END IF;
  IF to_regprocedure('public._section9_receive_po_items_intent_impl_20260826(jsonb,uuid,text,boolean)') IS NULL THEN
    ALTER FUNCTION public.receive_po_items(jsonb, uuid, text, boolean)
      RENAME TO _section9_receive_po_items_intent_impl_20260826;
  END IF;
END;
$rename$;

REVOKE ALL ON FUNCTION public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_update_vendor_bill_intent_impl_20260826(uuid, bigint, bigint, date, date, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_record_vendor_payment_intent_impl_20260826(uuid, bigint, date, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_void_vendor_payment_intent_impl_20260826(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_void_vendor_bill_intent_impl_20260826(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_receive_po_items_intent_impl_20260826(jsonb, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public._section9_create_vendor_bill_intent_impl_20260826(uuid, uuid, text, date, date, text, bigint, bigint, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_update_vendor_bill_intent_impl_20260826(uuid, bigint, bigint, date, date, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_record_vendor_payment_intent_impl_20260826(uuid, bigint, date, text, text, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_void_vendor_payment_intent_impl_20260826(uuid, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_void_vendor_bill_intent_impl_20260826(uuid, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_receive_po_items_intent_impl_20260826(jsonb, uuid, text, boolean) TO postgres;

CREATE OR REPLACE FUNCTION public.create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL::uuid,
  p_bill_number text DEFAULT ''::text,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL::date,
  p_payment_terms text DEFAULT NULL::text,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_bill_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_vendor_bill requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_id', p_vendor_id,
    'purchase_order_id', p_purchase_order_id,
    'bill_number', p_bill_number,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'payment_terms', p_payment_terms,
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', p_adjustment_cents,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay -> 'result' ->> 'bill_id')::uuid;
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'create_vendor_bill', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_bill_id := public._section9_create_vendor_bill_intent_impl_20260826(
    p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date, p_due_date,
    p_payment_terms, p_subtotal_cents, p_adjustment_cents, p_notes, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_bill_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_vendor_bill(
  p_bill_id uuid,
  p_subtotal_cents bigint,
  p_adjustment_cents bigint,
  p_bill_date date,
  p_due_date date,
  p_notes text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_vendor_bill requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'bill_id', p_bill_id,
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', p_adjustment_cents,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'update_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'update_vendor_bill', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_result := public._section9_update_vendor_bill_intent_impl_20260826(
    p_bill_id, p_subtotal_cents, p_adjustment_cents, p_bill_date,
    p_due_date, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'update_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_vendor_payment(
  p_vendor_bill_id uuid,
  p_amount_cents bigint,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT NULL::text,
  p_reference_number text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_vendor_payment requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_bill_id', p_vendor_bill_id,
    'amount_cents', p_amount_cents,
    'payment_date', p_payment_date,
    'payment_method', p_payment_method,
    'reference_number', p_reference_number,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'record_vendor_payment', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay -> 'result' ->> 'payment_id')::uuid;
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'record_vendor_payment', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_payment_id := public._section9_record_vendor_payment_intent_impl_20260826(
    p_vendor_bill_id, p_amount_cents, p_payment_date, p_payment_method,
    p_reference_number, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'record_vendor_payment';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_payment(
  p_payment_id uuid,
  p_reason text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can void vendor payments';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_vendor_payment requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'payment_id', p_payment_id, 'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_vendor_payment', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'void_vendor_payment', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_result := public._section9_void_vendor_payment_intent_impl_20260826(
    p_payment_id, p_reason, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'void_vendor_payment';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_bill(
  p_vendor_bill_id uuid,
  p_reason text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to void vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_vendor_bill requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'vendor_bill_id', p_vendor_bill_id, 'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN;
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'void_vendor_bill', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  PERFORM public._section9_void_vendor_bill_intent_impl_20260826(
    p_vendor_bill_id, p_reason, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'void_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_allow_over_receive boolean := COALESCE(p_allow_over_receive, false);
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: receive_po_items requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'items', p_items,
    'allow_over_receive', v_allow_over_receive
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'receive_po_items', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'receive_po_items', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_result := public._section9_receive_po_items_intent_impl_20260826(
    p_items, p_performed_by, p_idempotency_key, v_allow_over_receive
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'receive_po_items';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text) OWNER TO postgres;
ALTER FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text) OWNER TO postgres;
ALTER FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.void_vendor_payment(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.void_vendor_bill(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_vendor_payment(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_vendor_bill(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_vendor_payment(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_vendor_bill(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ap_dashboard_summary(
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today date := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_month_end date;
  v_result jsonb;
BEGIN
  PERFORM public.require_admin();
  v_month_end := (date_trunc('month', v_today)::date + INTERVAL '1 month - 1 day')::date;

  SELECT jsonb_build_object(
    'total_owed_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') THEN balance_cents ELSE 0 END), 0),
    'overdue_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < v_today THEN balance_cents ELSE 0 END), 0),
    'overdue_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < v_today THEN 1 END),
    'due_this_week_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN v_today AND v_today + 7 THEN balance_cents ELSE 0 END), 0),
    'due_this_week_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN v_today AND v_today + 7 THEN 1 END),
    'due_this_month_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN v_today AND v_month_end THEN balance_cents ELSE 0 END), 0),
    'total_bills', COUNT(*),
    'unpaid_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') THEN 1 END),
    'paid_this_month_cents', COALESCE((
      SELECT SUM(vp.amount_cents)
       FROM public.vendor_payments vp
       WHERE vp.payment_date >= date_trunc('month', v_today)::date
         AND vp.payment_date < (v_month_end + 1)
         AND vp.voided_at IS NULL
    ), 0)
  )
  INTO v_result
  FROM public.vendor_bills
  WHERE deleted_at IS NULL AND status <> 'voided';

  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.get_ap_dashboard_summary(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_ap_dashboard_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_dashboard_summary(text) TO authenticated, service_role;

DO $verify$
DECLARE
  v_name text;
  v_source text;
  v_signature text;
  v_trigger_count integer;
  v_overload_count integer;
  v_owner text;
  v_language text;
  v_security_definer boolean;
  v_config text[];
BEGIN
  FOR v_name, v_signature IN
    SELECT * FROM (VALUES
      ('create_vendor_bill', 'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'),
      ('update_vendor_bill', 'public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text)'),
      ('record_vendor_payment', 'public.record_vendor_payment(uuid,bigint,date,text,text,text,text)'),
      ('void_vendor_payment', 'public.void_vendor_payment(uuid,text,text)'),
      ('void_vendor_bill', 'public.void_vendor_bill(uuid,text,text)'),
      ('receive_po_items', 'public.receive_po_items(jsonb,uuid,text,boolean)')
    ) AS expected(name, signature)
  LOOP
    SELECT count(*) INTO v_overload_count
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_overload_count <> 1 OR to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'SECTION9_POSTFLIGHT_PUBLIC_OVERLOAD_DRIFT: %', v_name;
    END IF;
    SELECT p.prosrc, r.rolname, l.lanname, p.prosecdef, p.proconfig
      INTO v_source, v_owner, v_language, v_security_definer, v_config
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = to_regprocedure(v_signature);
    IF v_owner IS DISTINCT FROM 'postgres'
       OR v_language IS DISTINCT FROM 'plpgsql'
       OR v_security_definer IS DISTINCT FROM true
       OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
      RAISE EXCEPTION 'SECTION9_POSTFLIGHT_PUBLIC_FUNCTION_SHAPE_DRIFT: %', v_signature;
    END IF;
    IF position('check_idempotency_intent' IN v_source) = 0
       OR position('crx.section9_idempotency_intent' IN v_source) = 0
       OR position('request_actor_id = v_actor' IN v_source) = 0
       OR position('request_fingerprint = v_fingerprint' IN v_source) = 0 THEN
      RAISE EXCEPTION '% intent-binding wrapper verification failed', v_signature;
    END IF;
  END LOOP;

  SELECT COUNT(*)
    INTO v_trigger_count
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.idempotency_keys'::regclass
     AND t.tgname = 'section9_bind_idempotency_receipt_20260826'
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O';
  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'Section 9 receipt-binding trigger verification failed';
  END IF;

  SELECT count(*) INTO v_overload_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_ap_dashboard_summary';
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'SECTION9_POSTFLIGHT_PUBLIC_OVERLOAD_DRIFT: get_ap_dashboard_summary';
  END IF;
  SELECT p.prosrc, r.rolname, l.lanname, p.prosecdef, p.proconfig
    INTO v_source, v_owner, v_language, v_security_definer, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public.get_ap_dashboard_summary(text)'::regprocedure;
  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_language IS DISTINCT FROM 'plpgsql'
     OR v_security_definer IS DISTINCT FROM true
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR position('AT TIME ZONE ''America/Chicago''' IN v_source) = 0
     OR position('due_date BETWEEN v_today AND v_month_end' IN v_source) = 0
     OR position('vp.payment_date < (v_month_end + 1)' IN v_source) = 0
     OR position('CURRENT_DATE + 30' IN v_source) > 0 THEN
    RAISE EXCEPTION 'get_ap_dashboard_summary calendar-month verification failed';
  END IF;
END;
$verify$;
