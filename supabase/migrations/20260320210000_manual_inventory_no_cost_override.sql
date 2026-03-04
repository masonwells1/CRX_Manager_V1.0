-- Migration: Stop manual_inventory_add from overwriting products.current_cost
-- Purpose: Adding old inventory should NOT change the product's pricing cost.
--          The unit cost (if provided) is recorded in the transaction notes only,
--          as an audit trail. products.current_cost stays locked to what you set
--          from supplier price sheets, keeping pricing, margins, COGS, and
--          commissions accurate.
-- ============================================================================

CREATE OR REPLACE FUNCTION manual_inventory_add(
  p_product_id      uuid,
  p_location        text,
  p_quantity        numeric,
  p_unit_size       text    DEFAULT NULL,
  p_performed_by    uuid    DEFAULT NULL,
  p_notes           text    DEFAULT NULL,
  p_unit_cost       numeric DEFAULT NULL   -- kept for audit trail in notes only
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid;
  v_existing record;
  v_product  record;
  v_note     text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Check for existing record
  SELECT * INTO v_existing
  FROM inventory WHERE product_id = p_product_id AND location = COALESCE(p_location, 'Main Warehouse');

  IF FOUND THEN
    RAISE EXCEPTION 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.';
  END IF;

  -- Get product for unit_size fallback
  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  -- Insert inventory record
  INSERT INTO inventory (product_id, location, quantity_available, unit_size)
  VALUES (
    p_product_id,
    COALESCE(p_location, 'Main Warehouse'),
    GREATEST(p_quantity, 0),
    COALESCE(p_unit_size, v_product.unit_size)
  );

  -- NOTE: We intentionally do NOT update products.current_cost here.
  -- The product cost should only change via supplier price sheet updates
  -- or PO receiving. Manual inventory adds are for getting existing stock
  -- into the system, not for repricing the product.

  -- Build the transaction note with cost info for audit trail
  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');
  IF p_unit_cost IS NOT NULL AND p_unit_cost > 0 THEN
    v_note := v_note || ' (purchased @ $' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p_unit_cost::text)) || '/unit)';
  END IF;

  -- Create audit trail (in same transaction)
  IF p_quantity > 0 THEN
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      p_product_id, 'adjusted', p_quantity,
      COALESCE(p_location, 'Main Warehouse'), v_actor,
      v_note
    );
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric) TO authenticated;
