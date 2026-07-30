-- Quote and customer whole-record lost-update guard (row-version contract).
-- Adds a dedicated monotonic version to each saved record. Existing clients must
-- refresh after rollout; update saves fail closed unless the exact loaded version
-- is supplied. New-record inserts remain token-free.
--
-- Rerun/drift policy: the columns are added only if absent, then asserted to be
-- bigint, NOT NULL, and default 1. The named triggers are deliberately replaced
-- so a prior partial run cannot retain a different trigger body.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;

DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('%I.%I', c.relname, a.attname), ', ')
    INTO v_bad
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relname IN ('quotes', 'customers')
    AND a.attname = 'row_version'
    AND NOT a.attisdropped
    AND (
      a.atttypid <> 'int8'::regtype
      OR NOT a.attnotnull
      OR regexp_replace(
        regexp_replace(pg_get_expr(d.adbin, d.adrelid), '::(pg_catalog\.)?(int8|bigint)', '', 'g'),
        E'[\\s''()]',
        '',
        'g'
      ) <> '1'
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_SCHEMA_DRIFT: % must be bigint NOT NULL DEFAULT 1', v_bad;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.bump_record_row_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$function$;

-- Trigger-only helper: default privileges in this project grant new public
-- functions to API roles, so strip every callable application role explicitly.
-- Trigger execution does not require callers to hold EXECUTE on the helper.
REVOKE ALL ON FUNCTION public.bump_record_row_version() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS quotes_bump_row_version ON public.quotes;
CREATE TRIGGER quotes_bump_row_version
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.bump_record_row_version();

DROP TRIGGER IF EXISTS customers_bump_row_version ON public.customers;
CREATE TRIGGER customers_bump_row_version
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.bump_record_row_version();

-- Quote/customer editors replace their child collections only inside the
-- parent-locking SECURITY DEFINER save RPCs below. Direct child DML let an
-- authenticated tab evade the parent row_version and later be overwritten by
-- a whole-record save. Do not use child->parent bump triggers here: save_quote
-- and save_customer already lock parent then manage children, so the inverse
-- child->parent lock order would introduce a deadlock path.
--
-- SELECT stays available to the current authenticated readers; service_role
-- and the migration owner retain their existing direct maintenance access.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.quote_sections FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.quote_items FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.customer_addresses FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.save_quote(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_section_id uuid;
  v_item jsonb;
  v_section jsonb;
  v_status text;
  v_old_status text;
  v_old_commission_split jsonb;
  v_old_row_version bigint;
  v_expected_row_version bigint;
  v_tier int;
  v_server_totals record;
  v_drawn_guard record;
  v_allowed_transitions jsonb := '{
    "draft": ["sent"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"]
  }'::jsonb;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role IN ('admin','sales_rep') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- LAYER2-COORD (#5): lock the quote row up front (FOR UPDATE) so the unplan
    -- guard's job_product_draws check below can't be raced by a concurrent job
    -- schedule (_sync_quote_job_reservations locks the same row FOR UPDATE, so
    -- the two serialize). Was: SELECT status ... WHERE id = p_quote_id;
    SELECT status, commission_split, row_version
      INTO v_old_status, v_old_commission_split, v_old_row_version
    FROM quotes WHERE id = p_quote_id FOR UPDATE;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    -- Lost-update guard (2026-07-22): when the client passes the split it
    -- originally loaded (commission_split_expected), reject a split overwrite
    -- if a different value landed in between (stale-tab last-write-wins).
    -- Callers that omit commission_split_expected behave exactly as before.
    IF p_quote_payload ? 'commission_split_expected'
       AND p_quote_payload->'commission_split' IS NOT NULL
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_quote_payload->'commission_split_expected', 'null'::jsonb)
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM p_quote_payload->'commission_split' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this quote''s commission split was changed elsewhere after you opened it — reload the quote and re-apply your change';
    END IF;

    IF NOT (p_quote_payload ? 'row_version_expected')
       OR jsonb_typeof(p_quote_payload->'row_version_expected') <> 'number'
       OR (p_quote_payload->>'row_version_expected') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;
    v_expected_row_version := (p_quote_payload->>'row_version_expected')::bigint;
    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;

    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    -- LAYER2<<< block unplanning a booking a scheduled job is still drawing from
    -- (Codex final push-gate P1 #1): if is_planned would become false while a live
    -- job_product_draws row exists for this quote, the UPDATE below + trailing
    -- _sync_planned_holds release the quote's crop_program holds, and the next job
    -- re-sync drops the draw (quote no longer planned-open) — reopening the full
    -- booking balance while the job still consumes the stock (double-count). Clear the
    -- job reservation via the job lifecycle (cancel/reschedule) before unplanning.
    IF COALESCE((p_quote_payload->>'is_planned')::boolean,
                (SELECT is_planned FROM quotes WHERE id = p_quote_id)) = false
       AND EXISTS (
         SELECT 1 FROM job_product_draws
         WHERE quote_id = p_quote_id AND quantity_drawn > 0
       ) THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB_RESERVATION: cannot unplan this booking — a scheduled job is still reserving product from it; cancel or reschedule the job first';
    END IF;
    -- >>>LAYER2

    v_quote_id := p_quote_id;

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft';
    END IF;

    INSERT INTO quotes (
      id, quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit, total_margin_pct,
      valid_days, expires_at, header_notes, footer_notes, is_planned, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      'draft',
      COALESCE(p_quote_payload->'commission_split', '{"splits":[]}'::jsonb),
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::int, 15),
      COALESCE((p_quote_payload->>'expires_at')::date, current_date + 15),
      p_quote_payload->>'header_notes',
      p_quote_payload->>'footer_notes',
      COALESCE((p_quote_payload->>'is_planned')::boolean, false),
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes,
      section_header_notes, needed_by_date, field_id
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      NULLIF(v_section->>'needed_by_date', '')::date,
      NULLIF(v_section->>'field_id', '')::uuid
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        id, quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, price_override, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit
      ) VALUES (
        gen_random_uuid(),
        v_quote_id,
        v_section_id,
        (v_item->>'product_id')::uuid,
        COALESCE((v_item->>'sort_order')::int, 0),
        v_item->>'notes',
        COALESCE((v_item->>'price_per_unit')::numeric, 0),
        (v_item->>'price_override')::numeric,
        COALESCE((v_item->>'current_cost')::numeric, 0),
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        COALESCE((v_item->>'profit')::numeric, 0),
        COALESCE((v_item->>'total_price')::numeric, 0),
        COALESCE((v_item->>'net_margin')::numeric, 0),
        COALESCE(v_item->>'calc_mode', 'rate_acres'),
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
      COALESCE(qi.price_override, CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END) AS ppu,
      COALESCE(p.current_cost, 0) AS cc,
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(COALESCE(p.inventory_unit, p.unit_size, 'Ea'))
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      calc_mode,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'rate_acres'
          THEN ROUND(ar * rate_oz, 2)
        ELSE 0
      END AS oz_per_acre,
      CASE
        WHEN calc_mode = 'units_direct' THEN ROUND(client_units, 2)
        WHEN inv_oz > 0 THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0
      END AS total_units,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'rate_acres' AND inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0
      END AS price_per_acre
    FROM base
  ),
  final AS (
    SELECT
      item_id,
      ppu,
      cc,
      oz_per_acre,
      total_units,
      price_per_acre,
      ROUND(ppu * total_units, 2) AS total_price,
      ROUND((ppu - cc) * total_units, 2) AS profit,
      CASE
        WHEN ppu * total_units > 0
          THEN ROUND(((ppu - cc) * total_units) / (ppu * total_units) * 100, 2)
        ELSE 0
      END AS net_margin
    FROM calc
  )
  UPDATE quote_items qi SET
    price_per_unit = f.ppu,
    current_cost = f.cc,
    oz_per_acre = f.oz_per_acre,
    total_units_needed = f.total_units,
    price_per_acre = f.price_per_acre,
    total_price = f.total_price,
    profit = f.profit,
    net_margin = f.net_margin
  FROM final f
  WHERE qi.id = f.item_id;

  -- LAYER2<<< drawn-product guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1):
  -- a line can't be reduced below what an order OR a scheduled job already drew from it.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = v_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot remove % — % already drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot reduce % below its already-drawn % (new total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;

  SELECT
    COALESCE(SUM(total_price), 0) AS total_price,
    COALESCE(SUM(current_cost * total_units_needed), 0) AS total_cost,
    COALESCE(SUM(profit), 0) AS total_profit
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  -- One logical save must produce exactly one quote UPDATE. The row was
  -- already locked and its expected version checked before any children were
  -- replaced; combining header/status fields with the calculated totals keeps
  -- that lock order while ensuring the row-version trigger advances once.
  UPDATE quotes SET
    customer_id = (p_quote_payload->>'customer_id')::uuid,
    tier = v_tier,
    status = v_status,
    commission_split = CASE
      WHEN p_quote_payload->'commission_split' IS NOT NULL
      THEN p_quote_payload->'commission_split'
      ELSE commission_split
    END,
    valid_days = COALESCE((p_quote_payload->>'valid_days')::int, valid_days),
    expires_at = COALESCE((p_quote_payload->>'expires_at')::date, expires_at),
    header_notes = p_quote_payload->>'header_notes',
    footer_notes = p_quote_payload->>'footer_notes',
    is_planned = COALESCE((p_quote_payload->>'is_planned')::boolean, is_planned),
    sent_at = CASE
      WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
      WHEN v_status = 'sent' THEN sent_at
      ELSE sent_at
    END,
    total_price = v_server_totals.total_price,
    total_cost = v_server_totals.total_cost,
    total_profit = v_server_totals.total_profit,
    total_margin_pct = CASE
      WHEN v_server_totals.total_price > 0
      THEN ROUND(v_server_totals.total_profit / v_server_totals.total_price * 100, 2)
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  INSERT INTO activity_feed (id, event_type, description, performed_by, related_entity_type, related_entity_id, created_at)
  VALUES (
    gen_random_uuid(),
    CASE WHEN p_quote_id IS NOT NULL THEN 'quote_updated' ELSE 'quote_created' END,
    'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' saved',
    v_actor,
    'quote',
    v_quote_id,
    now()
  );

  -- LAYER2-COORD (#4): re-sync this quote's ACTIVE jobs to the edited booking,
  -- then resync crop_program holds. _sync_quote_job_reservations rebuilds every
  -- active job's draws+holds (so a grown line re-draws its job, a shrunk line
  -- reallocates siblings) and ends by calling _sync_planned_holds itself, so it
  -- is a strict superset of the prior trailing `_sync_planned_holds(v_quote_id)`
  -- (identical for a quote with no jobs). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(v_quote_id, v_actor);

  v_result := jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    'commission_split', (SELECT commission_split FROM quotes WHERE id = v_quote_id),
    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id),
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_customer(p_customer_id uuid, p_customer_payload jsonb, p_addresses jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_incoming_ids uuid[];
  v_result jsonb;
  v_existing jsonb;
  v_cached_customer_id uuid;
  v_old_commission_split jsonb;
  v_old_row_version bigint;
  v_expected_row_version bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor
    AND is_active = true
    AND role IN ('admin', 'sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Ownership gates run BEFORE the idempotency early-return (Codex P2, 2026-07-17):
  -- check_idempotency is not actor/customer-scoped, so a cached result must never
  -- be released to an actor the gates below would reject.
  IF v_actor_role <> 'admin' THEN
    IF v_is_new THEN
      -- Mirrors customers_insert WITH CHECK: a sales rep may only create
      -- customers assigned to themselves; NULL/absent is rejected too.
      IF (p_customer_payload->>'assigned_sales_rep')::uuid IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'REP_MUST_SELF_ASSIGN';
      END IF;
    ELSE
      -- Mirrors customers_update USING: non-admin actors may only update
      -- customers assigned to them. FOR UPDATE holds the row lock through the
      -- customer/address DML so a concurrent reassignment can't slip between
      -- this check and the UPDATE.
      IF NOT EXISTS (
        SELECT 1 FROM customers
        WHERE id = p_customer_id
          AND assigned_sales_rep = v_actor
        FOR UPDATE
      ) THEN
        RAISE EXCEPTION 'NOT_CUSTOMER_OWNER';
      END IF;
      -- Mirrors customers_update WITH CHECK: a rep may not hand the customer to
      -- someone else (absent key leaves the column untouched, which is fine).
      IF p_customer_payload ? 'assigned_sales_rep'
         AND (p_customer_payload->>'assigned_sales_rep')::uuid IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'REP_CANNOT_REASSIGN';
      END IF;
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_customer');
    IF v_existing IS NOT NULL THEN
      -- Bind the replay to the cached target (Codex r2, 2026-07-17):
      -- check_idempotency is scoped only by key+operation, so the cached result
      -- must name the same customer as this request and still pass ownership
      -- before it is released (same pattern as save_purchase_order's replay).
      v_cached_customer_id := NULLIF(v_existing->>'customer_id', '')::uuid;
      IF v_cached_customer_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_CUSTOMER_RESULT_INVALID';
      END IF;
      IF p_customer_id IS NOT NULL
         AND p_customer_id IS DISTINCT FROM v_cached_customer_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF v_actor_role <> 'admin' AND NOT EXISTS (
        SELECT 1 FROM customers
        WHERE id = v_cached_customer_id
          AND assigned_sales_rep = v_actor
      ) THEN
        RAISE EXCEPTION 'NOT_CUSTOMER_OWNER';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  IF p_customer_payload ? 'default_commission_split'
     AND p_customer_payload->'default_commission_split' IS NOT NULL
     AND p_customer_payload->'default_commission_split' <> 'null'::jsonb THEN
    PERFORM public.validate_commission_split_json(p_customer_payload->'default_commission_split');
  END IF;

  IF v_is_new THEN
    INSERT INTO customers (
      farm_name, contact_name, phone, email, billing_address,
      assigned_tier, assigned_sales_rep, total_acres, corn_acres,
      soybean_acres, other_acres, payment_terms,
      default_commission_split, notes, is_active,
      parent_customer_id, credit_limit_cents,
      finance_charge_rate, finance_charge_enabled, finance_charge_grace_days,
      default_application_service_id
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
        THEN (p_customer_payload->'default_commission_split') ELSE NULL END,
      NULLIF(p_customer_payload->>'notes', ''),
      COALESCE((p_customer_payload->>'is_active')::boolean, true),
      (p_customer_payload->>'parent_customer_id')::uuid,
      COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0),
      COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0),
      COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true),
      COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0),
      (p_customer_payload->>'default_application_service_id')::uuid
    ) RETURNING id INTO v_customer_id;
  ELSE
    v_customer_id := p_customer_id;

    -- Lost-update guard (2026-07-22): lock the row and compare the stored split
    -- against the value the client loaded (default_commission_split_expected)
    -- before allowing a split overwrite from a stale tab. Callers that omit
    -- default_commission_split_expected behave exactly as before.
    SELECT default_commission_split, row_version
      INTO v_old_commission_split, v_old_row_version
    FROM customers WHERE id = v_customer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;
    IF p_customer_payload ? 'default_commission_split_expected'
       AND p_customer_payload ? 'default_commission_split'
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_customer_payload->'default_commission_split_expected', 'null'::jsonb)
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM p_customer_payload->'default_commission_split' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this customer''s default commission split was changed elsewhere after you opened it — reload the page and re-apply your change';
    END IF;

    IF NOT (p_customer_payload ? 'row_version_expected')
       OR jsonb_typeof(p_customer_payload->'row_version_expected') <> 'number'
       OR (p_customer_payload->>'row_version_expected') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'CUSTOMER_STALE_WRITE: customer changed after this page opened — reload to review the current customer before saving';
    END IF;
    v_expected_row_version := (p_customer_payload->>'row_version_expected')::bigint;
    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN
      RAISE EXCEPTION 'CUSTOMER_STALE_WRITE: customer changed after this page opened — reload to review the current customer before saving';
    END IF;

    UPDATE customers SET
      farm_name = COALESCE(p_customer_payload->>'farm_name', farm_name),
      contact_name = CASE WHEN p_customer_payload ? 'contact_name' THEN NULLIF(p_customer_payload->>'contact_name', '') ELSE contact_name END,
      phone = CASE WHEN p_customer_payload ? 'phone' THEN NULLIF(p_customer_payload->>'phone', '') ELSE phone END,
      email = CASE WHEN p_customer_payload ? 'email' THEN NULLIF(p_customer_payload->>'email', '') ELSE email END,
      billing_address = CASE WHEN p_customer_payload ? 'billing_address' THEN NULLIF(p_customer_payload->>'billing_address', '') ELSE billing_address END,
      assigned_tier = CASE WHEN p_customer_payload ? 'assigned_tier' THEN COALESCE((p_customer_payload->>'assigned_tier')::integer, 1) ELSE assigned_tier END,
      assigned_sales_rep = CASE WHEN p_customer_payload ? 'assigned_sales_rep' THEN (p_customer_payload->>'assigned_sales_rep')::uuid ELSE assigned_sales_rep END,
      total_acres = CASE WHEN p_customer_payload ? 'total_acres' THEN (p_customer_payload->>'total_acres')::numeric ELSE total_acres END,
      corn_acres = CASE WHEN p_customer_payload ? 'corn_acres' THEN (p_customer_payload->>'corn_acres')::numeric ELSE corn_acres END,
      soybean_acres = CASE WHEN p_customer_payload ? 'soybean_acres' THEN (p_customer_payload->>'soybean_acres')::numeric ELSE soybean_acres END,
      other_acres = CASE WHEN p_customer_payload ? 'other_acres' THEN (p_customer_payload->>'other_acres')::numeric ELSE other_acres END,
      payment_terms = CASE WHEN p_customer_payload ? 'payment_terms' THEN NULLIF(p_customer_payload->>'payment_terms', '') ELSE payment_terms END,
      default_commission_split = CASE WHEN p_customer_payload ? 'default_commission_split' THEN (p_customer_payload->'default_commission_split') ELSE default_commission_split END,
      notes = CASE WHEN p_customer_payload ? 'notes' THEN NULLIF(p_customer_payload->>'notes', '') ELSE notes END,
      is_active = COALESCE((p_customer_payload->>'is_active')::boolean, is_active),
      parent_customer_id = CASE WHEN p_customer_payload ? 'parent_customer_id' THEN (p_customer_payload->>'parent_customer_id')::uuid ELSE parent_customer_id END,
      credit_limit_cents = CASE WHEN p_customer_payload ? 'credit_limit_cents' THEN COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0) ELSE credit_limit_cents END,
      finance_charge_rate = CASE WHEN p_customer_payload ? 'finance_charge_rate' THEN COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0) ELSE finance_charge_rate END,
      finance_charge_enabled = CASE WHEN p_customer_payload ? 'finance_charge_enabled' THEN COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true) ELSE finance_charge_enabled END,
      finance_charge_grace_days = CASE WHEN p_customer_payload ? 'finance_charge_grace_days' THEN COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0) ELSE finance_charge_grace_days END,
      default_application_service_id = CASE WHEN p_customer_payload ? 'default_application_service_id' THEN (p_customer_payload->>'default_application_service_id')::uuid ELSE default_application_service_id END,
      updated_at = now()
    WHERE id = v_customer_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;

    SELECT array_agg((addr->>'id')::uuid) INTO v_incoming_ids
    FROM jsonb_array_elements(COALESCE(p_addresses, '[]'::jsonb)) AS addr
    WHERE addr->>'id' IS NOT NULL;

    DELETE FROM customer_addresses ca
    WHERE ca.customer_id = v_customer_id
      AND (v_incoming_ids IS NULL OR ca.id != ALL(v_incoming_ids))
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_address_id = ca.id);
  END IF;

  IF p_addresses IS NOT NULL AND jsonb_array_length(p_addresses) > 0 THEN
    UPDATE customer_addresses ca SET
      label = COALESCE(addr->>'label', ''),
      address_line = NULLIF(addr->>'address_line', ''),
      city = NULLIF(addr->>'city', ''),
      state = NULLIF(addr->>'state', ''),
      zip = NULLIF(addr->>'zip', ''),
      delivery_notes = NULLIF(addr->>'delivery_notes', ''),
      is_default = COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE ca.id = (addr->>'id')::uuid AND ca.customer_id = v_customer_id;

    INSERT INTO customer_addresses (
      customer_id, label, address_line, city, state, zip, delivery_notes, is_default
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
    WHERE addr->>'id' IS NULL
      AND (COALESCE(addr->>'label', '') != '' OR COALESCE(addr->>'address_line', '') != '');
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'customer_created' ELSE 'customer_updated' END,
    CASE WHEN v_is_new
      THEN 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' created'
      ELSE 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' updated'
    END,
    v_actor, 'customer', v_customer_id, v_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'saved',
    'customer_id', v_customer_id,
    'default_commission_split', (SELECT default_commission_split FROM customers WHERE id = v_customer_id),
    'row_version', (SELECT row_version FROM customers WHERE id = v_customer_id)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_customer', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Self-contained ACL restatement for the two re-emitted SECDEF mutators
-- (matches live 2026-07-22: anon/PUBLIC denied, authenticated + service_role allowed).
REVOKE EXECUTE ON FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.save_customer(uuid, jsonb, jsonb, uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_customer(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;


-- Postflight assertions make a partially-created or shadowed trigger a hard failure.
DO $$
DECLARE
  v_count integer;
  v_distinct_tables integer;
  v_child_table text;
BEGIN
  SELECT count(*), count(DISTINCT c.relname) INTO v_count, v_distinct_tables
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND t.tgname IN ('quotes_bump_row_version', 'customers_bump_row_version')
    AND NOT t.tgisinternal
    AND t.tgfoid = 'public.bump_record_row_version()'::regprocedure
    AND t.tgtype = 19
    AND cardinality(t.tgattr) = 0;
  IF v_count <> 2 OR v_distinct_tables <> 2 THEN
    RAISE EXCEPTION 'ROW_VERSION_TRIGGER_POSTFLIGHT_FAILED: expected 2 row-version triggers, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.oid = 'public.bump_record_row_version()'::regprocedure
      AND p.prosecdef = false
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
        WHERE regexp_replace(setting, '\s+', '', 'g') = 'search_path=public,pg_temp'
      )
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'ROW_VERSION_FUNCTION_POSTFLIGHT_FAILED';
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'save_quote';
  IF v_count <> 1 THEN RAISE EXCEPTION 'ROW_VERSION_QUOTE_OVERLOAD_POSTFLIGHT_FAILED'; END IF;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'save_customer';
  IF v_count <> 1 THEN RAISE EXCEPTION 'ROW_VERSION_CUSTOMER_OVERLOAD_POSTFLIGHT_FAILED'; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure
      AND p.prosecdef
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
        WHERE regexp_replace(setting, '\s+', '', 'g') = 'search_path=public,pg_temp'
      )
  ) THEN
    RAISE EXCEPTION 'ROW_VERSION_QUOTE_SECURITY_POSTFLIGHT_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = 'public.save_customer(uuid,jsonb,jsonb,uuid,text)'::regprocedure
      AND p.prosecdef
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
        WHERE regexp_replace(setting, '\s+', '', 'g') = 'search_path=public,pg_temp'
      )
  ) THEN
    RAISE EXCEPTION 'ROW_VERSION_CUSTOMER_SECURITY_POSTFLIGHT_FAILED';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_customer(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.save_customer(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_customer(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'ROW_VERSION_RPC_ACL_POSTFLIGHT_FAILED';
  END IF;

  -- Browser roles retain the established read boundary but cannot change an
  -- independently-addressable child behind a stable quote/customer token.
  -- service_role and the migration owner retain the prior maintenance path;
  -- save_quote/save_customer are SECURITY DEFINER and therefore continue to
  -- replace children while holding the parent row lock.
  FOREACH v_child_table IN ARRAY ARRAY['quote_sections', 'quote_items', 'customer_addresses'] LOOP
    IF has_table_privilege('authenticated', format('public.%I', v_child_table), 'INSERT')
       OR has_table_privilege('authenticated', format('public.%I', v_child_table), 'UPDATE')
       OR has_table_privilege('authenticated', format('public.%I', v_child_table), 'DELETE')
       OR has_table_privilege('anon', format('public.%I', v_child_table), 'INSERT')
       OR has_table_privilege('anon', format('public.%I', v_child_table), 'UPDATE')
       OR has_table_privilege('anon', format('public.%I', v_child_table), 'DELETE') THEN
      RAISE EXCEPTION 'ROW_VERSION_CHILD_DML_ACL_POSTFLIGHT_FAILED: %', v_child_table;
    END IF;

    IF NOT has_table_privilege('authenticated', format('public.%I', v_child_table), 'SELECT')
       OR NOT has_table_privilege('service_role', format('public.%I', v_child_table), 'SELECT, INSERT, UPDATE, DELETE')
       OR NOT has_table_privilege(current_user, format('public.%I', v_child_table), 'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'ROW_VERSION_CHILD_ACCESS_POSTFLIGHT_FAILED: %', v_child_table;
    END IF;
  END LOOP;
END;
$$;
