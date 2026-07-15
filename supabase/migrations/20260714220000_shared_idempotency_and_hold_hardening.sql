-- Shared money/inventory hardening.
-- 1. Serialize every idempotency key before checking the cache.
-- 2. Make inventory-hold writes RPC-only.
-- 3. Gate batch prepay application to active admins.
-- 4. Retire browser access to unused legacy mutation endpoints.

CREATE OR REPLACE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing record;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;

  -- idempotency_keys is globally unique on idempotency_key, not operation/key.
  -- Lock that same boundary so same-operation retries and accidental
  -- cross-operation key reuse serialize before either caller mutates.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));

  DELETE FROM public.idempotency_keys WHERE expires_at < now();
  SELECT * INTO v_existing
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key;

  IF FOUND THEN
    IF v_existing.operation IS DISTINCT FROM p_operation THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
    END IF;
    RETURN v_existing.result;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_idempotency(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_idempotency(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.save_idempotency(
  p_key text,
  p_operation text,
  p_result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_op text;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;

  SELECT operation INTO v_existing_op
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key
    AND operation <> p_operation
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing_op, p_operation;
  END IF;

  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_idempotency(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_idempotency(text, text, jsonb) TO service_role;

-- Keep the existing implementation as an owner-only helper and put the
-- route-level active-admin contract around the public RPC name.
ALTER FUNCTION public.batch_apply_prepayments(jsonb, uuid, text)
  RENAME TO _batch_apply_prepayments_impl;
REVOKE ALL ON FUNCTION public._batch_apply_prepayments_impl(jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._batch_apply_prepayments_impl(jsonb, uuid, text)
  TO service_role;

CREATE FUNCTION public.batch_apply_prepayments(
  p_allocations jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;

  v_result := public._batch_apply_prepayments_impl(
    p_allocations, v_actor, p_idempotency_key
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'batch_apply_prepayments', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text)
  TO authenticated, service_role;

DROP POLICY IF EXISTS inventory_holds_insert ON public.inventory_holds;
DROP POLICY IF EXISTS inventory_holds_update ON public.inventory_holds;
DROP POLICY IF EXISTS inventory_holds_delete ON public.inventory_holds;

-- No current frontend caller exists for these legacy mutation RPCs. Keep them
-- available to service-role maintenance only instead of exposing unsafe paths.
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.restore_cancelled_delivery(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_cancelled_delivery(uuid, text, uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.adjust_inventory(uuid, numeric, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory(uuid, numeric, text, uuid, text)
  TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.check_idempotency(text,text)'::regprocedure
      AND prosrc LIKE '%pg_advisory_xact_lock%'
      AND prosrc LIKE '%IDEMPOTENCY_CROSS_OP_KEY_REUSE%'
      AND prosrc LIKE '%IDEMPOTENCY_KEY_REQUIRED%'
  ) THEN
    RAISE EXCEPTION 'check_idempotency lost serialization, blank-key, or cross-operation rejection';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.save_idempotency(text,text,jsonb)'::regprocedure
      AND prosrc LIKE '%IDEMPOTENCY_KEY_REQUIRED%'
      AND prosrc LIKE '%IDEMPOTENCY_CROSS_OP_KEY_REUSE%'
  ) THEN
    RAISE EXCEPTION 'save_idempotency lost blank-key or cross-operation rejection';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inventory_holds'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'inventory_holds still exposes direct writes';
  END IF;
  IF has_function_privilege('anon', 'public.adjust_inventory(uuid,numeric,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'adjust_inventory remains anon executable';
  END IF;
END $$;
