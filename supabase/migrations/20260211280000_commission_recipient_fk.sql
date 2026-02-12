-- ============================================================================
-- S5-4: COMMISSION RECIPIENT FK
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- Problem: commissions.recipient is a text field matched against profiles.full_name.
-- If a name changes, commissions orphan. If two users share a name, they collide.
--
-- Fix: Add recipient_user_id UUID FK. Backfill from profiles. Update RLS.
-- Keep recipient text column for display (denormalized), but use FK for security.
-- ============================================================================

-- 1. Add the FK column (nullable initially for backfill)
ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid REFERENCES profiles(id);

-- 2. Backfill existing rows by matching recipient name to profiles.full_name
UPDATE commissions c
SET recipient_user_id = p.id
FROM profiles p
WHERE c.recipient = p.full_name
  AND c.recipient_user_id IS NULL;

-- 3. Create index for FK lookups and RLS performance
CREATE INDEX IF NOT EXISTS idx_commissions_recipient_user_id
  ON commissions(recipient_user_id);

-- 4. Drop old RLS policy and replace with FK-based policy
DROP POLICY IF EXISTS "comm_rep_select" ON commissions;

CREATE POLICY "comm_rep_select" ON commissions FOR SELECT TO authenticated
  USING (
    is_sales_rep() AND (
      recipient_user_id = auth.uid()
      -- Fallback to name matching for any rows that couldn't be backfilled
      OR (recipient_user_id IS NULL AND EXISTS (
        SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND commissions.recipient = p.full_name
      ))
    )
  );

-- 5. Update convert_quote_to_order to populate recipient_user_id
-- We need to recreate the function to include the new column
CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_order_id uuid;
  v_order_number text;
  v_year text := extract(year FROM current_date)::text;
  v_max_num int;
  v_section record;
BEGIN
  -- Lock the quote row
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;
  IF v_quote.status != 'accepted' THEN
    RAISE EXCEPTION 'Only accepted quotes can be converted. Status: %', v_quote.status;
  END IF;

  -- Generate order number
  SELECT COALESCE(MAX(
    CASE WHEN order_number ~ ('^ORD-' || v_year || '-\d+$')
    THEN CAST(split_part(order_number, '-', 3) AS int)
    ELSE 0 END
  ), 0) INTO v_max_num FROM orders;
  v_order_number := 'ORD-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  -- Create order
  INSERT INTO orders (
    order_number, quote_id, customer_id, created_by, status,
    commission_split, total_price, total_cost, total_profit, total_margin_pct
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, p_performed_by, 'confirmed',
    v_quote.commission_split, v_quote.total_price, v_quote.total_cost,
    v_quote.total_profit, v_quote.total_margin_pct
  ) RETURNING id INTO v_order_id;

  -- Copy items (flattened — no sections in orders)
  INSERT INTO order_items (
    order_id, product_id, sort_order, notes,
    price_per_unit, current_cost, actual_rate, rate_unit,
    oz_per_acre, price_per_acre, acres,
    total_units_needed, unit_size, profit, total_price, net_margin
  )
  SELECT
    v_order_id, qi.product_id, qi.sort_order, qi.notes,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit,
    qi.oz_per_acre, qi.price_per_acre, qi.acres,
    qi.total_units_needed, qi.unit_size, qi.profit, qi.total_price, qi.net_margin
  FROM quote_items qi
  JOIN quote_sections qs ON qi.section_id = qs.id
  WHERE qs.quote_id = p_quote_id
  ORDER BY qs.sort_order, qi.sort_order;

  -- Update quote status
  UPDATE quotes SET status = 'converted', updated_at = now() WHERE id = p_quote_id;

  -- Create commission records (with recipient_user_id lookup)
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, recipient_user_id, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, v_quote.customer_id,
      s->>'recipient',
      (SELECT id FROM profiles WHERE full_name = s->>'recipient' LIMIT 1),
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit,
      current_date,
      'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number,
    p_performed_by, 'order', v_order_id, v_quote.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'converted',
    'order_id', v_order_id,
    'order_number', v_order_number
  );
END;
$$;

-- Also update create_direct_order to include recipient_user_id
CREATE OR REPLACE FUNCTION create_direct_order(
  p_customer_id uuid,
  p_items jsonb,
  p_commission_split jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_order_number text;
  v_year text := extract(year FROM current_date)::text;
  v_max_num int;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric := 0;
  v_margin_pct numeric := 0;
  v_item jsonb;
BEGIN
  -- Generate order number
  SELECT COALESCE(MAX(
    CASE WHEN order_number ~ ('^ORD-' || v_year || '-\d+$')
    THEN CAST(split_part(order_number, '-', 3) AS int)
    ELSE 0 END
  ), 0) INTO v_max_num FROM orders;
  v_order_number := 'ORD-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  -- Calculate totals from items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_total_price := v_total_price + COALESCE((v_item->>'total_price')::numeric, 0);
    v_total_cost := v_total_cost + COALESCE((v_item->>'total_cost')::numeric, 0);
  END LOOP;
  v_total_profit := v_total_price - v_total_cost;
  IF v_total_price > 0 THEN
    v_margin_pct := (v_total_profit / v_total_price) * 100;
  END IF;

  -- Create order
  INSERT INTO orders (
    order_number, customer_id, created_by, status,
    commission_split, total_price, total_cost, total_profit, total_margin_pct
  ) VALUES (
    v_order_number, p_customer_id, p_performed_by, 'confirmed',
    p_commission_split, v_total_price, v_total_cost, v_total_profit, v_margin_pct
  ) RETURNING id INTO v_order_id;

  -- Insert items
  INSERT INTO order_items (
    order_id, product_id, sort_order, notes,
    price_per_unit, current_cost, actual_rate, rate_unit,
    oz_per_acre, price_per_acre, acres,
    total_units_needed, unit_size, profit, total_price, net_margin
  )
  SELECT
    v_order_id,
    (item->>'product_id')::uuid,
    row_number() OVER (),
    item->>'notes',
    (item->>'price_per_unit')::numeric,
    (item->>'current_cost')::numeric,
    (item->>'actual_rate')::numeric,
    item->>'rate_unit',
    (item->>'oz_per_acre')::numeric,
    (item->>'price_per_acre')::numeric,
    (item->>'acres')::numeric,
    (item->>'total_units_needed')::numeric,
    (item->>'unit_size')::numeric,
    (item->>'profit')::numeric,
    (item->>'total_price')::numeric,
    (item->>'net_margin')::numeric
  FROM jsonb_array_elements(p_items) AS item;

  -- Create commission records (with recipient_user_id lookup)
  IF p_commission_split IS NOT NULL AND p_commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, recipient_user_id, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, p_customer_id,
      s->>'recipient',
      (SELECT id FROM profiles WHERE full_name = s->>'recipient' LIMIT 1),
      (s->>'percentage')::numeric,
      v_total_profit * ((s->>'percentage')::numeric / 100),
      v_total_profit,
      current_date,
      'pending'
    FROM jsonb_array_elements(p_commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || v_order_number || ' created',
    p_performed_by, 'order', v_order_id, p_customer_id
  );

  RETURN jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number
  );
END;
$$;
