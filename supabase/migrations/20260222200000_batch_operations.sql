-- ─── Sprint 15: Batch Operations ────────────────────────────────────────
--
-- New RPCs:
--   batch_void_invoices(p_invoice_ids, p_void_reason, p_performed_by) → integer
--   batch_apply_all_prepayments(p_performed_by) → jsonb
--
-- No schema changes — pure RPC additions that build on existing invoice/prepay infra.


-- ─── batch_void_invoices ────────────────────────────────────────────────
-- Voids multiple posted invoices in a single atomic transaction.
-- Returns count of invoices voided.

CREATE OR REPLACE FUNCTION public.batch_void_invoices(
  p_invoice_ids  uuid[],
  p_void_reason  text DEFAULT 'Batch voided',
  p_performed_by uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv       record;
  v_id        uuid;
  v_count     integer := 0;
  v_actor     uuid;
  v_actor_role text;
BEGIN
  -- Resolve actor
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  -- Lock all target invoices to prevent concurrent modifications
  FOR v_inv IN
    SELECT *
    FROM invoices
    WHERE id = ANY(p_invoice_ids)
      AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Skip non-posted invoices (don't error, just skip)
    IF v_inv.status <> 'posted' THEN
      CONTINUE;
    END IF;

    -- Void the invoice
    UPDATE invoices SET
      status      = 'voided',
      voided_by   = v_actor,
      voided_at   = now(),
      void_reason = p_void_reason,
      updated_at  = now()
    WHERE id = v_inv.id;

    -- Audit log
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_voided', 'invoice', v_inv.id,
      v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'batch', true),
      -1 * v_inv.total_amount_cents,
      'Batch voided ' || v_inv.invoice_number || ' — ' || p_void_reason
    );

    -- Activity feed
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'invoice_voided',
      'Batch voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
      v_actor, 'invoice', v_inv.id, v_inv.customer_id
    );

    v_count := v_count + 1;
  END LOOP;

  -- Batch-level audit entry
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'batch_void', 'invoice', NULL,
    v_actor_role,
    jsonb_build_object('invoice_count', array_length(p_invoice_ids, 1)),
    jsonb_build_object('voided_count', v_count, 'void_reason', p_void_reason),
    0,
    'Batch voided ' || v_count || ' invoice(s) — ' || p_void_reason
  );

  RETURN v_count;
END;
$$;


-- ─── batch_apply_all_prepayments ────────────────────────────────────────
-- Iterates all customers with prepay_balance_cents > 0 and applies credits
-- to their oldest outstanding invoices via the existing apply_remaining_prepayments RPC.
-- Returns a JSONB summary of all applications.

CREATE OR REPLACE FUNCTION public.batch_apply_all_prepayments(
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust       record;
  v_result     jsonb;
  v_details    jsonb := '[]'::jsonb;
  v_total_customers integer := 0;
  v_total_applied   bigint  := 0;
  v_actor      uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  FOR v_cust IN
    SELECT c.id, c.farm_name, c.prepay_balance_cents
    FROM customers c
    WHERE c.prepay_balance_cents > 0
      AND c.is_active = true
      AND EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.customer_id = c.id
          AND i.status = 'posted'
          AND i.balance_cents > 0
          AND i.deleted_at IS NULL
      )
    ORDER BY c.farm_name
    FOR UPDATE OF c
  LOOP
    -- Call existing per-customer RPC
    v_result := apply_remaining_prepayments(v_cust.id, v_actor);

    IF (v_result->>'applied_cents')::bigint > 0 THEN
      v_total_customers := v_total_customers + 1;
      v_total_applied := v_total_applied + (v_result->>'applied_cents')::bigint;
      v_details := v_details || jsonb_build_object(
        'customer_id', v_cust.id,
        'farm_name', v_cust.farm_name,
        'applied_count', (v_result->>'applied_count')::integer,
        'applied_cents', (v_result->>'applied_cents')::bigint,
        'remaining_prepay_cents', (v_result->>'remaining_prepay_cents')::bigint
      );
    END IF;
  END LOOP;

  -- Batch-level audit entry
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'batch_prepay_apply', 'customer', NULL,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('total_customers_checked', (
      SELECT count(*) FROM customers WHERE prepay_balance_cents > 0 AND is_active = true
    )),
    jsonb_build_object('total_customers_applied', v_total_customers, 'total_applied_cents', v_total_applied),
    v_total_applied,
    'Batch applied prepayments: ' || v_total_customers || ' customer(s), ' ||
      '$' || ROUND(v_total_applied / 100.0, 2) || ' total'
  );

  RETURN jsonb_build_object(
    'total_customers', v_total_customers,
    'total_applied_cents', v_total_applied,
    'details', v_details
  );
END;
$$;
