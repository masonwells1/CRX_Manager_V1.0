-- idempotency-body-check: exempt
-- Section 9 HIGH remediation: authoritative PO on-order cache, governed vendor
-- writes, PO/bill serialization, truthful AP aging, and closed-period bill edits.

-- ---------------------------------------------------------------------------
-- 1. inventory.quantity_on_order has one authority: the Main Warehouse row.
-- Recompute from open PO remainder instead of maintaining scattered deltas.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._recompute_po_on_order_for_products(
  p_product_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_id uuid;
  v_expected numeric;
BEGIN
  -- Serialize the aggregate before reading it. This transaction-scoped lock is
  -- intentionally global: one PO edit can touch several products across
  -- several SQL statements, so per-product locks can still be acquired in
  -- opposite orders and deadlock. PO volume is low and correctness wins here.
  PERFORM pg_advisory_xact_lock(73492009);

  FOR v_product_id IN
    SELECT DISTINCT product_id
    FROM unnest(COALESCE(p_product_ids, ARRAY[]::uuid[])) AS product_id
    WHERE product_id IS NOT NULL
    ORDER BY product_id
  LOOP
    SELECT COALESCE(SUM(GREATEST(
      poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
      0
    )), 0)
    INTO v_expected
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE poi.product_id = v_product_id
      AND po.status IN ('submitted', 'partially_received');

    IF v_expected > 0 THEN
      INSERT INTO public.inventory (
        product_id,
        location,
        quantity_available,
        quantity_prebooked,
        quantity_on_order
      ) VALUES (
        v_product_id,
        'Main Warehouse',
        0,
        0,
        0
      )
      ON CONFLICT (product_id, location) DO NOTHING;
    END IF;

    -- The transaction-wide PO-derived-state lock above makes this write the
    -- only concurrent recomputation authority. Receiving may already hold the
    -- same Main Warehouse row; alternate-location stock remains independent.
    UPDATE public.inventory
    SET quantity_on_order = v_expected,
        updated_at = now()
    WHERE product_id = v_product_id
      AND location = 'Main Warehouse'
      AND quantity_on_order IS DISTINCT FROM v_expected;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public._recompute_po_on_order_for_products(uuid[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._recompute_po_on_order_for_products(uuid[])
TO service_role;

CREATE OR REPLACE FUNCTION public.trg_po_items_recompute_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._recompute_po_on_order_for_products(
    CASE TG_OP
      WHEN 'INSERT' THEN ARRAY[NEW.product_id]
      WHEN 'DELETE' THEN ARRAY[OLD.product_id]
      ELSE ARRAY[OLD.product_id, NEW.product_id]
    END
  );
  RETURN COALESCE(NEW, OLD);
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_po_items_recompute_on_order()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_po_items_recompute_on_order
ON public.purchase_order_items;
CREATE TRIGGER trg_po_items_recompute_on_order
AFTER INSERT OR DELETE OR UPDATE OF
  purchase_order_id,
  product_id,
  quantity_ordered,
  quantity_received
ON public.purchase_order_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_po_items_recompute_on_order();

CREATE OR REPLACE FUNCTION public.trg_po_status_recompute_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_ids uuid[];
BEGIN
  SELECT ARRAY_AGG(DISTINCT poi.product_id ORDER BY poi.product_id)
  INTO v_product_ids
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = NEW.id;

  PERFORM public._recompute_po_on_order_for_products(v_product_ids);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_po_status_recompute_on_order()
FROM PUBLIC, anon, authenticated;

-- Retire the draft->submitted/cancelled delta trigger. The replacement handles
-- every status transition by recomputing the authoritative remainder.
DROP TRIGGER IF EXISTS trg_po_submitted_on_order ON public.purchase_orders;
DROP TRIGGER IF EXISTS trg_po_status_recompute_on_order ON public.purchase_orders;
CREATE TRIGGER trg_po_status_recompute_on_order
AFTER UPDATE OF status ON public.purchase_orders
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.trg_po_status_recompute_on_order();

-- Every governed path that can reach the recompute trigger takes the same
-- transaction lock before it locks a PO or inventory row. Renaming preserves
-- the reviewed implementation OID; the thin public wrapper standardizes lock
-- order without copying six mature money/inventory functions into this patch.
ALTER FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  RENAME TO _section9_save_purchase_order_serialized;
ALTER FUNCTION public.submit_purchase_order(uuid, uuid, text)
  RENAME TO _section9_submit_purchase_order_serialized;
ALTER FUNCTION public.cancel_purchase_order(uuid, text, uuid, text)
  RENAME TO _section9_cancel_purchase_order_serialized;
ALTER FUNCTION public.delete_purchase_order(uuid, uuid, text)
  RENAME TO _section9_delete_purchase_order_serialized;
ALTER FUNCTION public.receive_po_items(jsonb, uuid, text, boolean)
  RENAME TO _section9_receive_po_items_serialized;
ALTER FUNCTION public.reverse_receiving_record(uuid, text, uuid, text)
  RENAME TO _section9_reverse_receiving_record_serialized;

REVOKE ALL ON FUNCTION public._section9_save_purchase_order_serialized(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._section9_submit_purchase_order_serialized(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._section9_cancel_purchase_order_serialized(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._section9_delete_purchase_order_serialized(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._section9_receive_po_items_serialized(jsonb, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._section9_reverse_receiving_record_serialized(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.save_purchase_order(
  p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  RETURN public._section9_save_purchase_order_serialized(
    p_po_id, p_po_payload, p_items, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.submit_purchase_order(
  p_po_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  RETURN public._section9_submit_purchase_order_serialized(
    p_po_id, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.cancel_purchase_order(
  p_po_id uuid, p_reason text DEFAULT 'Cancelled', p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  RETURN public._section9_cancel_purchase_order_serialized(
    p_po_id, p_reason, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.delete_purchase_order(
  p_po_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  RETURN public._section9_delete_purchase_order_serialized(
    p_po_id, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.receive_po_items(
  p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  RETURN public._section9_receive_po_items_serialized(
    p_items, p_performed_by, p_idempotency_key, p_allow_over_receive
  );
END;
$function$;

CREATE FUNCTION public.reverse_receiving_record(
  p_record_id uuid, p_reason text DEFAULT 'Manually reversed',
  p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  RETURN public._section9_reverse_receiving_record_serialized(
    p_record_id, p_reason, p_performed_by, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_purchase_order(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_purchase_order(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_purchase_order(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_purchase_order(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_purchase_order(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text) TO authenticated, service_role;

-- Fail closed on migration drift. The live preflight was clean; this migration
-- intentionally does not rewrite historical rows.
DO $verification$
DECLARE
  v_mismatch_count integer;
BEGIN
  SELECT COUNT(*)
  INTO v_mismatch_count
  FROM (
    SELECT
      COALESCE(i.product_id, expected.product_id) AS product_id,
      i.quantity_on_order AS actual,
      COALESCE(expected.quantity_on_order, 0) AS expected
    FROM (
      SELECT
        poi.product_id,
        SUM(GREATEST(
          poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
          0
        )) AS quantity_on_order
      FROM public.purchase_order_items poi
      JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ) expected
    FULL JOIN (
      SELECT product_id, quantity_on_order
      FROM public.inventory
      WHERE location = 'Main Warehouse'
    ) i ON i.product_id = expected.product_id
  ) comparison
  WHERE comparison.actual IS DISTINCT FROM comparison.expected;

  IF v_mismatch_count > 0 THEN
    RAISE EXCEPTION
      'SECTION9_ON_ORDER_PREFLIGHT_FAILED: % Main Warehouse rows require governed reconciliation',
      v_mismatch_count;
  END IF;
END;
$verification$;

-- ---------------------------------------------------------------------------
-- 2. Vendor master data: browser roles read; active-admin RPCs write.
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.vendors
FROM anon, authenticated;

DROP POLICY IF EXISTS vendors_insert ON public.vendors;
DROP POLICY IF EXISTS vendors_update ON public.vendors;
DROP POLICY IF EXISTS vendors_admin_delete ON public.vendors;

-- Preserve governed read access and service/migration ownership. save_vendor
-- and delete_vendor retain their existing active-admin body checks and grants.

-- ---------------------------------------------------------------------------
-- 3. Serialize vendor-bill creation with PO cancellation.
-- ---------------------------------------------------------------------------

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
  v_po_status text;
  v_po_total_cents bigint;
  v_amount_drift_pct numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'create_vendor_bill'
    );
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
    RAISE EXCEPTION
      'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted',
      p_vendor_id;
  END IF;

  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;

  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_total <= 0 THEN
    RAISE EXCEPTION
      'INVALID_AMOUNT: bill total must be positive (got %)',
      v_total;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    -- cancel_purchase_order takes this same parent lock first, then inspects
    -- vendor_bills. Holding it through INSERT makes create/cancel serializable.
    SELECT vendor, status, total_cost_cents
    INTO v_po_vendor, v_po_status, v_po_total_cents
    FROM public.purchase_orders
    WHERE id = p_purchase_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'PO_NOT_FOUND: purchase order % does not exist',
        p_purchase_order_id;
    END IF;
    IF v_po_status NOT IN (
      'submitted',
      'partially_received',
      'fully_received'
    ) THEN
      RAISE EXCEPTION
        'PO_NOT_BILLABLE: purchase order % has status %',
        p_purchase_order_id,
        v_po_status;
    END IF;
    IF lower(trim(v_po_vendor)) <> lower(trim(v_vendor_name)) THEN
      RAISE EXCEPTION
        'VENDOR_PO_MISMATCH: bill vendor "%" does not match PO vendor "%"',
        v_vendor_name,
        v_po_vendor;
    END IF;

    IF v_po_total_cents > 0 THEN
      v_amount_drift_pct :=
        ABS(v_total - v_po_total_cents)::numeric /
        v_po_total_cents::numeric;
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
            ' but PO total is $' ||
            (v_po_total_cents / 100.0)::numeric(12,2) ||
            ' (' || ROUND(v_amount_drift_pct * 100, 1) ||
            '% drift). Verify the bill matches the PO.',
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
    'Vendor bill ' ||
      COALESCE(NULLIF(p_bill_number, ''), v_bill_id::text) ||
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

-- ---------------------------------------------------------------------------
-- 4. Existing rows lack complete durable history. Reject historical dates
-- rather than presenting today's balance/status as a past snapshot.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_ap_aging(
  p_as_of_date date DEFAULT ((clock_timestamp() AT TIME ZONE 'America/Chicago')::date)
)
RETURNS TABLE(
  vendor_id uuid,
  vendor_name text,
  current_amount bigint,
  days_31_60 bigint,
  days_61_90 bigint,
  over_90 bigint,
  total_outstanding bigint,
  bill_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.require_admin();

  IF p_as_of_date IS DISTINCT FROM
    ((clock_timestamp() AT TIME ZONE 'America/Chicago')::date)
  THEN
    RAISE EXCEPTION
      'HISTORICAL_AP_UNAVAILABLE: exact AP history is unavailable before durable bill-state history exists';
  END IF;

  RETURN QUERY
  SELECT
    v.id AS vendor_id,
    v.name AS vendor_name,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.bill_date) <= 30 THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS current_amount,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.bill_date) BETWEEN 31 AND 60
          THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS days_31_60,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.bill_date) BETWEEN 61 AND 90
          THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS days_61_90,
    COALESCE(SUM(
      CASE
        WHEN (p_as_of_date - vb.bill_date) > 90 THEN vb.balance_cents
        ELSE 0
      END
    ), 0)::bigint AS over_90,
    COALESCE(SUM(vb.balance_cents), 0)::bigint AS total_outstanding,
    COUNT(vb.id)::integer AS bill_count
  FROM public.vendors v
  LEFT JOIN public.vendor_bills vb
    ON vb.vendor_id = v.id
   AND vb.status IN ('unpaid', 'partially_paid')
   AND vb.deleted_at IS NULL
   AND vb.bill_date <= p_as_of_date
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Lock/load the stored bill before checking both accounting periods.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_vendor_bill(
  p_bill_id uuid,
  p_subtotal_cents bigint,
  p_adjustment_cents bigint,
  p_bill_date date,
  p_due_date date,
  p_notes text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_bill record;
  v_active_payment_count integer;
  v_new_total_cents bigint;
  v_old_values jsonb;
  v_new_values jsonb;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'update_vendor_bill'
    );
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  IF p_due_date < p_bill_date THEN
    RAISE EXCEPTION
      'INVALID_DATE_RANGE: due_date cannot precede bill_date';
  END IF;

  SELECT * INTO v_bill
  FROM public.vendor_bills
  WHERE id = p_bill_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND';
  END IF;

  -- Both sides of a date/money rewrite must be open. Checking after the row
  -- lock prevents a concurrent update from changing the stored period.
  PERFORM public.check_period_open(v_bill.bill_date);
  PERFORM public.check_period_open(p_bill_date);

  IF v_bill.status <> 'unpaid' THEN
    RAISE EXCEPTION
      'BILL_NOT_EDITABLE: status is % (only unpaid bills can be edited)',
      v_bill.status;
  END IF;

  SELECT COUNT(*) INTO v_active_payment_count
  FROM public.vendor_payments
  WHERE vendor_bill_id = p_bill_id
    AND voided_at IS NULL;

  IF v_active_payment_count > 0 THEN
    RAISE EXCEPTION
      'BILL_HAS_ACTIVE_PAYMENTS: void each payment first (% active)',
      v_active_payment_count;
  END IF;

  v_new_total_cents :=
    p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_new_total_cents <= 0 THEN
    RAISE EXCEPTION
      'INVALID_AMOUNT: bill total must be positive (got %)',
      v_new_total_cents;
  END IF;

  v_old_values := jsonb_build_object(
    'subtotal_cents', v_bill.subtotal_cents,
    'adjustment_cents', v_bill.adjustment_cents,
    'total_cents', v_bill.total_cents,
    'bill_date', v_bill.bill_date,
    'due_date', v_bill.due_date,
    'notes', v_bill.notes
  );

  UPDATE public.vendor_bills
  SET subtotal_cents = p_subtotal_cents,
      adjustment_cents = COALESCE(p_adjustment_cents, 0),
      total_cents = v_new_total_cents,
      bill_date = p_bill_date,
      due_date = p_due_date,
      notes = p_notes,
      updated_at = now()
  WHERE id = p_bill_id;

  v_new_values := jsonb_build_object(
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', COALESCE(p_adjustment_cents, 0),
    'total_cents', v_new_total_cents,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'notes', p_notes
  );

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id,
    actor_role,
    old_values,
    new_values,
    total_impact_cents,
    description
  ) VALUES (
    'vendor_bill_updated',
    'vendor_bill',
    p_bill_id,
    v_actor,
    v_actor_role,
    v_old_values,
    v_new_values,
    v_new_total_cents - v_bill.total_cents,
    'Updated vendor bill ' || v_bill.bill_number || ' — total $' ||
      (v_bill.total_cents / 100.0)::numeric(12,2) || ' → $' ||
      (v_new_total_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO public.activity_feed (
    event_type,
    description,
    performed_by,
    related_entity_type,
    related_entity_id
  ) VALUES (
    'vendor_bill_updated',
    'Updated vendor bill ' || v_bill.bill_number,
    v_actor,
    'vendor_bill',
    p_bill_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'bill_id', p_bill_id,
    'old_total_cents', v_bill.total_cents,
    'new_total_cents', v_new_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'update_vendor_bill',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

-- Preserve the established public RPC boundary exactly.
REVOKE ALL ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_ap_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_aging(date)
TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_vendor_bill(
  uuid, bigint, bigint, date, date, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vendor_bill(
  uuid, bigint, bigint, date, date, text, text
) TO authenticated, service_role;

DO $verification$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'create_vendor_bill',
      'get_ap_aging',
      'update_vendor_bill'
    );
  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'SECTION9_OVERLOAD_CHECK_FAILED: expected 3 public AP routines, got %',
      v_count;
  END IF;

  IF has_table_privilege('authenticated', 'public.vendors', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vendors', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.vendors', 'DELETE')
     OR has_table_privilege('authenticated', 'public.vendors', 'TRUNCATE') THEN
    RAISE EXCEPTION
      'SECTION9_VENDOR_GRANT_CHECK_FAILED: authenticated retains vendor mutation';
  END IF;
END;
$verification$;
