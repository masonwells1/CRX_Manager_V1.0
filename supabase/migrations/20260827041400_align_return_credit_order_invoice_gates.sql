-- Keep order-level invoice recovery aligned with the return-credit billing
-- predicate used by delivery recovery and the UI. A credit memo reverses a
-- recognized sale; it is not itself proof that the order has been billed.
-- Soft-deleted invoices likewise do not cover the order.
--
-- This file intentionally re-emits both complete private implementations with
-- only one exact guard changed in each body. The preflight aborts on any
-- current-source or contract drift, and the postflight pins the exact resulting
-- bodies and private grants.

DO $cutover_barrier$
DECLARE
  v_cutover_barrier regprocedure := to_regprocedure('public.block_return_credit_during_cogs_cutover()');
BEGIN
  IF v_cutover_barrier IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'block_return_credit_during_cogs_cutover') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_cutover_barrier
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', v_cutover_barrier, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cutover_barrier, 'EXECUTE')
     OR has_function_privilege('service_role', v_cutover_barrier, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = 'public.returns'::regclass
         AND t.tgname = 'aa_crx_block_return_credit_during_cogs_cutover'
         AND NOT t.tgisinternal
         AND t.tgfoid = v_cutover_barrier
     ) THEN
    RAISE EXCEPTION 'RETURN_COGS_CUTOVER_BARRIER_DRIFTED';
  END IF;
END;
$cutover_barrier$;

DO $preflight$
DECLARE
  v_order regprocedure := to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)');
  v_split regprocedure := to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)');
  v_order_old text := E'SELECT COUNT(*) INTO v_existing_count\n    FROM invoices\n   WHERE order_id = p_order_id\n     AND status NOT IN (''voided'', ''cancelled'');';
  v_split_old text := E'SELECT COUNT(*) INTO v_existing_count FROM invoices\n    WHERE order_id = p_order_id AND status NOT IN (''voided'', ''cancelled'');';
BEGIN
  IF v_order IS NULL OR v_split IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_create_invoice_from_order_impl_20260718') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_create_split_invoices_from_order_provenance_impl_20260719') <> 1 THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ORDER_GATE_PREFLIGHT_OVERLOAD_DRIFT';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_order
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '1280d2461c9e79712900a7208fc2fcd760ccd9b4448f7fb3fc89a5523196bfc5'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_order_old, ''))) / length(v_order_old) = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_split
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid[]'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '4e17b8eb18b544ebab5785f88c2346f76528a3a490c0a31b5f765b06db24d351'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_split_old, ''))) / length(v_split_old) = 1
     )
     OR EXISTS (
       SELECT 1 FROM pg_roles r
       WHERE r.rolname IN ('anon','authenticated','service_role')
         AND (has_function_privilege(r.oid, v_order, 'EXECUTE')
              OR has_function_privilege(r.oid, v_split, 'EXECUTE'))
     ) THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ORDER_GATE_PREFLIGHT_CONTRACT_DRIFT';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._create_invoice_from_order_impl_20260718(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_order          record;
  v_invoice_id     uuid;
  v_item           record;
  v_total_cents    bigint := 0;
  v_cost_cents     bigint := 0;
  v_existing       jsonb;
  v_existing_count int;
  v_delivery_count int;
  -- CURRENT_DATE follows the UTC database date, so during the Chicago evening
  -- window this path stamped tomorrow's invoice_date and derived the wrong
  -- season, which moves due dates, aging, overdue classification, and period
  -- boundaries. Resolve one explicit business date and use it for both.
  v_business_date  date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  -- Codex P1: lock the order row FOR UPDATE before the existence checks below.
  -- create_delivery_with_items locks the order while it inserts a delivery; without
  -- this lock the invoice txn could read zero deliveries while a concurrent
  -- scheduled-delivery insert is still uncommitted, then create the order-level
  -- invoice anyway — recreating the exact double-billing this guard prevents.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  SELECT COUNT(*) INTO v_existing_count
    FROM invoices
   WHERE order_id = p_order_id
     AND status NOT IN ('voided', 'cancelled')
     AND invoice_type <> 'credit_memo'
     AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;

  -- W5 (sell-side #4): the order is being fulfilled via deliveries, which each
  -- produce their own invoice on completion — a manual order-level invoice here
  -- would double-represent the order. The check above only catches deliveries
  -- that ALREADY produced an invoice; a still scheduled/in_progress delivery has
  -- none yet, so this closes that gap.
  SELECT COUNT(*) INTO v_delivery_count
    FROM deliveries
   WHERE order_id = p_order_id
     AND status NOT IN ('cancelled', 'voided');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_order_id, v_order.customer_id, p_invoice_type, 'draft',
    COALESCE(v_order.season, compute_season(v_business_date)),
    COALESCE(p_salesman_id, v_order.salesman_id),
    v_actor, 0, v_business_date
  )
  RETURNING id INTO v_invoice_id;

  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id, v_item.id, v_item.product_id,
      COALESCE(v_item.product_name, ''),
      v_item.total_units_needed,
      round(v_item.price_per_unit * 100)::bigint,
      round(v_item.total_price * 100)::bigint,
      round(v_item.cost_per_unit * 100)::bigint,
      COALESCE(v_item.sort_order, 0),
      v_item.actual_rate,
      v_item.acres,
      v_item.unit_size
    );
    v_total_cents := v_total_cents + round(v_item.total_price * 100)::bigint;
    v_cost_cents := v_cost_cents + round(COALESCE(v_item.cost_per_unit, 0) * v_item.total_units_needed * 100)::bigint;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice created from order ' || v_order.order_number
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
    'Invoice created from order ' || v_order.order_number,
    v_actor, 'invoice', v_invoice_id, v_order.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_from_order', jsonb_build_object('invoice_id', v_invoice_id));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing text;
  v_order record;
  v_has_alloc boolean := false;
  v_existing_count int;
  v_delivery_count int;
  v_group_id uuid;
  v_invoice_id uuid;
  v_invoice_ids uuid[] := '{}';
  v_item record;
  v_alloc record;
  v_cust record;
  v_line_cents bigint;
  v_total_acres numeric;
  v_acre_pcts numeric[];
  v_field_cents bigint[];
  v_field_idx int;
  v_owner_ids uuid[];
  v_owner_pcts numeric[];
  v_owner_cents bigint[];
  v_owner_acres numeric;
  v_sum_pct numeric;
  v_oidx int;
  v_total_cents bigint;
  -- per-(customer, line) contribution accumulator; aggregated in pass 2.
  v_rows jsonb := '[]'::jsonb;
  -- Same Chicago business-date resolution as the single-invoice path above:
  -- every invoice minted by this call shares one explicit business date for
  -- both invoice_date and season, instead of the UTC CURRENT_DATE.
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Authorization (mirror create_invoice_from_order): creating invoices is admin/sales_rep only.
  -- The old split path was unreachable (quote_sections.field_id was never persisted), so it had
  -- no gate; making it reachable means it MUST gate here or any authenticated user (driver/applicator)
  -- could mint invoices via this SECURITY DEFINER RPC (Codex P1).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  -- Lock the order FIRST (mirror create_invoice_from_order's Codex-P1 lock): serializes against a
  -- concurrent delivery/invoice insert AND against a same-key retry, so the idempotency replay below
  -- runs only after any in-flight first call on this order has committed.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  -- Canonical operation-scoped idempotency replay, AFTER the order lock (draw_down_quote 2026-06-10
  -- pattern): a racing same-key retry blocks on the lock above, then resumes here and returns the
  -- cached invoice ids — instead of missing the still-uncommitted row pre-lock and then falsely
  -- erroring on the active-invoice guard below (Codex round-3 P2). result is a jsonb string; #>>'{}'
  -- extracts the bare "id1,id2" text so string_to_array sees no surrounding quotes.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_split_invoices_from_order';
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM order_item_field_allocations oifa
    JOIN order_items oi ON oi.id = oifa.order_item_id
    WHERE oi.order_id = p_order_id
  ) INTO v_has_alloc;

  -- No per-line field allocations anywhere on this order -> single invoice (unchanged).
  IF NOT v_has_alloc THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  -- The split path inserts invoices DIRECTLY (the single-invoice path above delegates to
  -- create_invoice_from_order, which carries these guards). Replicate them so an allocated order
  -- that already has an active invoice or an active delivery cannot be double-billed (Codex P1).
  SELECT COUNT(*) INTO v_existing_count FROM invoices
    WHERE order_id = p_order_id AND status NOT IN ('voided', 'cancelled')
     AND invoice_type <> 'credit_memo'
     AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;
  SELECT COUNT(*) INTO v_delivery_count FROM deliveries
    -- U7 SAFE-SCOPE (#43): only an OPEN (scheduled/in_progress) delivery blocks now;
    -- a COMPLETED delivery on a field/acre-allocated order left NO auto-draft to
    -- double against (complete_delivery skipped the mono-bill), so the split can run.
    WHERE order_id = p_order_id AND status IN ('scheduled', 'in_progress');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  -- U7 SAFE-SCOPE (#43, refined R3 P2): this engine bills the WHOLE order (off
  -- order_items.total_price). Block ONLY the partial-delivery-in-progress case — a
  -- delivery has COMPLETED but product still remains — where whole-order billing would
  -- bill undelivered product. A PRE-delivery order (no completed delivery) can still be
  -- invoiced up front (invoice-on-order, like create_invoice_from_order), and a fully
  -- delivered order passes. (Per-delivery split billing would be a larger redesign.)
  IF EXISTS (SELECT 1 FROM deliveries WHERE order_id = p_order_id AND status = 'completed')
     AND EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND COALESCE(quantity_remaining, 0) > 0) THEN
    RAISE EXCEPTION 'Order % is partially delivered — split invoicing bills the whole order and would bill undelivered product. Finish delivering (or void the open deliveries) first.', v_order.order_number;
  END IF;

  -- Split-by-acre needs real line prices: a price-pending order would allocate $0 across fields
  -- (meaningless) and price_order cannot re-split a multi-customer invoice, so the single-invoice
  -- path's "create $0 drafts, sweep later" does not transfer here. Reject EXPLICITLY rather than
  -- silently produce no invoice (Codex round-2 P2). Price the order first, then split.
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND pricing_pending) THEN
    RAISE EXCEPTION 'PRICING_INCOMPLETE: price the order before generating split invoices';
  END IF;

  -- PASS 1: compute every (customer, line) cents + prorated qty into v_rows.
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    v_line_cents := round(v_item.total_price * 100)::bigint;

    IF NOT EXISTS (SELECT 1 FROM order_item_field_allocations WHERE order_item_id = v_item.id) THEN
      -- Unallocated line: bill the whole line (incl. its full acres) to the order's own customer.
      v_rows := v_rows || jsonb_build_object(
        'c', v_order.customer_id, 'oi', v_item.id,
        'cents', v_line_cents, 'qty', COALESCE(v_item.total_units_needed, 0),
        'acres', COALESCE(v_item.acres, 0));
      CONTINUE;
    END IF;

    -- Split the line across its fields BY ACRES (stable order = field_id).
    SELECT sum(acres) INTO v_total_acres
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    SELECT array_agg(acres / v_total_acres * 100 ORDER BY field_id) INTO v_acre_pcts
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    v_field_cents := calculate_billing_splits(v_line_cents, v_acre_pcts);

    v_field_idx := 0;
    FOR v_alloc IN
      SELECT field_id, acres FROM order_item_field_allocations
      WHERE order_item_id = v_item.id ORDER BY field_id
    LOOP
      v_field_idx := v_field_idx + 1;

      -- Owners of this field, or fall back to the field's own customer at 100%.
      IF EXISTS (SELECT 1 FROM field_billing_defaults WHERE field_id = v_alloc.field_id) THEN
        SELECT array_agg(customer_id ORDER BY customer_id),
               array_agg(split_pct ORDER BY customer_id),
               sum(split_pct)
          INTO v_owner_ids, v_owner_pcts, v_sum_pct
          FROM field_billing_defaults WHERE field_id = v_alloc.field_id;
        IF v_sum_pct < 99.99 OR v_sum_pct > 100.01 THEN
          RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: field % billing splits total % (must equal 100)',
            v_alloc.field_id, v_sum_pct;
        END IF;
        -- Normalize to sum EXACTLY 100 (order-preserving) so calculate_billing_splits — which assumes
        -- the percentages total 100 — cannot over-allocate within the tolerance band, e.g. 50.01+50.00
        -- would otherwise floor to MORE than the field's cents (Codex P2). v_owner_ids stays aligned.
        SELECT array_agg(p / v_sum_pct * 100 ORDER BY ord)
          INTO v_owner_pcts FROM unnest(v_owner_pcts) WITH ORDINALITY AS u(p, ord);
      ELSE
        SELECT ARRAY[customer_id] INTO v_owner_ids FROM fields WHERE id = v_alloc.field_id;
        v_owner_pcts := ARRAY[100::numeric];
      END IF;

      -- Split this field's portion among its owners BY split_pct (penny-exact).
      v_owner_cents := calculate_billing_splits(v_field_cents[v_field_idx], v_owner_pcts);

      FOR v_oidx IN 1..array_length(v_owner_ids, 1) LOOP
        -- This owner's slice of THIS field = field acres * their normalized pct. Bill that many
        -- acres to them (so split invoice items carry PRORATED acres, not the line's full acres —
        -- otherwise year-end/RUP acre reports double-count; Codex round-5 P2). qty is prorated by the
        -- same acre-share: well-defined even for a $0 line (v_total_acres > 0 for any allocated line)
        -- and it sums back to the line's total qty across owners.
        v_owner_acres := v_alloc.acres * v_owner_pcts[v_oidx] / 100;
        v_rows := v_rows || jsonb_build_object(
          'c', v_owner_ids[v_oidx], 'oi', v_item.id,
          'cents', v_owner_cents[v_oidx],
          'acres', round(v_owner_acres, 4),
          'qty', round(COALESCE(v_item.total_units_needed, 0) * v_owner_acres / v_total_acres, 4));
      END LOOP;
    END LOOP;
  END LOOP;

  -- A customer whose allocated subtotal is NEGATIVE (a discount line allocated to them exceeds their
  -- charges) cannot become a non-negative invoice; silently skipping them (the outer HAVING > 0 below)
  -- would make the OTHER customers' invoices over-sum the order total — breaking the penny-exact
  -- reconciliation guarantee. Fail loudly instead of mis-billing (Codex round-6 P2). A net-ZERO customer
  -- is safe to skip (contributes 0, reconciliation still holds); only a strictly-negative net is rejected.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
    GROUP BY x.c HAVING sum(x.cents) < 0
  ) THEN
    RAISE EXCEPTION 'SPLIT_NET_NEGATIVE: a customer''s allocated subtotal is negative — cannot create split invoices (adjust the discount/allocation or issue a credit memo)';
  END IF;

  -- PASS 2: one invoice per customer, from the accumulated contributions.
  v_group_id := gen_random_uuid();

  FOR v_cust IN
    SELECT x.c AS customer_id, sum(x.cents) AS cust_total
    FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric)
    GROUP BY x.c
    HAVING sum(x.cents) > 0
    ORDER BY x.c
  LOOP
    INSERT INTO invoices (order_id, customer_id, invoice_type, status, season, salesman_id,
      created_by, total_amount_cents, invoice_date, invoice_group_id, header_notes)
    VALUES (p_order_id, v_cust.customer_id, p_invoice_type, 'draft',
      COALESCE(v_order.season, compute_season(v_business_date)),
      COALESCE(p_salesman_id, v_order.salesman_id), auth.uid(), 0, v_business_date, v_group_id,
      'Split invoice (by field/acre) from order ' || v_order.order_number)
    RETURNING id INTO v_invoice_id;

    v_total_cents := 0;
    FOR v_item IN
      SELECT oi.*, agg.cents AS cust_cents, agg.qty AS cust_qty, agg.acres AS cust_acres
      FROM (
        SELECT x.oi AS order_item_id, sum(x.cents)::bigint AS cents, sum(x.qty) AS qty, sum(x.acres) AS acres
        FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
        WHERE x.c = v_cust.customer_id
        GROUP BY x.oi
        -- Keep a line on the invoice if the customer has ANY contribution to it: non-zero cents
        -- (incl. a negative discount line, so the total reconciles to their net — Codex round-4 P2),
        -- OR non-zero qty/acres (so a legitimate $0 / no-charge product line still carries its product,
        -- quantity and acres for the PDF and year-end usage reports, matching create_invoice_from_order
        -- — Codex round-5 P2). The per-customer (outer) HAVING > 0 still gates which customers get a
        -- (CHECK-non-negative) invoice; a customer whose net is <= 0 is skipped (v1 — a net credit /
        -- a $0-only allocation would need a credit_memo / explicit $0 invoice, out of scope).
        HAVING sum(x.cents) <> 0 OR sum(x.qty) <> 0 OR sum(x.acres) <> 0
      ) agg
      JOIN order_items oi ON oi.id = agg.order_item_id
      ORDER BY oi.sort_order NULLS LAST, oi.id
    LOOP
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, unit_size)
      VALUES (v_invoice_id, v_item.id, v_item.product_id, COALESCE(v_item.product_name, ''),
        v_item.cust_qty, round(v_item.price_per_unit * 100)::bigint, v_item.cust_cents,
        round(v_item.cost_per_unit * 100)::bigint, COALESCE(v_item.sort_order, 0),
        v_item.actual_rate, v_item.cust_acres, v_item.unit_size);
      v_total_cents := v_total_cents + v_item.cust_cents;
    END LOOP;

    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description)
    VALUES ('invoice_created', 'invoice', v_invoice_id,
      COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object('order_number', v_order.order_number, 'group_id', v_group_id,
        'split_basis', 'field_acre'),
      v_total_cents, 'Split invoice (by field/acre) from order ' || v_order.order_number);

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created',
    COALESCE(array_length(v_invoice_ids, 1), 0) || ' split invoices from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  -- U7 SAFE-SCOPE (#43): the order is now split-billed per-owner — clear the
  -- "needs split billing" queue flag complete_delivery set when it skipped the mono-bill.
  UPDATE orders SET needs_split_billing = false, updated_at = now() WHERE id = p_order_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_split_invoices_from_order',
      to_jsonb(array_to_string(v_invoice_ids, ',')));
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

REVOKE ALL ON FUNCTION public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_order regprocedure := 'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'::regprocedure;
  v_split regprocedure := 'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'::regprocedure;
  v_order_new text := E'SELECT COUNT(*) INTO v_existing_count\n    FROM invoices\n   WHERE order_id = p_order_id\n     AND status NOT IN (''voided'', ''cancelled'')\n     AND invoice_type <> ''credit_memo''\n     AND deleted_at IS NULL;';
  v_split_new text := E'SELECT COUNT(*) INTO v_existing_count FROM invoices\n    WHERE order_id = p_order_id AND status NOT IN (''voided'', ''cancelled'')\n     AND invoice_type <> ''credit_memo''\n     AND deleted_at IS NULL;';
  v_order_hash text;
  v_split_hash text;
BEGIN
  SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
    INTO v_order_hash FROM pg_proc p WHERE p.oid = v_order;
  SELECT encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
    INTO v_split_hash FROM pg_proc p WHERE p.oid = v_split;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_order
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '0d6ef022779bd6bc8ef694dab4ce9255053339eeb7d5e79e288d60eba15a6d28'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_order_new, ''))) / length(v_order_new) = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_split
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid[]'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             'ef8ed2b1e60554722eda863c953d997fd992c771f48ad9254f9e95155898df70'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_split_new, ''))) / length(v_split_new) = 1
     )
     OR EXISTS (
       SELECT 1 FROM pg_roles r
       WHERE r.rolname IN ('anon','authenticated','service_role')
         AND (has_function_privilege(r.oid, v_order, 'EXECUTE')
              OR has_function_privilege(r.oid, v_split, 'EXECUTE'))
     ) THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ORDER_GATE_POSTFLIGHT_CONTRACT_DRIFT: order %, split %',
      v_order_hash, v_split_hash;
  END IF;
END;
$postflight$;
