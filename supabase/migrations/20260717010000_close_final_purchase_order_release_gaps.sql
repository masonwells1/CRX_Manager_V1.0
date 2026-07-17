-- Close the final purchase-order release review gaps:
--   * allocate PO numbers inside the same transaction that inserts the PO;
--   * remove bulk-import claims when an admin deliberately deletes their PO;
--   * compare vendor bills with the authoritative line-rounded PO header.

DO $guard$
BEGIN
  IF to_regprocedure(
    'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Expected save_purchase_order(uuid,jsonb,jsonb,uuid,text)';
  END IF;
  IF to_regprocedure(
    'public._save_purchase_order_atomic_number_impl(uuid,jsonb,jsonb,uuid,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION '_save_purchase_order_atomic_number_impl already exists';
  END IF;
END
$guard$;

ALTER FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  RENAME TO _save_purchase_order_atomic_number_impl;

REVOKE ALL ON FUNCTION public._save_purchase_order_atomic_number_impl(
  uuid, jsonb, jsonb, uuid, text
)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_payload jsonb := COALESCE(p_po_payload, '{}'::jsonb);
  v_result jsonb;
  v_po_number text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  IF p_po_id IS NULL THEN
    -- next_po_number takes a transaction-scoped advisory lock. Calling it from
    -- this outer writer keeps that lock until the delegated INSERT commits, so
    -- a concurrent creator cannot receive the same MAX+1 value.
    v_po_number := public.next_po_number();
    v_payload := jsonb_set(
      v_payload,
      '{po_number}',
      to_jsonb(v_po_number),
      true
    );
  END IF;

  v_result := public._save_purchase_order_atomic_number_impl(
    p_po_id,
    v_payload,
    p_items,
    p_performed_by,
    p_idempotency_key
  );

  IF NULLIF(v_result->>'po_id', '') IS NOT NULL THEN
    SELECT po_number
      INTO v_po_number
      FROM public.purchase_orders
     WHERE id = (v_result->>'po_id')::uuid;
    IF v_po_number IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
)
TO authenticated, service_role;

COMMENT ON FUNCTION public._save_purchase_order_atomic_number_impl(
  uuid, jsonb, jsonb, uuid, text
) IS 'Internal purchase-order writer. Direct execution is revoked; use public.save_purchase_order so new PO numbering and insertion share one transaction lock.';
COMMENT ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
) IS 'Saves a purchase order; new PO numbers are allocated atomically inside the insert transaction.';

-- A bulk-import claim has no independent business meaning after its PO is
-- deliberately removed by the admin-only delete workflow. Cascading the claim
-- permits the delete and allows a later reviewed re-import of that document.
ALTER TABLE public.purchase_order_import_intents
  DROP CONSTRAINT IF EXISTS purchase_order_import_intents_purchase_order_id_fkey;
ALTER TABLE public.purchase_order_import_intents
  ADD CONSTRAINT purchase_order_import_intents_purchase_order_id_fkey
  FOREIGN KEY (purchase_order_id)
  REFERENCES public.purchase_orders(id)
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_total bigint;
  v_bill_id uuid;
  v_terms_days integer;
  v_terms text;
  v_actor uuid;
  v_actor_role text;
  v_existing jsonb;
  v_vendor_name text;
  v_po_vendor text;
  v_po_total_cents bigint;
  v_amount_drift_pct numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_vendor_bill');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'bill_id')::uuid;
    END IF;
  END IF;

  PERFORM public.check_period_open(p_bill_date);

  SELECT name INTO v_vendor_name
    FROM public.vendors
   WHERE id = p_vendor_id
     AND deleted_at IS NULL;
  IF v_vendor_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  IF p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;

  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    -- total_cost_cents is maintained as the sum of individually rounded line
    -- extensions, so the bill comparison must consume that exact authority.
    SELECT vendor, total_cost_cents
      INTO v_po_vendor, v_po_total_cents
      FROM public.purchase_orders
     WHERE id = p_purchase_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id;
    END IF;
    IF lower(trim(v_po_vendor)) <> lower(trim(v_vendor_name)) THEN
      RAISE EXCEPTION 'VENDOR_PO_MISMATCH: bill vendor "%" does not match PO vendor "%"',
        v_vendor_name, v_po_vendor;
    END IF;

    IF v_po_total_cents > 0 THEN
      v_amount_drift_pct := ABS(v_total - v_po_total_cents)::numeric / v_po_total_cents::numeric;
      IF v_amount_drift_pct > 0.05 THEN
        INSERT INTO public.notifications (
          user_id,
          title,
          message,
          notification_type,
          related_entity_type,
          related_entity_id
        )
        SELECT
          p.id,
          'Vendor bill amount differs from PO',
          'Bill ' || COALESCE(NULLIF(p_bill_number, ''), 'pending') ||
            ' for ' || v_vendor_name ||
            ' is $' || (v_total / 100.0)::numeric(12,2) ||
            ' but PO total is $' || (v_po_total_cents / 100.0)::numeric(12,2) ||
            ' (' || ROUND(v_amount_drift_pct * 100, 1) || '% drift). Verify the bill matches the PO.',
          'vendor_bill_drift',
          'purchase_order',
          p_purchase_order_id
        FROM public.profiles p
        WHERE p.role = 'admin'
          AND p.is_active = true;
      END IF;
    END IF;
  END IF;

  IF p_payment_terms IS NULL THEN
    SELECT default_payment_terms, default_payment_terms_days
      INTO v_terms, v_terms_days
      FROM public.vendors
     WHERE id = p_vendor_id;
  ELSE
    v_terms := p_payment_terms;
    v_terms_days := CASE
      WHEN p_payment_terms ILIKE '%90%' THEN 90
      WHEN p_payment_terms ILIKE '%60%' THEN 60
      WHEN p_payment_terms ILIKE '%45%' THEN 45
      WHEN p_payment_terms ILIKE '%30%' THEN 30
      WHEN p_payment_terms ILIKE '%15%' THEN 15
      WHEN p_payment_terms ILIKE '%10%' THEN 10
      ELSE 30
    END;
  END IF;

  INSERT INTO public.vendor_bills (
    vendor_id,
    purchase_order_id,
    bill_number,
    bill_date,
    due_date,
    payment_terms,
    subtotal_cents,
    adjustment_cents,
    total_cents,
    paid_cents,
    status,
    notes,
    created_by
  ) VALUES (
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    COALESCE(
      p_due_date,
      p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval
    ),
    v_terms,
    p_subtotal_cents,
    COALESCE(p_adjustment_cents, 0),
    v_total,
    0,
    'unpaid',
    p_notes,
    v_actor
  )
  RETURNING id INTO v_bill_id;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id,
    actor_role,
    new_values,
    total_impact_cents,
    description
  ) VALUES (
    'vendor_bill_created',
    'vendor_bill',
    v_bill_id,
    v_actor,
    v_actor_role,
    jsonb_build_object(
      'vendor_id', p_vendor_id,
      'purchase_order_id', p_purchase_order_id,
      'bill_number', p_bill_number,
      'bill_date', p_bill_date,
      'total_cents', v_total,
      'po_total_cents', v_po_total_cents,
      'drift_pct', v_amount_drift_pct
    ),
    v_total,
    'Vendor bill ' || COALESCE(NULLIF(p_bill_number, ''), v_bill_id::text) ||
      ' created for $' || (v_total / 100.0)::numeric(12,2)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_vendor_bill',
      jsonb_build_object('bill_id', v_bill_id)
    );
  END IF;

  RETURN v_bill_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
)
TO authenticated, service_role;

DO $verify$
DECLARE
  v_save_source text;
  v_bill_source text;
  v_save_config text[];
  v_delete_action "char";
BEGIN
  SELECT prosrc, proconfig
    INTO v_save_source, v_save_config
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  IF v_save_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_save_source NOT LIKE '%public.next_po_number()%'
     OR v_save_source NOT LIKE '%_save_purchase_order_atomic_number_impl%'
     OR strpos(v_save_source, 'public.next_po_number()')
        > strpos(v_save_source, '_save_purchase_order_atomic_number_impl') THEN
    RAISE EXCEPTION 'save_purchase_order atomic-number wrapper is incomplete';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public._save_purchase_order_atomic_number_impl(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'save_purchase_order wrapper grants are too broad';
  END IF;

  SELECT confdeltype
    INTO v_delete_action
    FROM pg_constraint
   WHERE conrelid = 'public.purchase_order_import_intents'::regclass
     AND conname = 'purchase_order_import_intents_purchase_order_id_fkey';
  IF v_delete_action IS DISTINCT FROM 'c'::"char" THEN
    RAISE EXCEPTION 'Bulk-import claim FK must cascade when its PO is deleted';
  END IF;

  SELECT prosrc
    INTO v_bill_source
    FROM pg_proc
   WHERE oid = 'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'::regprocedure;
  IF v_bill_source NOT LIKE '%SELECT vendor, total_cost_cents%'
     OR v_bill_source LIKE '%SUM(quantity_ordered * unit_cost * 100)%' THEN
    RAISE EXCEPTION 'create_vendor_bill must use authoritative PO total_cost_cents';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Anonymous create_vendor_bill execute must remain revoked';
  END IF;
END
$verify$;
