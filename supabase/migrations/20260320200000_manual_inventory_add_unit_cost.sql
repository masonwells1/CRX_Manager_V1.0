-- Migration: Add optional p_unit_cost parameter to manual_inventory_add
-- Purpose: Allow setting/overriding product unit cost when manually adding inventory
-- (needed for old inventory that was purchased at a different price than current sheet)
-- ============================================================================

CREATE OR REPLACE FUNCTION manual_inventory_add(
  p_product_id      uuid,
  p_location        text,
  p_quantity        numeric,
  p_unit_size       text    DEFAULT NULL,
  p_performed_by    uuid    DEFAULT NULL,
  p_notes           text    DEFAULT NULL,
  p_unit_cost       numeric DEFAULT NULL   -- optional: override product current_cost
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

  -- If a unit cost was provided, update the product's current_cost
  IF p_unit_cost IS NOT NULL AND p_unit_cost > 0 THEN
    IF v_product.current_cost IS DISTINCT FROM p_unit_cost THEN
      INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_reason)
      VALUES (p_product_id, v_actor, v_product.current_cost, p_unit_cost, 'Manual inventory add');
    END IF;
    UPDATE products SET current_cost = p_unit_cost, updated_at = now() WHERE id = p_product_id;
  END IF;

  -- Create audit trail (in same transaction)
  IF p_quantity > 0 THEN
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      p_product_id, 'adjusted', p_quantity,
      COALESCE(p_location, 'Main Warehouse'), v_actor,
      COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units'
        || CASE WHEN p_unit_cost IS NOT NULL THEN ' @ $' || p_unit_cost || '/unit' ELSE '' END)
    );
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric) TO authenticated;
