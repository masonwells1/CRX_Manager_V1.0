-- ============================================================================
-- APPLIED LIVE 2026-07-02 (structure-fix loop, Wave A / A13) via gated MCP apply_migration
-- with Mason's explicit OK. Reviewers rls-security + migration-drift = CLEAN; live pre-apply
-- confirmed exactly ONE 8-arg overload so the single DROP sufficed; verified live post-apply:
-- exactly 1 overload (the 10-arg), SECDEF + search_path, ACL authenticated (no anon).
-- caller-analysis: manual_inventory_add :: the only live caller is the UI rpc at
--   src/pages/InventoryPage.tsx (runs as an authenticated user). The REVOKEs strip only
--   PUBLIC/anon; authenticated EXECUTE is re-GRANTed, so that callsite is unaffected. The
--   DROP+CREATE re-establishes the sole overload with the identical ACL (authenticated +
--   service_role). No other in-DB / cron caller (leaf function).
--
-- WHAT: manual_inventory_add gains two optional params — p_reorder_point and
--       p_min_stock_level — written into the new inventory row on creation.
-- WHY:  Today the Add-Inventory flow can only set qty/unit/cost; a new inventory
--       row is stuck at reorder_point = 0 / min_stock_level = 0 (column defaults).
--       The reorder-alert panel + "Needs Reorder" filter (is_low_stock) therefore
--       stay empty because nobody sets a reorder point at creation, and the only way
--       to set it (an inline-edit column) is admin-only + undiscoverable. Result:
--       0 of the live inventory rows have a reorder point (the ChemMan Reorder gap, A13).
-- SCOPE: SURGICAL. Body rebuilt VERBATIM from live pg_get_functiondef
--        (manual_inventory_add, sole overload, 8-arg signature) — the ONLY changes are:
--          (1) two new trailing params with DEFAULT NULL (backward compatible: an
--              8-arg call still binds via the defaults), and
--          (2) reorder_point / min_stock_level added to the INSERT INTO inventory,
--              GREATEST(COALESCE(.,0),0) so a NULL/omitted value keeps the column's
--              0 default and a negative can't be stored (cols are NUMERIC NOT NULL DEFAULT 0).
--        DROP + CREATE (not CREATE-OR-REPLACE) because adding params would otherwise
--        create a SECOND overload → "function is not unique" on the existing 8-arg call.
--        DROP removes the old signature; CREATE re-establishes the SOLE overload.
--        Grants re-applied to match the live ACL (authenticated only; anon NOT granted).
--        No other statement changed; strict-actor / role-gate / idempotency untouched.
--
-- SMOKE (2026-07-02, live tx aborted via summary RAISE — NOTHING persisted; live
--   manual_inventory_add unchanged post-run = original 8-arg signature confirmed):
--   after DROP+CREATE exactly ONE overload existed in-tx (overloads_in_tx=1, the 10-arg).
--   plpgsql_check = CLEAN except a single benign extra-warning 'never read variable
--   "v_existing"' — verified IDENTICAL on the live 8-arg function (pre-existing, inherited
--   verbatim from live source; NOT introduced by this change, so left untouched).
-- CODEX (gpt-5.5 xhigh, --uncommitted, this session): CLEAN on the SQL (no dual-overload,
--   grants preserved, body verbatim). R2's only note is the EXPECTED parked-coupling — a
--   frontend deployed AHEAD of this migration that sends p_reorder_point/p_min_stock_level
--   to the live 8-arg fn would 404 the Add. Not a code defect: the two params are optional
--   DEFAULTs, so this migration is BACKWARD-COMPATIBLE.
-- APPLY ORDER: apply this migration FIRST — the live 8-arg callers keep working via the new
--   DEFAULT params (zero-downtime) — THEN merge/deploy the InventoryPage frontend. Never
--   deploy the frontend ahead of this migration.
-- ============================================================================

-- idempotency-body-check: exempt (uses check_idempotency/save_idempotency helpers)

DROP FUNCTION IF EXISTS public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text);

CREATE OR REPLACE FUNCTION public.manual_inventory_add(
  p_product_id      uuid,
  p_location        text,
  p_quantity        numeric,
  p_unit_size       text    DEFAULT NULL::text,
  p_performed_by    uuid    DEFAULT NULL::uuid,
  p_notes           text    DEFAULT NULL::text,
  p_unit_cost       numeric DEFAULT NULL::numeric,
  p_idempotency_key text    DEFAULT NULL::text,
  p_reorder_point   numeric DEFAULT NULL::numeric,
  p_min_stock_level numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing record;
  v_product  record;
  v_note     text;
  v_idemp_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_idemp_existing := check_idempotency(p_idempotency_key, 'manual_inventory_add');
    IF v_idemp_existing IS NOT NULL THEN RETURN v_idemp_existing; END IF;
  END IF;

  SELECT * INTO v_existing
  FROM inventory WHERE product_id = p_product_id AND location = COALESCE(p_location, 'Main Warehouse');

  IF FOUND THEN
    RAISE EXCEPTION 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.';
  END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  INSERT INTO inventory (product_id, location, quantity_available, unit_size, reorder_point, min_stock_level)
  VALUES (
    p_product_id,
    COALESCE(p_location, 'Main Warehouse'),
    GREATEST(p_quantity, 0),
    COALESCE(p_unit_size, v_product.unit_size),
    GREATEST(COALESCE(p_reorder_point, 0), 0),
    GREATEST(COALESCE(p_min_stock_level, 0), 0)
  );

  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');
  IF p_unit_cost IS NOT NULL AND p_unit_cost > 0 THEN
    v_note := v_note || ' (purchased @ $' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p_unit_cost::text)) || '/unit)';
  END IF;

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

  v_result := jsonb_build_object('success', true);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'manual_inventory_add', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) TO authenticated;
