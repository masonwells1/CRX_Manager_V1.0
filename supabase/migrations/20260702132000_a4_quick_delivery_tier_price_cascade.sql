-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix loop, Wave A / A4-SQL). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review.
--
-- WHAT: create_quick_delivery cascades tier2/tier3 price → tier1 when the higher
--       tier price is NULL, instead of billing $0.
-- WHY:  The live function computes the line price as CASE assigned_tier WHEN 2 THEN
--       COALESCE(tier2_price, 0) ... — so a tier-2/3 customer whose product has no
--       tier2/3 price is billed $0 (client-shows-price / server-bills-$0). The 5+
--       frontend cascades all fall back to tier1 and DISPLAY a real total; only the
--       server drops it to $0. This aligns the server with the client + the canonical
--       getTierPrice (src/lib/quoteCalc.ts:40-45): tier2 → tier1, tier3 → tier1.
-- SCOPE: SURGICAL. Rebuilt verbatim from live pg_get_functiondef; the ONLY change is
--        the two identical tier-price CASE blocks (net-available loop + item-insert
--        loop) — WHEN 2 / ELSE now COALESCE(tierN, tier1, 0). Everything else identical.
-- SAFE:  additive to price (can only raise a $0 line to tier1, never lower it); no
--        signature change; commissions/AR/audit unaffected (0 live quick deliveries).
--
-- SMOKE (2026-07-02, live rolled-back BEGIN…ROLLBACK + plpgsql_check): PASS —
--   full function CREATE OR REPLACEd in a tx; plpgsql_check = NO FINDINGS - CLEAN; tx aborted;
--   live create_quick_delivery confirmed unchanged (cascade text absent, position()=0) + 1 overload.
-- CODEX: CLEAN — "no introduced correctness issues; consistently applies the tier2/tier3→tier1
--   fallback in both quick-delivery pricing passes while preserving the function body." (Codex also
--   noted create_direct_order (20260312200000) already uses this exact COALESCE(tierN, tier1, 0) pattern.)
--
-- FRONTEND NOTE (A4 second half — DEFERRED, not a bug): the ~7 frontend tier-price cascades the
--   audit named ALREADY fall back to tier1 (QuickDeliveryModal/OrderDetail/NewOrder/QuoteBuilder/
--   Returns), so after THIS server fix client & server agree — the "shared getTierPrice" swap is pure
--   DRY, not a $0 fix. It is intentionally deferred because the sites have divergent, sometimes-
--   deliberate semantics (JobDetail.tsx:2396+2410 uses a `tierPrice != null` GUARD to NOT clobber an
--   existing price; recipeHelpers.ts:81 is recipe-price-first) — a blind sweep onto the `||`-based
--   helper would change money behavior on explicit-0 / no-tier-price edges. Needs a per-site pass.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_quick_delivery(p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_actor_role text;
  v_order_id uuid; v_order_number text;
  v_delivery_id uuid; v_delivery_number text;
  v_invoice_id uuid; v_invoice_number text;
  v_item jsonb; v_order_item_id uuid; v_product record;
  v_inv record; v_total_cents bigint := 0; v_total_cost_cents bigint := 0;
  v_item_price_cents bigint; v_item_qty numeric; v_sort integer := 0;
  v_customer record; v_split jsonb;
  v_order_profit numeric; v_split_total numeric; v_net_available numeric;
  v_ar_balance_cents bigint; v_projected_cents bigint;
  v_credit_warning boolean := false; v_admin record;
  v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep', 'driver') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins, sales reps, and drivers can create quick deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_quick_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT v_customer.is_active THEN RAISE EXCEPTION 'Customer is inactive'; END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- Overnight bug-hunt LOW (20260620): aggregate duplicate product lines BEFORE
  -- the net-available check so two lines of the same product can't each pass against
  -- the same prebooked baseline and then both prebook (over-prebook). Group by the
  -- UUID VALUE, not the raw text, so non-canonical text variants of the same
  -- product_id (case / braces / hyphens) collapse into one group — they cast to the
  -- same uuid in the body + prebook loop, so text-grouping would let them slip the
  -- check (Codex fix-gate hardening). The loop yields a jsonb object (product_id as
  -- canonical uuid text), so the body below is unchanged.
  FOR v_item IN
    SELECT jsonb_build_object('product_id', sub.product_id::text, 'quantity', sub.quantity) AS item
      FROM (
        SELECT (elem->>'product_id')::uuid AS product_id,
               SUM((elem->>'quantity')::numeric) AS quantity
          FROM jsonb_array_elements(p_items) elem
         GROUP BY (elem->>'product_id')::uuid
      ) sub
  LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;
    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse' FOR UPDATE;
    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);
    IF NOT FOUND OR v_net_available < v_item_qty THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net available (% on hand, % prebooked)',
        v_product.product_name, v_item_qty, GREATEST(v_net_available, 0),
        COALESCE(v_inv.quantity_available, 0), COALESCE(v_inv.quantity_prebooked, 0);
    END IF;

    -- A4: cascade tier2/tier3 → tier1 when the higher tier price is NULL (was COALESCE(tierN,0)=$0).
    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, v_product.tier1_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, v_product.tier1_price, 0) * 100)
    END;
    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
  END LOOP;

  IF COALESCE(v_customer.credit_limit_cents, 0) > 0 THEN
    SELECT COALESCE(SUM(balance_cents), 0) INTO v_ar_balance_cents
      FROM invoices WHERE customer_id = p_customer_id
        AND status IN ('draft', 'posted', 'overdue');
    v_projected_cents := v_ar_balance_cents + v_total_cents;
    IF v_projected_cents >= v_customer.credit_limit_cents THEN
      v_credit_warning := true;
      INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
      VALUES ('credit_limit_warning',
        'WARNING: Quick delivery for "' || v_customer.farm_name || '" projected to push AR exposure to $' ||
          (v_projected_cents / 100.0)::numeric(12,2) ||
          ' (limit $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
          '). Current AR (draft+posted+overdue) is $' || (v_ar_balance_cents / 100.0)::numeric(12,2) ||
          '. Delivery proceeded; review with finance.',
        v_actor, 'customer', p_customer_id, p_customer_id);
      FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (v_admin.id,
          'Credit Limit Exceeded — ' || v_customer.farm_name,
          'A quick delivery was created for ' || v_customer.farm_name ||
            ' that projects AR exposure to $' || (v_projected_cents / 100.0)::numeric(12,2) ||
            ', exceeding the $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
            ' credit limit. Current AR (incl. draft+overdue) is $' ||
            (v_ar_balance_cents / 100.0)::numeric(12,2) ||
            '. The delivery proceeded; please review.',
          'credit_warning', 'customer', p_customer_id);
      END LOOP;
    END IF;
  END IF;

  v_split := v_customer.default_commission_split;
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
      INTO v_split_total FROM jsonb_array_elements(v_split->'splits') elem;
    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, total_price, total_cost, total_profit, total_margin_pct, commission_split)
  VALUES (v_order_id, v_order_number, p_customer_id, 'confirmed', CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0, v_customer.default_commission_split);

  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();
  INSERT INTO deliveries (id, delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, delivery_notes, is_quick_delivery, created_by)
  VALUES (v_delivery_id, v_delivery_number, v_order_id, p_customer_id, p_driver_id, p_scheduled_date, 'scheduled', p_delivery_notes, true, v_actor);

  IF NOT p_skip_invoice THEN
    v_invoice_id := gen_random_uuid();
    v_invoice_number := next_invoice_number('chemical_sale');
    INSERT INTO invoices (id, invoice_number, invoice_type, order_id, delivery_id, customer_id, status, total_amount_cents, paid_amount_cents, prepay_applied_cents, invoice_date, is_quick_delivery, created_by)
    VALUES (v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, v_delivery_id, p_customer_id, 'draft', 0, 0, 0, CURRENT_DATE, true, v_actor);
  END IF;

  v_total_cents := 0;
  v_total_cost_cents := 0;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_item_qty := (v_item->>'quantity')::numeric;

    -- A4: cascade tier2/tier3 → tier1 when the higher tier price is NULL (was COALESCE(tierN,0)=$0).
    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, v_product.tier1_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, v_product.tier1_price, 0) * 100)
    END;

    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_product.current_cost, 0) * 100 * v_item_qty)::bigint;

    INSERT INTO order_items (order_id, product_id, product_name, total_units_needed, price_per_unit, cost_per_unit, quantity_delivered, quantity_remaining, total_price, profit, net_margin, sort_order)
    VALUES (
      v_order_id, v_product.id, v_product.product_name, v_item_qty,
      (v_item_price_cents / 100.0)::numeric,
      COALESCE(v_product.current_cost, 0),
      0, v_item_qty,
      (v_item_price_cents / 100.0)::numeric * v_item_qty,
      ((v_item_price_cents / 100.0)::numeric - COALESCE(v_product.current_cost, 0)) * v_item_qty,
      CASE WHEN (v_item_price_cents / 100.0)::numeric > 0
        THEN (((v_item_price_cents / 100.0)::numeric - COALESCE(v_product.current_cost, 0))
              / (v_item_price_cents / 100.0)::numeric) * 100
        ELSE 0
      END,
      v_sort)
    RETURNING id INTO v_order_item_id;

    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_delivery_id, v_order_item_id, v_product.id, v_item_qty, 0, COALESCE(v_item->>'unit_size', v_product.unit_size));

    IF NOT p_skip_invoice THEN
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES (v_invoice_id, v_order_item_id, v_product.id, v_product.product_name, v_item_qty, v_item_price_cents,
        safe_cents_qty(v_item_price_cents, v_item_qty), ROUND(COALESCE(v_product.current_cost, 0) * 100)::bigint, v_sort);
    END IF;

    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item_qty, updated_at = now()
    WHERE product_id = v_product.id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, delivery_id, performed_by, notes)
    VALUES (v_product.id, 'prebooked', v_item_qty, v_order_id, v_delivery_id, v_actor, 'Quick delivery prebooked: ' || v_delivery_number);
  END LOOP;

  UPDATE orders SET total_price = (v_total_cents / 100.0)::numeric, total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = ((v_total_cents - v_total_cost_cents) / 100.0)::numeric,
    total_margin_pct = CASE WHEN v_total_cents > 0 THEN ROUND((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100, 2) ELSE 0 END
  WHERE id = v_order_id;

  IF NOT p_skip_invoice THEN
    UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;
  END IF;

  v_order_profit := (v_total_cents - v_total_cost_cents) / 100.0;
  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_order_profit,
    v_split, CURRENT_DATE
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'order_created', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'order_number', v_order_number,
      'customer_id', p_customer_id,
      'customer_name', v_customer.farm_name,
      'total_cents', v_total_cents,
      'total_cost_cents', v_total_cost_cents,
      'is_quick_delivery', true,
      'delivery_id', v_delivery_id,
      'invoice_id', v_invoice_id,
      'credit_warning', v_credit_warning
    ),
    v_total_cents,
    'Quick delivery order ' || v_order_number || ' for ' || v_customer.farm_name ||
      ' — $' || (v_total_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'delivery_created', 'delivery', v_delivery_id, v_actor_role,
    jsonb_build_object(
      'delivery_number', v_delivery_number,
      'order_id', v_order_id,
      'order_number', v_order_number,
      'customer_id', p_customer_id,
      'scheduled_date', p_scheduled_date,
      'assigned_driver', p_driver_id,
      'is_quick_delivery', true
    ),
    v_total_cents,
    'Delivery ' || v_delivery_number || ' scheduled for ' || p_scheduled_date::text ||
      ' (' || v_customer.farm_name || ')'
  );

  v_result := jsonb_build_object('order_id', v_order_id, 'delivery_id', v_delivery_id, 'invoice_id', v_invoice_id,
    'order_number', v_order_number, 'delivery_number', v_delivery_number, 'invoice_number', v_invoice_number,
    'total_cents', v_total_cents, 'credit_warning', v_credit_warning);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
