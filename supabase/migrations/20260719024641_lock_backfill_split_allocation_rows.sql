-- CodeRabbit follow-up: serialize the durable split-billing predicate against
-- concurrent order_item_field_allocations (OIFA) writes. The backfill locks the
-- order's items FOR UPDATE before reading OIFA. The OIFA trigger locks every
-- OLD/NEW parent item FOR KEY SHARE, in stable order, before reading invoices.
-- Whichever side wins therefore commits evidence that the other must observe.
-- A separate invoice trigger makes an existing order link immutable, applies
-- the same item-lock contract before posting, and refuses when the order's
-- durable split evidence or transient needs_split_billing flag is present.
-- Governed-group provenance is trusted only after a zero-anomaly live preflight
-- and revocation of all direct audit-log mutation privileges.
--
-- Body reproduced from the live catalog at md5
-- 6726ae9bccf8bfeef0fb7418eca6ed5c. Its only change is the marked order_items
-- lock immediately after the existing order lock. The trigger body is
-- reproduced from live md5 3504008c207e43adae24b8a1713c40c9 with the
-- complementary parent-item lock + any-active-invoice guard.

-- APPLY-TIME WRITE BARRIER: keep the zero-anomaly scan, privilege revoke, and
-- trigger attachment in one stable snapshot. SHARE ROW EXCLUSIVE conflicts with
-- RowExclusive DML while preserving ordinary reads. The single written order is
-- deliberate and must stay identical for every execution of this migration.
LOCK TABLE
  public.orders,
  public.order_items,
  public.order_item_field_allocations,
  public.invoices,
  public.financial_audit_log
IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.create_invoice_for_unbilled_delivery(p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_existing jsonb; v_delivery record; v_existing_count integer;
  v_invoice_id uuid; v_invoice_number text; v_total_cents bigint := 0;
  v_cost_cents bigint := 0; v_item record; v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required to create an invoice for a delivery'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Delivery is not completed (current status: %). Only completed deliveries can be invoiced retroactively.', v_delivery.status;
  END IF;
  IF v_delivery.order_id IS NULL THEN RAISE EXCEPTION 'Delivery has no order_id — cannot auto-invoice an orphan delivery'; END IF;
  PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

  -- CODE-RABBIT FIX: child allocation inserts take a KEY SHARE lock on their
  -- parent item. Lock every item in stable id order before checking OIFA rows.
  PERFORM 1
    FROM order_items
   WHERE order_id = v_delivery.order_id
   ORDER BY id
   FOR UPDATE;

  IF (SELECT COALESCE(needs_split_billing, false) FROM orders WHERE id = v_delivery.order_id)
     OR EXISTS (
       SELECT 1 FROM order_item_field_allocations oifa
       JOIN order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = v_delivery.order_id
     ) THEN
    RAISE EXCEPTION 'ORDER_NEEDS_SPLIT_BILLING: delivery %''s order uses split billing — a single backfilled invoice would mono-bill it and mis-attribute AR. Create the split invoices through the split-billing flow instead.', v_delivery.delivery_number;
  END IF;

  SELECT COUNT(*) INTO v_existing_count FROM invoices
  WHERE order_id = v_delivery.order_id AND status NOT IN ('voided', 'cancelled')
    AND (delivery_id = p_delivery_id OR delivery_id IS NULL) AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'This delivery already has an active invoice (or an order-level invoice covers the whole order) — nothing to backfill. Find and review the existing invoice instead.';
  END IF;
  v_invoice_number := next_invoice_number('chemical_sale');
  INSERT INTO invoices (invoice_number, invoice_type, order_id, customer_id, delivery_id,
    status, invoice_date, total_amount_cents, total_cost_cents, created_by)
  VALUES (v_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id,
    p_delivery_id, 'draft', CURRENT_DATE, 0, 0, v_actor) RETURNING id INTO v_invoice_id;
  FOR v_item IN
    SELECT di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id,
      oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name, p.product_name AS p_name
    FROM delivery_items di JOIN order_items oi ON oi.id = di.order_item_id
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id AND COALESCE(di.quantity_delivered, 0) > 0
  LOOP
    v_total_cents := v_total_cents + ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint;
    v_cost_cents := v_cost_cents + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
    INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents, unit_size)
    VALUES (v_invoice_id, v_item.order_item_id, v_item.product_id,
      COALESCE(v_item.oi_product_name, v_item.p_name), v_item.quantity_delivered,
      ROUND(v_item.price_per_unit * 100)::bigint,
      ROUND(v_item.quantity_delivered * v_item.price_per_unit * 100)::bigint,
      ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint, v_item.unit_size);
  END LOOP;
  UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_cost_cents WHERE id = v_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description)
  VALUES ('invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('invoice_number', v_invoice_number, 'delivery_id', p_delivery_id,
      'order_id', v_delivery.order_id, 'customer_id', v_delivery.customer_id, 'total_cents', v_total_cents),
    v_total_cents, 'Invoice ' || v_invoice_number || ' backfilled for completed delivery ' || v_delivery.delivery_number);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_backfilled_for_delivery', 'Backfilled draft invoice ' || v_invoice_number ||
    ' for completed delivery ' || v_delivery.delivery_number, v_actor, 'invoice', v_invoice_id, v_delivery.customer_id);
  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id,
    'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number, 'total_cents', v_total_cents);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_for_unbilled_delivery', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_oifa_edit_after_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_item_id  uuid;
  v_new_item_id  uuid;
  v_order_ids    uuid[];
  v_blocking_inv text;
BEGIN
  -- Branch before touching NEW/OLD: one of those records is unassigned on
  -- INSERT/DELETE triggers.
  IF TG_OP = 'INSERT' THEN
    v_new_item_id := NEW.order_item_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_item_id := OLD.order_item_id;
  ELSE
    v_old_item_id := OLD.order_item_id;
    v_new_item_id := NEW.order_item_id;
  END IF;

  -- CONCURRENCY FIX: lock every OLD/NEW parent item before the invoice read.
  -- The FK's own KEY SHARE arrives after this BEFORE trigger, too late to close
  -- the race; this explicit stable-order lock is the shared serialization point.
  PERFORM 1
    FROM order_items oi
   WHERE oi.id = ANY (
     array_remove(ARRAY[v_old_item_id, v_new_item_id]::uuid[], NULL)
   )
   ORDER BY oi.id
   FOR KEY SHARE;

  SELECT array_agg(DISTINCT oi.order_id ORDER BY oi.order_id)
    INTO v_order_ids
    FROM order_items oi
   WHERE oi.id = ANY (
     array_remove(ARRAY[v_old_item_id, v_new_item_id]::uuid[], NULL)
   );

  IF COALESCE(cardinality(v_order_ids), 0) = 0 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT i.invoice_number
    INTO v_blocking_inv
    FROM invoices i
   WHERE i.order_id = ANY (v_order_ids)
     AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled')
   ORDER BY i.created_at, i.id
   LIMIT 1;

  IF v_blocking_inv IS NOT NULL THEN
    RAISE EXCEPTION
      'ORDER_ALLOCATION_INVOICE_CONFLICT: cannot modify field allocation because active invoice % already covers the order; delete/void the draft or reverse the posted invoice first',
      v_blocking_inv
      USING ERRCODE = 'check_violation';
  END IF;

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- caller-analysis: trigger-internal function; authenticated clients must not
-- invoke the SECURITY DEFINER body directly.
REVOKE EXECUTE ON FUNCTION public.prevent_oifa_edit_after_post() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_oifa_edit_after_post() TO service_role;

CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order_id    uuid;
  v_needs_split boolean := false;
  v_has_oifa    boolean := false;
BEGIN
  -- An existing order-backed invoice cannot be re-parented while still a draft
  -- and posted later against a different/no order. This applies on every update,
  -- before any status-based early return.
  IF TG_OP = 'UPDATE'
     AND OLD.order_id IS NOT NULL
     AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION
      'INVOICE_ORDER_IMMUTABLE: an existing order-backed invoice cannot clear or change order_id'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Once an invoice is active, its group identity cannot be rewritten to escape
  -- the provenance predicate.
  IF TG_OP = 'UPDATE'
     AND (OLD.status IN ('posted', 'paid', 'overdue')
          OR NEW.status IN ('posted', 'paid', 'overdue'))
     AND NEW.invoice_group_id IS DISTINCT FROM OLD.invoice_group_id THEN
    RAISE EXCEPTION
      'INVOICE_GROUP_IMMUTABLE_ON_POST: invoice_group_id cannot be assigned, cleared, or changed while an invoice enters or remains active'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only the transition into an active posted state needs the split-billing
  -- predicate. INSERT is included defensively even though the existing draft-on-
  -- insert trigger independently rejects non-draft invoices.
  IF NEW.status NOT IN ('posted', 'paid', 'overdue')
     OR (TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'paid', 'overdue')) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  IF v_order_id IS NULL THEN RETURN NEW; END IF;

  -- Match the backfill/OIFA lock contract. If OIFA wins, this waits and then
  -- observes it. If posting wins, OIFA waits and then observes this invoice.
  PERFORM 1
    FROM order_items oi
   WHERE oi.order_id = v_order_id
   ORDER BY oi.id
   FOR UPDATE;

  SELECT COALESCE(o.needs_split_billing, false)
    INTO v_needs_split
    FROM orders o
   WHERE o.id = v_order_id;

  SELECT EXISTS (
    SELECT 1
      FROM order_item_field_allocations oifa
      JOIN order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = v_order_id
  ) INTO v_has_oifa;

  IF COALESCE(v_needs_split, false) OR COALESCE(v_has_oifa, false) THEN
    IF NEW.invoice_group_id IS NULL THEN
      RAISE EXCEPTION
        'MONO_INVOICE_SPLIT_BILLING_CONFLICT: cannot post a mono invoice for an order with split-billing evidence; use the split invoice group flow instead'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A non-null UUID is not proof of a governed split group. Require the
    -- immutable per-member audit provenance written by
    -- create_split_invoices_from_order, and reject the entire group if any live
    -- member belongs to another order or lacks that exact group/basis evidence.
    IF NOT EXISTS (
      SELECT 1
        FROM financial_audit_log fal
       WHERE fal.operation_type = 'invoice_created'
         AND fal.entity_type = 'invoice'
         AND fal.entity_id = NEW.id
         AND fal.new_values->>'group_id' = NEW.invoice_group_id::text
         AND fal.new_values->>'split_basis' = 'field_acre'
    ) OR EXISTS (
      SELECT 1
        FROM invoices member
       WHERE member.invoice_group_id = NEW.invoice_group_id
         AND member.deleted_at IS NULL
         AND (
           member.order_id IS DISTINCT FROM v_order_id
           OR NOT EXISTS (
             SELECT 1
               FROM financial_audit_log member_audit
              WHERE member_audit.operation_type = 'invoice_created'
                AND member_audit.entity_type = 'invoice'
                AND member_audit.entity_id = member.id
                AND member_audit.new_values->>'group_id' = NEW.invoice_group_id::text
                AND member_audit.new_values->>'split_basis' = 'field_acre'
           )
         )
    ) THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_GROUP_PROVENANCE_REQUIRED: active split-billing invoices must belong to the field-acre group created by create_split_invoices_from_order'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- caller-analysis: trigger-internal function; authenticated clients must not
-- invoke the SECURITY DEFINER body directly.
REVOKE EXECUTE ON FUNCTION public.guard_mono_invoice_split_billing_post() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_mono_invoice_split_billing_post() TO service_role;

-- Fail closed if production already contains a protected active invoice that
-- the new trigger would not recognize as canonical governed split provenance.
-- The 2026-07-19 live preflight returned zero rows for every branch below.
DO $preflight$
DECLARE
  v_anomalies jsonb;
BEGIN
  WITH protected AS (
    SELECT i.id, i.invoice_number, i.order_id, i.invoice_group_id
      FROM public.invoices i
      JOIN public.orders o ON o.id = i.order_id
     WHERE i.deleted_at IS NULL
       AND i.status NOT IN ('voided', 'cancelled')
       AND (
         COALESCE(o.needs_split_billing, false)
         OR EXISTS (
           SELECT 1
             FROM public.order_item_field_allocations oifa
             JOIN public.order_items oi ON oi.id = oifa.order_item_id
            WHERE oi.order_id = i.order_id
         )
       )
  ), anomalous AS (
    SELECT p.*
      FROM protected p
     WHERE p.invoice_group_id IS NULL
        OR NOT EXISTS (
          SELECT 1
            FROM public.financial_audit_log fal
           WHERE fal.operation_type = 'invoice_created'
             AND fal.entity_type = 'invoice'
             AND fal.entity_id = p.id
             AND fal.new_values->>'group_id' = p.invoice_group_id::text
             AND fal.new_values->>'split_basis' = 'field_acre'
        )
        OR EXISTS (
          SELECT 1
            FROM public.invoices member
           WHERE member.invoice_group_id = p.invoice_group_id
             AND member.deleted_at IS NULL
             AND (
               member.order_id IS DISTINCT FROM p.order_id
               OR NOT EXISTS (
                 SELECT 1
                   FROM public.financial_audit_log member_audit
                  WHERE member_audit.operation_type = 'invoice_created'
                    AND member_audit.entity_type = 'invoice'
                    AND member_audit.entity_id = member.id
                    AND member_audit.new_values->>'group_id' = p.invoice_group_id::text
                    AND member_audit.new_values->>'split_basis' = 'field_acre'
               )
             )
        )
  )
  SELECT jsonb_agg(jsonb_build_object(
           'invoice_id', id,
           'invoice_number', invoice_number,
           'order_id', order_id,
           'invoice_group_id', invoice_group_id
         ) ORDER BY invoice_number)
    INTO v_anomalies
    FROM anomalous;

  IF v_anomalies IS NOT NULL THEN
    RAISE EXCEPTION
      'SPLIT_PROVENANCE_PREFLIGHT_FAILED: active protected invoices require reconciliation before this guard can trust provenance: %',
      v_anomalies;
  END IF;
END;
$preflight$;

-- financial_audit_log is append-only owner-RPC evidence. Repo/live caller
-- analysis found no direct Data API writer; SECURITY DEFINER business RPCs keep
-- writing in owner context. Remove the forge path before attaching the trigger.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.financial_audit_log
  FROM PUBLIC, anon, authenticated, service_role;

DO $grant_postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS role_name(name)
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS privilege_name(name)
     WHERE has_table_privilege(
       role_name.name,
       'public.financial_audit_log',
       privilege_name.name
     )
  ) THEN
    RAISE EXCEPTION 'financial_audit_log direct mutation privilege remains after revoke';
  END IF;
END;
$grant_postflight$;

DROP TRIGGER IF EXISTS guard_mono_invoice_split_billing_post ON public.invoices;
CREATE TRIGGER guard_mono_invoice_split_billing_post
BEFORE INSERT OR UPDATE OF status, order_id, invoice_group_id
ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.guard_mono_invoice_split_billing_post();
