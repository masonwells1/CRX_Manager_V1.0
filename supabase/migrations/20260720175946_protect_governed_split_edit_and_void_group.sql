-- Close two split-invoice integrity gaps found by the exact-SHA Codex gate:
-- 1. save_invoice replaces line items without preserving order_item_id, so a
--    governed field-acre split must never pass through that generic editor.
-- 2. void_invoice previously allowed one member of a governed group to be
--    voided independently. Group voids must be one all-or-nothing transaction.

-- Keep the zero-exposure preflight and RPC cutover atomic with invoice writers.
LOCK TABLE public.invoices, public.invoice_items, public.split_invoice_provenance
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_save_hash text;
  v_void_hash text;
  v_governed_count bigint;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_save_hash
    FROM pg_proc p
   WHERE p.oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure;
  SELECT md5(p.prosrc)
    INTO v_void_hash
    FROM pg_proc p
   WHERE p.oid = 'public.void_invoice(uuid,text,text)'::regprocedure;
  SELECT count(*) INTO v_governed_count
    FROM public.split_invoice_provenance;

  IF v_save_hash IS DISTINCT FROM '6eb68b6248b52328bfc94284e790ef85' THEN
    RAISE EXCEPTION 'PREFLIGHT_SAVE_INVOICE_DRIFT: expected 6eb68b6248b52328bfc94284e790ef85, got %', v_save_hash;
  END IF;
  IF v_void_hash IS DISTINCT FROM '9f1656542c5c6a667b1c8a67034c5c3f' THEN
    RAISE EXCEPTION 'PREFLIGHT_VOID_INVOICE_DRIFT: expected 9f1656542c5c6a667b1c8a67034c5c3f, got %', v_void_hash;
  END IF;
  IF v_governed_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_GOVERNED_SPLIT_RECONCILIATION_REQUIRED: expected zero rows, found %',
      v_governed_count;
  END IF;
END;
$preflight$;

ALTER FUNCTION public.save_invoice(jsonb, jsonb, text)
  RENAME TO _save_invoice_governed_split_guard_impl_20260720;

REVOKE ALL ON FUNCTION
  public._save_invoice_governed_split_guard_impl_20260720(jsonb, jsonb, text)
FROM PUBLIC, anon, authenticated, service_role;

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
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
BEGIN
  IF v_invoice_id IS NOT NULL THEN
    PERFORM 1
      FROM public.invoices i
     WHERE i.id = v_invoice_id
     FOR UPDATE;

    IF EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance p
       WHERE p.invoice_id = v_invoice_id
    ) THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_EDIT_REQUIRES_REISSUE: governed split invoices cannot be edited; void the group and create a replacement'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN public._save_invoice_governed_split_guard_impl_20260720(
    p_invoice,
    p_items,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  TO authenticated, service_role;

ALTER FUNCTION public.void_invoice(uuid, text, text)
  RENAME TO _void_invoice_group_guard_impl_20260720;

REVOKE ALL ON FUNCTION
  public._void_invoice_group_guard_impl_20260720(uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_group_id uuid;
  v_governed boolean := false;
BEGIN
  SELECT i.invoice_group_id,
         EXISTS (
           SELECT 1
             FROM public.split_invoice_provenance p
            WHERE p.invoice_id = i.id
         )
    INTO v_group_id, v_governed
    FROM public.invoices i
   WHERE i.id = p_invoice_id
   FOR UPDATE;

  IF FOUND AND v_governed AND v_group_id IS NOT NULL THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_GROUP_VOID_REQUIRED: use void_invoice_group so every governed member is voided atomically'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._void_invoice_group_guard_impl_20260720(
    p_invoice_id,
    p_void_reason,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.void_invoice(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_invoice(uuid, text, text)
  TO authenticated, service_role;

CREATE FUNCTION public.void_invoice_group(
  p_invoice_group_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'void_invoice_group_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_member record;
  v_member_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
BEGIN
  IF p_invoice_group_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_GROUP_ID_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_void_reason), '') IS NULL THEN
    RAISE EXCEPTION 'VOID_REASON_REQUIRED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = v_actor
       AND p.is_active = true
       AND p.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin users can void invoices';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'invoice_group_id', p_invoice_group_id,
    'void_reason', p_void_reason
  );
  v_fingerprint := md5(v_request::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'void_invoice_group',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_replay IS NOT NULL THEN
      RETURN (v_replay #>> '{}')::integer;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(i.id ORDER BY i.id), '{}'::uuid[])
    INTO v_member_ids
    FROM public.invoices i
   WHERE i.invoice_group_id = p_invoice_group_id
     AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled');

  IF cardinality(v_member_ids) = 0 THEN
    RAISE EXCEPTION 'INVOICE_GROUP_HAS_NO_ACTIVE_MEMBERS: %', p_invoice_group_id;
  END IF;

  -- Deterministic row locking makes every precheck and mutation observe one
  -- stable group. Any member failure rolls the entire function back.
  PERFORM 1
    FROM public.invoices i
   WHERE i.id = ANY(v_member_ids)
   ORDER BY i.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM unnest(v_member_ids) member_id
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.split_invoice_provenance p
        WHERE p.invoice_id = member_id
          AND p.invoice_group_id = p_invoice_group_id
     )
  ) THEN
    RAISE EXCEPTION
      'INVOICE_GROUP_PROVENANCE_REQUIRED: every active member must have exact governed split provenance';
  END IF;

  FOR v_member IN
    SELECT unnest(v_member_ids) AS invoice_id
  LOOP
    PERFORM public._void_invoice_group_guard_impl_20260720(
      v_member.invoice_id,
      p_void_reason,
      NULL::text
    );
    v_count := v_count + 1;
  END LOOP;

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'void_invoice_group',
    v_contract,
    v_fingerprint,
    v_request,
    to_jsonb(v_count)
  );

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.void_invoice_group(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_invoice_group(uuid, text, text)
  TO authenticated, service_role;

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.void_invoice_group(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_invoice_group(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_invoice_group_guard_impl_20260720(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_GRANT_MISMATCH';
  END IF;
END;
$postflight$;
