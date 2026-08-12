-- STATUS: PARKED DRAFT - NOT APPLIED
-- Wave A (ordering-cycle review 2026-08-09) — reject NaN / Infinity / -Infinity
-- on every remaining numeric money and quantity column.
--
-- THE DEFECT
-- PostgreSQL `numeric` accepts the special values 'NaN', 'Infinity' and
-- '-Infinity', and they defeat the usual range guards because NaN compares
-- GREATER than every finite number:
--
--     'NaN'::numeric > 0            -> true   (so `CHECK (col >= 0)` passes)
--     'NaN'::numeric <= 0           -> false  (so a `<= 0` skip test is skipped)
--     ROUND('NaN'::numeric, 2) = 'NaN'  -> true (so a rounding CHECK alone passes)
--
-- All three verified against this database on 2026-08-10.
--
-- This is why the six pre-existing non-negativity CHECKs on these tables
-- (chk_commission_amount, chk_inventory_qty_on_order, chk_inventory_qty_prebooked,
-- chk_oi_qty_delivered, chk_oi_qty_remaining, orders_total_price_non_negative)
-- do NOT already cover this. Each is of the form `col >= 0`, which rejects
-- -Infinity but ACCEPTS NaN. Stated explicitly so a later reader does not assume
-- the overlap makes these constraints redundant.
--
-- 20260805220757 closed this at the bulk_import_order boundary, and
-- 20260812010000 closes it at the create_direct_order boundary. Both are
-- per-RPC. The columns themselves were still unguarded, so any OTHER writer
-- could still land a non-finite value.
--
-- THE CONCRETE REACHABLE HOLE THIS CLOSES
-- save_quote (20260810150500, live md5 386da656846648f4a54523db39d42c97) stores
-- the client-supplied `acres`, `actual_rate` and `price_override` verbatim and
-- its later recompute pass overwrites only price_per_unit, current_cost,
-- oz_per_acre, total_units_needed, price_per_acre, total_price, profit and
-- net_margin — never those three. With calc_mode 'units_direct', an `acres` of
-- 'NaN' is therefore stored raw. Because NaN > 0 is true, the per-acre CASE
-- branches are taken and oz_per_acre / price_per_acre become NaN as well, while
-- total_price and profit stay finite — so the 20260810151000 whole-cent CHECKs
-- never fire and THE SAVE SUCCEEDS, leaving a quote whose per-acre figures are
-- garbage. In 'rate_acres' mode the same input reaches total_price and IS
-- rejected, but as an opaque `violates check constraint` rather than a usable
-- message.
--
-- WHY CONSTRAINTS RATHER THAN EDITING save_quote
-- save_quote is an 18,947-character SECURITY DEFINER function. Guarding the
-- columns is one reviewable statement per column, applies to every writer
-- including the frontend and any future RPC, and cannot be bypassed by adding a
-- caller — the same argument 20260809170800 made for the rounding trigger.
--
-- ERROR-MESSAGE QUALITY, STATED HONESTLY. 20260812010000 adds an actionable
-- ITEM_INVALID at the create_direct_order boundary, and that is the only RPC
-- with such a boundary check. Two other writers get the raw constraint name
-- instead, and no boundary check is added for them here:
--   * save_quote — a NaN payload now aborts the save rather than storing garbage
--     per-acre figures. Fail-closed and correct, but the user sees
--     `violates check constraint "quote_items_acres_finite_chk"` through
--     assertRpcResult.
--   * _update_order_items_impl (20260617123503) — its `IF v_new_qty <= 0 THEN
--     CONTINUE` skip does not catch NaN (NaN <= 0 is false), so a NaN quantity
--     currently flows through and inserts. After this migration it aborts the
--     whole RPC on order_items_total_units_needed_finite_chk.
-- Both are strict improvements over silently storing a meaningless number, and
-- adding matching boundary checks is worthwhile follow-up work — but refusing
-- the write is the part that must not wait on it.
--
-- WHY A CHECK IS THE RIGHT SHAPE HERE, UNLIKE THE BLEND-TICKET CASE
-- 20260812020000 ADDS a rounding trigger precisely to stop a CHECK from
-- aborting a legitimate write. The difference is intent: a sub-cent value is a
-- precision artefact that should be corrected silently, whereas a non-finite
-- value is meaningless and must be refused. Rounding cannot help here —
-- ROUND('NaN',2) is still 'NaN' — so refusing is the only correct behaviour.
--
-- SCOPE — 30 columns, chosen as "every numeric column on these six tables that
-- is not already guarded"
-- 20260810151000 already rejects non-finite values on orders.total_cost,
-- orders.total_profit, order_items.profit, quotes.total_price,
-- quotes.total_profit, quote_items.total_price and quote_items.profit, because
-- its whole-cent predicate carries the same `> '-Infinity' AND < 'Infinity'`
-- bounds clause. Those seven are deliberately NOT re-constrained here.
-- commissions.split_percentage is already covered by accident and is likewise
-- skipped: chk_commission_pct is `>= 0 AND <= 100`, and `NaN <= 100` is FALSE,
-- so it rejects all three non-finite values. quotes.row_version and
-- order_items.cost_at_time_cents are bigint and structurally immune. The five
-- `text` columns that look numeric (quote_items.suggested_rate, unit_size and
-- friends) cannot hold a numeric NaN at all.
--
-- After this migration, quote_items, quotes, orders, order_items, inventory and
-- commissions have NO unguarded numeric column left.
--
-- This adds FINITENESS ONLY. It deliberately does NOT add whole-cent rounding,
-- non-negativity, or any other rule to these columns — several of them
-- legitimately hold sub-cent values (per-unit rates, per-acre rates,
-- percentages) and constraining their precision is a separate decision with
-- different evidence behind it. That is also why the five columns
-- 20260810151000 deferred for dirty sub-cent rows (order_items.total_price,
-- quotes.total_cost, orders.total_price, commissions.commission_amount,
-- commissions.order_profit) can be constrained here: a legacy sub-cent value is
-- finite, so it still passes and those rows stay editable.
--
-- NO EXISTING ROW IS AFFECTED. Every column below was counted on live on
-- 2026-08-10/11 and holds ZERO non-finite values: quote_items (20 rows),
-- quotes (4), orders (65), order_items (288), inventory (117), commissions (35).
-- The constraints are therefore added directly as VALID rather than NOT VALID —
-- there is nothing to grandfather, and a NOT VALID constraint would leave the
-- existing rows permanently unchecked (the trap recorded in the 2026-08-10
-- bigint-cents evaluation). A VALID ADD CONSTRAINT also fails closed: if that
-- zero-dirty-rows claim were wrong, the ALTER aborts rather than corrupting
-- anything. No live row is read for its value, modified, or deleted.
--
-- REQUIRES POSTGRESQL 14+. `'Infinity'::numeric` errors on PG13 and earlier.
-- Not a live concern — the identical literals are already live via
-- 20260810151000 — but it pins the floor for any replay target.

-- Each ADD CONSTRAINT takes ACCESS EXCLUSIVE on its table. The validation scans
-- are trivial at these row counts; the real exposure is lock QUEUEING — an
-- ACCESS EXCLUSIVE request waits behind any open transaction, and every later
-- query on that table then queues behind the waiter, which would stall quoting,
-- ordering and inventory for as long as the blocker lives. With a lock_timeout a
-- contended apply fails fast and is simply retried instead of freezing the app.
--
-- Plain SET, NOT SET LOCAL, and this is deliberate. SET LOCAL outside a
-- transaction block emits `WARNING: SET LOCAL can only be used in transaction
-- blocks` and is then silently discarded — verified empirically against
-- postgres:17 while building the replay harness for this wave. Whether the
-- applier wraps a migration file in one transaction is an implementation detail
-- of the tool, so relying on it would make the guard above invisibly optional.
-- Plain SET works either way: inside a transaction it is rolled back on abort,
-- outside one it is reset explicitly at the end of this file.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- RE-RUNNABLE BY CONSTRUCTION. PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`,
-- so a bare ADD makes the file one-shot: if the apply were ever interrupted part
-- way — a lock timeout on table four, a dirty row, a dropped connection — the
-- retry would hard-fail on the constraints that DID land, and someone would have
-- to hand-unpick a half-applied schema at exactly the wrong moment. Each ADD is
-- therefore preceded by DROP CONSTRAINT IF EXISTS on the same name. The DROP is a
-- catalogue edit only: it never touches a row, and the ADD that follows one
-- statement later re-validates the same predicate over the same data. This also
-- makes the file safe to replay against a disaster-recovery restore whose dump
-- already carries these constraints.
--
-- CORRECTED CLAIM (security review, 2026-08-10). An earlier draft of this header
-- said there is "no window in which bad data could be written". That overstated
-- it, and contradicted this file's own reasoning about SET vs SET LOCAL directly
-- above — which is that we must NOT assume the applier wraps the file in one
-- transaction. Both cannot be true. Stated accurately:
--   * If the applier DOES wrap the file (the Supabase runner does), every
--     DROP/ADD pair is atomic with the rest and there is genuinely no window.
--   * If it does NOT, a failure landing between a DROP and its ADD — and with
--     lock_timeout at 3s against an ACCESS EXCLUSIVE request, a contended apply
--     failing is a realistic outcome, not a hypothetical — leaves that one
--     column's constraint dropped until the file is re-run.
-- Exposure on the FIRST apply is nil either way, because the DROPs are all no-ops
-- against a database that has never carried these constraints. The window exists
-- only on a retry or a DR replay against a database that already has them, and it
-- closes as soon as the file is re-run. An explicit BEGIN/COMMIT around the 30
-- statements was considered and REJECTED: if the applier already opened a
-- transaction, the inner COMMIT would commit ITS transaction early and silently
-- split the migration, which is a worse failure than the one it would prevent.

-- ---------------------------------------------------------------------------
-- quote_items — the nine columns save_quote can store from client input
-- ---------------------------------------------------------------------------
ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_price_per_unit_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_price_per_unit_finite_chk
  CHECK (price_per_unit IS NULL OR (price_per_unit > '-Infinity'::numeric AND price_per_unit < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_current_cost_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_current_cost_finite_chk
  CHECK (current_cost IS NULL OR (current_cost > '-Infinity'::numeric AND current_cost < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_actual_rate_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_actual_rate_finite_chk
  CHECK (actual_rate IS NULL OR (actual_rate > '-Infinity'::numeric AND actual_rate < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_oz_per_acre_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_oz_per_acre_finite_chk
  CHECK (oz_per_acre IS NULL OR (oz_per_acre > '-Infinity'::numeric AND oz_per_acre < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_price_per_acre_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_price_per_acre_finite_chk
  CHECK (price_per_acre IS NULL OR (price_per_acre > '-Infinity'::numeric AND price_per_acre < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_acres_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_acres_finite_chk
  CHECK (acres IS NULL OR (acres > '-Infinity'::numeric AND acres < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_total_units_needed_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_total_units_needed_finite_chk
  CHECK (total_units_needed IS NULL OR (total_units_needed > '-Infinity'::numeric AND total_units_needed < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_net_margin_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_net_margin_finite_chk
  CHECK (net_margin IS NULL OR (net_margin > '-Infinity'::numeric AND net_margin < 'Infinity'::numeric));

ALTER TABLE public.quote_items DROP CONSTRAINT IF EXISTS quote_items_price_override_finite_chk;
ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_price_override_finite_chk
  CHECK (price_override IS NULL OR (price_override > '-Infinity'::numeric AND price_override < 'Infinity'::numeric));

-- ---------------------------------------------------------------------------
-- quotes — total_price and total_profit already carry whole-cent CHECKs
-- ---------------------------------------------------------------------------
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_total_cost_finite_chk;
ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_total_cost_finite_chk
  CHECK (total_cost IS NULL OR (total_cost > '-Infinity'::numeric AND total_cost < 'Infinity'::numeric));

ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_total_margin_pct_finite_chk;
ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_total_margin_pct_finite_chk
  CHECK (total_margin_pct IS NULL OR (total_margin_pct > '-Infinity'::numeric AND total_margin_pct < 'Infinity'::numeric));

-- ---------------------------------------------------------------------------
-- orders — total_cost and total_profit already carry whole-cent CHECKs.
-- total_price gets finiteness only. It is deliberately NOT whole-cent
-- constrained here, and the reason has just shifted: until 20260812020000, the
-- blocker was that _update_order_items_impl writes the raw un-rounded line sum,
-- so a whole-cent CHECK would have aborted the ordinary order-editing path. Its
-- sibling in this same wave installs trg_orders_round_money, which intercepts
-- exactly that write — so the mechanical blocker is now gone. What remains is
-- that adding the constraint is a separate money decision deferred by
-- 20260810151000 and never approved, and this file adds finiteness only. Left
-- open on purpose, not by oversight.
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_total_price_finite_chk;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_total_price_finite_chk
  CHECK (total_price IS NULL OR (total_price > '-Infinity'::numeric AND total_price < 'Infinity'::numeric));

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_total_margin_pct_finite_chk;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_total_margin_pct_finite_chk
  CHECK (total_margin_pct IS NULL OR (total_margin_pct > '-Infinity'::numeric AND total_margin_pct < 'Infinity'::numeric));

-- ---------------------------------------------------------------------------
-- order_items — profit already carries a whole-cent CHECK.
--
-- acres / actual_rate / suggested_price were missed by the first draft of this
-- migration and added after review. They are the SAME pair this file's own
-- argument is built on for quote_items, on the downstream table that
-- _convert_quote_to_order_owner_impl and bulk_import_order copy quote values
-- into. No frontend writer touches order_items today (every src/ call site on
-- that table is a .select), so this is defense in depth rather than a currently
-- open hole — but leaving the identical pair unguarded one table over would
-- have been an arbitrary line.
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_price_per_unit_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_price_per_unit_finite_chk
  CHECK (price_per_unit IS NULL OR (price_per_unit > '-Infinity'::numeric AND price_per_unit < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_cost_per_unit_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_cost_per_unit_finite_chk
  CHECK (cost_per_unit IS NULL OR (cost_per_unit > '-Infinity'::numeric AND cost_per_unit < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_total_units_needed_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_total_units_needed_finite_chk
  CHECK (total_units_needed IS NULL OR (total_units_needed > '-Infinity'::numeric AND total_units_needed < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_total_price_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_total_price_finite_chk
  CHECK (total_price IS NULL OR (total_price > '-Infinity'::numeric AND total_price < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_net_margin_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_net_margin_finite_chk
  CHECK (net_margin IS NULL OR (net_margin > '-Infinity'::numeric AND net_margin < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_quantity_delivered_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_quantity_delivered_finite_chk
  CHECK (quantity_delivered IS NULL OR (quantity_delivered > '-Infinity'::numeric AND quantity_delivered < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_quantity_remaining_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_quantity_remaining_finite_chk
  CHECK (quantity_remaining IS NULL OR (quantity_remaining > '-Infinity'::numeric AND quantity_remaining < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_actual_rate_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_actual_rate_finite_chk
  CHECK (actual_rate IS NULL OR (actual_rate > '-Infinity'::numeric AND actual_rate < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_acres_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_acres_finite_chk
  CHECK (acres IS NULL OR (acres > '-Infinity'::numeric AND acres < 'Infinity'::numeric));

ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_suggested_price_finite_chk;
ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_suggested_price_finite_chk
  CHECK (suggested_price IS NULL OR (suggested_price > '-Infinity'::numeric AND suggested_price < 'Infinity'::numeric));

-- ---------------------------------------------------------------------------
-- inventory — a NaN here poisons Net Position for every later quote and order
-- of that product, which is the highest-blast-radius case in this migration.
-- reorder_point / min_stock_level were added after review: a NaN in either
-- makes `quantity_available < reorder_point` permanently false, silently
-- disabling the below-reorder alert for that product forever.
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_quantity_available_finite_chk;
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_quantity_available_finite_chk
  CHECK (quantity_available IS NULL OR (quantity_available > '-Infinity'::numeric AND quantity_available < 'Infinity'::numeric));

ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_quantity_prebooked_finite_chk;
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_quantity_prebooked_finite_chk
  CHECK (quantity_prebooked IS NULL OR (quantity_prebooked > '-Infinity'::numeric AND quantity_prebooked < 'Infinity'::numeric));

ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_quantity_on_order_finite_chk;
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_quantity_on_order_finite_chk
  CHECK (quantity_on_order IS NULL OR (quantity_on_order > '-Infinity'::numeric AND quantity_on_order < 'Infinity'::numeric));

ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_reorder_point_finite_chk;
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_reorder_point_finite_chk
  CHECK (reorder_point IS NULL OR (reorder_point > '-Infinity'::numeric AND reorder_point < 'Infinity'::numeric));

ALTER TABLE public.inventory DROP CONSTRAINT IF EXISTS inventory_min_stock_level_finite_chk;
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_min_stock_level_finite_chk
  CHECK (min_stock_level IS NULL OR (min_stock_level > '-Infinity'::numeric AND min_stock_level < 'Infinity'::numeric));

-- ---------------------------------------------------------------------------
-- commissions — what a poisoned profit basis ultimately turns into
-- ---------------------------------------------------------------------------
ALTER TABLE public.commissions DROP CONSTRAINT IF EXISTS commissions_commission_amount_finite_chk;
ALTER TABLE public.commissions
  ADD CONSTRAINT commissions_commission_amount_finite_chk
  CHECK (commission_amount IS NULL OR (commission_amount > '-Infinity'::numeric AND commission_amount < 'Infinity'::numeric));

ALTER TABLE public.commissions DROP CONSTRAINT IF EXISTS commissions_order_profit_finite_chk;
ALTER TABLE public.commissions
  ADD CONSTRAINT commissions_order_profit_finite_chk
  CHECK (order_profit IS NULL OR (order_profit > '-Infinity'::numeric AND order_profit < 'Infinity'::numeric));

-- ---------------------------------------------------------------------------
-- Postcondition
-- ---------------------------------------------------------------------------
DO $postcond$
DECLARE
  -- Parallel arrays: v_tables[i] is the table v_expected[i] must live on.
  -- Checking the table too is the point — a same-named constraint on the wrong
  -- table would otherwise satisfy a name-only lookup.
  v_tables constant text[] := ARRAY[
    'quote_items','quote_items','quote_items','quote_items','quote_items',
    'quote_items','quote_items','quote_items','quote_items',
    'quotes','quotes',
    'orders','orders',
    'order_items','order_items','order_items','order_items','order_items',
    'order_items','order_items','order_items','order_items','order_items',
    'inventory','inventory','inventory','inventory','inventory',
    'commissions','commissions'
  ];
  v_expected constant text[] := ARRAY[
    'quote_items_price_per_unit_finite_chk','quote_items_current_cost_finite_chk',
    'quote_items_actual_rate_finite_chk','quote_items_oz_per_acre_finite_chk',
    'quote_items_price_per_acre_finite_chk','quote_items_acres_finite_chk',
    'quote_items_total_units_needed_finite_chk','quote_items_net_margin_finite_chk',
    'quote_items_price_override_finite_chk',
    'quotes_total_cost_finite_chk','quotes_total_margin_pct_finite_chk',
    'orders_total_price_finite_chk','orders_total_margin_pct_finite_chk',
    'order_items_price_per_unit_finite_chk','order_items_cost_per_unit_finite_chk',
    'order_items_total_units_needed_finite_chk','order_items_total_price_finite_chk',
    'order_items_net_margin_finite_chk','order_items_quantity_delivered_finite_chk',
    'order_items_quantity_remaining_finite_chk','order_items_actual_rate_finite_chk',
    'order_items_acres_finite_chk','order_items_suggested_price_finite_chk',
    'inventory_quantity_available_finite_chk','inventory_quantity_prebooked_finite_chk',
    'inventory_quantity_on_order_finite_chk','inventory_reorder_point_finite_chk',
    'inventory_min_stock_level_finite_chk',
    'commissions_commission_amount_finite_chk','commissions_order_profit_finite_chk'
  ];
  -- The seven pre-existing whole-cent constraints, by literal name. Counting
  -- `LIKE '%_whole_cents_chk'` instead would make this migration un-replayable
  -- the moment an eighth is added — which 20260810151000 explicitly anticipates
  -- once its deferred sub-cent rows are repaired.
  v_whole_cents constant text[] := ARRAY[
    'orders_total_cost_whole_cents_chk','orders_total_profit_whole_cents_chk',
    'order_items_profit_whole_cents_chk','quotes_total_price_whole_cents_chk',
    'quotes_total_profit_whole_cents_chk','quote_items_total_price_whole_cents_chk',
    'quote_items_profit_whole_cents_chk'
  ];
  v_i integer;
  v_found integer;
  v_constraint text;
  v_def text;
  v_col text;
  v_quote_id uuid;
  v_section_id uuid;
  v_product_id uuid;
BEGIN
  -- 1. SEMANTIC PROOF of the predicate itself. This is the part that is easy to
  -- get wrong: the bounds clause is load-bearing precisely because the usual
  -- comparisons do NOT reject these values. Assert PostgreSQL actually behaves
  -- the way this migration assumes, rather than trusting the reasoning.
  IF ('NaN'::numeric > '-Infinity'::numeric AND 'NaN'::numeric < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'POSTCOND: the finiteness predicate does NOT reject NaN on this server';
  END IF;
  IF ('Infinity'::numeric > '-Infinity'::numeric AND 'Infinity'::numeric < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'POSTCOND: the finiteness predicate does NOT reject Infinity on this server';
  END IF;
  IF ('-Infinity'::numeric > '-Infinity'::numeric AND '-Infinity'::numeric < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'POSTCOND: the finiteness predicate does NOT reject -Infinity on this server';
  END IF;
  IF NOT (0::numeric > '-Infinity'::numeric AND 0::numeric < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'POSTCOND: the finiteness predicate wrongly rejects 0';
  END IF;

  -- 2. STRUCTURAL PROOF. Every constraint exists, ON THE NAMED TABLE, and is
  -- VALIDATED — an unvalidated constraint silently exempts the existing rows.
  IF array_length(v_tables, 1) <> array_length(v_expected, 1) THEN
    RAISE EXCEPTION 'POSTCOND: the table and constraint arrays are different lengths (% vs %)',
      array_length(v_tables, 1), array_length(v_expected, 1);
  END IF;

  FOR v_i IN 1 .. array_length(v_expected, 1) LOOP
    SELECT count(*) INTO v_found
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = v_tables[v_i]
      AND c.conname = v_expected[v_i]
      AND c.contype = 'c' AND c.convalidated;

    IF v_found <> 1 THEN
      RAISE EXCEPTION 'POSTCOND: constraint %.% is missing or not validated (found %)',
        v_tables[v_i], v_expected[v_i], v_found;
    END IF;

    -- Existence is not enough. A constraint named quote_items_acres_finite_chk
    -- whose predicate actually guards actual_rate would satisfy every check
    -- above while leaving acres wide open, and nothing in a 30-statement file
    -- makes that copy-paste slip visible by eye. So read the predicate back out
    -- of the catalogue and confirm it names the column its own name claims.
    -- The column is DERIVED from the constraint name (strip the '<table>_'
    -- prefix and the '_finite_chk' suffix) rather than listed in a third
    -- 30-element array, because a third array is one more thing that can drift
    -- out of step with the other two.
    SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = v_tables[v_i]
      AND c.conname = v_expected[v_i]
      AND c.contype = 'c';

    v_col := left(right(v_expected[v_i], -(length(v_tables[v_i]) + 1)), -length('_finite_chk'));

    IF v_def IS NULL
       OR v_def NOT LIKE '%(' || v_col || ' > ''-Infinity''::numeric)%'
       OR v_def NOT LIKE '%(' || v_col || ' < ''Infinity''::numeric)%' THEN
      RAISE EXCEPTION 'POSTCOND: constraint %.% does not guard column % — its live definition is %',
        v_tables[v_i], v_expected[v_i], v_col, COALESCE(v_def, '(could not be read)');
    END IF;
  END LOOP;

  -- 3. The seven pre-existing whole-cent constraints must still be there. This
  -- migration must not have disturbed them.
  --
  -- The table is pinned, not just the name. An earlier draft matched on conname
  -- alone here while sections 1 and 2 of this same postcondition deliberately pin
  -- the table, on the stated grounds that "a same-named constraint on the wrong
  -- table would otherwise satisfy a name-only lookup" — the file failed its own
  -- standard in one of three places (security review, 2026-08-10). Every one of
  -- these names is prefixed with its table, so the table is derived from the name
  -- rather than maintained as a second list that could drift out of step with it.
  FOREACH v_constraint IN ARRAY v_whole_cents LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.conname = v_constraint AND c.convalidated
        AND c.contype = 'c'
        AND v_constraint LIKE t.relname || '\_%'
    ) THEN
      RAISE EXCEPTION 'POSTCOND: whole-cent constraint % from 20260810151000 is missing, no longer validated, or is not a CHECK constraint on the public table its name claims', v_constraint;
    END IF;
  END LOOP;

  -- 4. BEHAVIOURAL PROOF on the actual reachable hole: a quote_items row with a
  -- NaN `acres`, which is exactly what save_quote stores verbatim today.
  --
  -- The row is never committed. If the constraint works, the INSERT raises
  -- check_violation and the implicit savepoint of this EXCEPTION block undoes
  -- it. If the constraint does NOT work, the INSERT succeeds and the assertion
  -- below raises a non-check_violation error, which is not caught here and
  -- aborts the whole migration — rolling the row back with it. There is no path
  -- on which the probe row survives, and no DELETE is required.
  --
  -- SKIPPED, NOT FATAL, on an empty database. The probe needs a real FK triple
  -- to hang the row off. Live has 20 quote_items rows, but the documented
  -- disaster-recovery path replays every post-baseline migration against a
  -- schema-only restore with ZERO rows — and a DR restore is the worst possible
  -- moment for a migration to refuse to replay. The semantic and structural
  -- proofs above do not depend on any data and still run.
  SELECT qi.quote_id, qi.section_id, qi.product_id
    INTO v_quote_id, v_section_id, v_product_id
  FROM public.quote_items qi LIMIT 1;

  IF v_quote_id IS NULL THEN
    RAISE NOTICE 'POSTCOND: no quote_items row available to source FK values from — behavioural probe SKIPPED (semantic and structural proofs still ran)';
  ELSE
    BEGIN
      INSERT INTO public.quote_items (quote_id, section_id, product_id, acres)
      VALUES (v_quote_id, v_section_id, v_product_id, 'NaN'::numeric);

      RAISE EXCEPTION 'POSTCOND: a NaN acres value was ACCEPTED — quote_items_acres_finite_chk is not taking effect';
    EXCEPTION
      WHEN check_violation THEN
        -- Which constraint rejected it matters. Treating any 23514 as proof
        -- would let a future unrelated CHECK on quote_items produce a confident
        -- "NaN correctly rejected" while proving nothing about the NaN guard.
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'quote_items_acres_finite_chk' THEN
          RAISE EXCEPTION 'POSTCOND: the probe row was rejected by % rather than quote_items_acres_finite_chk, so the NaN guard is unproven', COALESCE(v_constraint, '(unnamed constraint)');
        END IF;
        RAISE NOTICE 'POSTCOND: NaN acres correctly rejected by quote_items_acres_finite_chk; probe row rolled back';
    END;
  END IF;
END;
$postcond$;

-- Release the caps set at the top of this file. Plain SET is session-scoped, so
-- without this an applier that reuses its connection would carry a 60s statement
-- timeout into whatever runs next.
RESET statement_timeout;
RESET lock_timeout;
