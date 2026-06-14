-- idempotency-body-check: exempt
-- ============================================================================
-- create_quick_delivery — latent-break column fixes (plpgsql_check sweep,
-- 2026-06-10 error-prevention follow-up queue item #1; see
-- docs/audits/2026-06-10-error-prevention-execution-log.md §4.1)
-- ----------------------------------------------------------------------------
-- BUG (the function is dead on arrival — the breaks are NOT on dead branches;
-- they sit on the UNCONDITIONAL path, so EVERY call has failed since the
-- 20260328000000 wave4 rewrite; the transaction rolls back, so no partial
-- writes ever landed):
--   B-a  23502 (found during this draft, invisible to plpgsql_check): the
--        deliveries INSERT omits created_by — NOT NULL since the v2 baseline
--        (20260206172436), no default, no filling trigger (verified: the only
--        BEFORE INSERT trigger on deliveries is guard_completed_delivery_
--        signature, which fills nothing). Every call dies HERE, before the
--        item loop. The pre-wave4 body (20260325100000) also omitted it.
--        Fix: created_by = v_actor — the same actor this body already writes
--        to invoices.created_by and inventory_transactions.performed_by, and
--        what every other delivery-creating RPC records.
--   B-b  42703 (plpgsql_check, line ~138): the order_items INSERT references
--        "quantity" AND "quantity_prebooked" — order_items has NEITHER and
--        never has (v2 baseline). plpgsql_check reported only "quantity" (the
--        first unresolved column aborts parsing of the statement); the same
--        statement hides the second bad column. The per-line quantity column
--        is total_units_needed (already set to the same v_item_qty in the
--        same INSERT); per-product prebook accounting lives on
--        inventory.quantity_prebooked, which this same loop updates 3
--        statements later. Fix: drop the two phantom column refs + their two
--        v_item_qty VALUES entries. No real column changes value.
--   B-c  42703 (plpgsql_check, line ~143): the delivery_items INSERT
--        references "sort_order" — delivery_items has no sort_order (v2
--        baseline; live columns: id, delivery_id, order_item_id, product_id,
--        quantity, unit_size, notes, quantity_delivered, tote_number). Line
--        ordering lives on order_items.sort_order (kept). Fix: drop the one
--        phantom column ref + its v_sort VALUES entry.
--   B-d  double-prebook (found during this draft — trigger interaction,
--        invisible to plpgsql_check): once B-a..B-c are fixed, the legacy
--        AFTER INSERT trigger trg_prebook_quick_delivery on delivery_items
--        (_prebook_quick_delivery_inventory, from 20260306200001/
--        20260307200000 — the era when the function body did NOT prebook)
--        fires for every quick-delivery item and adds quantity_prebooked +=
--        qty with a 'booked' transaction, ON TOP of the body's own
--        quantity_prebooked += qty with its 'prebooked' transaction (added by
--        wave4 and kept through 20260512000000 / 20260513020000 /
--        20260513030000 — three deliberate rewrites; the maintained intent).
--        Net effect would be +2x qty per item: Net Free permanently
--        understated, and every reversal invariant broken (complete_delivery
--        deducts prebooked once per delivered unit; cancel_order releases the
--        undelivered remainder once). Fix: drop the LEGACY TRIGGER ATTACHMENT
--        only — the trigger function _prebook_quick_delivery_inventory is
--        deliberately KEPT (no logic deleted; reversible with a one-line
--        CREATE TRIGGER). The body's in-body prebook ('prebooked' txn type,
--        in the live CHECK set and the documented inventory lifecycle) is the
--        single remaining writer, matching the wave4→20260513 lineage intent.
--
-- EVIDENCE (all read live 2026-06-10, project rhyzpcqhnizqbxphqdkr):
--   * order_items columns: id, order_id, product_id, quote_item_id,
--     section_name, product_name, price_per_unit, cost_per_unit, actual_rate,
--     rate_unit, acres, total_units_needed, unit_size, total_price, profit,
--     net_margin, quantity_delivered, quantity_remaining, sort_order, notes,
--     cost_at_time_cents. NO quantity / quantity_prebooked.
--   * delivery_items columns: id, delivery_id, order_item_id, product_id,
--     quantity, unit_size, notes, quantity_delivered, tote_number.
--     NO sort_order.
--   * deliveries.created_by: uuid NOT NULL REFERENCES profiles(id), no
--     default; no trigger fills it.
--   * trg_prebook_quick_delivery: BEFORE-the-fix live trigger, AFTER INSERT
--     ON delivery_items FOR EACH ROW EXECUTE _prebook_quick_delivery_
--     inventory() — prebooks (+qty, 'booked' txn) only when the parent
--     delivery is is_quick_delivery AND 'scheduled', i.e. exactly and only
--     the rows this function inserts. create_quick_delivery is the ONLY
--     function that creates is_quick_delivery deliveries (live prosrc sweep);
--     edit_delivery / create_followup_delivery never touch the flag.
--   * History: the original create_quick_delivery (20260227200000) used the
--     correct columns (total_units_needed etc., no in-body prebook — the
--     trigger era). The 20260328000000 wave4 rewrite introduced the phantom
--     quantity/quantity_prebooked/sort_order refs AND dropped created_by AND
--     added in-body prebooking without dropping the trigger; every later
--     definer (20260333600000, 20260430240000, 20260510020000,
--     20260510040000, 20260512000000, 20260513020000, 20260513030000)
--     carried all four defects verbatim.
--   * Status literals already in the live CHECK sets: orders 'confirmed';
--     deliveries 'scheduled'; invoices 'draft' + 'chemical_sale';
--     inventory_transactions 'prebooked'; financial_audit_log
--     'order_created'/'delivery_created' + 'order'/'delivery'.
--   * Helpers exist, single overload each: check_idempotency(text,text),
--     save_idempotency(text,text,jsonb), safe_cents_qty(bigint,numeric),
--     generate_order_number(), next_delivery_number(),
--     next_invoice_number(text), _insert_commissions_for_order(uuid,uuid,
--     numeric,jsonb,date). All callable as owner (postgres) inside this
--     SECDEF body.
--
-- BASELINE (verbatim-from-live):
--   md5(prosrc) of live public.create_quick_delivery(uuid, jsonb, uuid, date,
--   text, uuid, text, boolean) pre-apply = 142ed469a659043f346b8f038219b715
--   (single overload, prosecdef = true, proconfig = search_path=public,
--   pg_temp, proacl = {postgres=X, authenticated=X, service_role=X}).
--   Body below is byte-faithful to the live prosrc EXCEPT the
--   sentinel-delimited deltas (draft-time check: stripping the three
--   sentinel blocks and restoring the three original statements reproduces
--   the baseline md5 exactly).
--
-- RE-VERIFIED AGAINST LIVE 2026-06-11 (independent DRAFT session — did not
-- trust the 2026-06-10 draft; every claim re-derived from the live catalog):
--   * bug still live: plpgsql_check_function_tb(fatal_errors := false) still
--     reports exactly the two 42703s (line 138 order_items.quantity, line 143
--     delivery_items.sort_order); baseline md5(prosrc) unchanged =
--     142ed469a659043f346b8f038219b715; single overload; prosecdef = true;
--     proconfig search_path=public, pg_temp; proacl still
--     {postgres=X, authenticated=X, service_role=X}.
--   * byte-fidelity re-proven mechanically: body below with the three
--     sentinel blocks replaced by the three original statements (extracted
--     from live prosrc, not from this header) is byte-identical to live
--     prosrc (md5 match; file is LF-clean). New-body md5(prosrc-to-be) =
--     89398059dfedfe896c41863517612792.
--   * B-a re-confirmed: deliveries.created_by uuid NOT NULL, no default; the
--     only BEFORE INSERT trigger on deliveries is
--     trg_guard_completed_delivery_signature (fills nothing).
--   * B-b/B-c re-confirmed from information_schema: order_items has NO
--     quantity / quantity_prebooked (has total_units_needed + sort_order);
--     delivery_items has NO sort_order. No other NOT-NULL-no-default hole in
--     ANY insert-target table of this body (full sweep, 10 tables).
--   * B-d re-confirmed: trg_prebook_quick_delivery still attached AFTER
--     INSERT ON delivery_items; its function prebooks (+NEW.quantity,
--     'booked' txn) exactly when the parent is is_quick_delivery AND
--     'scheduled' — precisely the rows this fixed body also prebooks
--     in-body ('prebooked' txn) => +2x without DELTA-4. prosrc sweep:
--     create_quick_delivery is still the ONLY inserter of is_quick_delivery
--     deliveries; live quick-delivery count = 0 (function dead since wave4),
--     so the trigger drop loses no live behavior.
--   * Status/type literals re-checked in live CHECK constraints: orders
--     'confirmed'; deliveries 'scheduled'; invoices 'draft' +
--     'chemical_sale'; inventory_transactions 'prebooked';
--     financial_audit_log 'order_created'/'delivery_created' +
--     'order'/'delivery'. activity_feed / notifications carry no CHECKs.
--   * Helpers re-checked: all 8 single-overload with live signatures
--     matching the calls below; 121/121 referenced table.column pairs exist
--     in the live catalog (bulk existence query, 0 missing).
--
-- EXHAUSTIVE DELTA LIST (everything else is verbatim live):
--   DELTA-1  order_items INSERT: drop phantom "quantity" and
--            "quantity_prebooked" column refs + their two v_item_qty VALUES
--            entries (B-b). Original statement:
--              INSERT INTO order_items (order_id, product_id, quantity,
--                total_units_needed, price_per_unit, quantity_delivered,
--                quantity_remaining, quantity_prebooked, total_price,
--                sort_order)
--              VALUES (v_order_id, v_product.id, v_item_qty, v_item_qty,
--                (v_item_price_cents / 100.0)::numeric, 0, v_item_qty,
--                v_item_qty, (v_item_price_cents / 100.0)::numeric *
--                v_item_qty, v_sort)
--   DELTA-2  delivery_items INSERT: drop phantom "sort_order" column ref +
--            its v_sort VALUES entry (B-c). Original statement:
--              INSERT INTO delivery_items (delivery_id, order_item_id,
--                product_id, quantity, quantity_delivered, unit_size,
--                sort_order)
--              VALUES (v_delivery_id, v_order_item_id, v_product.id,
--                v_item_qty, 0, COALESCE(v_item->>'unit_size',
--                v_product.unit_size), v_sort)
--   DELTA-3  deliveries INSERT: append created_by column + v_actor value
--            (B-a). Original statement had 9 columns ending
--            "is_quick_delivery" / value "true".
--   DELTA-4  DROP TRIGGER trg_prebook_quick_delivery ON delivery_items
--            (B-d; outside the function body, after the CREATE). The trigger
--            FUNCTION _prebook_quick_delivery_inventory is kept untouched —
--            re-attachable with one CREATE TRIGGER if ever needed.
--
-- DELIBERATELY NOT CHANGED (out of scope, noted for the record):
--   * order_items rows from this path leave product_name = '' (NOT NULL
--     DEFAULT ''), cost_per_unit = 0 and unit_size = NULL — live behavior of
--     the current body. cost_at_time_cents IS captured by the
--     _snapshot_order_item_cost BEFORE INSERT trigger. Downstream effect:
--     complete_delivery's auto-invoice branch (p_skip_invoice = true path)
--     builds descriptions/costs from these fields. Candidate follow-up.
--   * edit_delivery adds items to a scheduled delivery without any inventory
--     prebook of its own; for quick deliveries the dropped legacy trigger
--     used to (one-sidedly — INSERT only, never on DELETE) cover that.
--     Pre-existing asymmetry, dead path today (no quick deliveries exist);
--     candidate follow-up on edit_delivery.
--   * The '%.2f' inside the commission-split RAISE renders literally (plpgsql
--     RAISE only knows bare %) — cosmetic, live behavior preserved.
--   * INSUFFICIENT_ROLE role set (admin/sales_rep/driver) and all error
--     strings preserved exactly.
--
-- GRANTS: restated below exactly as live (authenticated + service_role
-- EXECUTE; nothing for anon/PUBLIC). CREATE OR REPLACE preserves the ACL;
-- the REVOKE/GRANT pair makes the intent explicit and the DO block asserts it.
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

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
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

    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, 0) * 100)
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
  -- BEGIN DELTA-3 (quick_delivery_column_fixes): deliveries.created_by is
  -- NOT NULL with no default and no filling trigger — the live INSERT died
  -- 23502 here, before the item loop ever ran (B-a). created_by = v_actor
  -- matches the invoices INSERT below and every other delivery-creating RPC.
  -- Original statement recorded in the migration header.
  INSERT INTO deliveries (id, delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, delivery_notes, is_quick_delivery, created_by)
  VALUES (v_delivery_id, v_delivery_number, v_order_id, p_customer_id, p_driver_id, p_scheduled_date, 'scheduled', p_delivery_notes, true, v_actor);
  -- END DELTA-3

  IF NOT p_skip_invoice THEN
    v_invoice_id := gen_random_uuid();
    v_invoice_number := next_invoice_number('chemical_sale');
    INSERT INTO invoices (id, invoice_number, invoice_type, order_id, customer_id, status, total_amount_cents, paid_amount_cents, prepay_applied_cents, invoice_date, is_quick_delivery, created_by)
    VALUES (v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id, 'draft', 0, 0, 0, CURRENT_DATE, true, v_actor);
  END IF;

  v_total_cents := 0;
  v_total_cost_cents := 0;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_item_qty := (v_item->>'quantity')::numeric;

    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, 0) * 100)
    END;

    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_product.current_cost, 0) * 100 * v_item_qty)::bigint;

    -- BEGIN DELTA-1 (quick_delivery_column_fixes): order_items has NO
    -- "quantity" and NO "quantity_prebooked" columns (42703, B-b; never
    -- existed — v2 baseline 20260206172436). The per-line quantity lives in
    -- total_units_needed (already set to v_item_qty here); per-product
    -- prebook accounting lives on inventory.quantity_prebooked, updated
    -- below in this same loop. Dropped exactly those two column refs + their
    -- two v_item_qty VALUES entries; every real column keeps its exact live
    -- value. Original statement recorded in the migration header.
    INSERT INTO order_items (order_id, product_id, total_units_needed, price_per_unit, quantity_delivered, quantity_remaining, total_price, sort_order)
    VALUES (v_order_id, v_product.id, v_item_qty, (v_item_price_cents / 100.0)::numeric, 0, v_item_qty,
      (v_item_price_cents / 100.0)::numeric * v_item_qty, v_sort)
    RETURNING id INTO v_order_item_id;
    -- END DELTA-1

    -- BEGIN DELTA-2 (quick_delivery_column_fixes): delivery_items has NO
    -- sort_order column (42703, B-c; never existed — v2 baseline). Line
    -- ordering lives on order_items.sort_order, kept above. Dropped that one
    -- column ref + its v_sort VALUES entry; all real columns keep their
    -- exact live values. Original statement recorded in the migration header.
    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_delivery_id, v_order_item_id, v_product.id, v_item_qty, 0, COALESCE(v_item->>'unit_size', v_product.unit_size));
    -- END DELTA-2

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

-- ----------------------------------------------------------------------------
-- DELTA-4 (B-d): detach the legacy duplicate-prebook trigger. The body above
-- is now the single prebook writer for quick deliveries (the wave4→20260513
-- maintained intent). The trigger FUNCTION is kept untouched — reversible via:
--   CREATE TRIGGER trg_prebook_quick_delivery AFTER INSERT ON
--   public.delivery_items FOR EACH ROW
--   EXECUTE FUNCTION public._prebook_quick_delivery_inventory();
-- caller-analysis: trg_prebook_quick_delivery fires only for rows whose
-- parent delivery is is_quick_delivery = true AND status = 'scheduled';
-- create_quick_delivery is the only creator of such deliveries (live prosrc
-- sweep 2026-06-10) and it has been dead-on-arrival since 20260328, so no
-- live path loses behavior; edit_delivery's theoretical quick-delivery add
-- was already one-sided (INSERT-only, no DELETE release) and is recorded as
-- a follow-up in the header.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_prebook_quick_delivery ON public.delivery_items;

-- ----------------------------------------------------------------------------
-- Grants restated exactly as live (proacl pre-apply:
-- {postgres=X, authenticated=X, service_role=X} — nothing for anon/PUBLIC).
-- caller-analysis: create_quick_delivery — UI caller QuickDeliveryModal.tsx
-- (supabase.rpc, authenticated role, admin/sales_rep/driver in-body gate);
-- no Edge Function or cron caller; service_role retained for ops parity with
-- live. No grant is being narrowed or widened — this restates the live ACL.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text, boolean) TO service_role;

-- ============================================================================
-- SELF-VERIFICATION — raises (rolling back the migration) on any failure.
-- ============================================================================
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'create_quick_delivery' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_quick_delivery overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'create_quick_delivery' AND pronamespace = 'public'::regnamespace;

  -- All three in-body delta sentinels present in the deployed body
  IF v_src NOT LIKE '%BEGIN DELTA-1%' OR v_src NOT LIKE '%END DELTA-1%'
     OR v_src NOT LIKE '%BEGIN DELTA-2%' OR v_src NOT LIKE '%END DELTA-2%'
     OR v_src NOT LIKE '%BEGIN DELTA-3%' OR v_src NOT LIKE '%END DELTA-3%' THEN
    RAISE EXCEPTION 'create_quick_delivery: missing delta sentinel marker(s)';
  END IF;

  -- The broken references must be GONE
  IF v_src LIKE '%order_items (order_id, product_id, quantity,%' THEN
    RAISE EXCEPTION 'create_quick_delivery still inserts order_items.quantity';
  END IF;
  IF v_src LIKE '%quantity_prebooked, total_price%' THEN
    RAISE EXCEPTION 'create_quick_delivery still inserts order_items.quantity_prebooked';
  END IF;
  IF v_src LIKE '%unit_size, sort_order)%' THEN
    RAISE EXCEPTION 'create_quick_delivery still inserts delivery_items.sort_order';
  END IF;

  -- The fixes must be PRESENT
  IF v_src NOT LIKE '%order_items (order_id, product_id, total_units_needed,%' THEN
    RAISE EXCEPTION 'create_quick_delivery: order_items column fix missing';
  END IF;
  IF v_src NOT LIKE '%is_quick_delivery, created_by)%'
     OR v_src NOT LIKE '%p_delivery_notes, true, v_actor)%' THEN
    RAISE EXCEPTION 'create_quick_delivery: deliveries.created_by fix missing';
  END IF;

  -- DELTA-4: legacy duplicate-prebook trigger detached, its function kept
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_prebook_quick_delivery'
      AND tgrelid = 'public.delivery_items'::regclass
  ) THEN
    RAISE EXCEPTION 'trg_prebook_quick_delivery still attached — double-prebook not fixed';
  END IF;
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = '_prebook_quick_delivery_inventory' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '_prebook_quick_delivery_inventory function must be kept (count = %)', v_count;
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'create_quick_delivery' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'create_quick_delivery must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL exactly as live: authenticated + service_role yes, anon no.
  IF NOT has_function_privilege('authenticated', 'public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_quick_delivery: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_quick_delivery: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_quick_delivery: service_role lost EXECUTE';
  END IF;
END $$;
