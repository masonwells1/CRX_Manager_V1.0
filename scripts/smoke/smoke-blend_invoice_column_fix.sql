-- ============================================================================
-- ROLLED-BACK smoke test for scripts/.staging-migrations/blend_invoice_column_fix.sql
-- (create_invoice_from_blend_ticket 42703 repair: p.unit_cost -> p.current_cost
--  + p.unit_size / p.rate_unit added to the chem-line join SELECT)
-- ----------------------------------------------------------------------------
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, invoice, share, feed and idempotency row created here is
-- rolled back -- nothing persists. Any other exception text = a real failure.
--
-- Auth: the RPC requires auth.uid() AND (is_admin() OR is_sales_rep()), and
-- additionally asserts p_created_by = auth.uid(). auth.uid() reads
-- request.jwt.claims -- injected below via set_config(..., is_local => true)
-- using a real active admin profile id selected at runtime. Direct fixture
-- INSERTs bypass RLS because we run as the table owner; the RPC under test
-- still enforces its own auth/role gates.
--
-- THE CHAIN (the required scenario): fixture completed+approved blend ticket
-- with one field (10 ac via blend_ticket_fields.actual_acres) and one chem
-- line (rate 2/ac, NO manual price, NO btp-level cost)
--   -> create_invoice_from_blend_ticket
--   -> exactly one 'draft' field_application invoice, ticket payment_status
--      flips to 'billed', share + activity_feed + idempotency rows written,
--      idempotent replay returns the cached result without a second invoice.
--
-- PROOF THE FIXED BRANCH EXECUTES (not just "didn't crash"):
-- the fixture forces the v_chem_qty_b > 0 branch (no field price overrides ->
-- all acreage is "qty_b"), with btp.unit_cost_cents NULL so
--     v_unit_cost := COALESCE(v_btp.unit_cost_cents,
--                             ROUND(COALESCE(v_btp.product_cost,0)*100)::bigint, 0)
-- can ONLY produce 1234 by reading p.current_cost = 12.34 (D1 -- the column
-- the live body misnames unit_cost; pre-fix this loop 42703s before any row).
-- unit_size '2.5 GAL' / rate_unit 'oz/ac' on the item prove the D2 record
-- fields resolve from the joined products row. description must be the
-- PRODUCTS name (not the distinct btp name) -- proves full_product_name comes
-- through the same join. The application-fee branch is provably guarded off:
-- application_service_id is NULL on the fixture ticket.
--
-- Expected money math (bigint cents end to end):
--   qty      = rate 2/ac * 10 share acres            = 20 units
--   price    = tier1 ($10.00 * 100, tier path)       = 1000 c/unit
--   extended = safe_cents_qty(1000, 20)              = 20000
--   cost/u   = ROUND(12.34 * 100)                    = 1234   <- THE FIX
--   inv cost = safe_cents_qty(1234, 20)              = 24680
--
-- Fixture notes (live-catalog-validated):
-- * products: tier1_margin left NULL so trigger calculate_prices_from_margin
--   keeps tier1_price exactly as inserted; product_form NULL so
--   validate_product_units is a no-op.
-- * customers.assigned_tier 1 -> derive_customer_shares_from_fields fallback
--   path (no field_billing_defaults row) yields ONE customer, tier 1, no
--   overrides -> single invoice, invoice_group_id NULL.
-- * blend ticket literals are all in the live CHECK sets: status 'completed',
--   review_status 'approved', payment_status 'unbilled'->'billed',
--   source 'manual'.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin       uuid;
  v_customer_id uuid;
  v_field_id    uuid;
  v_product_id  uuid;
  v_ticket_id   uuid;
  v_invoice_id  uuid;
  v_res         jsonb;
  v_res2        jsonb;
  v_suffix      text := substr(md5(random()::text), 1, 8);
  v_idem        text;
  v_count       int;
  v_pay         text;
  v_inv         record;
  v_item        record;
  v_share       record;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin (runtime-selected, never hardcoded)
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name, assigned_tier)
  VALUES ('[SMOKE] Blend Inv Farm ' || v_suffix, 1)
  RETURNING id INTO v_customer_id;

  INSERT INTO fields (customer_id, field_name, total_acres)
  VALUES (v_customer_id, '[SMOKE] Field ' || v_suffix, 10)
  RETURNING id INTO v_field_id;

  -- current_cost 12.34 DOLLARS = the column the fix points at; tier1_margin
  -- NULL keeps the price trigger from rewriting tier1_price.
  INSERT INTO products (product_name, current_cost, tier1_price, unit_size, rate_unit)
  VALUES ('[SMOKE] Blend Inv Product ' || v_suffix, 12.34, 10, '2.5 GAL', 'oz/ac')
  RETURNING id INTO v_product_id;

  INSERT INTO blend_tickets (
    ticket_number, uploaded_by, customer_id, status, review_status,
    payment_status, season, total_acres, source
  ) VALUES (
    '[SMOKE]-BT-' || v_suffix, v_admin, v_customer_id, 'completed', 'approved',
    'unbilled', current_season(), 10, 'manual'
  ) RETURNING id INTO v_ticket_id;

  INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
  VALUES (v_ticket_id, v_field_id, v_customer_id, 10);

  -- Distinct btp-level product_name so the description assert can tell the
  -- products-join name apart; unit_price_cents / unit_cost_cents left NULL on
  -- purpose (forces the tier-price path and the p.current_cost cost path).
  INSERT INTO blend_ticket_products (
    blend_ticket_id, product_id, product_name, quantity, rate_per_acre, sequence_order
  ) VALUES (
    v_ticket_id, v_product_id, '[SMOKE] BTP ' || v_suffix, 20, 2, 1
  );

  -- --------------------------------------------------------------------
  -- 2. The chain under test
  -- --------------------------------------------------------------------
  v_idem := '[SMOKE]-idem-' || v_suffix;
  v_res := create_invoice_from_blend_ticket(v_ticket_id, v_admin, v_idem);

  IF jsonb_array_length(v_res -> 'invoice_ids') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected exactly 1 invoice id, got %', v_res;
  END IF;
  IF (v_res ->> 'invoice_group_id') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: single-customer ticket must not create a group, got %', v_res;
  END IF;
  v_invoice_id := (v_res -> 'invoice_ids' ->> 0)::uuid;

  -- --------------------------------------------------------------------
  -- 3. Invoice header (status/type per CHECK sets; money = bigint cents)
  -- --------------------------------------------------------------------
  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice row % not found', v_invoice_id;
  END IF;
  IF v_inv.status <> 'draft'
     OR v_inv.invoice_type <> 'field_application'
     OR v_inv.customer_id <> v_customer_id
     OR v_inv.blend_ticket_id <> v_ticket_id
     OR v_inv.total_amount_cents <> 20000
     OR COALESCE(v_inv.total_cost_cents, -1) <> 24680 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice header wrong: status=% type=% total=% cost=%',
      v_inv.status, v_inv.invoice_type, v_inv.total_amount_cents, v_inv.total_cost_cents;
  END IF;

  -- --------------------------------------------------------------------
  -- 4. THE FIXED BRANCH: exactly one chem line whose cost_cents can only
  --    come from p.current_cost (D1) and whose unit_size/rate_unit can only
  --    come from the joined products row (D2).
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM invoice_items WHERE invoice_id = v_invoice_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected exactly 1 invoice item (no fee, no override lines), got %', v_count;
  END IF;

  SELECT * INTO v_item FROM invoice_items WHERE invoice_id = v_invoice_id;
  IF v_item.product_id IS DISTINCT FROM v_product_id
     OR v_item.quantity <> 20
     OR v_item.unit_price_cents <> 1000
     OR v_item.extended_cents <> 20000
     OR v_item.cost_cents <> 1234
     OR v_item.unit_size IS DISTINCT FROM '2.5 GAL'
     OR v_item.rate_unit IS DISTINCT FROM 'oz/ac'
     OR v_item.price_source IS DISTINCT FROM 'tier'
     OR COALESCE(v_item.is_application_fee, false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: chem line wrong: qty=% price=% ext=% cost=% unit_size=% rate_unit=% src=% fee=%',
      v_item.quantity, v_item.unit_price_cents, v_item.extended_cents, v_item.cost_cents,
      v_item.unit_size, v_item.rate_unit, v_item.price_source, v_item.is_application_fee;
  END IF;
  IF v_item.description IS DISTINCT FROM ('[SMOKE] Blend Inv Product ' || v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: description should be the PRODUCTS name via the join, got %', v_item.description;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. Lifecycle: ticket flipped to billed
  -- --------------------------------------------------------------------
  SELECT payment_status INTO v_pay FROM blend_tickets WHERE id = v_ticket_id;
  IF v_pay <> 'billed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blend ticket payment_status=% (expected billed)', v_pay;
  END IF;

  -- --------------------------------------------------------------------
  -- 6. Share + activity feed rows
  -- --------------------------------------------------------------------
  SELECT * INTO v_share FROM invoice_shares WHERE invoice_id = v_invoice_id;
  IF NOT FOUND
     OR v_share.customer_id <> v_customer_id
     OR v_share.amount_cents <> 20000
     OR COALESCE(v_share.acres, -1) <> 10
     OR v_share.split_percentage <> 100.0
     OR v_share.price_per_acre_cents IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice_share wrong: amount=% acres=% split=% ppa=%',
      v_share.amount_cents, v_share.acres, v_share.split_percentage, v_share.price_per_acre_cents;
  END IF;

  SELECT count(*) INTO v_count FROM activity_feed
  WHERE related_entity_type = 'invoice' AND related_entity_id = v_invoice_id
    AND event_type = 'invoice_created' AND performed_by = v_admin;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 invoice_created activity_feed row, got %', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- 7. Idempotency: row persisted; replay returns the cached result and
  --    does NOT raise "already billed" or create a second invoice.
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_count FROM idempotency_keys
  WHERE idempotency_key = v_idem AND operation = 'create_invoice_from_blend_ticket';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency_keys row missing/dup (count=%)', v_count;
  END IF;

  v_res2 := create_invoice_from_blend_ticket(v_ticket_id, v_admin, v_idem);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay returned a different result: % vs %', v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_count FROM invoices WHERE blend_ticket_id = v_ticket_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay created a second invoice (count=%)', v_count;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed -- force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
