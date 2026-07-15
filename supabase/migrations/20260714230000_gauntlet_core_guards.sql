-- Full-gauntlet remediation: replay safety, receiving authorization,
-- commission posting invariants, inventory read authorization, and the final
-- blend-ticket billing idempotency gap.

CREATE OR REPLACE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;

  -- Serialize every transaction using the same key. The lock is intentionally
  -- key-only so same-operation retries replay and cross-operation reuse fails
  -- before either caller can perform business side effects.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key
     AND expires_at < now();

  SELECT *
    INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_key;

  IF FOUND AND v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing.operation, p_operation;
  END IF;

  IF FOUND THEN
    RETURN v_existing.result;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_idempotency(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_idempotency(text, text)
  TO service_role;

-- Some older mutators write idempotency_keys inline instead of using the
-- helper. Their insert happens after business work, so a concurrent loser must
-- raise (rolling back its whole transaction), not silently lose ON CONFLICT and
-- commit duplicate effects. This trigger shares the key-only advisory lock with
-- check_idempotency and protects those legacy callers without re-emitting dozens
-- of unrelated business functions.
CREATE OR REPLACE FUNCTION public._guard_idempotency_key_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_operation text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || NEW.idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = NEW.idempotency_key
     AND expires_at < now();

  SELECT operation
    INTO v_existing_operation
    FROM public.idempotency_keys
   WHERE idempotency_key = NEW.idempotency_key;

  IF FOUND THEN
    IF v_existing_operation IS DISTINCT FROM NEW.operation THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
        NEW.idempotency_key, v_existing_operation, NEW.operation;
    END IF;
    RAISE EXCEPTION
      'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY: operation % with key % completed concurrently; retry to read its saved result',
      NEW.operation, NEW.idempotency_key;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_idempotency_key_insert()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_idempotency_key_insert
  ON public.idempotency_keys;
CREATE TRIGGER guard_idempotency_key_insert
  BEFORE INSERT ON public.idempotency_keys
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_idempotency_key_insert();

CREATE OR REPLACE FUNCTION public.receive_po_items(p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_allow_over_receive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item jsonb; v_po_item RECORD;
  v_existing jsonb; v_result jsonb;
  v_recv_id uuid; v_receiving_record_ids jsonb := '[]'::jsonb;
  v_qty numeric; v_actor uuid; v_actor_role text;
  v_affected_po_ids uuid[] := '{}'; v_unique_po_id uuid;
  v_condition text; v_lot_number text; v_notes text;
  v_storage_location text;
  v_over_receive boolean; v_over_receive_reason text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  SELECT role INTO v_actor_role
    FROM profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items provided for receiving';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'Receiving quantity must be finite';
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'RECEIVING_QUANTITY_MUST_BE_POSITIVE';
    END IF;

    -- PARKED-009 + bug-hunt B2: lock BOTH the po_item AND its parent purchase_order.
    -- Locking poi serializes concurrent receives of the same item; locking po serializes
    -- receive against a concurrent cancel_purchase_order so a cancel can't slip in after
    -- we read po.status but before we increment inventory / roll the status up.
    SELECT poi.*, po.po_number, po.id AS po_parent_id, po.status AS po_status
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'po_item_id')::uuid
     FOR UPDATE OF poi, po;

    IF NOT FOUND THEN RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id'; END IF;

    -- Fail fast on a PO that cannot legitimately be received. draft (never submitted)
    -- and cancelled are the states where a receive today wastefully touches inventory
    -- before the status-transition trigger rejects the roll-up. submitted /
    -- partially_received / fully_received stay receivable (fully_received only via
    -- p_allow_over_receive, preserving the existing over-receive correction path).
    IF v_po_item.po_status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot receive against PO % -- status is % (draft/cancelled cannot be received)',
        v_po_item.po_number, v_po_item.po_status;
    END IF;

    v_over_receive :=
      (COALESCE(v_po_item.quantity_received, 0) + v_qty) > v_po_item.quantity_ordered;
    v_over_receive_reason := NULLIF(btrim(v_item->>'over_receive_reason'), '');

    IF v_over_receive AND NOT COALESCE(p_allow_over_receive, false) THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id, v_po_item.quantity_ordered, COALESCE(v_po_item.quantity_received, 0), v_qty;
    END IF;
    IF v_over_receive AND v_actor_role <> 'admin' THEN
      RAISE EXCEPTION 'OVER_RECEIVE_ADMIN_REQUIRED';
    END IF;
    IF v_over_receive AND v_over_receive_reason IS NULL THEN
      RAISE EXCEPTION 'OVER_RECEIVE_REASON_REQUIRED';
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    IF v_over_receive THEN
      v_notes := concat_ws(' | ', NULLIF(btrim(v_notes), ''), 'OVER-RECEIVE: ' || v_over_receive_reason);
    END IF;
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes)
    VALUES (v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_item.po_parent_id, v_actor,
      concat_ws(
        ' | ',
        'Received ' || v_qty || ' units via PO ' || COALESCE(v_po_item.po_number, ''),
        CASE WHEN v_over_receive
          THEN 'OVER-RECEIVE: ' || v_over_receive_reason
        END
      ));

    INSERT INTO receiving_records (purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size)
    VALUES (v_po_item.po_parent_id, v_po_item.id, v_po_item.product_id,
      v_qty, v_actor, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size)
    RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF NOT v_po_item.po_parent_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_item.po_parent_id;
    END IF;

    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty
    WHERE id = v_po_item.id;
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    -- A large over-receipt on one line must never hide an open line on another.
    -- The PO is fully received only when every individual line is complete.
    IF NOT EXISTS (
      SELECT 1 FROM purchase_order_items
       WHERE purchase_order_id = v_unique_po_id
         AND COALESCE(quantity_received, 0) < quantity_ordered
    ) THEN
      UPDATE purchase_orders SET status = 'fully_received', updated_at = now()
      WHERE id = v_unique_po_id AND status != 'fully_received';
    ELSIF EXISTS (
      SELECT 1 FROM purchase_order_items
       WHERE purchase_order_id = v_unique_po_id
         AND COALESCE(quantity_received, 0) > 0
    ) THEN
      UPDATE purchase_orders SET status = 'partially_received', updated_at = now()
      WHERE id = v_unique_po_id AND status != 'partially_received';
    END IF;
  END LOOP;

  v_result := jsonb_build_object('status', 'received', 'receiving_record_ids', v_receiving_record_ids);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_commission_payment(p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_payment  record;
  v_count    integer;
  v_item_count integer;
  v_item_total numeric;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment FROM commission_payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found';
  END IF;

  IF v_payment.status = 'posted' THEN
    RAISE EXCEPTION 'Commission payment is already posted';
  END IF;
  IF v_payment.status = 'voided' THEN
    RAISE EXCEPTION 'Cannot post a voided commission payment';
  END IF;

  -- Lock and validate the immutable batch snapshot before changing any status.
  PERFORM 1
    FROM commission_payment_items
   WHERE commission_payment_id = p_payment_id
   FOR UPDATE;

  SELECT count(*), COALESCE(sum(amount), 0)
    INTO v_item_count, v_item_total
    FROM commission_payment_items
   WHERE commission_payment_id = p_payment_id;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_EMPTY: commission payment has no items and cannot be posted';
  END IF;
  IF v_item_total IS DISTINCT FROM v_payment.total_amount THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_TOTAL_MISMATCH: item total % does not match header total %',
      v_item_total, v_payment.total_amount;
  END IF;

  PERFORM check_period_open(COALESCE(v_payment.payment_date, CURRENT_DATE));

  UPDATE commission_payments
     SET status = 'posted',
         posted_by = v_actor,
         posted_at = now(),
         updated_at = now()
   WHERE id = p_payment_id;

  UPDATE commissions
     SET status = 'paid',
         paid_date = v_payment.payment_date
   WHERE id IN (
     SELECT commission_id FROM commission_payment_items
     WHERE commission_payment_id = p_payment_id
   )
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): every commission
  -- in this batch must still be 'pending'. If any was cancelled/voided out from under the
  -- batch (or already paid), the count flipped will differ from the batch's item count —
  -- refuse to post the stale batch rather than resurrect a cancelled commission to 'paid'
  -- and pay its retained snapshot. The admin must void and rebuild the batch.
  IF v_count <> v_item_count THEN
    RAISE EXCEPTION 'BATCH_COMMISSION_DRIFT: % of % batched commission(s) are no longer pending (cancelled or already paid). Void and rebuild this commission payment.', (v_item_count - v_count), v_item_count;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_posted', 'commission_payment', p_payment_id,
    v_actor, (v_payment.total_amount * 100)::bigint,
    'Posted commission payment ' || v_payment.payment_number ||
    ' for $' || to_char(v_payment.total_amount, 'FM999,999,990.00') ||
    ' (' || v_count || ' commissions marked paid)'
  );

  v_result := jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_paid',  v_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.post_commission_payment(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_commission_payment(uuid, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_inventory_position()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    v_season_start := DATE_TRUNC('year', CURRENT_DATE)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(poi.quantity_ordered - poi.quantity_received) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ),
    holds AS (
      SELECT ih.product_id,
             SUM(ih.quantity) AS qty,
             -- LAYER2<<< job-type subset broken out as its own column (§4B.2 #1)
             SUM(ih.quantity) FILTER (WHERE ih.hold_type = 'job') AS job_qty
             -- >>>LAYER2
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      -- LAYER2<<< quantity-aware dedup (§4B.2 #2): unreserved remainder per booking line.
      -- Codex A+B round-2 P2: AGGREGATE the booking per (quote, product) FIRST, THEN
      -- subtract the product-level hold/draws ONCE. Subtracting them inside a per-line
      -- SUM over-deducts when a product appears on multiple quote lines (two 50-unit
      -- lines with a 60-unit job draw and no hold would report 0 instead of 40 unreserved).
      SELECT pq.product_id, SUM(pq.remainder) AS qty
      FROM (
        SELECT b.quote_id, b.product_id,
               GREATEST(
                 b.booked
                   - COALESCE(lh.linked_hold, 0)
                   - COALESCE(od.order_drawn, 0)
                   - COALESCE(jd.job_drawn, 0),
                 0) AS remainder
        FROM (
          SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
          FROM quote_items qi
          JOIN quotes q ON q.id = qi.quote_id
          WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
          GROUP BY qi.quote_id, qi.product_id
        ) b
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ih.quantity), 0) AS linked_hold
          FROM inventory_holds ih
          WHERE ih.source_id = b.quote_id
            AND ih.product_id = b.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        ) lh ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(qpd.quantity_drawn), 0) AS order_drawn
          FROM quote_product_draws qpd
          WHERE qpd.quote_id = b.quote_id
            AND qpd.product_id = b.product_id
        ) od ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jpd.quantity_drawn), 0) AS job_drawn
          FROM job_product_draws jpd
          WHERE jpd.quote_id = b.quote_id
            AND jpd.product_id = b.product_id
        ) jd ON true
      ) pq
      GROUP BY pq.product_id
      -- >>>LAYER2
    ),
    delivered_ytd AS (
      SELECT it.product_id, SUM(it.quantity) AS qty
      FROM inventory_transactions it
      WHERE it.transaction_type = 'delivered' AND it.created_at >= v_season_start
      GROUP BY it.product_id
    ),
    base AS (
      SELECT
        p.id AS product_id, p.product_name, p.inventory_unit,
        p.container_size, p.container_type, p.vendor, p.current_cost,
        i.id AS inventory_id, i.location, i.unit_size,
        COALESCE(i.quantity_available, 0) AS quantity_available,
        COALESCE(i.quantity_prebooked, 0) AS quantity_prebooked,
        COALESCE(i.reorder_point, 0) AS reorder_point,
        COALESCE(i.min_stock_level, 0) AS min_stock_level
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.is_active = true
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.product_name), '[]'::jsonb)
    FROM (
      SELECT
        b.inventory_id, b.product_id, b.product_name, b.inventory_unit,
        b.container_size, b.container_type, b.vendor, b.current_cost,
        b.location, b.unit_size,
        b.quantity_available, b.quantity_prebooked,
        COALESCE(oo.qty, 0) AS quantity_on_order,
        COALESCE(h.qty, 0)  AS holds_qty,
        COALESCE(h.job_qty, 0) AS job_holds_qty,   -- LAYER2: new column
        COALESCE(pq.qty, 0) AS planned_qty,
        COALESCE(dy.qty, 0) AS delivered_ytd,
        (b.quantity_available - b.quantity_prebooked + COALESCE(oo.qty, 0)) AS net_position,
        b.reorder_point, b.min_stock_level,
        -- U18 #90: negative on-hand is always a stock problem, reorder_point set or not.
        ((b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) OR b.quantity_available < 0) AS is_low_stock
      FROM base b
      LEFT JOIN on_order       oo ON oo.product_id = b.product_id
      LEFT JOIN holds          h  ON h.product_id  = b.product_id
      LEFT JOIN planned_quotes pq ON pq.product_id = b.product_id
      LEFT JOIN delivered_ytd  dy ON dy.product_id = b.product_id
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_inventory_position()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_position()
  TO authenticated, service_role;

DROP FUNCTION public.update_blend_ticket_billing_status(uuid, text, uuid);

CREATE FUNCTION public.update_blend_ticket_billing_status(
  p_blend_ticket_id uuid,
  p_payment_status text DEFAULT NULL,
  p_performed_by uuid DEFAULT auth.uid(),
  p_idempotency_key text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ticket public.blend_tickets%ROWTYPE;
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(
      p_idempotency_key,
      'update_blend_ticket_billing_status'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing::json;
    END IF;
  END IF;

  SELECT *
    INTO v_ticket
    FROM public.blend_tickets
   WHERE id = p_blend_ticket_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;

  IF p_payment_status = 'billed'
     AND v_ticket.order_link_status = 'unlinked'
     AND NOT EXISTS (
       SELECT 1 FROM public.invoices
        WHERE blend_ticket_id = p_blend_ticket_id
          AND deleted_at IS NULL
          AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
     ) THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Cannot set payment status to billed without a linked order or active invoice'
    );
  END IF;

  IF p_payment_status IS NOT NULL THEN
    UPDATE public.blend_tickets
       SET payment_status = p_payment_status,
           updated_at = now()
     WHERE id = p_blend_ticket_id;

    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'blend_ticket_status_changed',
      'Blend ticket ' || v_ticket.ticket_number ||
        ' payment status changed to ' || p_payment_status,
      v_actor, 'blend_ticket', p_blend_ticket_id
    );
  END IF;

  v_result := jsonb_build_object('success', true);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'update_blend_ticket_billing_status',
      v_result
    );
  END IF;

  RETURN v_result::json;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.update_blend_ticket_billing_status(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_blend_ticket_billing_status(uuid, text, uuid, text)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.check_idempotency(text,text)'::regprocedure;
  IF v_source NOT LIKE '%pg_advisory_xact_lock%'
     OR v_source NOT LIKE '%IDEMPOTENCY_CROSS_OP_KEY_REUSE%'
     OR v_source NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%'
     OR v_source NOT LIKE '%IDEMPOTENCY_OPERATION_REQUIRED%'
     OR v_source NOT LIKE '%WHERE idempotency_key = p_key%AND expires_at < now()%' THEN
    RAISE EXCEPTION 'check_idempotency validation/serialization/cross-operation guard missing';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.receive_po_items(jsonb,uuid,text,boolean)'::regprocedure;
  IF v_source NOT LIKE '%NOT COALESCE(p_allow_over_receive, false)%' THEN
    RAISE EXCEPTION 'receive_po_items NULL override fail-closed guard missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.idempotency_keys'::regclass
       AND tgname = 'guard_idempotency_key_insert'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'idempotency_keys inline-insert concurrency guard missing';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.receive_po_items(jsonb,uuid,text,boolean)'::regprocedure;
  IF v_source NOT LIKE '%OVER_RECEIVE_ADMIN_REQUIRED%'
     OR v_source NOT LIKE '%OVER_RECEIVE_REASON_REQUIRED%'
     OR v_source NOT LIKE '%RECEIVING_QUANTITY_MUST_BE_POSITIVE%'
     OR v_source NOT LIKE '%CASE WHEN v_over_receive%OVER-RECEIVE:%' THEN
    RAISE EXCEPTION 'receive_po_items quantity or over-receive guards missing';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.post_commission_payment(uuid,uuid,text)'::regprocedure;
  IF v_source NOT LIKE '%COMMISSION_PAYMENT_EMPTY%'
     OR v_source NOT LIKE '%COMMISSION_PAYMENT_TOTAL_MISMATCH%' THEN
    RAISE EXCEPTION 'post_commission_payment snapshot guards missing';
  END IF;

  IF (
    SELECT count(*) FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'update_blend_ticket_billing_status'
  ) <> 1 THEN
    RAISE EXCEPTION 'update_blend_ticket_billing_status must have exactly one overload';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.update_blend_ticket_billing_status(uuid,text,uuid,text)'::regprocedure;
  IF v_source LIKE '%COALESCE(p_payment_status, ''unchanged'')%'
     OR v_source NOT LIKE '%IF p_payment_status IS NOT NULL THEN%INSERT INTO public.activity_feed%' THEN
    RAISE EXCEPTION 'update_blend_ticket_billing_status no-op activity guard missing';
  END IF;
END;
$verify$;
