-- Serialize field-application invoice saves with single-invoice and group posting.
--
-- The prior save function checked draft/unposted status without locking the invoice
-- rows, then deleted and rebuilt child rows. A concurrent post could therefore
-- commit between that check and those writes. Keep the mature implementation as an
-- owner-only helper and put the public RPC behind a lock-and-recheck wrapper.

ALTER FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text)
  RENAME TO _save_field_app_invoice_impl_20260714;

REVOKE ALL ON FUNCTION public._save_field_app_invoice_impl_20260714(uuid, jsonb, jsonb, jsonb, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._save_field_app_invoice_impl_20260714(uuid, jsonb, jsonb, jsonb, uuid, uuid, text)
  TO service_role;

CREATE FUNCTION public.save_field_app_invoice(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_locations jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_application_service_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_initial_group_id uuid;
  v_locked_group_id uuid;
  v_locked_status text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = v_actor
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required to save field application invoices';
  END IF;

  -- This acquires the shared transaction-scoped advisory lock before any invoice
  -- row is touched. A retry that already completed returns without being rejected
  -- merely because the invoice was posted after the original save committed.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'save_field_app_invoice'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id
      INTO v_initial_group_id
    FROM public.invoices
    WHERE id = p_invoice_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
    END IF;

    -- Use the same row-lock boundary as post_invoice/post_invoice_group. Once this
    -- returns, a concurrent post has either completed (and is rejected below) or
    -- must wait until the complete save transaction finishes.
    IF v_initial_group_id IS NOT NULL THEN
      -- A row UUID is not a stable group anchor: a concurrent insert can create a
      -- lower UUID. Serialize every group save/post on the immutable group ID first.
      PERFORM pg_advisory_xact_lock(hashtextextended(v_initial_group_id::text, 0));

      -- Lock one stable member first, then acquire the full set in a NEW statement.
      -- Under READ COMMITTED, a one-statement multi-row lock keeps its pre-wait
      -- snapshot and can miss a sibling created by the transaction it waited for.
      -- The anchor wait ends first; the fresh second statement then sees and locks
      -- every current sibling. post_invoice_group uses the identical order below.
      PERFORM 1
      FROM public.invoices
      WHERE invoice_group_id = v_initial_group_id
        AND deleted_at IS NULL
      ORDER BY id
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice group changed while saving; reload and try again';
      END IF;

      PERFORM 1
      FROM public.invoices
      WHERE invoice_group_id = v_initial_group_id
        AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE;
    ELSE
      PERFORM 1
      FROM public.invoices
      WHERE id = p_invoice_id
        AND deleted_at IS NULL
      FOR UPDATE;
    END IF;

    SELECT status, invoice_group_id
      INTO v_locked_status, v_locked_group_id
    FROM public.invoices
    WHERE id = p_invoice_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
    END IF;
    IF v_locked_group_id IS DISTINCT FROM v_initial_group_id THEN
      RAISE EXCEPTION 'Invoice group changed while saving; reload and try again';
    END IF;
    IF v_locked_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice with status: %', v_locked_status;
    END IF;
    IF v_locked_group_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.invoices
      WHERE invoice_group_id = v_locked_group_id
        AND deleted_at IS NULL
        AND status NOT IN ('draft', 'unposted')
    ) THEN
      RAISE EXCEPTION 'Cannot edit field app invoice group after any member is posted or voided';
    END IF;
  END IF;

  RETURN public._save_field_app_invoice_impl_20260714(
    p_invoice_id,
    p_invoice,
    p_locations,
    p_chemicals,
    v_actor,
    p_application_service_id,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) IS
  'Saves a field-application invoice after locking and rechecking the target invoice or split group so save and post cannot race.';

-- A grouped invoice must never be posted member-by-member. Preserve the mature
-- implementation as an owner-only helper; the public entrypoint rejects grouped
-- invoices, while post_invoice_group invokes the helper only after locking and
-- validating the complete member set.
ALTER FUNCTION public.post_invoice(uuid, text)
  RENAME TO _post_invoice_impl_20260714;
REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._post_invoice_impl_20260714(uuid, text)
  TO service_role;

CREATE FUNCTION public.post_invoice(
  p_invoice_id uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing jsonb;
  v_group_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT invoice_group_id INTO v_group_id
  FROM public.invoices
  WHERE id = p_invoice_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_POST_REQUIRED';
  END IF;

  PERFORM public._post_invoice_impl_20260714(p_invoice_id, p_idempotency_key);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid, text) TO authenticated, service_role;

-- The existing group-post function locked the same member set without a stable
-- order. Re-emit it with the same anchor + ordered full-set lock as save so the two
-- operations cannot deadlock or retain a snapshot that misses a just-created member.
CREATE OR REPLACE FUNCTION public.post_invoice_group(
  p_invoice_group_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_inv record;
  v_posted_ids uuid[] := '{}';
  v_total_cents bigint := 0;
  v_member_count int := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to post invoice groups';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'post_invoice_group');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_group_id IS NULL THEN
    RAISE EXCEPTION 'invoice_group_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_invoice_group_id::text, 0));

  PERFORM 1
  FROM public.invoices
  WHERE invoice_group_id = p_invoice_group_id
    AND deleted_at IS NULL
  ORDER BY id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id;
  END IF;

  PERFORM 1
  FROM public.invoices
  WHERE invoice_group_id = p_invoice_group_id
    AND deleted_at IS NULL
  ORDER BY id
  FOR UPDATE;

  SELECT count(*) INTO v_member_count
  FROM public.invoices
  WHERE invoice_group_id = p_invoice_group_id
    AND deleted_at IS NULL;

  FOR v_inv IN
    SELECT *
    FROM public.invoices
    WHERE invoice_group_id = p_invoice_group_id
      AND deleted_at IS NULL
    ORDER BY invoice_number
  LOOP
    IF v_inv.status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot post group -- invoice % has status %',
        v_inv.invoice_number, v_inv.status;
    END IF;
    IF v_inv.pricing_pending THEN
      RAISE EXCEPTION 'PRICING_INCOMPLETE';
    END IF;
    PERFORM public.check_period_open(v_inv.invoice_date);
  END LOOP;

  FOR v_inv IN
    SELECT *
    FROM public.invoices
    WHERE invoice_group_id = p_invoice_group_id
      AND deleted_at IS NULL
    ORDER BY invoice_number
  LOOP
    PERFORM public._post_invoice_impl_20260714(v_inv.id, NULL);
    v_posted_ids := array_append(v_posted_ids, v_inv.id);
    v_total_cents := v_total_cents + v_inv.total_amount_cents;
  END LOOP;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'invoice_group_posted',
    'Posted ' || v_member_count || ' invoice(s) in group -- total $' ||
      (v_total_cents / 100.0)::numeric(12,2),
    p_performed_by, 'invoice', v_posted_ids[1]
  );

  v_result := jsonb_build_object(
    'posted_invoice_ids', to_jsonb(v_posted_ids),
    'invoice_group_id', p_invoice_group_id,
    'total_posted_cents', v_total_cents,
    'member_count', v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'post_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice_group(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_group(uuid, uuid, text)
  TO authenticated, service_role;

DO $$
DECLARE
  v_source text;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure;

  IF v_source IS NULL
     OR strpos(v_source, 'pg_advisory_xact_lock') = 0
     OR strpos(v_source, 'FOR UPDATE') = 0
     OR strpos(v_source, 'LIMIT 1') = 0
     OR strpos(v_source, '_save_field_app_invoice_impl_20260714') = 0
     OR strpos(v_source, 'v_locked_status NOT IN') = 0
     OR strpos(v_source, 'v_locked_status NOT IN') > strpos(v_source, '_save_field_app_invoice_impl_20260714') THEN
    RAISE EXCEPTION 'save_field_app_invoice lock/recheck wrapper is incomplete';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'field-app save implementation remains browser executable';
  END IF;

  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'public.post_invoice(uuid,text)'::regprocedure;
  IF v_source IS NULL
     OR strpos(v_source, 'GROUP_POST_REQUIRED') = 0
     OR strpos(v_source, '_post_invoice_impl_20260714') = 0 THEN
    RAISE EXCEPTION 'post_invoice grouped-invoice guard is incomplete';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public._post_invoice_impl_20260714(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'post_invoice implementation remains browser executable';
  END IF;

  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'public.post_invoice_group(uuid,uuid,text)'::regprocedure;
  IF v_source IS NULL
     OR strpos(v_source, 'pg_advisory_xact_lock') = 0
     OR strpos(v_source, 'LIMIT 1') = 0
     OR strpos(v_source, 'ORDER BY id') = 0
     OR strpos(v_source, 'FOR UPDATE') = 0
     OR strpos(v_source, 'check_idempotency') = 0
     OR strpos(v_source, 'save_idempotency') = 0
     OR strpos(v_source, '_post_invoice_impl_20260714') = 0 THEN
    RAISE EXCEPTION 'post_invoice_group anchor/ordered locking is incomplete';
  END IF;
END $$;
