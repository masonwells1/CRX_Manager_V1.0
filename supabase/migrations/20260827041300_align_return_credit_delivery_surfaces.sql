-- Return-credit delivery surface alignment (PR #361 successor).
--
-- A posted order-level credit memo has delivery_id IS NULL, but it is a reversal,
-- not proof that another delivery was billed. Keep every billing reminder and
-- lifecycle warning aligned with the invoice-creation guards. Soft-deleted invoices
-- likewise cannot suppress automatic delivery billing.
--
-- This forward migration pins the exact incoming and outgoing bodies, signatures,
-- ownership, security mode, search path, volatility, and effective application grants.

DO $cutover_barrier$
DECLARE
  v_cutover_barrier regprocedure := to_regprocedure('public.block_return_credit_during_cogs_cutover()');
BEGIN
  IF v_cutover_barrier IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'block_return_credit_during_cogs_cutover') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_cutover_barrier
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', v_cutover_barrier, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cutover_barrier, 'EXECUTE')
     OR has_function_privilege('service_role', v_cutover_barrier, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = 'public.returns'::regclass
         AND t.tgname = 'aa_crx_block_return_credit_during_cogs_cutover'
         AND NOT t.tgisinternal
         AND t.tgfoid = v_cutover_barrier
     ) THEN
    RAISE EXCEPTION 'RETURN_COGS_CUTOVER_BARRIER_DRIFTED';
  END IF;
END;
$cutover_barrier$;

DO $preflight$
DECLARE
  v_check jsonb;
  v_count integer;
  v_oid oid;
  v_arg_oids text;
  v_return_oid oid;
  v_security_definer boolean;
  v_volatility "char";
  v_config text[];
  v_owner text;
  v_hash text;
BEGIN
  FOR v_check IN
    SELECT value
    FROM jsonb_array_elements($checks$[{"name":"get_dashboard_action_items","signature":"public.get_dashboard_action_items(integer)","args":"23","hash":"3b4d1634a519a26ef1d4cc71179b962e03b4ba484e31901aa31580eea2c43722","private":false},{"name":"void_delivery","signature":"public.void_delivery(uuid,text,uuid,text)","args":"2950 25 2950 25","hash":"ea2c7035e5a47aa88fdd94ad87f0d81ef95c4ab2d4eca1c0138862d04bc43691","private":false},{"name":"cancel_delivery","signature":"public.cancel_delivery(uuid,text,uuid,text)","args":"2950 25 2950 25","hash":"ef1569c57720b1b314670ec8b6b2b6b7d78dc620cf56ebfb2934018366e71227","private":false},{"name":"_complete_delivery_authorized_impl","signature":"public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)","args":"2950 25 2950 3802 25 25 25 1184","hash":"15c5a7ddf836f402d52544a69b8628061b4e9042444362262c1d76d26916ee69","private":true}]$checks$::jsonb)
  LOOP
    SELECT count(*)
      INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_check->>'name';

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'RETURN_CREDIT_DELIVERY_SURFACE_PREFLIGHT_OVERLOAD_DRIFT: % has % definitions',
        v_check->>'name', v_count;
    END IF;

    SELECT p.oid,
           p.proargtypes::text,
           p.prorettype,
           p.prosecdef,
           p.provolatile,
           p.proconfig,
           owner_role.rolname,
           encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
      INTO v_oid,
           v_arg_oids,
           v_return_oid,
           v_security_definer,
           v_volatility,
           v_config,
           v_owner,
           v_hash
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname = v_check->>'name';

    IF v_arg_oids <> v_check->>'args'
       OR v_return_oid <> 3802::oid
       OR NOT v_security_definer
       OR v_volatility <> 'v'
       OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR v_owner <> 'postgres'
       OR v_hash <> v_check->>'hash' THEN
      RAISE EXCEPTION 'RETURN_CREDIT_DELIVERY_SURFACE_PREFLIGHT_CONTRACT_DRIFT: %', v_check->>'signature';
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR ((v_check->>'private')::boolean AND (
         has_function_privilege('authenticated', v_oid, 'EXECUTE')
         OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       ))
       OR (NOT (v_check->>'private')::boolean AND (
         NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
         OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       )) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_DELIVERY_SURFACE_PREFLIGHT_GRANT_DRIFT: %', v_check->>'signature';
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION "public"."get_dashboard_action_items"("p_limit" integer DEFAULT 5) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_today date := current_date;
BEGIN
  -- 1. Overdue Invoices
  SELECT jsonb_agg(row_to_json(t))
  INTO v_result
  FROM (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
    ORDER BY (v_today - i.due_date) DESC
    LIMIT p_limit
  ) t;

  v_result := jsonb_build_object('overdue_invoices', COALESCE(v_result, '[]'::jsonb));

  -- 2. Cancelled Orders with Posted Invoices
  v_result := v_result || jsonb_build_object('cancelled_posted', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        o.id,
        o.order_number AS primary_text,
        c.farm_name AS secondary_text,
        i.invoice_number
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN invoices i ON i.order_id = o.id
        AND i.status = 'posted'
        AND i.invoice_type <> 'credit_memo'
        AND i.deleted_at IS NULL
      WHERE o.status = 'cancelled'
      ORDER BY o.created_at DESC
      LIMIT p_limit
    ) t
  ));

  -- 3. Overdue Deliveries
  v_result := v_result || jsonb_build_object('overdue_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        (v_today - d.scheduled_date) AS days_overdue
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status IN ('scheduled', 'in_progress')
        AND d.scheduled_date < v_today
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- 4. Low Stock Items
  v_result := v_result || jsonb_build_object('low_stock', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        p.id,
        p.product_name AS primary_text,
        p.category AS secondary_text,
        COALESCE(inv.quantity_available, 0) AS current_qty,
        COALESCE(inv.reorder_point, 0) AS reorder_point
      FROM products p
      JOIN inventory inv ON inv.product_id = p.id
      WHERE p.is_active = true
        AND (
          (inv.reorder_point IS NOT NULL
            AND inv.reorder_point > 0
            AND COALESCE(inv.quantity_available, 0) < inv.reorder_point)
          OR COALESCE(inv.quantity_available, 0) < 0
        )
      ORDER BY (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) ASC
      LIMIT p_limit
    ) t
  ));

  -- 5. Expiring Quotes (within 7 days)
  v_result := v_result || jsonb_build_object('expiring_quotes', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        q.id,
        q.quote_number AS primary_text,
        c.farm_name AS secondary_text,
        (q.expires_at::date - v_today) AS days_until_expiry
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE q.status IN ('sent', 'revised')
        AND q.is_planned = false
        AND q.expires_at IS NOT NULL
        AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
      ORDER BY q.expires_at ASC
      LIMIT p_limit
    ) t
  ));

  -- 6. Unassigned Deliveries
  v_result := v_result || jsonb_build_object('unassigned_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'scheduled'
        AND d.assigned_driver IS NULL
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- U13<<< 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no
  -- currently-active per-location dispatch — neither the wizard's per-location
  -- assignment NOR (indirectly, via the sync triggers above) a whole-job
  -- applicator has reached the field crew. deleted_at IS NULL mirrors the other
  -- job reads.
  v_result := v_result || jsonb_build_object('unassigned_jobs', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        j.id,
        j.job_number AS primary_text,
        c.farm_name AS secondary_text,
        j.job_date AS scheduled_date
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.status = 'scheduled'
        AND j.deleted_at IS NULL
        -- Codex R1 P2: a job with a legacy WHOLE-JOB applicator is assigned,
        -- not "unassigned" — pre-trigger jobs have no dispatch rows yet (no
        -- backfill: business-data writes are outside this run's additive-only
        -- mandate; rows materialize via the triggers on the next edit, and
        -- FieldView already surfaces legacy assignments client-side).
        AND j.applicator_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM job_location_dispatches d
          WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
        )
      ORDER BY j.job_date ASC
      LIMIT p_limit
    ) t
  ));
  -- >>>U13

  -- 8. Due-today deliveries that have not been started.
  v_result := v_result || jsonb_build_object('due_today_not_started', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.scheduled_date = v_today
        AND d.status = 'scheduled'
        AND d.deleted_at IS NULL
      ORDER BY d.delivery_number ASC
      LIMIT p_limit
    ) t
  ));

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice.
  v_result := v_result || jsonb_build_object('unbilled_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'completed'
        AND d.deleted_at IS NULL
        AND d.order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM invoices i
          WHERE i.order_id = d.order_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
            AND i.invoice_type <> 'credit_memo'
            AND i.deleted_at IS NULL
        )
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."void_delivery"("p_delivery_id" "uuid", "p_reason" "text", "p_performed_by" "uuid" DEFAULT NULL::"uuid", "p_idempotency_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor         uuid;
  v_delivery      record;
  v_item          record;
  v_posted_invoices_exist boolean := false;
  v_order_confirmed boolean;
  v_order_fulfilled boolean;
  v_new_order_status text;
  v_closed_period record;
  v_effective_completion_date date;
  v_admin record;
  -- DELTA-IDEM BEGIN (#11 nightly-debug: canonical idempotency — cache/replay the rich result)
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-IDEM END
BEGIN
  -- Strict actor pattern (codex audit F1)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to void a completed delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a delivery';
  END IF;

  -- DELTA-IDEM BEGIN (#11: canonical check — replay the cached rich payload, not a bare marker)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- DELTA-IDEM END

  SELECT * INTO v_delivery
  FROM deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed deliveries can be voided (current status: %)', v_delivery.status;
  END IF;

  -- A received/credited return has already put part of this delivery lineage
  -- back into inventory. Restoring the delivery again would double-count that
  -- stock and can leave active return-credit accounting attached to zero
  -- delivered quantity. Source-free legacy lines are conservatively order-wide;
  -- order-linked lines block only deliveries sharing that order line.
  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM returns r
    JOIN return_items ri ON ri.return_id = r.id
    WHERE r.order_id = v_delivery.order_id
      AND r.deleted_at IS NULL
      AND r.status IN ('received', 'credited')
      AND (
        ri.order_item_id IS NULL
        OR EXISTS (
          SELECT 1 FROM delivery_items linked_di
          WHERE linked_di.delivery_id = p_delivery_id
            AND linked_di.order_item_id = ri.order_item_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'DELIVERY_HAS_RECEIVED_RETURN';
  END IF;

  -- A void reverses the completed delivery's accounting event, so period
  -- detection must use the actual Chicago completion business date rather
  -- than the schedule date. Keep the schedule date only as a legacy fallback.
  v_effective_completion_date := COALESCE(
    (v_delivery.completed_at AT TIME ZONE 'America/Chicago')::date,
    v_delivery.scheduled_date
  );

  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' voided for completion date ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Reason: ' || p_reason ||
        '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Void',
        'Delivery ' || v_delivery.delivery_number ||
          ' was voided for completion date ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory was restored and ' ||
          'draft invoices were auto-cancelled. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
      AND di.quantity_delivered > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.quantity_delivered,
      quantity_prebooked = quantity_prebooked + v_item.quantity_delivered,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'void_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason || ' (available + prebooked restored)'
    );

    UPDATE order_items SET
      quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
      quantity_remaining = quantity_remaining + v_item.quantity_delivered
    WHERE id = v_item.order_item_id;
  END LOOP;

  DELETE FROM delivery_remainders WHERE original_delivery_id = p_delivery_id;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_order_fulfilled;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining < total_units_needed
  ) INTO v_order_confirmed;

  v_new_order_status :=
    CASE
      WHEN v_order_fulfilled  THEN 'fulfilled'
      WHEN v_order_confirmed  THEN 'confirmed'
      ELSE 'partially_fulfilled'
    END;

  UPDATE orders SET
    status = v_new_order_status,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- U2 (Codex P1): scope the auto-cancel to THIS delivery's own draft invoice or an
  -- order-level one (delivery_id IS NULL) — was per-order, which would cancel a
  -- SIBLING delivery's draft invoice on void of this delivery.
  UPDATE invoices SET
    status      = 'cancelled',
    void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' was voided by admin',
    updated_at  = now()
  WHERE order_id = v_delivery.order_id AND status = 'draft'
    AND invoice_type <> 'credit_memo'
    AND deleted_at IS NULL
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

  -- U2 (Codex P1): read-only "posted invoice needs review" flag — scope it the same
  -- way so a SIBLING delivery's posted invoice (untouched by this void) no longer
  -- raises a false manual-review warning. No guard/blocking behaviour hangs off this
  -- flag, so scoping cannot loosen a safety check.
  SELECT EXISTS (
    SELECT 1 FROM invoices
    WHERE order_id = v_delivery.order_id AND status = 'posted'
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
  ) INTO v_posted_invoices_exist;

  UPDATE deliveries SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_delivery_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_voided', 'delivery', p_delivery_id, v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'completed'),
    jsonb_build_object('status', 'voided', 'order_status', v_new_order_status),
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_voided',
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- DELTA-IDEM BEGIN (#11: build the rich result first, then cache it via the canonical helper + replay it)
  v_result := jsonb_build_object(
    'success',                true,
    'delivery_id',            p_delivery_id,
    'delivery_number',        v_delivery.delivery_number,
    'new_order_status',       v_new_order_status,
    'posted_invoices_exist',  v_posted_invoices_exist
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_delivery', v_result);
  END IF;

  PERFORM set_config('app.admin_override', 'false', true);

  RETURN v_result;
  -- DELTA-IDEM END
END;
$$;

CREATE OR REPLACE FUNCTION "public"."cancel_delivery"("p_delivery_id" "uuid", "p_cancel_reason" "text", "p_performed_by" "uuid" DEFAULT NULL::"uuid", "p_idempotency_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_delivery record; v_actor uuid; v_item record; v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0; v_invoice record; v_draft_cancelled integer := 0;
  v_posted_notified integer := 0; v_admin record; v_order_has_remaining boolean; v_order_status text;
  v_result jsonb;
  v_quick_scheduled_exclusive boolean := false; v_prebooked_released integer := 0;
  v_qd_item record; v_release_qty numeric; v_actor_role text; v_paid_commissions integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND auth.uid() IS DISTINCT FROM p_performed_by THEN RAISE EXCEPTION 'actor mismatch'; END IF;
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached jsonb;
    BEGIN v_cached := check_idempotency(p_idempotency_key, 'cancel_delivery'); IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; END;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress', 'completed') THEN RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'Not authorized to cancel deliveries'; END IF;

  -- Match void_delivery's fail-closed return-lineage boundary. This also
  -- prevents the quick-delivery branch from directly cancelling an order that
  -- already has physically received or credited merchandise.
  IF v_delivery.order_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM returns r
    JOIN return_items ri ON ri.return_id = r.id
    WHERE r.order_id = v_delivery.order_id
      AND r.deleted_at IS NULL
      AND r.status IN ('received', 'credited')
      AND (
        ri.order_item_id IS NULL
        OR EXISTS (
          SELECT 1 FROM delivery_items linked_di
          WHERE linked_di.delivery_id = p_delivery_id
            AND linked_di.order_item_id = ri.order_item_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'DELIVERY_HAS_RECEIVED_RETURN';
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        UPDATE inventory SET quantity_available = quantity_available + v_item.quantity_delivered, quantity_prebooked = quantity_prebooked + v_item.quantity_delivered, updated_at = now() WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
        INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
        VALUES (v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name);
        UPDATE order_items SET quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0), quantity_remaining = quantity_remaining + v_item.quantity_delivered WHERE id = v_item.order_item_id;
        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- Codex P2 (20260616171449): lock the order row so a concurrent update_order_items
    -- (which holds orders FOR UPDATE) cannot add/increase prebook in the window between
    -- the release loop and the order cancel. cancel_order locks the order the same way.
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

    IF COALESCE(v_delivery.is_quick_delivery, false) AND v_delivery.status IN ('scheduled', 'in_progress') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM deliveries
        WHERE order_id = v_delivery.order_id AND id <> p_delivery_id
          AND status NOT IN ('cancelled', 'voided')
      ) INTO v_quick_scheduled_exclusive;
    END IF;

    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      IF v_quick_scheduled_exclusive THEN
        -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): this branch
        -- auto-cancels the order and zeroes its pending commissions. A pending commission
        -- already committed to a non-voided commission_payments batch must not be silently
        -- cancelled — post_commission_payment would later resurrect it to 'paid'. Force the
        -- admin to void the payout first.
        IF EXISTS (
          SELECT 1
          FROM commissions cm
          JOIN commission_payment_items cpi ON cpi.commission_id = cm.id
          JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
          WHERE cm.order_id = v_delivery.order_id
            AND cm.status = 'pending'
            AND cp.status <> 'voided'
        ) THEN
          RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: the order auto-cancelled by this quick delivery has pending commission(s) committed to an active commission payment batch. Void that payment first.';
        END IF;
        -- P2-1: release by ORDER_ITEMS (the booking source of truth) so edited/added quantities prebooked via
        -- update_order_items (which never touches delivery_items) are released too. Mirrors cancel_order.
        FOR v_qd_item IN SELECT product_id, total_units_needed, COALESCE(quantity_delivered, 0) AS quantity_delivered FROM order_items WHERE order_id = v_delivery.order_id
        LOOP
          v_release_qty := GREATEST(v_qd_item.total_units_needed - v_qd_item.quantity_delivered, 0);
          IF v_release_qty <= 0 THEN CONTINUE; END IF;
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_release_qty, 0), updated_at = now() WHERE product_id = v_qd_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
          VALUES (v_qd_item.product_id, 'released', v_release_qty, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Released ' || v_release_qty || ' units — quick delivery ' || v_delivery.delivery_number || ' cancelled');
          v_prebooked_released := v_prebooked_released + 1;
        END LOOP;

        UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = v_delivery.order_id;
        UPDATE commissions SET status = 'cancelled', commission_amount = 0 WHERE order_id = v_delivery.order_id AND status = 'pending';

        -- P2-2: a quick order may have already-paid commissions — flag for admin review (mirror cancel_order).
        SELECT COUNT(*) INTO v_paid_commissions FROM commissions WHERE order_id = v_delivery.order_id AND status = 'paid';
        IF v_paid_commissions > 0 THEN
          FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
            INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
            VALUES (v_admin.id, 'Cancelled Order Has Paid Commissions',
              'Quick-delivery order auto-cancelled with delivery ' || v_delivery.delivery_number || ' has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
              'cancellation_review', 'order', v_delivery.order_id);
          END LOOP;
        END IF;

        SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
        INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
        VALUES ('order_cancelled', 'order', v_delivery.order_id, COALESCE(v_actor_role, 'sales_rep'),
          jsonb_build_object('status', v_order_status),
          jsonb_build_object('status', 'cancelled', 'reason', 'Quick delivery ' || v_delivery.delivery_number || ' cancelled', 'prebook_lines_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions),
          0,
          'Auto-cancelled quick-delivery order on cancellation of delivery ' || v_delivery.delivery_number);
      ELSE
        SELECT EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0) INTO v_order_has_remaining;
        IF v_order_has_remaining THEN
          IF EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_delivered > 0) THEN
            UPDATE orders SET status = 'partially_fulfilled', updated_at = now() WHERE id = v_delivery.order_id;
          ELSE
            UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = v_delivery.order_id;
          END IF;
        END IF;
      END IF;
    END IF;
    UPDATE delivery_remainders SET status = 'cancelled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status = 'pending' AND followup_delivery_id IS NULL;
    UPDATE delivery_remainders SET status = 'fulfilled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status IN ('pending', 'scheduled') AND followup_delivery_id IS NOT NULL;
  END IF;

  UPDATE deliveries SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancel_reason = p_cancel_reason, updated_at = now() WHERE id = p_delivery_id;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 (Codex P1): scope the invoice reversal to THIS delivery's own invoice or an
    -- order-level one (delivery_id IS NULL) — NEVER a sibling delivery's invoice. Was
    -- an unscoped per-order loop, which with per-delivery invoices would auto-cancel a
    -- sibling's draft/unposted invoice and raise a false posted-invoice review alert.
    FOR v_invoice IN SELECT * FROM invoices WHERE order_id = v_delivery.order_id AND status IN ('draft', 'posted', 'unposted') AND invoice_type <> 'credit_memo' AND deleted_at IS NULL AND (delivery_id = p_delivery_id OR delivery_id IS NULL)
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET status = 'cancelled', voided_by = v_actor, void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' cancelled', updated_at = now() WHERE id = v_invoice.id;
        v_draft_cancelled := v_draft_cancelled + 1;
      ELSIF v_invoice.status = 'posted' THEN
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_admin.id, 'Posted Invoice Needs Review', 'Delivery ' || v_delivery.delivery_number || ' cancelled but invoice ' || v_invoice.invoice_number || ' is posted.', 'invoice_review', 'invoice', v_invoice.id);
        END LOOP;
        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_delivery.assigned_driver, 'Delivery Cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason, 'delivery_update', 'delivery', p_delivery_id);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' items.' ELSE '' END, v_actor, 'delivery', p_delivery_id, v_delivery.customer_id);

  PERFORM set_config('app.admin_override', 'false', true);

  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id, 'items_restored', v_items_restored, 'prebooked_reincremented', v_prebooked_reincremented, 'prebooked_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions, 'draft_invoices_cancelled', v_draft_cancelled, 'posted_invoices_flagged', v_posted_notified);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_auto_invoice_id uuid;
  v_auto_invoice_number text;
  v_auto_total_cents bigint := 0;
  v_auto_cost_cents bigint := 0;
  -- CRX-MONEY-LIFECYCLE-001: cents allocated to THIS delivery from the order
  -- line's stored total, rather than re-extended from price x quantity.
  v_line_alloc_cents bigint := 0;
  v_existing_active_invoice_count int;
  v_closed_period record;
  v_admin record;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
  v_effective_completion_date date;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- U15: optional backdate. Reject future timestamps (small clock-skew allowance);
  -- NULL = legacy behavior (now()/CURRENT_DATE).
  IF p_completed_at IS NOT NULL AND p_completed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'COMPLETED_AT_IN_FUTURE: completion time cannot be in the future';
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- PR-01 fix: column is `scheduled_date`, not `delivery_date`.
  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Completion',
        'Delivery ' || v_delivery.delivery_number ||
          ' was completed for ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory and lifecycle ' ||
          'changes proceeded. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same on-hand math; completion proceeds and stock is allowed to go negative.
    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_item.product_name || ': need ' || v_qty_to_deliver || ', only ' ||
        COALESCE(v_inv.quantity_available, 0) || ' on-hand');
      -- U9 (Codex R2 P2): seed a zero row when missing so the deduction UPDATE
      -- below lands and the on-hand aggregate goes visibly negative.
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_item.product_id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- P2-D: authorize the post-completion delivery_items + lifecycle writes below.
  -- The enforce_delivery_items_parent_lock trigger blocks writes to a
  -- non-scheduled delivery's items; complete_delivery legitimately records
  -- quantity_delivered after flipping status to 'completed', so it sets the
  -- canonical admin_override escape hatch (transaction-local).
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = COALESCE(p_completed_at, now()), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    -- U9: flag the delivered ledger row for review when the product was short.
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END ||
        CASE WHEN v_item.product_id = ANY(v_short_product_ids)
          THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        '. Signed by: ' || p_signed_by,
      v_item.product_id = ANY(v_short_product_ids)
    );

    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- U2 (Codex P2): with per-delivery invoices now possible on one order, the
  -- tote copy must NOT stamp a SIBLING delivery's invoice — scope it to this
  -- delivery's own invoice or an order-level one (delivery_id IS NULL), the
  -- same shape as the auto-invoice guard below. Return-credit lines are
  -- immutable accounting provenance, not delivery-sale lines to relabel.
  UPDATE invoice_items ii
  SET tote_number = di.tote_number
  FROM delivery_items di
  JOIN invoices inv ON inv.order_id = v_delivery.order_id AND inv.deleted_at IS NULL
    AND inv.invoice_type <> 'credit_memo'
    AND (inv.delivery_id = p_delivery_id OR inv.delivery_id IS NULL)
  WHERE di.delivery_id = p_delivery_id
    AND ii.invoice_id = inv.id
    AND di.order_item_id = ii.order_item_id
    AND di.tote_number IS NOT NULL;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- U2 #39: close out the remainder rows THIS follow-up delivery was created to satisfy.
  -- create_followup_delivery flips the parent's remainders 'pending'->'scheduled' and stamps
  -- followup_delivery_id = this delivery. Now that this delivery has completed, mark them
  -- 'fulfilled'. Any lines this follow-up ITSELF shorted are already captured as fresh
  -- 'pending' remainder rows by the v_any_partial INSERT above (original_delivery_id = this
  -- delivery), so this flip never loses outstanding quantity — it prevents the same shortfall
  -- being double-counted as both a stale 'scheduled' row and a new 'pending' row. Idempotent
  -- (guarded by status = 'scheduled'); targets rows disjoint from the ones just inserted.
  UPDATE delivery_remainders
     SET status = 'fulfilled', updated_at = now()
   WHERE followup_delivery_id = p_delivery_id
     AND status = 'scheduled';

  -- P2 fix (Codex 2026-07-10): serialize concurrent same-day FINAL deliveries on the SAME
  -- order. Two deliveries completing at once each read v_all_delivered under READ COMMITTED
  -- without seeing the other's uncommitted order_items decrement, so both could compute
  -- false and skip the Feature A auto-split (order falls back to manual split-billing — safe,
  -- but the auto-split silently doesn't fire). Take the orders row lock BEFORE the read: the
  -- second completion blocks here until the first commits, then sees the committed decrement.
  -- Lock ORDER is unchanged (deliveries -> inventory -> orders): the UPDATE orders just below
  -- already acquired this same row lock — this only moves the acquisition ahead of the read,
  -- adding no new lock pair (no new deadlock surface).
  IF v_delivery.order_id IS NOT NULL THEN
    PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = public._allocated_delivery_cents(
                           ii.order_item_id, di.quantity_delivered, ii.invoice_id)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id AND ii.invoice_id = v_linked_invoice.id AND ii.order_item_id = di.order_item_id;
      -- Overnight bug-hunt LOW (20260620): also recompute the stored header cost so
      -- a partial completion doesn't leave total_cost_cents sized to the full qty.
      -- cost_cents is PER-UNIT cents; line cost = cost_cents * quantity (no *100).
      UPDATE invoices SET
        total_amount_cents = (SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 #34: per-DELIVERY-aware guard (was per-ORDER). Block only if THIS delivery already
    -- has an active invoice, or an ORDER-LEVEL invoice (delivery_id IS NULL) already covers
    -- the whole order. An active invoice tied to a DIFFERENT delivery must NOT block this
    -- delivery — otherwise a follow-up delivery of shorted product is never billed.
    SELECT COUNT(*) INTO v_existing_active_invoice_count
    FROM invoices
    WHERE order_id = v_delivery.order_id
      AND status NOT IN ('voided', 'cancelled')
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

    IF v_existing_active_invoice_count = 0 THEN
      -- U7 SAFE-SCOPE (#43): a field/acre-allocated order must NOT be mono-billed
      -- 100% to the primary customer (that dead-ends the landlord's payment). Skip the
      -- auto-draft, flag the order for a manual per-owner split-billing pass, and notify
      -- the office. Non-allocated orders keep the EXACT auto-draft in the ELSE below.
      IF EXISTS (
        SELECT 1 FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
        WHERE oi.order_id = v_delivery.order_id
      ) THEN
        -- Codex pre-ship HIGH fix: only auto-split when the delivery's EFFECTIVE date is TODAY.
        -- create_split_invoices_from_order stamps invoice_date = CURRENT_DATE and takes no date arg, so
        -- auto-splitting a BACKDATED completion (p_completed_at in a prior/closed period) would silently
        -- date the drafts today and shift AR aging/terms — while the mono-bill path (below) respects the
        -- backdate. A backdated allocated order falls through to flag+notify (the office creates the split
        -- manually, exactly as before Feature A); same-day completions (the common case) auto-split.
        IF v_all_delivered
           AND v_effective_completion_date = (now() AT TIME ZONE 'America/Chicago')::date THEN
          -- the whole order is now delivered TODAY -> auto-create the per-owner split DRAFTS via the proven engine.
          BEGIN
            PERFORM create_split_invoices_from_order(
              v_delivery.order_id, NULL, 'chemical_sale',
              COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit'
            );
            -- create_split_invoices_from_order creates draft invoices per owner, clears
            -- needs_split_billing, and writes its own activity_feed + financial_audit_log rows.
            -- Add ONE activity_feed row noting the auto-creation on this delivery completion.
            INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
            VALUES (
              'split_invoices_auto_created',
              'Delivery ' || v_delivery.delivery_number || ' completed the order — per-owner split DRAFT invoices were auto-created (review + post them).',
              v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
            );
          EXCEPTION WHEN OTHERS THEN
            -- Any reason the split cannot run yet (order not priced -> PRICING_INCOMPLETE, an
            -- edge race, a still-open sibling delivery, etc.): fall back to today's flag+notify.
            -- The subtransaction rolls back any partial split work; the delivery completion is UNAFFECTED.
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
        END;
      ELSE
        -- Partial delivery of an allocated order (product still remains): keep today's
        -- skip-and-queue exactly. (Per-delivery split billing for partial orders is a separate redesign.)
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
      END IF;
      ELSE
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', v_effective_completion_date, 0, 0, v_actor
      ) RETURNING id INTO v_auto_invoice_id;

      v_auto_total_cents := 0;
      v_auto_cost_cents := 0;
      FOR v_item IN
        SELECT di.id AS di_id, di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
               oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
               p.product_name AS p_name
          FROM delivery_items di
          JOIN order_items oi ON oi.id = di.order_item_id
          JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id
           AND COALESCE(di.quantity_delivered, 0) > 0
      LOOP
        v_line_alloc_cents := public._allocated_delivery_cents(
                                v_item.order_item_id, v_item.quantity_delivered, NULL);
        v_auto_total_cents := v_auto_total_cents + v_line_alloc_cents;
        v_auto_cost_cents  := v_auto_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, order_item_id, product_id, description,
          quantity, unit_price_cents, extended_cents, cost_cents,
          unit_size, tote_number
        ) VALUES (
          v_auto_invoice_id, v_item.order_item_id, v_item.product_id,
          COALESCE(v_item.oi_product_name, v_item.p_name),
          v_item.quantity_delivered,
          ROUND(v_item.price_per_unit * 100)::bigint,
          v_line_alloc_cents,
          ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
          v_item.unit_size,
          v_item.tote_number
        );
      END LOOP;

      UPDATE invoices
         SET total_amount_cents = v_auto_total_cents,
             total_cost_cents   = v_auto_cost_cents
       WHERE id = v_auto_invoice_id;

      -- Overnight bug-hunt MED (20260620): provenance breadcrumb. Write the same
      -- financial_audit_log 'invoice_created' row create_invoice_from_order /
      -- create_invoice_for_unbilled_delivery write, so the append-only ledger
      -- records this auto-creator too (it previously logged only activity_feed).
      -- Draft-stage provenance; post_invoice still writes 'invoice_posted' later.
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_auto_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', v_auto_invoice_number,
          'delivery_id', p_delivery_id,
          'order_id', v_delivery.order_id,
          'customer_id', v_delivery.customer_id,
          'total_cents', v_auto_total_cents
        ),
        v_auto_total_cents,
        'Invoice ' || v_auto_invoice_number || ' auto-created on completion of delivery ' || v_delivery.delivery_number
      );
      END IF;
    END IF;
  END IF;

  -- U9: short-stock WARN emit (mirrors the backdated-period warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' || v_short_count ||
        ' product(s) short on stock: ' || array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' || v_short_count ||
          ' product(s) did not have enough on-hand stock: ' || array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END ||
      CASE WHEN v_auto_invoice_id IS NOT NULL THEN ' [draft invoice ' || v_auto_invoice_number || ' auto-created]' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- U9: additive result fields — warnings[] + short_stock_count.
  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END,
    'stock_warning', (v_short_count > 0),
    'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.get_dashboard_action_items(integer) OWNER TO postgres;
ALTER FUNCTION public.void_delivery(uuid, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.cancel_delivery(uuid, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamptz) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_dashboard_action_items(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_delivery(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_delivery(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl(uuid, text, uuid, jsonb, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_dashboard_action_items(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_delivery(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_delivery(uuid, text, uuid, text) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_check jsonb;
  v_count integer;
  v_oid oid;
  v_arg_oids text;
  v_return_oid oid;
  v_security_definer boolean;
  v_volatility "char";
  v_config text[];
  v_owner text;
  v_hash text;
BEGIN
  FOR v_check IN
    SELECT value
    FROM jsonb_array_elements($checks$[{"name":"get_dashboard_action_items","signature":"public.get_dashboard_action_items(integer)","args":"23","hash":"583519bf36990ea38eac510ce46aeaf0425b13964abbab2fded53d442e60a769","private":false},{"name":"void_delivery","signature":"public.void_delivery(uuid,text,uuid,text)","args":"2950 25 2950 25","hash":"81efbd554ce4023c177a92dd96e1331003550ecad3139a3cb8b25cddf0b7a1fc","private":false},{"name":"cancel_delivery","signature":"public.cancel_delivery(uuid,text,uuid,text)","args":"2950 25 2950 25","hash":"36c9407d2aa78a4d1e60ec790c99e32d8f8009c953ba9378595f6f5a358d76a5","private":false},{"name":"_complete_delivery_authorized_impl","signature":"public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)","args":"2950 25 2950 3802 25 25 25 1184","hash":"3c2dc6185c3f0de6beb32641f3963eacc4845ca2c22ad2575a72d2cb2892594a","private":true}]$checks$::jsonb)
  LOOP
    SELECT count(*)
      INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_check->>'name';

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'RETURN_CREDIT_DELIVERY_SURFACE_POSTFLIGHT_OVERLOAD_DRIFT: % has % definitions',
        v_check->>'name', v_count;
    END IF;

    SELECT p.oid,
           p.proargtypes::text,
           p.prorettype,
           p.prosecdef,
           p.provolatile,
           p.proconfig,
           owner_role.rolname,
           encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
      INTO v_oid,
           v_arg_oids,
           v_return_oid,
           v_security_definer,
           v_volatility,
           v_config,
           v_owner,
           v_hash
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname = v_check->>'name';

    IF v_arg_oids <> v_check->>'args'
       OR v_return_oid <> 3802::oid
       OR NOT v_security_definer
       OR v_volatility <> 'v'
       OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       OR v_owner <> 'postgres'
       OR v_hash <> v_check->>'hash' THEN
      RAISE EXCEPTION 'RETURN_CREDIT_DELIVERY_SURFACE_POSTFLIGHT_CONTRACT_DRIFT: %', v_check->>'signature';
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR ((v_check->>'private')::boolean AND (
         has_function_privilege('authenticated', v_oid, 'EXECUTE')
         OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       ))
       OR (NOT (v_check->>'private')::boolean AND (
         NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
         OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       )) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_DELIVERY_SURFACE_POSTFLIGHT_GRANT_DRIFT: %', v_check->>'signature';
    END IF;
  END LOOP;
END;
$postflight$;
