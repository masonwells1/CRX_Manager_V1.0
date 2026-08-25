-- STATUS: PARKED DRAFT - NOT APPLIED
-- Wave A (ordering-cycle review 2026-08-09) — create_direct_order money hardening.
--
-- Closes two confirmed findings on the direct-order seam:
--
--   1. Caller-controlled cost drives the commission basis (HIGH).
--      create_direct_order accepted `unit_cost` from the request payload and used
--      it verbatim, so a sales rep could submit a low cost to inflate the profit
--      that _insert_commissions_for_order turns into their own commission
--      liability. NewOrder.tsx exposes unit cost as an editable field, so this
--      needed no API access. The identical attack was closed on bulk_import_order
--      by 20260806000752_authorize_bulk_import_product_cost; this migration
--      applies the same rule — products.current_cost is authoritative — to the
--      direct-order path.
--
--      Scope note: the review's finding title also named convert_quote_to_order.
--      Its own verifier refuted that half (save_quote overwrites every line's cost
--      and profit from products.current_cost before conversion, so the basis it
--      passes is already server-computed), and the independent Codex triage
--      reached the same narrowing from source. convert_quote_to_order is
--      deliberately NOT touched here.
--
--   2. Non-finite money and quantity values are accepted (HIGH after triage).
--      PostgreSQL numeric accepts 'NaN', 'Infinity' and '-Infinity'. The 2026-08-05
--      review treated this as a publication blocker and it was fixed for
--      bulk_import_order only (20260805220757). On this seam a NaN quantity passes
--      the `<= 0` skip test (NaN <= 0 is false) and NaN compares greater than every
--      finite value, so `CHECK (quantity_prebooked >= 0)` passes too — the value
--      lands in inventory and poisons Net Position for every later quote and order
--      of that product.
--
--      The whole-cent CHECK constraints applied on 2026-08-10 already reject
--      non-finite values on orders.total_cost, orders.total_profit and
--      order_items.profit. Verified against live pg_constraint: they do NOT cover
--      orders.total_price (only `>= 0`, which NaN satisfies), order_items.total_price
--      (no whole-cent constraint at all), inventory.quantity_prebooked (only `>= 0`)
--      or commissions.commission_amount (only `>= 0`). Rejecting at the RPC
--      boundary closes those columns and replaces an opaque constraint violation
--      with an actionable message.
--
-- Also corrected in passing: the two refusal messages raised non-canonical prose
-- ('Actor mismatch', 'Authentication required'). Every other governed RPC raises
-- the canonical ACTOR_MISMATCH / AUTH_REQUIRED tokens, which src/lib/db.ts maps
-- to friendly messages; these two fell through to a generic error instead. Both
-- are now canonical. Verified before changing them: a grep over src/ returns zero
-- matches for either prose string, so no caller or test matched the old text, and
-- hasRpcCode (src/lib/db.ts) matches a leading 'TOKEN:' prefix. The binding logic
-- itself is unchanged — a NULL p_performed_by is still accepted, deliberately,
-- because tightening it to IS DISTINCT FROM would reject the live callers that
-- pass NULL, and that is a behaviour change outside this scope.
--
-- Undeclared-drift notes, recorded so a reviewer need not rediscover them:
--
--   * Per-unit rates are now rounded to 2dp before storage (price_per_unit and
--     cost_per_unit), not only the line totals. This copies the bulk-import
--     precedent exactly (20260806000752:152). Verified against live before
--     adopting it: of the 602 products carrying a current_cost, ZERO hold a
--     sub-cent value, and zero existing order_items rows hold a sub-cent
--     price_per_unit or cost_per_unit. So this is a no-op on all current data and
--     a guard going forward, not a silent re-pricing.
--   * The finiteness checks also reject a negative price or cost. That is broader
--     than "reject NaN and Infinity" and is intentional: a negative unit rate has
--     no meaning on this path and previously wrote silently.
--   * product_name and unit_size now fall back to the catalogue when the caller
--     omits them, instead of writing NULL.
--   * An unknown product_id now raises ITEM_INVALID instead of relying on the FK.
--   * A malformed or negative supplied unit_cost raises even though the value is
--     then discarded. Failing loudly on a payload we cannot interpret is the
--     deliberate choice; silently ignoring garbage is how the original bug hid.
--   * products.is_active is deliberately NOT filtered here, unlike the bulk-import
--     precedent. create_direct_order never read products at all before this
--     change, so adding an active-only filter would newly reject orders for a
--     just-deactivated product. Preserving current behaviour is the safer default;
--     tightening it is a separate decision.
--
-- Behaviour deliberately preserved:
--   * Lines with a NULL product_id or a quantity <= 0 are still skipped silently
--     rather than raising, matching the existing contract the UI relies on.
--   * DELTA-A (commission basis re-read from the canonical order header) and
--     DELTA-C (per-line whole-cent rounding) from 20260810150000 are carried
--     forward unchanged.
--   * A supplied unit_cost is still validated when present, but is never used.
--
-- Products with a NULL current_cost resolve to 0. Verified against live data
-- before choosing that default: exactly one active product has a NULL cost, and
-- every historical order line for it was written at cost 0, so this reproduces
-- current behaviour rather than changing it.

-- Precondition: pin the exact live body this migration expects to replace. The
-- three 2026-08-10 migrations are applied to production, so the body on live is
-- NOT the one an origin/main checkout would rebuild. Without this pin an
-- unconditional CREATE OR REPLACE would silently clobber a change made by a
-- concurrent session against the same function (the known pending-migration
-- overlap trap). md5 read from live pg_proc immediately before writing this file.
-- RETARGETED 2026-08-13 — the pinned body MOVED, it did not change.
--
-- When this file was written, public.create_direct_order held the entire 7692-char
-- body whose md5 is pinned below. A concurrent session has since split that
-- function in two: create_direct_order is now a 441-char SECURITY DEFINER wrapper
-- that declares below-cost operation context via _begin_below_cost_money_write and
-- then delegates to _create_direct_order_below_cost_impl_20260810 — and that impl
-- carries the pinned md5 byte-for-byte, because the split moved the body verbatim.
--
-- So the body this migration rewrites now lives in the impl. Running this file's
-- CREATE OR REPLACE against the WRAPPER would overwrite the delegation with the
-- old inline body and delete the below-cost approval gate the split installed —
-- a money-safety regression far worse than the bug being fixed. The rewrite is
-- therefore applied to the impl, and the wrapper is deliberately left untouched.
DO $precond$
DECLARE
  v_count integer;
  v_md5 text;
  v_impl_src text;
  v_wrapper_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_create_direct_order_below_cost_impl_20260810';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _create_direct_order_below_cost_impl_20260810, found %', v_count;
  END IF;

  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_impl_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_create_direct_order_below_cost_impl_20260810';

  -- ONLY the pinned baseline may proceed. An earlier draft of this file also
  -- accepted any body containing this migration's two marker variables, so that
  -- a re-run could pass as a no-op re-assertion. That was unsafe, and the reason
  -- is worth recording so it is not re-added: a later security or money fix to
  -- this same function would naturally keep both markers, so the structural test
  -- would accept the NEWER body and this file would then overwrite it with its
  -- own older text — silently, and in a SECURITY DEFINER money writer.
  --
  -- The obvious repair is to pin the exact post-apply md5 instead. That hash can
  -- only be obtained by applying, and the catalog stores prosrc verbatim (line
  -- endings included), so writing a locally computed literal here would assert a
  -- value nobody has observed — the exact habit that produced the four refusals
  -- this wave exists to fix.
  --
  -- Carrying the pre-apply hash forward to a postcondition equality check was
  -- also considered and rejected: it only works if the whole migration runs in
  -- one transaction, and that could not be verified from here without applying.
  --
  -- So this migration is deliberately single-shot. It applies against the state
  -- it was written for, and refuses anything else. A refusal writes nothing and
  -- names what to check. Losing re-runnability costs one human diff; getting the
  -- replay test wrong costs a silently reverted money fix.
  --
  -- Read from live 2026-08-13, the pre-apply baseline ALREADY contains
  -- v_canonical_profit (it arrived with the earlier DELTA-A commission-basis
  -- change) and does NOT contain v_norm_items, which this migration introduces.
  -- That is what distinguishes "not yet applied" from "already applied" below.
  IF v_md5 <> 'c761f4c46dc12ea07efd74af5b2ada54' THEN
    IF v_impl_src LIKE '%v_norm_items%' AND v_impl_src LIKE '%v_canonical_profit%' THEN
      RAISE EXCEPTION 'PRECOND: _create_direct_order_below_cost_impl_20260810 already carries this migration''s markers [md5 %], so this looks like a re-run. It is refused on purpose: this file cannot tell its own output apart from its output plus a later fix, and re-applying would discard that fix. If a re-apply is genuinely needed, diff the live body against this file by hand first.', v_md5;
    END IF;
    RAISE EXCEPTION 'PRECOND: _create_direct_order_below_cost_impl_20260810 is not the body this migration was written against [expected md5 c761f4c46dc12ea07efd74af5b2ada54, got %]. It changed after this migration was retargeted — re-diff before applying.', v_md5;
  END IF;

  RAISE NOTICE 'PRECOND: impl matches the pinned pre-apply baseline — first application may proceed';

  -- The wrapper must still exist AND still route here. If a later session
  -- re-inlined the body or pointed create_direct_order at something else, then
  -- patching the impl would fix a function no customer path actually reaches,
  -- and this migration would report success while changing nothing that matters.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_direct_order';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 create_direct_order wrapper, found %', v_count;
  END IF;

  SELECT p.prosrc INTO v_wrapper_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_direct_order';

  IF v_wrapper_src NOT LIKE '%_create_direct_order_below_cost_impl_20260810%' THEN
    RAISE EXCEPTION 'PRECOND: create_direct_order no longer delegates to _create_direct_order_below_cost_impl_20260810, so rewriting the impl would not change what callers reach — re-diff before applying.';
  END IF;

  -- Routing alone is not the property worth protecting. The whole reason this
  -- migration was retargeted onto the impl is that overwriting the wrapper
  -- would have deleted the below-cost approval gate -- so assert the gate
  -- itself, not merely the name it delegates to. A wrapper that still MENTIONED
  -- the impl while having dropped this call would sail past the check above and
  -- leave the gate silently gone.
  --
  -- Read from the live wrapper body while writing this migration: it calls
  -- _begin_below_cost_money_write, which rejects an unknown operation name,
  -- requires a signed-in caller, binds the actor to that caller, requires an
  -- active admin or sales_rep profile, and records the below-cost reason. It is
  -- a real gate, not a blanket authorization, and this migration must not be
  -- applied to a seam where it has gone missing.
  IF v_wrapper_src NOT LIKE '%_begin_below_cost_money_write%' THEN
    RAISE EXCEPTION 'PRECOND: create_direct_order no longer declares below-cost operation context -- _begin_below_cost_money_write is absent from the wrapper body. The approval gate this retarget exists to preserve is already gone; stop and re-diff before applying.';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public._create_direct_order_below_cost_impl_20260810(
  p_customer_id uuid,
  p_order_date date,
  p_order_name text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_customer_po_number text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_order_id uuid;
  v_order_number text;
  v_item jsonb;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_customer record;
  v_cached_result jsonb;
  v_result jsonb;
  v_inv record;
  v_warnings text[] := '{}';
  v_qty numeric;
  v_net_position numeric;
  v_canonical_profit numeric;  -- DELTA-A
  -- WAVE-A
  v_norm_items jsonb := '[]'::jsonb;
  v_product record;
  v_price numeric;
  v_supplied_cost numeric;
  v_cost numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED: sign-in required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must equal auth.uid()';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_direct_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  -- WAVE-A: validate and normalize every line BEFORE any write. Cost is resolved
  -- from the product catalogue here and nowhere else, so no later loop can read a
  -- caller-supplied cost back in.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;

    BEGIN
      v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
      v_price := COALESCE((v_item->>'price_per_unit')::numeric, 0);
      v_supplied_cost := NULLIF(btrim(v_item->>'unit_cost'), '')::numeric;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'ITEM_INVALID: quantity, price, and cost must be valid numbers';
    END;

    -- Finiteness is checked before the `<= 0` skip: NaN <= 0 is false, so a NaN
    -- quantity would otherwise slip past the skip and be written.
    IF v_qty::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'ITEM_INVALID: quantity must be a finite number';
    END IF;
    IF v_price::text IN ('NaN', 'Infinity', '-Infinity') OR v_price < 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: price must be finite and >= 0';
    END IF;
    IF v_supplied_cost IS NOT NULL
       AND (v_supplied_cost::text IN ('NaN', 'Infinity', '-Infinity') OR v_supplied_cost < 0) THEN
      RAISE EXCEPTION 'ITEM_INVALID: supplied unit_cost must be finite and >= 0';
    END IF;

    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT id, product_name, unit_size, current_cost
      INTO v_product
    FROM products
    WHERE id = (v_item->>'product_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_INVALID: product not found: %', v_item->>'product_id';
    END IF;

    -- Authoritative cost. A supplied unit_cost is validated above but discarded.
    v_cost := COALESCE(v_product.current_cost, 0);
    IF v_cost::text IN ('NaN', 'Infinity', '-Infinity') OR v_cost < 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: product current_cost is invalid for %', v_product.product_name;
    END IF;

    v_norm_items := v_norm_items || jsonb_build_object(
      'product_id',     v_item->>'product_id',
      'product_name',   COALESCE(v_item->>'product_name', v_product.product_name),
      'unit_size',      COALESCE(v_item->>'unit_size', v_product.unit_size),
      'quantity',       v_qty,
      'price_per_unit', round(v_price, 2),
      'unit_cost',      round(v_cost, 2)
    );
  END LOOP;

  v_order_number := generate_order_number();

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_norm_items) LOOP
    v_qty := (v_item->>'quantity')::numeric;
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          COALESCE(v_item->>'product_name', 'Unknown product') ||
          ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_norm_items) LOOP
    -- DELTA-C (2026-08-10): round each line to whole cents before accumulating, so
    -- this header matches the canonical rollup formula in trg_recalc_order_totals
    -- (SUM of per-line ROUND(...,2)) instead of summing sub-cent raw products.
    v_total_price := v_total_price
      + ROUND((v_item->>'quantity')::numeric * (v_item->>'price_per_unit')::numeric, 2);
    v_total_cost := v_total_cost
      + ROUND((v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric, 2);
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  INSERT INTO orders (
    order_number, order_name, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes,
    customer_po_number  -- DELTA-2 (create_direct_order_customer_po_param)
  ) VALUES (
    v_order_number, NULLIF(TRIM(COALESCE(p_order_name, '')), ''),
    p_customer_id, 'confirmed',
    v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
    p_order_date,
    NULLIF(TRIM(COALESCE(p_notes, '')), ''),
    NULLIF(TRIM(COALESCE(p_customer_po_number, '')), '')  -- DELTA-2
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_norm_items) LOOP
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id, (v_item->>'product_id')::uuid, v_item->>'product_name',
      (v_item->>'price_per_unit')::numeric,
      (v_item->>'unit_cost')::numeric,
      (v_item->>'quantity')::numeric, v_item->>'unit_size',
      -- DELTA-C (2026-08-10): store whole-cent line money. The BEFORE trigger
      -- _round_money_to_whole_cents normalizes these anyway; rounding here keeps the
      -- value this function believes it wrote identical to the value that lands.
      ROUND((v_item->>'quantity')::numeric * (v_item->>'price_per_unit')::numeric, 2),
      ROUND((v_item->>'quantity')::numeric * (v_item->>'price_per_unit')::numeric, 2)
        - ROUND((v_item->>'unit_cost')::numeric * (v_item->>'quantity')::numeric, 2),
      CASE WHEN (v_item->>'price_per_unit')::numeric > 0
        THEN (((v_item->>'price_per_unit')::numeric - (v_item->>'unit_cost')::numeric)
              / (v_item->>'price_per_unit')::numeric) * 100
        ELSE 0
      END,
      0, (v_item->>'quantity')::numeric
    );
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ((v_item->>'product_id')::uuid, 'Main Warehouse', 0, (v_item->>'quantity')::numeric, 0, v_item->>'unit_size');
    END IF;
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', (v_item->>'quantity')::numeric,
      'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- DELTA-A (2026-08-10): see the matching note in
  -- _convert_quote_to_order_owner_impl. v_total_profit is this function's local
  -- accumulator, computed BEFORE the order_items rows (and therefore the
  -- 20260809230500 triggers) rewrote orders.total_profit. Re-read the header so the
  -- commission basis is the same number the order itself reports.
  SELECT ROUND(COALESCE(o.total_profit, 0), 2)
    INTO v_canonical_profit
    FROM orders o
   WHERE o.id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_canonical_profit,
    v_customer.default_commission_split, p_order_date
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || v_order_number || COALESCE(' (' || NULLIF(TRIM(COALESCE(p_order_name, '')), '') || ')', '') || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text) IS
  'Creates a confirmed order directly. Cost is authoritative from products.current_cost — a caller-supplied unit_cost is validated but never used (Wave A, ordering-cycle review 2026-08-09). Non-finite quantity/price/cost values are rejected at the boundary. Reached only through the public.create_direct_order wrapper, which declares below-cost operation context before delegating here.';

-- Enforce the impl's owner-only reachability instead of only asserting it.
-- Live currently shows its ACL as {postgres=X/postgres}, and CREATE OR REPLACE
-- preserves ACLs, so on today's database every REVOKE below is a no-op. That is
-- precisely why it belongs here: the postcondition raises if any of these roles
-- holds EXECUTE, and an assertion broader than its remedy is a self-aborting
-- migration. Emitting the REVOKE makes the postcondition a check on work this
-- file actually did, rather than a bet on a grant state it never enforced.
--
-- REVOKE is not conditional on the grant existing, and revoking a privilege that
-- was never granted is a documented no-op, so no pg_roles guard is needed for
-- the roles themselves. Supabase always provisions anon/authenticated/
-- service_role; on a bare-Postgres replay these statements would fail on the
-- missing role, which is the correct loud failure for a target that is not this
-- database.
REVOKE ALL ON FUNCTION public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Postcondition: the replacement must not have silently dropped SECURITY DEFINER
-- or the pinned search_path. An ALTER FUNCTION elsewhere can change an attribute
-- without touching the body, so assert on the catalogue rather than the source.
--
-- RETARGETED 2026-08-13. The structural checks follow the body onto the impl,
-- because that is what this migration now writes. The EXECUTE-grant checks stay
-- on the WRAPPER: create_direct_order is the only name PostgREST exposes, so it
-- is the only name an anon grant could actually be reached through. This
-- migration does not touch the wrapper, so those three are "nothing else moved
-- underneath us" checks rather than claims about our own write — and they are
-- worth keeping for exactly that reason, since a concurrent session already
-- reshaped this seam once.
--
-- The impl then gets its own, stricter grant check. It must be reachable from
-- nothing but its owner: any grant there would be a second door into the order
-- writer that skips the wrapper's below-cost approval context entirely.
DO $postcond$
DECLARE
  v_count integer;
  v_secdef boolean;
  v_config text[];
  v_src text;
  v_wrapper_src text;
BEGIN
  -- Overload uniqueness FIRST. A bare SELECT ... INTO over several rows takes an
  -- arbitrary row without erroring, so every check below would silently inspect
  -- the wrong function if a second overload existed. This is also the failure the
  -- signature was written to avoid, so it is worth asserting rather than assuming.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_create_direct_order_below_cost_impl_20260810';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: expected exactly 1 _create_direct_order_below_cost_impl_20260810, found % — a second overload was created', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
    INTO v_secdef, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_create_direct_order_below_cost_impl_20260810';

  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'POSTCOND: _create_direct_order_below_cost_impl_20260810 lost SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTCOND: _create_direct_order_below_cost_impl_20260810 lost its pinned search_path (got %)', v_config;
  END IF;

  -- The security fix itself actually landed. A clobbered or partial apply would
  -- otherwise pass every attribute check above while leaving the caller-supplied
  -- cost in place.
  IF v_src NOT LIKE '%v_norm_items%' THEN
    RAISE EXCEPTION 'POSTCOND: the WAVE-A normalization pass is missing — caller-supplied cost may still be authoritative';
  END IF;
  IF v_src NOT LIKE '%v_canonical_profit%' THEN
    RAISE EXCEPTION 'POSTCOND: DELTA-A (canonical commission basis) was lost by this replacement';
  END IF;

  -- The wrapper must still exist and still route here. Patching an impl that
  -- nothing reaches would let this migration report success while changing
  -- nothing a customer path actually runs.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_direct_order';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: expected exactly 1 create_direct_order wrapper, found %', v_count;
  END IF;

  SELECT p.prosrc INTO v_wrapper_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_direct_order';

  IF v_wrapper_src NOT LIKE '%_create_direct_order_below_cost_impl_20260810%' THEN
    RAISE EXCEPTION 'POSTCOND: create_direct_order no longer delegates to the impl this migration rewrote';
  END IF;

  -- Same reasoning as the matching precondition: delegation by name is not the
  -- property that matters. Re-assert that the wrapper still declares below-cost
  -- operation context, so that a concurrent session which reshaped the wrapper
  -- while this migration was running cannot leave the gate removed behind us.
  IF v_wrapper_src NOT LIKE '%_begin_below_cost_money_write%' THEN
    RAISE EXCEPTION 'POSTCOND: create_direct_order no longer declares below-cost operation context -- _begin_below_cost_money_write is absent from the wrapper body';
  END IF;

  -- CREATE OR REPLACE preserves ACLs, so these should be no-ops — but this is a
  -- SECURITY DEFINER mutator and the B9 incident was exactly an unnoticed anon
  -- grant. Assert it rather than trust it.
  -- Each NAMED-role check is guarded on pg_roles, the same intent the sibling
  -- 20260813060000 already carries. has_function_privilege() RAISES for a role
  -- that does not exist rather than returning false, so an unguarded call turns a
  -- replay target that lacks Supabase's roles into a "role does not exist" abort
  -- instead of a real grant verdict. The PUBLIC checks below are deliberately
  -- left UNGUARDED: PUBLIC is a pseudo-role and never appears in pg_roles, so an
  -- EXISTS guard there would silently skip it forever.
  --
  -- The guard is a CASE, not `EXISTS (...) AND has_function_privilege(...)`.
  -- PostgreSQL does not promise left-to-right evaluation of AND, so the planner
  -- may run the privilege lookup before the existence test and re-raise exactly
  -- the error the guard exists to prevent. CASE is the documented construct with
  -- guaranteed ordering.
  IF CASE
       WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN false
       ELSE has_function_privilege('anon', 'public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     END THEN
    RAISE EXCEPTION 'POSTCOND: anon must not hold EXECUTE on create_direct_order';
  END IF;
  IF has_function_privilege('public', 'public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: PUBLIC must not hold EXECUTE on create_direct_order';
  END IF;
  -- Fail-closed on the positive half: where the `authenticated` role does not
  -- exist the grant genuinely is not held, and that is what this must report.
  IF NOT CASE
       WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN false
       ELSE has_function_privilege('authenticated', 'public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     END THEN
    RAISE EXCEPTION 'POSTCOND: authenticated lost EXECUTE on create_direct_order';
  END IF;

  -- The impl is internal and must be reachable from its owner alone. The REVOKE
  -- above enforces that; these four checks confirm the enforcement landed. Each
  -- one now has a remedy in this same file, which is the difference between a
  -- postcondition and a self-abort.
  IF CASE
       WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN false
       ELSE has_function_privilege('anon', 'public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     END THEN
    RAISE EXCEPTION 'POSTCOND: anon must not hold EXECUTE on _create_direct_order_below_cost_impl_20260810';
  END IF;
  IF CASE
       WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN false
       ELSE has_function_privilege('authenticated', 'public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     END THEN
    RAISE EXCEPTION 'POSTCOND: authenticated must not hold EXECUTE on _create_direct_order_below_cost_impl_20260810 — it would bypass the below-cost wrapper';
  END IF;
  IF CASE
       WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN false
       ELSE has_function_privilege('service_role', 'public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')
     END THEN
    RAISE EXCEPTION 'POSTCOND: service_role must not hold EXECUTE on _create_direct_order_below_cost_impl_20260810 — it would bypass the below-cost wrapper';
  END IF;
  IF has_function_privilege('public', 'public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: PUBLIC must not hold EXECUTE on _create_direct_order_below_cost_impl_20260810';
  END IF;
  -- The four named-role checks above cannot see an explicit grant to any OTHER
  -- role, and such a grant would reach the impl and bypass the wrapper just the
  -- same. Sweep the whole ACL: no grantee other than the owner may hold
  -- EXECUTE. A NULL ACL expands to its default (owner + PUBLIC), so this also
  -- fails closed if the REVOKEs above ever stop leaving an explicit ACL behind.
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl(grantor, grantee, privilege_type, is_grantable)
    WHERE p.oid = 'public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)'::regprocedure
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'POSTCOND: a non-owner role holds EXECUTE on _create_direct_order_below_cost_impl_20260810 — it would bypass the below-cost wrapper';
  END IF;
END;
$postcond$;
