-- ============================================================================
-- SECURITY AUDIT REMEDIATION — Phase 1
-- Migration: 20260317200000_security_audit_auth_uid_enforcement.sql
--
-- Fixes:
--   P0-001: auth.uid() enforcement on 9 SECURITY DEFINER RPCs
--   P0-002: Editability guard on save_invoice (posted invoice immutability)
--   P1-003: ROUND fix in save_invoice (truncation rounding error)
--
-- Also:
--   - Adds missing is_active check to close_accounting_period
--   - Restores lost FOR UPDATE on quote row in convert_quote_to_order
--   - Cleans up orphan function overloads from 20260306200000
--   - Adds p_idempotency_key DEFAULT NULL to functions missing it
-- ============================================================================


-- ============================================================================
-- STEP 0: Drop orphan overloads from 20260306200000 + old signatures
--
-- 20260306200000 used pg_get_functiondef() to inject p_idempotency_key,
-- creating duplicate overloads when later migrations rewrote the originals.
-- We drop BOTH versions to ensure a single clean function after this migration.
-- ============================================================================

-- save_quote: orphan 5-param + current 4-param
DROP FUNCTION IF EXISTS save_quote(uuid, jsonb, jsonb, uuid, text);
DROP FUNCTION IF EXISTS save_quote(uuid, jsonb, jsonb, uuid);

-- close_accounting_period: orphan 3-param + current 2-param
DROP FUNCTION IF EXISTS public.close_accounting_period(date, uuid, text);
DROP FUNCTION IF EXISTS public.close_accounting_period(date, uuid);

-- convert_quote_to_order: orphan 3-param + current 2-param
DROP FUNCTION IF EXISTS convert_quote_to_order(uuid, uuid, text);
DROP FUNCTION IF EXISTS convert_quote_to_order(uuid, uuid);

-- delete_purchase_order: orphan 3-param + current 2-param
DROP FUNCTION IF EXISTS delete_purchase_order(uuid, uuid, text);
DROP FUNCTION IF EXISTS delete_purchase_order(uuid, uuid);

-- save_invoice: orphan 3-param + current 2-param
DROP FUNCTION IF EXISTS save_invoice(jsonb, jsonb, text);
DROP FUNCTION IF EXISTS save_invoice(jsonb, jsonb);

-- cancel_order: no orphan, just gaining p_idempotency_key
DROP FUNCTION IF EXISTS cancel_order(uuid, uuid);

-- save_customer: no orphan, just gaining p_idempotency_key
DROP FUNCTION IF EXISTS save_customer(uuid, jsonb, jsonb, uuid);


-- ============================================================================
-- 1. save_quote — P0-001: auth.uid() enforcement
-- Source: 20260316100000 L31-320
-- Changes: v_actor from auth.uid(), p_idempotency_key added
-- ============================================================================

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_is_new boolean := (p_quote_id IS NULL);
  v_section jsonb;
  v_section_id uuid;
  v_item jsonb;
  v_tier integer;
  v_server_totals RECORD;
  v_current_status text;
  v_new_status text;
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  -- State machine validation
  v_new_status := COALESCE(p_quote_payload->>'status', 'draft');

  IF v_is_new THEN
    IF v_new_status != 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft, got: %', v_new_status;
    END IF;
  ELSE
    SELECT status INTO v_current_status
    FROM quotes WHERE id = p_quote_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    IF v_new_status IS DISTINCT FROM v_current_status THEN
      IF NOT (
        (v_current_status = 'draft'   AND v_new_status IN ('sent', 'revised', 'declined', 'expired'))
        OR (v_current_status = 'sent'    AND v_new_status IN ('revised', 'accepted', 'declined', 'expired'))
        OR (v_current_status = 'revised' AND v_new_status IN ('sent', 'accepted', 'declined', 'expired'))
        OR (v_current_status = 'expired' AND v_new_status = 'revised')
      ) THEN
        RAISE EXCEPTION 'Invalid quote status transition: % -> %', v_current_status, v_new_status;
      END IF;
    END IF;
  END IF;

  v_tier := COALESCE((p_quote_payload->>'tier')::integer, 1);

  IF v_is_new THEN
    INSERT INTO quotes (
      quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit,
      total_margin_pct, valid_days, expires_at,
      header_notes, footer_notes, sent_at
    ) VALUES (
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      COALESCE(p_quote_payload->>'status', 'draft'),
      CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE NULL
      END,
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::integer, 30),
      (p_quote_payload->>'expires_at')::timestamptz,
      NULLIF(p_quote_payload->>'header_notes', ''),
      NULLIF(p_quote_payload->>'footer_notes', ''),
      CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE NULL
      END
    ) RETURNING id INTO v_quote_id;
  ELSE
    v_quote_id := p_quote_id;

    UPDATE quotes SET
      customer_id = COALESCE((p_quote_payload->>'customer_id')::uuid, customer_id),
      tier = v_tier,
      status = COALESCE(p_quote_payload->>'status', status),
      commission_split = CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE commission_split
      END,
      valid_days = COALESCE((p_quote_payload->>'valid_days')::integer, valid_days),
      expires_at = COALESCE((p_quote_payload->>'expires_at')::timestamptz, expires_at),
      header_notes = CASE WHEN p_quote_payload ? 'header_notes'
        THEN NULLIF(p_quote_payload->>'header_notes', '')
        ELSE header_notes
      END,
      footer_notes = CASE WHEN p_quote_payload ? 'footer_notes'
        THEN NULLIF(p_quote_payload->>'footer_notes', '')
        ELSE footer_notes
      END,
      sent_at = CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = v_quote_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', v_quote_id;
    END IF;

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  END IF;

  -- Insert sections and items
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    INSERT INTO quote_sections (
      quote_id, section_name, sort_order, section_notes
    ) VALUES (
      v_quote_id,
      COALESCE(v_section->>'section_name', ''),
      COALESCE((v_section->>'sort_order')::integer, 0),
      NULLIF(v_section->>'section_notes', '')
    ) RETURNING id INTO v_section_id;

    IF v_section ? 'items' AND jsonb_array_length(v_section->'items') > 0 THEN
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin
      )
      SELECT
        v_quote_id,
        v_section_id,
        (item->>'product_id')::uuid,
        COALESCE((item->>'sort_order')::integer, 0),
        NULLIF(item->>'notes', ''),
        COALESCE((item->>'price_per_unit')::numeric, 0),
        COALESCE((item->>'current_cost')::numeric, 0),
        item->>'suggested_rate',
        (item->>'actual_rate')::numeric,
        item->>'rate_unit',
        (item->>'oz_per_acre')::numeric,
        (item->>'price_per_acre')::numeric,
        (item->>'acres')::numeric,
        (item->>'total_units_needed')::numeric,
        item->>'unit_size',
        COALESCE((item->>'profit')::numeric, 0),
        COALESCE((item->>'total_price')::numeric, 0),
        COALESCE((item->>'net_margin')::numeric, 0)
      FROM jsonb_array_elements(v_section->'items') AS item
      WHERE (item->>'product_id') IS NOT NULL;
    END IF;
  END LOOP;

  -- Server-authoritative recalculation
  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, 0)
        ELSE COALESCE(p.tier3_price, 0)
      END AS ppu,
      COALESCE(p.current_cost, 0) AS cc,
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(p.inventory_unit)
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      ROUND(ar * rate_oz, 2) AS oz_per_acre,
      CASE WHEN inv_oz > 0
        THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0::numeric
      END AS total_units,
      CASE WHEN inv_oz > 0
        THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0::numeric
      END AS price_per_acre,
      ROUND(ppu * CASE WHEN inv_oz > 0
        THEN (ac * ar * rate_oz) / inv_oz
        ELSE 0 END, 2) AS total_price,
      ROUND((ppu - cc) * CASE WHEN inv_oz > 0
        THEN (ac * ar * rate_oz) / inv_oz
        ELSE 0 END, 2) AS profit
    FROM base
  )
  UPDATE quote_items qi SET
    price_per_unit = calc.ppu,
    current_cost = calc.cc,
    oz_per_acre = calc.oz_per_acre,
    total_units_needed = calc.total_units,
    price_per_acre = calc.price_per_acre,
    total_price = calc.total_price,
    profit = calc.profit,
    net_margin = CASE WHEN calc.total_price > 0
      THEN ROUND(calc.profit / calc.total_price * 100, 2)
      ELSE 0::numeric
    END
  FROM calc
  WHERE qi.id = calc.item_id;

  -- Recalculate quote-level totals
  SELECT
    COALESCE(ROUND(SUM(total_price), 2), 0) AS tp,
    COALESCE(ROUND(SUM(current_cost * total_units_needed), 2), 0) AS tc,
    COALESCE(ROUND(SUM(profit), 2), 0) AS tprof
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  UPDATE quotes SET
    total_price = v_server_totals.tp,
    total_cost = v_server_totals.tc,
    total_profit = v_server_totals.tprof,
    total_margin_pct = CASE WHEN v_server_totals.tp > 0
      THEN ROUND(v_server_totals.tprof / v_server_totals.tp * 100, 2)
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'quote_created' ELSE 'quote_updated' END,
    CASE WHEN v_is_new
      THEN 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' created'
      ELSE 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' updated'
    END,
    v_actor, 'quote', v_quote_id
  );

  RETURN jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    'server_totals', jsonb_build_object(
      'total_price', v_server_totals.tp,
      'total_cost', v_server_totals.tc,
      'total_profit', v_server_totals.tprof,
      'total_margin_pct', CASE WHEN v_server_totals.tp > 0
        THEN ROUND(v_server_totals.tprof / v_server_totals.tp * 100, 2)
        ELSE 0
      END
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION save_quote(uuid, jsonb, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- 2. receive_po_items — P0-001: auth.uid() enforcement
-- Source: 20260316100000 L535-710
-- Changes: v_actor from auth.uid() (idempotency check runs first)
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_item jsonb;
  v_po_item record;
  v_po record;
  v_qty numeric;
  v_product record;
  v_po_id uuid;
  v_all_received boolean;
  v_any_received boolean;
  v_new_status text;
  v_cached_result jsonb;
  v_result jsonb;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_recv_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
BEGIN
  -- Idempotency check first (cached result already passed auth)
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor
      AND role IN ('admin', 'sales_rep')
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins and sales reps can receive PO items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_po_item FROM purchase_order_items WHERE id = (v_item->>'po_item_id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF NOT p_allow_over_receive AND v_po_item.quantity_received + v_qty > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %', v_po_item.id;
    END IF;

    v_po_id := v_po_item.purchase_order_id;

    -- PO Header Status Gate
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id;
    IF FOUND THEN
      IF v_po.status NOT IN ('submitted', 'partially_received') THEN
        RAISE EXCEPTION 'Cannot receive items for PO in status: %. Must be submitted or partially_received.', v_po.status;
      END IF;
    END IF;

    IF NOT v_po_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_id;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    UPDATE purchase_order_items SET
      quantity_received = quantity_received + v_qty
    WHERE id = v_po_item.id;

    -- FOR UPDATE lock on inventory row
    PERFORM 1 FROM public.inventory
    WHERE product_id = v_po_item.product_id AND location = v_storage_location
    FOR UPDATE;

    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(quantity_on_order - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_id, v_actor,
      'Received ' || v_qty || ' units via PO'
    );

    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size
    ) VALUES (
      v_po_id, v_po_item.id, v_po_item.product_id,
      v_qty, v_actor, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size
    )
    RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF v_product.current_cost IS DISTINCT FROM v_po_item.unit_cost THEN
        INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
        VALUES (v_po_item.product_id, v_actor, v_product.current_cost, v_po_item.unit_cost,
                'Auto-updated from PO receiving');

        UPDATE products SET
          current_cost = v_po_item.unit_cost,
          cost_updated_date = now()
        WHERE id = v_po_item.product_id;
      END IF;
    END IF;
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY v_affected_po_ids
  LOOP
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_unique_po_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT
      bool_and(quantity_received >= quantity_ordered),
      bool_or(quantity_received > 0)
    INTO v_all_received, v_any_received
    FROM purchase_order_items WHERE purchase_order_id = v_unique_po_id;

    v_new_status := CASE
      WHEN v_all_received THEN 'fully_received'
      WHEN v_any_received THEN 'partially_received'
      ELSE v_po.status
    END;

    IF v_new_status IS DISTINCT FROM v_po.status THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_unique_po_id;
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_received',
      'Items received on PO ' || v_po.po_number || ' — inventory updated',
      v_actor, 'purchase_order', v_unique_po_id
    );
  END LOOP;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION receive_po_items(jsonb, uuid, text, boolean) TO authenticated;


-- ============================================================================
-- 3. close_accounting_period — P0-001: auth.uid() enforcement
-- Source: 20260316100000 L720-788
-- Changes: v_actor from auth.uid(), ADDED is_active check, p_idempotency_key
-- Note: Uses SET search_path = '' so all tables use public. prefix
-- ============================================================================

CREATE OR REPLACE FUNCTION public.close_accounting_period(
  p_period_end   date,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_period_start date;
  v_unposted_count integer;
  v_period_id uuid;
  v_summary jsonb;
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  -- FIX: Added is_active check (was missing in original)
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  v_period_start := date_trunc('month', p_period_end)::date;

  SELECT count(*)
    INTO v_unposted_count
    FROM public.invoices
   WHERE invoice_date BETWEEN v_period_start AND p_period_end
     AND status IN ('draft', 'unposted')
     AND deleted_at IS NULL;

  IF v_unposted_count > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted invoice(s) exist between % and %',
      v_unposted_count, v_period_start, p_period_end;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE period_start = v_period_start AND period_end = p_period_end AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  INSERT INTO public.accounting_periods (period_start, period_end, status, closed_by, closed_at)
  VALUES (v_period_start, p_period_end, 'closed', v_actor, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET status = 'closed', closed_by = v_actor, closed_at = now(), updated_at = now()
  RETURNING id INTO v_period_id;

  SELECT jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end,
    'invoices_posted', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN v_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL),
    'total_invoiced_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN v_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL), 0),
    'payments_received_cents', COALESCE((SELECT sum(amount_cents) FROM public.payments WHERE payment_date BETWEEN v_period_start AND p_period_end), 0),
    'orders_count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL),
    'deliveries_count', (SELECT count(*) FROM public.deliveries WHERE delivery_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL)
  ) INTO v_summary;

  RETURN v_summary;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_accounting_period(date, uuid, text) TO authenticated;


-- ============================================================================
-- 4. delete_purchase_order — P0-001: auth.uid() enforcement
-- Source: 20260211220000 L132-183
-- Changes: v_actor from auth.uid(), p_idempotency_key added
-- ============================================================================

CREATE OR REPLACE FUNCTION delete_purchase_order(
  p_po_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_po record;
  v_has_received boolean;
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can delete purchase orders';
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM purchase_order_items
    WHERE purchase_order_id = p_po_id AND quantity_received > 0
  ) INTO v_has_received;

  IF v_has_received THEN
    RAISE EXCEPTION 'Cannot delete PO % — items have already been received. Cancel instead.', v_po.po_number;
  END IF;

  DELETE FROM purchase_order_items WHERE purchase_order_id = p_po_id;
  DELETE FROM purchase_orders WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'po_deleted',
    'PO ' || v_po.po_number || ' deleted',
    v_actor, 'purchase_order', p_po_id
  );

  RETURN jsonb_build_object('status', 'deleted');
END;
$$;

GRANT EXECUTE ON FUNCTION delete_purchase_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- 5. cancel_order — P0-001: auth.uid() enforcement
-- Source: 20260305200000 L384-544
-- Changes: v_actor from auth.uid(), p_idempotency_key added
-- ============================================================================

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_order record;
  v_item record;
  v_undelivered numeric;
  v_invoice record;
  v_holds_released int;
  v_commissions_cancelled int;
  v_paid_commissions int;
  v_admin record;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status IN ('cancelled', 'fulfilled') THEN
    RAISE EXCEPTION 'Cannot cancel a % order', v_order.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- Release prebooked inventory for undelivered items
  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    UPDATE inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'adjusted', -v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- Release inventory holds
  UPDATE inventory_holds SET is_active = false, updated_at = now()
  WHERE order_id = p_order_id AND is_active = true;
  GET DIAGNOSTICS v_holds_released = ROW_COUNT;

  -- Cancel pending commissions
  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Check for paid commissions
  SELECT COUNT(*) INTO v_paid_commissions
  FROM commissions WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Cancelled Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was cancelled but has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
        'cancellation_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- Void draft invoices, notify about posted ones
  FOR v_invoice IN
    SELECT * FROM invoices
    WHERE order_id = p_order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE invoices SET
        status = 'voided',
        voided_by = v_actor,
        voided_at = now(),
        void_reason = 'Order ' || v_order.order_number || ' cancelled',
        total_amount_cents = 0,
        paid_amount_cents = 0,
        prepay_applied_cents = 0,
        write_off_cents = 0,
        updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order cancelled'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number || ' — order ' || v_order.order_number || ' cancelled'
      );

      v_draft_voided := v_draft_voided + 1;
    ELSE
      FOR v_admin IN
        SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (
          v_admin.id,
          'Order Cancelled — Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' cancelled. Invoice ' || v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'cancellation_review', 'invoice', v_invoice.id
        );
      END LOOP;
      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled' ||
      CASE WHEN v_draft_voided > 0 THEN '. ' || v_draft_voided || ' draft invoice(s) voided.' ELSE '' END ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.' ELSE '' END,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'order_number', v_order.order_number,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- 6. adjust_inventory — P0-001: auth.uid() enforcement
-- Source: 20260228320000 L134-217
-- Changes: v_actor from auth.uid() (idempotency check runs first)
-- ============================================================================

CREATE OR REPLACE FUNCTION adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_inv record;
  v_new_qty numeric;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Idempotency check first (cached result already passed auth)
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'adjust_inventory');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can adjust inventory';
  END IF;

  SELECT * INTO v_inv FROM inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  v_new_qty := v_inv.quantity_available + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Adjustment would result in negative inventory (current: %, delta: %, result: %)',
      v_inv.quantity_available, p_delta, v_new_qty;
  END IF;

  UPDATE inventory SET
    quantity_available = v_new_qty,
    updated_at = now()
  WHERE id = p_inventory_id;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, v_actor,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'adjust_inventory', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION adjust_inventory(uuid, numeric, text, uuid, text) TO authenticated;


-- ============================================================================
-- 7. convert_quote_to_order — P0-001: auth.uid() enforcement
-- Source: 20260311200000 L601-760
-- Changes: v_actor from auth.uid(), p_idempotency_key added,
--          RESTORED FOR UPDATE on quote row (lost in 20260311 rewrite),
--          RESTORED SET LOCAL app.admin_override for status transition
-- ============================================================================

CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_section record;
  v_item record;
  v_customer record;
  v_split jsonb;
  v_inv record;
  v_shortfalls text[] := '{}';
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  -- FIX: Restore FOR UPDATE (lost in 20260311 rewrite, originally from M5 fix)
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency: already converted?
  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Availability check with inventory locks
  FOR v_item IN
    SELECT qi.product_id, p.product_name,
           SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', have 0 in stock');
    ELSIF (v_inv.quantity_available - v_inv.quantity_prebooked) < v_item.qty_needed THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed ||
        ', only ' || (v_inv.quantity_available - v_inv.quantity_prebooked) || ' free');
    END IF;
  END LOOP;

  IF array_length(v_shortfalls, 1) > 0 THEN
    RAISE EXCEPTION 'Insufficient inventory to convert quote: %', array_to_string(v_shortfalls, '; ');
  END IF;

  -- FIX: Restore SET LOCAL for state machine trigger bypass
  SET LOCAL app.admin_override = 'true';

  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;

  v_order_number := generate_order_number();

  INSERT INTO orders (
    order_number, quote_id, customer_id, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, order_date
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split,
    v_quote.total_price, v_quote.total_cost, v_quote.total_profit,
    v_quote.total_margin_pct, current_date
  ) RETURNING id INTO v_order_id;

  -- Create order items from quote items
  INSERT INTO order_items (
    order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  )
  SELECT
    v_order_id, qi.product_id, qi.id,
    qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0)
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  -- Pre-book inventory
  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size
    FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- Create commission records
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, v_quote.customer_id,
      s->>'recipient',
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit,
      current_date,
      'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer'),
    v_actor, 'order', v_order_id, v_quote.customer_id
  );

  RETURN jsonb_build_object('status', 'created', 'order_id', v_order_id, 'order_number', v_order_number);
END;
$$;

GRANT EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- 8. save_customer — P0-001: auth.uid() enforcement
-- Source: 20260310200000 L11-154
-- Changes: v_actor from auth.uid(), p_idempotency_key added
-- ============================================================================

CREATE OR REPLACE FUNCTION save_customer(
  p_customer_id uuid,
  p_customer_payload jsonb,
  p_addresses jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_addr jsonb;
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to manage customers';
  END IF;

  IF v_is_new THEN
    INSERT INTO customers (
      farm_name, contact_name, phone, email, billing_address,
      assigned_tier, assigned_sales_rep, total_acres, corn_acres,
      soybean_acres, other_acres, payment_terms,
      default_commission_split, notes, is_active,
      parent_customer_id, credit_limit_cents,
      finance_charge_rate, finance_charge_enabled, finance_charge_grace_days
    ) VALUES (
      p_customer_payload->>'farm_name',
      NULLIF(p_customer_payload->>'contact_name', ''),
      NULLIF(p_customer_payload->>'phone', ''),
      NULLIF(p_customer_payload->>'email', ''),
      NULLIF(p_customer_payload->>'billing_address', ''),
      COALESCE((p_customer_payload->>'assigned_tier')::integer, 1),
      (p_customer_payload->>'assigned_sales_rep')::uuid,
      (p_customer_payload->>'total_acres')::numeric,
      (p_customer_payload->>'corn_acres')::numeric,
      (p_customer_payload->>'soybean_acres')::numeric,
      (p_customer_payload->>'other_acres')::numeric,
      NULLIF(p_customer_payload->>'payment_terms', ''),
      CASE WHEN p_customer_payload ? 'default_commission_split'
        THEN (p_customer_payload->'default_commission_split')
        ELSE NULL
      END,
      NULLIF(p_customer_payload->>'notes', ''),
      COALESCE((p_customer_payload->>'is_active')::boolean, true),
      (p_customer_payload->>'parent_customer_id')::uuid,
      COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0),
      COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0),
      COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true),
      COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0)
    ) RETURNING id INTO v_customer_id;
  ELSE
    v_customer_id := p_customer_id;

    UPDATE customers SET
      farm_name = COALESCE(p_customer_payload->>'farm_name', farm_name),
      contact_name = CASE WHEN p_customer_payload ? 'contact_name'
        THEN NULLIF(p_customer_payload->>'contact_name', '') ELSE contact_name END,
      phone = CASE WHEN p_customer_payload ? 'phone'
        THEN NULLIF(p_customer_payload->>'phone', '') ELSE phone END,
      email = CASE WHEN p_customer_payload ? 'email'
        THEN NULLIF(p_customer_payload->>'email', '') ELSE email END,
      billing_address = CASE WHEN p_customer_payload ? 'billing_address'
        THEN NULLIF(p_customer_payload->>'billing_address', '') ELSE billing_address END,
      assigned_tier = COALESCE((p_customer_payload->>'assigned_tier')::integer, assigned_tier),
      assigned_sales_rep = CASE WHEN p_customer_payload ? 'assigned_sales_rep'
        THEN (p_customer_payload->>'assigned_sales_rep')::uuid ELSE assigned_sales_rep END,
      total_acres = CASE WHEN p_customer_payload ? 'total_acres'
        THEN (p_customer_payload->>'total_acres')::numeric ELSE total_acres END,
      corn_acres = CASE WHEN p_customer_payload ? 'corn_acres'
        THEN (p_customer_payload->>'corn_acres')::numeric ELSE corn_acres END,
      soybean_acres = CASE WHEN p_customer_payload ? 'soybean_acres'
        THEN (p_customer_payload->>'soybean_acres')::numeric ELSE soybean_acres END,
      other_acres = CASE WHEN p_customer_payload ? 'other_acres'
        THEN (p_customer_payload->>'other_acres')::numeric ELSE other_acres END,
      payment_terms = CASE WHEN p_customer_payload ? 'payment_terms'
        THEN NULLIF(p_customer_payload->>'payment_terms', '') ELSE payment_terms END,
      default_commission_split = CASE WHEN p_customer_payload ? 'default_commission_split'
        THEN (p_customer_payload->'default_commission_split') ELSE default_commission_split END,
      notes = CASE WHEN p_customer_payload ? 'notes'
        THEN NULLIF(p_customer_payload->>'notes', '') ELSE notes END,
      is_active = COALESCE((p_customer_payload->>'is_active')::boolean, is_active),
      parent_customer_id = CASE WHEN p_customer_payload ? 'parent_customer_id'
        THEN (p_customer_payload->>'parent_customer_id')::uuid ELSE parent_customer_id END,
      credit_limit_cents = CASE WHEN p_customer_payload ? 'credit_limit_cents'
        THEN COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0) ELSE credit_limit_cents END,
      finance_charge_rate = CASE WHEN p_customer_payload ? 'finance_charge_rate'
        THEN COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0) ELSE finance_charge_rate END,
      finance_charge_enabled = CASE WHEN p_customer_payload ? 'finance_charge_enabled'
        THEN COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true) ELSE finance_charge_enabled END,
      finance_charge_grace_days = CASE WHEN p_customer_payload ? 'finance_charge_grace_days'
        THEN COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0) ELSE finance_charge_grace_days END,
      updated_at = now()
    WHERE id = v_customer_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found: %', v_customer_id;
    END IF;

    DELETE FROM customer_addresses WHERE customer_id = v_customer_id;
  END IF;

  IF p_addresses IS NOT NULL AND jsonb_array_length(p_addresses) > 0 THEN
    INSERT INTO customer_addresses (
      customer_id, label, address_line, city, state, zip,
      delivery_notes, is_default
    )
    SELECT
      v_customer_id,
      COALESCE(addr->>'label', ''),
      NULLIF(addr->>'address_line', ''),
      NULLIF(addr->>'city', ''),
      NULLIF(addr->>'state', ''),
      NULLIF(addr->>'zip', ''),
      NULLIF(addr->>'delivery_notes', ''),
      COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE COALESCE(addr->>'label', '') != '' OR COALESCE(addr->>'address_line', '') != '';
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'customer_created' ELSE 'customer_updated' END,
    CASE WHEN v_is_new
      THEN 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' created'
      ELSE 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' updated'
    END,
    v_actor, 'customer', v_customer_id, v_customer_id
  );

  RETURN jsonb_build_object('status', 'saved', 'customer_id', v_customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_customer(uuid, jsonb, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- 9. update_order_items — P0-001: auth.uid() enforcement
-- Source: 20260311200000 L940-1042
-- Changes: v_actor from auth.uid() (idempotency check runs first)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_order record;
  v_item jsonb;
  v_old_item record;
  v_qty_diff numeric;
  v_new_total numeric := 0;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Idempotency check first (cached result already passed auth)
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- P0-001 FIX: Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF v_order.status NOT IN ('pending', 'confirmed') THEN
    RAISE EXCEPTION 'Cannot edit items on a % order', v_order.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

    UPDATE order_items SET
      price_per_unit = (v_item->>'price_per_unit')::numeric,
      total_units_needed = (v_item->>'total_units_needed')::numeric,
      quantity_remaining = GREATEST(
        (v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0
      ),
      total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
    WHERE id = v_old_item.id;

    IF v_qty_diff <> 0 THEN
      UPDATE inventory SET
        quantity_prebooked = GREATEST(quantity_prebooked + v_qty_diff, 0),
        updated_at = now()
      WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        order_id, performed_by, notes
      ) VALUES (
        v_old_item.product_id,
        CASE WHEN v_qty_diff > 0 THEN 'prebooked' ELSE 'released' END,
        ABS(v_qty_diff),
        p_order_id, v_actor,
        'Order edit: adjusted prebooked by ' || v_qty_diff
      );
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
  FROM order_items WHERE order_id = p_order_id;

  UPDATE orders SET
    total_price = v_new_total,
    updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_edited',
    'Order ' || v_order.order_number || ' items updated — new total $' || ROUND(v_new_total, 2),
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object('status', 'updated');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION update_order_items(uuid, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- 10. save_invoice — P0-002 + P1-003 fixes (no P0-001 needed, already uses auth.uid())
-- Source: 20260228200000 L67-187
-- Changes:
--   P0-002: Editability guard — skip item mutation if invoice is not draft/unposted
--   P0-002: Status guard on total update
--   P1-003: ROUND() on extended_cents calculation
--   Also: p_idempotency_key added to signature
-- ============================================================================

CREATE OR REPLACE FUNCTION save_invoice(
  p_invoice       jsonb,
  p_items         jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id  uuid;
  v_is_new      boolean := false;
  v_item        jsonb;
  v_total_cents bigint := 0;
  v_qty         numeric;
  v_unit_price  bigint;
  v_extended    bigint;
  v_cost_cents  bigint;
  v_product     record;
BEGIN
  v_invoice_id := (p_invoice->>'id')::uuid;

  IF v_invoice_id IS NULL THEN
    v_is_new := true;
    INSERT INTO invoices (
      customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
      total_amount_cents, created_by
    ) VALUES (
      (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0,
      (SELECT auth.uid())
    )
    RETURNING id INTO v_invoice_id;
  ELSE
    -- Update existing (only if draft/unposted)
    UPDATE invoices SET
      customer_id = COALESCE((p_invoice->>'customer_id')::uuid, customer_id),
      invoice_type = COALESCE(p_invoice->>'invoice_type', invoice_type),
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = (p_invoice->>'due_date')::date,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  -- ═══ P0-002 FIX: Block item mutation on non-editable invoices ═══
  -- The header UPDATE above is already guarded by status IN ('draft','unposted'),
  -- but the DELETE + INSERT below was not. This guard prevents modifying items
  -- on posted/paid/overdue invoices.
  IF NOT v_is_new THEN
    IF NOT EXISTS (
      SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')
    ) THEN
      RETURN v_invoice_id;  -- silently return; no mutation
    END IF;
  END IF;

  -- Delete existing items and re-insert
  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Invoice line item quantity must be greater than zero';
    END IF;

    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);

    -- ═══ P1-003 FIX: Use ROUND instead of truncation ═══
    v_extended := ROUND(v_qty * v_unit_price)::bigint;

    -- SERVER-SIDE COST: Derive from products table, fallback to client value
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;

    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity,
      unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size, notes
    ) VALUES (
      v_invoice_id,
      (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty,
      v_unit_price,
      v_extended,
      v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric,
      (v_item->>'acres')::numeric,
      v_item->>'unit_size',
      v_item->>'notes'
    );
    v_total_cents := v_total_cents + v_extended;
  END LOOP;

  -- ═══ P0-002 FIX: Guard total update with status check ═══
  UPDATE invoices SET total_amount_cents = v_total_cents, updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  -- Activity log for new invoices
  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      (SELECT auth.uid()), 'invoice', v_invoice_id,
      (p_invoice->>'customer_id')::uuid
    );
  END IF;

  RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION save_invoice(jsonb, jsonb, text) TO authenticated;


-- ============================================================================
-- Migration complete: 10 functions hardened
--   9 RPCs: auth.uid() enforcement (P0-001)
--   save_invoice: editability guard (P0-002) + ROUND fix (P1-003)
-- ============================================================================
