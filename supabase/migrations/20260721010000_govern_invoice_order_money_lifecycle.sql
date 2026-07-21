-- 20260721010000: forward-only closeout for the invoice/order money lifecycle issues found while
-- reviewing Supplier Pricing Phase 1a. This migration deliberately wraps the
-- current live function bodies instead of copying them, except for
-- revert_quote_status: the gauntlet correction now owns its complete
-- concurrency-safe, request-bound public contract. The preflight hashes make the
-- apply fail closed if another migration changed any wrapped or verified baseline.
--
-- No business rows are modified. Existing unexpired retry keys for the touched
-- operations block the migration so no legacy unbound result can be replayed.

-- Close the apply-time window before any preflight or catalog change. Existing
-- writers finish first; new legacy-authority writes then wait until every guard,
-- wrapper, and revoke below commits atomically. The order matches the governed
-- lifecycle's parent-before-child direction after the shared retry ledger.
LOCK TABLE
  public.idempotency_keys,
  public.orders,
  public.order_items,
  public.deliveries,
  public.delivery_items,
  public.order_item_field_allocations,
  public.invoices,
  public.invoice_items,
  public.split_invoice_creation_claims,
  public.split_invoice_mutation_claims,
  public.split_invoice_provenance,
  public.financial_audit_log
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_actual text;
  v_expected record;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('public.void_invoice(uuid,text,text)'::regprocedure, 'c7a488d58bd876e92565bca9bd4edc90'),
      ('public.void_invoice_group(uuid,text,text)'::regprocedure, 'fa19808b6ab6b0663663cd28c89a3326'),
      ('public.save_invoice(jsonb,jsonb,text)'::regprocedure, 'f7e0fe8f494fe160039df9aef46067df'),
      ('public._void_invoice_group_guard_impl_20260720(uuid,text,text)'::regprocedure, '9f1656542c5c6a667b1c8a67034c5c3f'),
      ('public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'::regprocedure, '6eb68b6248b52328bfc94284e790ef85'),
      ('public.create_invoice_from_order(uuid,uuid,text,text)'::regprocedure, '6f7bfd6e0cc06bae9afb25e41610ebc8'),
      ('public.revert_quote_status(uuid,text,uuid,text)'::regprocedure, 'fb0cc5def3766270b13c401810b61f3e'),
      ('public.post_invoice(uuid,text)'::regprocedure, '39b9f427eb843e6cba859a1db62553a8'),
      ('public.cancel_order(uuid,uuid,text)'::regprocedure, '26c8b52a1f1e1a5bdf460bd89b730111'),
      ('public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)'::regprocedure, '0d6fe6c0c9ea71f11ce8cc233665eba2'),
      ('public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)'::regprocedure, '5c72187a25c2a5b7c807edda36bac2cd'),
      ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)'::regprocedure, '2fc0102fe8702f6c2d63c326a99c15dd'),
      ('public.get_customer_transaction_review(uuid,date,date)'::regprocedure, '743c25983e83071194ce7a3f12135525'),
      ('public._enforce_delivery_items_parent_lock()'::regprocedure, '4d1b80cae6d696ae65e8373bd9b860ab'),
      ('public.prevent_oifa_edit_after_post()'::regprocedure, '90a83898c13b7273d6e895691c619b88'),
      ('public.guard_mono_invoice_split_billing_post()'::regprocedure, 'e643f573e529a7117c10ff1e8b89fad0'),
      ('public.guard_split_invoice_provenance_identity()'::regprocedure, '639875d6641556c78c25d633c67821f1')
    ) AS baseline(signature, expected_md5)
  LOOP
    SELECT md5(p.prosrc) INTO v_actual
      FROM pg_proc p
     WHERE p.oid = v_expected.signature;
    IF v_actual IS DISTINCT FROM v_expected.expected_md5 THEN
      RAISE EXCEPTION 'PRECONDITION: % source md5 % <> expected %; rebase from live before applying',
        v_expected.signature, v_actual, v_expected.expected_md5;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.save_invoice(jsonb,jsonb,text)'),
        ('public.void_invoice(uuid,text,text)'),
        ('public.void_invoice_group(uuid,text,text)'),
        ('public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'),
        ('public._void_invoice_group_guard_impl_20260720(uuid,text,text)')
      ) AS governed(signature)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(governed.signature)
     WHERE p.oid IS NULL
        OR NOT p.prosecdef
        OR ('search_path=public, pg_temp' = ANY (
             COALESCE(p.proconfig, ARRAY[]::text[])
           )) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'PRECONDITION: governed split save/void function properties drifted; rebase from live before applying';
  END IF;

  -- The guards below preserve clean lineage; they are not a hidden repair job.
  -- Bind the zero-anomaly live preflight under the apply barrier so no legacy
  -- writer can create an ungoverned row between this scan and trigger attach.
  IF EXISTS (
       SELECT 1
         FROM public.invoices i
         JOIN public.orders o ON o.id = i.order_id
        WHERE i.customer_id IS DISTINCT FROM o.customer_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.invoices i
         LEFT JOIN public.deliveries d ON d.id = i.delivery_id
        WHERE i.delivery_id IS NOT NULL
          AND (
            d.id IS NULL
            OR d.deleted_at IS NOT NULL
            OR d.order_id IS DISTINCT FROM i.order_id
            OR d.customer_id IS DISTINCT FROM i.customer_id
          )
     )
     OR EXISTS (
       SELECT 1
         FROM public.deliveries d
         JOIN public.orders o ON o.id = d.order_id
        WHERE d.customer_id IS DISTINCT FROM o.customer_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.delivery_items di
         JOIN public.deliveries d ON d.id = di.delivery_id
         LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE oi.id IS NULL
           OR oi.order_id IS DISTINCT FROM d.order_id
           OR oi.product_id IS DISTINCT FROM di.product_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.invoices i
         JOIN public.orders o ON o.id = i.order_id
        WHERE i.deleted_at IS NULL
          AND i.status IN ('draft', 'unposted')
          AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'PRECONDITION: existing invoice/order/delivery source-lineage anomaly requires separate owner-reviewed reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.idempotency_keys k
     WHERE k.operation IN (
       'create_invoice_from_order', 'post_invoice',
       'create_invoice_for_unbilled_delivery'
      )
       AND (k.expires_at IS NULL OR k.expires_at >= now())
  ) THEN
    RAISE EXCEPTION 'PRECONDITION: unexpired legacy retry keys exist for a wrapped operation; wait for expiry before applying';
  END IF;

  IF to_regprocedure('public._cancel_order_provenance_wrapper_20260719(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION: cancel_order outer-wrapper private name already exists';
  END IF;
END;
$preflight$;

-- Keep the mature, current implementations byte-identical behind owner-only
-- names. Public wrappers below own argument-bound retry behavior. The upstream
-- group-aware save/void migration remains canonical; this migration verifies
-- those final public and private bodies without replacing or re-emitting them.
ALTER FUNCTION public.create_invoice_from_order(uuid, uuid, text, text)
  RENAME TO _create_invoice_from_order_impl_20260718;
REVOKE ALL ON FUNCTION public._create_invoice_from_order_impl_20260718(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.post_invoice(uuid, text)
  RENAME TO _post_invoice_public_impl_20260718;
REVOKE ALL ON FUNCTION public._post_invoice_public_impl_20260718(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  RENAME TO _create_invoice_for_unbilled_delivery_impl_20260718;
REVOKE ALL ON FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_invoice_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request jsonb;
  v_invoice_id uuid;
  v_order_status text;
  v_order_deleted_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'order_id', p_order_id,
    'salesman_id', p_salesman_id,
    'invoice_type', p_invoice_type,
    'actor_id', v_actor
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN
      IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: create_invoice_from_order';
      END IF;
      IF v_existing->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: create_invoice_from_order key was already used for different order, salesman, invoice type, or actor arguments';
      END IF;
      RETURN NULLIF(v_existing->'response'->>'invoice_id', '')::uuid;
    END IF;
  END IF;

  SELECT status, deleted_at
    INTO v_order_status, v_order_deleted_at
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;
  IF v_order_deleted_at IS NOT NULL OR v_order_status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot create an invoice for a cancelled, voided, or deleted order';
  END IF;

  v_invoice_id := public._create_invoice_from_order_impl_20260718(
    p_order_id, p_salesman_id, p_invoice_type, NULL
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_invoice_from_order',
      jsonb_build_object(
        'request', v_request,
        'response', jsonb_build_object('invoice_id', v_invoice_id)
      )
    );
  END IF;
  RETURN v_invoice_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_invoice_from_order(uuid, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_order(uuid, uuid, text, text)
  TO authenticated, service_role;

-- A few historical completed deliveries belong to soft-deleted fulfilled orders.
-- Keep their legitimate delivered-only billing path available without reopening
-- direct invoice writes: only the trusted wrappers can mint a transaction-local
-- capability, and the table is invisible to every API role.
CREATE TABLE public.invoice_delivery_recovery_capabilities (
  transaction_id bigint NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('writer', 'poster')),
  delivery_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, purpose)
);

ALTER TABLE public.invoice_delivery_recovery_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_delivery_recovery_capabilities_deny_all
ON public.invoice_delivery_recovery_capabilities
FOR ALL TO PUBLIC
USING (false)
WITH CHECK (false);
REVOKE ALL ON TABLE public.invoice_delivery_recovery_capabilities
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_invoice_for_unbilled_delivery(
  p_delivery_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request jsonb;
  v_result jsonb;
  v_is_deleted_fulfilled_recovery boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin access required to create an invoice for a delivery';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'delivery_id', p_delivery_id,
    'actor_id', v_actor
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key, 'create_invoice_for_unbilled_delivery'
    );
    IF v_existing IS NOT NULL THEN
      IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: create_invoice_for_unbilled_delivery';
      END IF;
      IF v_existing->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: create_invoice_for_unbilled_delivery key was already used for a different delivery or actor';
      END IF;
      RETURN v_existing->'response';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.deliveries d
      JOIN public.orders o ON o.id = d.order_id
     WHERE d.id = p_delivery_id
       AND d.status = 'completed'
       AND d.deleted_at IS NULL
       AND d.customer_id = o.customer_id
       AND o.deleted_at IS NOT NULL
       AND o.status IN ('fulfilled', 'partially_fulfilled')
  ) INTO v_is_deleted_fulfilled_recovery;

  IF v_is_deleted_fulfilled_recovery THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.delivery_items di
       WHERE di.delivery_id = p_delivery_id
    ) OR EXISTS (
      SELECT 1
        FROM public.delivery_items di
        LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
        JOIN public.deliveries d ON d.id = di.delivery_id
       WHERE di.delivery_id = p_delivery_id
         AND (
           oi.id IS NULL
           OR oi.order_id IS DISTINCT FROM d.order_id
           OR oi.product_id IS DISTINCT FROM di.product_id
           OR COALESCE(di.quantity_delivered, 0) <= 0
           OR di.quantity_delivered > COALESCE(di.quantity, 0)
         )
    ) THEN
      RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID: every historical recovery line must have matching order/product lineage and delivered quantity within its planned quantity';
    END IF;

    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    INSERT INTO public.invoice_delivery_recovery_capabilities (
      transaction_id, purpose, delivery_id, actor_id
    ) VALUES (txid_current(), 'writer', p_delivery_id, v_actor);
  END IF;

  BEGIN
    v_result := public._create_invoice_for_unbilled_delivery_impl_20260718(
      p_delivery_id, v_actor, NULL
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'writer';
    RAISE;
  END;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'writer';

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_invoice_for_unbilled_delivery',
      jsonb_build_object('request', v_request, 'response', v_result)
    );
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_for_unbilled_delivery(uuid, uuid, text)
  TO authenticated, service_role;

-- Posting a trusted recovery draft for a historical soft-deleted fulfilled order
-- is the only terminal-order posting exception. It revalidates exact delivered
-- quantity/cents immediately before posting and mints only a transaction-local
-- header capability. Ordinary posting continues through the mature implementation.
CREATE FUNCTION public._post_deleted_delivery_recovery_invoice_20260719(
  p_invoice_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_inv record;
  v_order_status text;
  v_order_pricing text;
  v_order_deleted_at timestamptz;
  v_order_id uuid;
  v_order_customer_id uuid;
  v_terms_days integer;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED_FOR_DELETED_DELIVERY_RECOVERY';
  END IF;

  SELECT order_id INTO v_order_id
    FROM public.invoices
   WHERE id = p_invoice_id AND deleted_at IS NULL;
  IF NOT FOUND OR v_order_id IS NULL THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_SOURCE_REQUIRED';
  END IF;

  -- Preserve the repository's order -> invoice lock hierarchy. Holding the
  -- order through posting also prevents a customer-lineage change between
  -- validation and RUP/audit generation.
  SELECT status, pricing_status, deleted_at, customer_id
    INTO v_order_status, v_order_pricing, v_order_deleted_at, v_order_customer_id
    FROM public.orders
   WHERE id = v_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_order_deleted_at IS NULL
     OR v_order_status NOT IN ('fulfilled', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ORDER_INVALID';
  END IF;

  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.order_id IS DISTINCT FROM v_order_id
     OR v_inv.customer_id IS DISTINCT FROM v_order_customer_id THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_CUSTOMER_LINEAGE_INVALID';
  END IF;
  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status;
  END IF;
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.delivery_id IS NULL THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_SOURCE_REQUIRED';
  END IF;
  IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.deliveries d
     WHERE d.id = v_inv.delivery_id
       AND d.order_id = v_inv.order_id
       AND d.customer_id = v_inv.customer_id
       AND d.status = 'completed'
       AND d.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_LINEAGE_INVALID';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_inv.delivery_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.delivery_items di
         LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE di.delivery_id = v_inv.delivery_id
          AND (
            oi.id IS NULL
            OR oi.order_id IS DISTINCT FROM v_inv.order_id
            OR oi.product_id IS DISTINCT FROM di.product_id
            OR COALESCE(di.quantity_delivered, 0) <= 0
            OR di.quantity_delivered > COALESCE(di.quantity, 0)
          )
     ) THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID: historical recovery lines failed order/product/quantity validation';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_inv.delivery_id
          AND COALESCE(di.quantity_delivered, 0) > 0
     )
     OR v_inv.total_amount_cents IS DISTINCT FROM (
       SELECT COALESCE(SUM(ROUND(di.quantity_delivered * oi.price_per_unit * 100)::bigint), 0)
         FROM public.delivery_items di
         JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE di.delivery_id = v_inv.delivery_id
          AND COALESCE(di.quantity_delivered, 0) > 0
     )
     OR v_inv.total_cost_cents IS DISTINCT FROM (
       SELECT COALESCE(SUM(ROUND(di.quantity_delivered * COALESCE(oi.cost_per_unit, 0) * 100)::bigint), 0)
         FROM public.delivery_items di
         JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE di.delivery_id = v_inv.delivery_id
          AND COALESCE(di.quantity_delivered, 0) > 0
     )
     OR EXISTS (
       WITH delivered AS (
         SELECT di.order_item_id, di.product_id,
                SUM(di.quantity_delivered) AS quantity,
                SUM(ROUND(di.quantity_delivered * oi.price_per_unit * 100)::bigint) AS extended_cents,
                ROUND(MAX(oi.price_per_unit) * 100)::bigint AS unit_price_cents,
                ROUND(MAX(COALESCE(oi.cost_per_unit, 0)) * 100)::bigint AS cost_cents
           FROM public.delivery_items di
           JOIN public.order_items oi ON oi.id = di.order_item_id
          WHERE di.delivery_id = v_inv.delivery_id
            AND COALESCE(di.quantity_delivered, 0) > 0
          GROUP BY di.order_item_id, di.product_id
       ), billed AS (
         SELECT ii.order_item_id, ii.product_id,
                SUM(ii.quantity) AS quantity,
                SUM(ii.extended_cents) AS extended_cents,
                MIN(ii.unit_price_cents) AS min_unit_price_cents,
                MAX(ii.unit_price_cents) AS max_unit_price_cents,
                MIN(ii.cost_cents) AS min_cost_cents,
                MAX(ii.cost_cents) AS max_cost_cents
           FROM public.invoice_items ii
          WHERE ii.invoice_id = p_invoice_id
          GROUP BY ii.order_item_id, ii.product_id
       )
       SELECT 1
         FROM delivered d
         FULL JOIN billed b
           ON b.order_item_id = d.order_item_id
          AND b.product_id = d.product_id
        WHERE d.order_item_id IS NULL
           OR b.order_item_id IS NULL
           OR d.quantity IS DISTINCT FROM b.quantity
           OR d.extended_cents IS DISTINCT FROM b.extended_cents
           OR d.unit_price_cents IS DISTINCT FROM b.min_unit_price_cents
           OR d.unit_price_cents IS DISTINCT FROM b.max_unit_price_cents
           OR d.cost_cents IS DISTINCT FROM b.min_cost_cents
           OR d.cost_cents IS DISTINCT FROM b.max_cost_cents
     ) THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CONTENT_MISMATCH: recovery invoice must exactly match delivered quantities and cents';
  END IF;

  PERFORM public.check_period_open(v_inv.invoice_date);
  SELECT public.parse_payment_terms_days(
           COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms)
         )
    INTO v_terms_days
    FROM public.customers c
   WHERE c.id = v_inv.customer_id;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'poster';
  INSERT INTO public.invoice_delivery_recovery_capabilities (
    transaction_id, purpose, delivery_id, actor_id
  ) VALUES (txid_current(), 'poster', v_inv.delivery_id, auth.uid());

  BEGIN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE public.invoices
       SET status = 'posted',
           posted_by = auth.uid(),
           posted_at = now(),
           updated_at = now(),
           due_date = COALESCE(
             due_date,
             (v_inv.invoice_date + (v_terms_days || ' days')::interval)::date
           )
     WHERE id = p_invoice_id;
    PERFORM set_config('app.admin_override', 'false', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.admin_override', 'false', true);
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'poster';
    RAISE;
  END;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'poster';

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_id,
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    jsonb_build_object('status', v_inv.status),
    jsonb_build_object('status', 'posted', 'posted_at', now()::text),
    v_inv.total_amount_cents,
    'Posted historical completed-delivery recovery invoice ' || v_inv.invoice_number
  );
  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'invoice_posted',
    'Posted historical completed-delivery recovery invoice ' || v_inv.invoice_number,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );
  PERFORM public.generate_rup_sales_records(p_invoice_id);
END;
$function$;

REVOKE ALL ON FUNCTION public._post_deleted_delivery_recovery_invoice_20260719(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.post_invoice(
  p_invoice_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_existing jsonb;
  v_request jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'invoice_id', p_invoice_id,
    'actor_id', v_actor
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN
      IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: post_invoice';
      END IF;
      IF v_existing->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: post_invoice key was already used for a different invoice or actor';
      END IF;
      PERFORM set_config('app.admin_override', 'false', true);
      RETURN;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.invoices
     WHERE id = p_invoice_id AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'INVOICE_DELETED: a soft-deleted invoice cannot be posted';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.invoices i
      JOIN public.orders o ON o.id = i.order_id
      JOIN public.deliveries d ON d.id = i.delivery_id
     WHERE i.id = p_invoice_id
       AND i.deleted_at IS NULL
       AND o.deleted_at IS NOT NULL
       AND o.status IN ('fulfilled', 'partially_fulfilled')
       AND d.status = 'completed'
       AND d.deleted_at IS NULL
       AND d.order_id = i.order_id
       AND d.customer_id = i.customer_id
       AND o.customer_id = i.customer_id
  ) THEN
    PERFORM public._post_deleted_delivery_recovery_invoice_20260719(p_invoice_id);
  ELSE
    PERFORM public._post_invoice_public_impl_20260718(p_invoice_id, NULL);
  END IF;
  -- The mature posting implementation sets a transaction-local override for
  -- the invoice status transition. Never leak it to later caller statements.
  PERFORM set_config('app.admin_override', 'false', true);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'post_invoice',
      jsonb_build_object(
        'request', v_request,
        'response', jsonb_build_object('success', true, 'invoice_id', p_invoice_id)
      )
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid, text)
  TO authenticated, service_role;

-- Internal posting entry points must not be directly callable through the Data
-- API. Owner-executed SECURITY DEFINER wrappers continue to use them.
REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._post_invoice_customer_scope_impl(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Once a delivery line references an order item, moving that item to another
-- order or product would split delivery and inventory lineage. This trigger is
-- the table-level boundary, including writes made by update_order_items.
CREATE OR REPLACE FUNCTION public._guard_order_item_delivery_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF public._is_admin_override() THEN
    RETURN NEW;
  END IF;

  IF (NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.product_id IS DISTINCT FROM OLD.product_id)
     AND EXISTS (
       SELECT 1
         FROM public.delivery_items di
        WHERE di.order_item_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'ORDER_ITEM_DELIVERY_LINEAGE_LOCKED: remove the item from every scheduled delivery before changing its order or product';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_order_item_delivery_lineage()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_order_item_delivery_lineage ON public.order_items;
CREATE TRIGGER guard_order_item_delivery_lineage
BEFORE UPDATE OF order_id, product_id ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public._guard_order_item_delivery_lineage();

-- Once an order has delivery or invoice provenance, changing its customer would
-- split accounting and compliance lineage. This boundary also closes the race
-- between recovery-draft creation and later posting.
CREATE OR REPLACE FUNCTION public._guard_order_customer_source_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     AND (
       EXISTS (SELECT 1 FROM public.deliveries d WHERE d.order_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.order_id = OLD.id)
     ) THEN
    RAISE EXCEPTION 'ORDER_CUSTOMER_LINEAGE_LOCKED: order customer cannot change after delivery or invoice provenance exists';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_order_customer_source_lineage()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_order_customer_source_lineage ON public.orders;
CREATE TRIGGER guard_order_customer_source_lineage
BEFORE UPDATE OF customer_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public._guard_order_customer_source_lineage();

-- Serialize scheduled delivery-line edits with delivery lifecycle changes and
-- enforce lineage at the point of entry. The prior trigger read parent status
-- without a row lock, allowing a concurrent cancel to race a late line insert.
CREATE OR REPLACE FUNCTION public._enforce_delivery_items_parent_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.delivery_id ELSE NEW.delivery_id END;
  v_order_item_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_item_id ELSE NEW.order_item_id END;
  v_delivery_status text;
  v_delivery_order_id uuid;
  v_delivery_customer_id uuid;
  v_order_customer_id uuid;
  v_item_order_id uuid;
  v_item_product_id uuid;
BEGIN
  IF public._is_admin_override() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id THEN
    RAISE EXCEPTION 'DELIVERY_ITEM_LINEAGE_IMMUTABLE: delivery_id cannot change after line creation';
  END IF;

  BEGIN
    SELECT d.status, d.order_id, d.customer_id, o.customer_id
      INTO v_delivery_status, v_delivery_order_id, v_delivery_customer_id, v_order_customer_id
      FROM public.deliveries d
      JOIN public.orders o ON o.id = d.order_id
     WHERE d.id = v_delivery_id
     FOR UPDATE OF d NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'DELIVERY_LIFECYCLE_BUSY_RETRY: this delivery is changing status; wait a moment and retry';
  END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_ITEM_PARENT_MISSING: delivery % does not exist', v_delivery_id;
  END IF;
  IF v_delivery_status <> 'scheduled' THEN
    RAISE EXCEPTION
      'DELIVERY_ITEMS_LOCKED: cannot % delivery items on a % delivery (items are editable only while scheduled)',
      lower(TG_OP), v_delivery_status;
  END IF;
  IF v_delivery_customer_id IS DISTINCT FROM v_order_customer_id THEN
    RAISE EXCEPTION 'DELIVERY_ITEM_LINEAGE_INVALID: delivery customer must match its order customer';
  END IF;

  BEGIN
    SELECT oi.order_id, oi.product_id
      INTO v_item_order_id, v_item_product_id
      FROM public.order_items oi
     WHERE oi.id = v_order_item_id
     FOR UPDATE OF oi NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORDER_ITEM_LINEAGE_BUSY_RETRY: this order item is being edited; wait a moment and retry';
  END;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NOT FOUND
       OR v_item_order_id IS DISTINCT FROM v_delivery_order_id
       OR v_item_product_id IS DISTINCT FROM NEW.product_id THEN
      RAISE EXCEPTION 'DELIVERY_ITEM_LINEAGE_INVALID: delivery, order item, and product must belong to the same order line';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public._enforce_delivery_items_parent_lock()
  FROM PUBLIC, anon, authenticated, service_role;

-- A partially delivered order cannot become a cancelled historical record: the
-- delivered goods, their invoices, and their commissions remain valid. This
-- helper closes only the undelivered remainder and finishes the delivered order.
CREATE FUNCTION public._close_undelivered_order_remainder_20260718(
  p_order_id uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order record;
  v_item record;
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  v_undelivered numeric;
  v_prebooked numeric;
  v_quantity_drawn numeric;
  v_released_quantity numeric := 0;
  v_holds_released integer := 0;
  v_deliveries_cancelled integer := 0;
  v_remainders_cancelled integer := 0;
  v_commissions_recomputed integer := 0;
  v_total_profit numeric;
  v_split_total numeric;
  v_profit_cents bigint;
  v_item_snapshot jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT * INTO v_order
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status NOT IN ('confirmed', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'ORDER_REMAINDER_CLOSE_STATUS_INVALID: %', v_order.status;
  END IF;

  -- Lock/refuse the whole-order invoice immediately after the order and before
  -- commissions. void_invoice owns invoice -> commission; matching that order
  -- here prevents a close-vs-void deadlock while still serializing creation via
  -- the order lock held above.
  PERFORM 1
    FROM public.invoices
   WHERE order_id = p_order_id
     AND delivery_id IS NULL
     AND deleted_at IS NULL
     AND status NOT IN ('cancelled', 'voided')
   ORDER BY id
   FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'ORDER_LEVEL_INVOICE_ACTIVE: cancel or void the active whole-order invoice before closing the undelivered remainder';
  END IF;

  PERFORM 1 FROM public.order_items
   WHERE order_id = p_order_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.deliveries
   WHERE order_id = p_order_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.commissions
   WHERE order_id = p_order_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.order_items
     WHERE order_id = p_order_id AND COALESCE(quantity_delivered, 0) > 0
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: no delivered order-item quantity exists';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.delivery_items di
      JOIN public.deliveries d ON d.id = di.delivery_id
     WHERE d.order_id = p_order_id
       AND d.deleted_at IS NULL
       AND d.status = 'completed'
       AND (
         COALESCE(di.quantity_delivered, 0) < 0
         OR COALESCE(di.quantity_delivered, 0) > di.quantity
       )
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: completed delivery quantities must be between zero and the planned quantity';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.delivery_items di
      JOIN public.deliveries d ON d.id = di.delivery_id
      JOIN public.orders o ON o.id = d.order_id
      JOIN public.order_items oi ON oi.id = di.order_item_id
     WHERE d.order_id = p_order_id
       AND d.deleted_at IS NULL
       AND d.status = 'completed'
       AND (
         d.customer_id IS DISTINCT FROM o.customer_id
         OR oi.order_id IS DISTINCT FROM p_order_id
         OR oi.product_id IS DISTINCT FROM di.product_id
       )
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_LINEAGE_INVALID: completed delivery customer, order item, and product must match the same order';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.order_items oi
      LEFT JOIN (
        SELECT di.order_item_id,
               SUM(COALESCE(di.quantity_delivered, 0)) AS completed_quantity
          FROM public.delivery_items di
          JOIN public.deliveries d ON d.id = di.delivery_id
         WHERE d.order_id = p_order_id
           AND d.deleted_at IS NULL
           AND d.status = 'completed'
         GROUP BY di.order_item_id
      ) delivered ON delivered.order_item_id = oi.id
     WHERE oi.order_id = p_order_id
       AND COALESCE(oi.quantity_delivered, 0)
             IS DISTINCT FROM COALESCE(delivered.completed_quantity, 0)
  ) THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: order-item delivered quantities do not match completed delivery-item history';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commissions
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'paid'
  ) THEN
    RAISE EXCEPTION 'ORDER_COMMISSIONS_PAID_VOID_BATCH_FIRST';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.commissions c
      JOIN public.commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN public.commission_payments cp ON cp.id = cpi.commission_payment_id
     WHERE c.order_id = p_order_id
       AND c.deleted_at IS NULL
       AND c.status = 'pending'
       AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.commissions
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status <> 'pending'
  ) THEN
    RAISE EXCEPTION 'ORDER_COMMISSION_STATE_UNSAFE';
  END IF;

  -- Booking draw-down locks the quote before inventory. Match that order here
  -- so a concurrent draw and remainder close cannot deadlock.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NULL THEN
    RAISE EXCEPTION 'BOOKING_DRAW_QUOTE_MISSING: booking-draw order % has no source quote', p_order_id;
  END IF;
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    SELECT * INTO v_draw_quote
      FROM public.quotes
     WHERE id = v_order.quote_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTE_NOT_FOUND: booking-draw order % references missing quote %',
        p_order_id, v_order.quote_id;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_item_id', oi.id,
           'product_id', oi.product_id,
           'before_total_units', oi.total_units_needed,
           'delivered_units', oi.quantity_delivered,
           'released_units', GREATEST(oi.total_units_needed - oi.quantity_delivered, 0)
         ) ORDER BY oi.id), '[]'::jsonb)
    INTO v_item_snapshot
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id;

  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE public.deliveries
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = p_actor,
         cancel_reason = 'Undelivered remainder closed for order ' || v_order.order_number,
         updated_at = now()
   WHERE order_id = p_order_id
     AND deleted_at IS NULL
     AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  UPDATE public.delivery_remainders
     SET status = 'cancelled', updated_at = now()
   WHERE order_id = p_order_id
     AND status IN ('pending', 'scheduled');
  GET DIAGNOSTICS v_remainders_cancelled = ROW_COUNT;

  FOR v_item IN
    SELECT product_id,
           SUM(GREATEST(total_units_needed - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
      FROM public.order_items
     WHERE order_id = p_order_id
     GROUP BY product_id
     ORDER BY product_id
  LOOP
    v_undelivered := v_item.qty_undelivered;
    IF v_undelivered <= 0 THEN CONTINUE; END IF;
    v_released_quantity := v_released_quantity + v_undelivered;

    SELECT quantity_prebooked INTO v_prebooked
      FROM public.inventory
     WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVENTORY_PREBOOK_ROW_MISSING: product % has no Main Warehouse inventory row', v_item.product_id;
    END IF;
    IF COALESCE(v_prebooked, 0) < v_undelivered THEN
      RAISE EXCEPTION 'INVENTORY_PREBOOK_UNDERFLOW: product % has % prebooked but % undelivered units must be released',
        v_item.product_id, COALESCE(v_prebooked, 0), v_undelivered;
    END IF;
    UPDATE public.inventory
       SET quantity_prebooked = quantity_prebooked - v_undelivered,
           updated_at = now()
     WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'released', v_undelivered, 'Main Warehouse',
      p_order_id, p_actor,
      'Released ' || v_undelivered || ' undelivered units — order ' ||
        v_order.order_number || ' remainder closed'
    );
  END LOOP;

  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    FOR v_draw_item IN
      SELECT product_id,
             SUM(GREATEST(total_units_needed - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
        FROM public.order_items
       WHERE order_id = p_order_id
       GROUP BY product_id
       ORDER BY product_id
    LOOP
      IF v_draw_item.qty_undelivered <= 0 THEN CONTINUE; END IF;
      SELECT quantity_drawn INTO v_quantity_drawn
        FROM public.quote_product_draws
       WHERE quote_id = v_order.quote_id
         AND product_id = v_draw_item.product_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'QUOTE_DRAW_ROW_MISSING: quote % product % has no draw row',
          v_order.quote_id, v_draw_item.product_id;
      END IF;
      IF COALESCE(v_quantity_drawn, 0) < v_draw_item.qty_undelivered THEN
        RAISE EXCEPTION 'QUOTE_DRAW_UNDERFLOW: quote % product % has % drawn but % undelivered units must be released',
          v_order.quote_id, v_draw_item.product_id,
          COALESCE(v_quantity_drawn, 0), v_draw_item.qty_undelivered;
      END IF;
      UPDATE public.quote_product_draws
         SET quantity_drawn = quantity_drawn - v_draw_item.qty_undelivered,
             updated_at = now()
       WHERE quote_id = v_order.quote_id
         AND product_id = v_draw_item.product_id;
    END LOOP;

    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true)
        INTO v_draw_fully_drawn
        FROM (
          SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
            FROM public.quote_items
           WHERE quote_id = v_order.quote_id
           GROUP BY product_id
        ) b
        LEFT JOIN public.quote_product_draws d
          ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
       WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        UPDATE public.quotes SET status = 'sent', updated_at = now()
         WHERE id = v_order.quote_id;
      END IF;
    END IF;
    PERFORM public._sync_planned_holds(v_order.quote_id, p_actor);
  ELSIF v_order.quote_id IS NOT NULL THEN
    UPDATE public.inventory_holds
       SET is_active = false, updated_at = now()
     WHERE source_id = v_order.quote_id AND is_active = true;
    GET DIAGNOSTICS v_holds_released = ROW_COUNT;
  END IF;

  UPDATE public.order_items
     SET total_units_needed = quantity_delivered,
         quantity_remaining = 0,
         total_price = ROUND(price_per_unit * quantity_delivered, 2),
         profit = ROUND((price_per_unit - COALESCE(cost_per_unit, 0)) * quantity_delivered, 2),
         net_margin = CASE
           WHEN price_per_unit > 0
             THEN ROUND(((price_per_unit - COALESCE(cost_per_unit, 0)) / price_per_unit) * 100, 2)
           ELSE 0
         END
   WHERE order_id = p_order_id;

  UPDATE public.orders
     SET status = 'fulfilled', updated_at = now()
   WHERE id = p_order_id;

  -- Keep the privileged trigger bypass narrowly bracketed. Leaving this GUC
  -- enabled would let later statements in the caller's transaction bypass
  -- unrelated immutability guards.
  PERFORM set_config('app.admin_override', 'false', true);

  SELECT ROUND(total_profit, 2) INTO v_total_profit
    FROM public.orders WHERE id = p_order_id;
  SELECT COALESCE(SUM(split_percentage), 0)
    INTO v_split_total
    FROM public.commissions
   WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'pending';

  IF EXISTS (
    SELECT 1 FROM public.commissions
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'pending'
  ) AND (
    abs(v_split_total - 100) > 0.01
    OR EXISTS (
      SELECT 1 FROM public.commissions
       WHERE order_id = p_order_id
         AND deleted_at IS NULL
         AND status = 'pending'
         AND split_percentage < 0
    )
  ) THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentages must be nonnegative and total 100.00 (actual total=%)', v_split_total;
  END IF;

  v_profit_cents := ROUND(GREATEST(COALESCE(v_total_profit, 0), 0) * 100)::bigint;
  WITH raw_allocations AS (
    SELECT c.id,
           c.split_percentage,
           (v_profit_cents::numeric * c.split_percentage / NULLIF(v_split_total, 0)) AS raw_cents
      FROM public.commissions c
     WHERE c.order_id = p_order_id
       AND c.deleted_at IS NULL
       AND c.status = 'pending'
  ), ranked AS (
    SELECT r.id,
           FLOOR(r.raw_cents)::bigint AS base_cents,
           row_number() OVER (
             ORDER BY (r.raw_cents - FLOOR(r.raw_cents)) DESC, r.id
           ) AS remainder_rank,
           SUM(FLOOR(r.raw_cents)::bigint) OVER () AS allocated_base_cents
      FROM raw_allocations r
  ), calculated AS (
    SELECT r.id,
           r.base_cents
             + CASE
                 WHEN r.remainder_rank <= v_profit_cents - r.allocated_base_cents THEN 1
                 ELSE 0
               END AS reconciled_cents
      FROM ranked r
  ), updated AS (
    UPDATE public.commissions c
       SET order_profit = COALESCE(v_total_profit, 0),
           commission_amount = calculated.reconciled_cents / 100.0
      FROM calculated
     WHERE c.id = calculated.id
     RETURNING c.id
  )
  SELECT count(*) INTO v_commissions_recomputed FROM updated;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_updated', 'order', p_order_id, 'admin',
    jsonb_build_object('status', v_order.status, 'items', v_item_snapshot),
    jsonb_build_object(
      'status', 'fulfilled',
      'released_quantity', v_released_quantity,
      'delivered_total_price', (SELECT total_price FROM public.orders WHERE id = p_order_id),
      'delivered_total_profit', v_total_profit,
      'commissions_recomputed', v_commissions_recomputed
    ),
    0,
    'Closed undelivered remainder for order ' || v_order.order_number ||
      '; delivered quantity remains fulfilled and billable'
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_remainder_closed',
    'Closed ' || v_released_quantity || ' undelivered unit(s) on order ' ||
      v_order.order_number || '; delivered quantity remains fulfilled',
    p_actor, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'mode', 'remainder_closed',
    'status', 'fulfilled',
    'order_number', v_order.order_number,
    'released_quantity', v_released_quantity,
    'deliveries_cancelled', v_deliveries_cancelled,
    'delivery_remainders_cancelled', v_remainders_cancelled,
    'holds_released', v_holds_released,
    'commissions_recomputed', v_commissions_recomputed,
    'commissions_cancelled', 0,
    'paid_commissions_flagged', 0,
    'draft_invoices_cancelled', 0,
    'posted_invoices_flagged', 0
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._close_undelivered_order_remainder_20260718(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the upstream provenance-aware, request-bound full-cancel wrapper as
-- an owner-only implementation. The public router below adds the safe
-- delivered-remainder close while keeping that wrapper as the only full-cancel
-- path, including its split-invoice transaction claims and provenance refresh.
ALTER FUNCTION public.cancel_order(uuid, uuid, text)
  RENAME TO _cancel_order_provenance_wrapper_20260719;
REVOKE ALL ON FUNCTION public._cancel_order_provenance_wrapper_20260719(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_order(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'cancel_order_v1';
  v_existing jsonb;
  v_request jsonb;
  v_fingerprint text;
  v_result jsonb;
  v_order_status text;
  v_has_delivered_quantity boolean;
  v_has_completed_delivery boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id
  );
  v_fingerprint := md5(v_request::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'cancel_order',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- complete_delivery locks its delivery before its parent order. Lock all
  -- deliveries deterministically first so cancellation follows the same order.
  PERFORM 1
    FROM public.deliveries
   WHERE order_id = p_order_id
   ORDER BY id
   FOR UPDATE;
  SELECT status INTO v_order_status
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.order_items
     WHERE order_id = p_order_id AND COALESCE(quantity_delivered, 0) > 0
  ) INTO v_has_delivered_quantity;
  SELECT EXISTS (
    SELECT 1 FROM public.deliveries
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'completed'
  ) INTO v_has_completed_delivery;

  IF v_has_completed_delivery AND NOT v_has_delivered_quantity THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: completed delivery exists without delivered order-item quantity';
  END IF;

  -- The UI and state machine expose "Cancel Remaining" only for a genuinely
  -- partially fulfilled order. Keep the mature full-cancel path canonical for
  -- confirmed orders (including governed split-draft fixtures) so the final
  -- PR #165 provenance-aware cancellation contract remains byte-for-byte owned
  -- by its preserved implementation.
  IF v_order_status = 'partially_fulfilled' THEN
    v_result := public._close_undelivered_order_remainder_20260718(
      p_order_id, v_actor
    );
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.returns r
       WHERE r.order_id = p_order_id
         AND r.deleted_at IS NULL
         AND r.status IN ('received', 'credited')
    ) THEN
      RAISE EXCEPTION 'ORDER_HAS_RECEIVED_RETURN';
    END IF;
    v_result := public._cancel_order_provenance_wrapper_20260719(
      p_order_id, v_actor, NULL
    ) || jsonb_build_object('mode', 'full_cancel', 'status', 'cancelled');
  END IF;

  -- The mature full-cancel implementation runs under a transaction-local
  -- admin override. Clear it before returning to the caller; the short-close
  -- helper already clears the same bracket internally.
  PERFORM set_config('app.admin_override', 'false', true);

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'cancel_order',
    v_contract,
    v_fingerprint,
    v_request,
    v_result
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_order(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text)
  TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.guard_order_delivered_activity_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.deleted_at IS NULL
     AND NEW.deleted_at IS NOT NULL
     AND OLD.status NOT IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'ORDER_MUST_BE_TERMINAL_BEFORE_DELETE';
  END IF;
  IF NEW.status IN ('cancelled', 'voided')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NOT public._is_admin_override() THEN
    RAISE EXCEPTION 'ORDER_TERMINAL_TRANSITION_USE_RPC: use cancel_order or void_order so inventory, draws, invoices, and commissions stay in sync';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_order_delivered_activity_cancel()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_order_delivered_activity_cancel ON public.orders;
CREATE TRIGGER guard_order_delivered_activity_cancel
BEFORE UPDATE OF status, deleted_at ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.guard_order_delivered_activity_cancel();

-- Central invoice invariant. Orderless accounting documents remain supported,
-- but browser table DML is revoked below. Every order-linked writer is guarded.
CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_status text;
  v_order_number text;
  v_order_deleted_at timestamptz;
  v_order_customer_id uuid;
  v_canonical_cancel_cleanup boolean := false;
  v_canonical_void_cleanup boolean := false;
  v_canonical_delete_cleanup boolean := false;
  v_existing_accounting_update boolean := false;
  v_valid_delivery_lineage boolean := false;
  v_valid_completed_delivery boolean := false;
  v_has_writer_capability boolean := false;
  v_has_poster_capability boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
  ) THEN
    RAISE EXCEPTION 'INVOICE_SOURCE_LINEAGE_IMMUTABLE: order_id and delivery_id cannot change after invoice creation';
  END IF;

  IF NEW.order_id IS NULL THEN
    IF NEW.delivery_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_ORDER_REQUIRED: a delivery-linked invoice must retain its source order';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id
     FOR UPDATE;
  ELSE
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach an invoice to missing order %', NEW.order_id;
  END IF;
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id THEN
    RAISE EXCEPTION 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match';
  END IF;

  IF NEW.delivery_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.deleted_at IS NULL
    ), EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.status = 'completed'
         AND d.deleted_at IS NULL
    ) INTO v_valid_delivery_lineage, v_valid_completed_delivery;
    IF NOT v_valid_delivery_lineage THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_LINEAGE_INVALID: delivery, order, and customer must match';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'writer'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ), EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'poster'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ) INTO v_has_writer_capability, v_has_poster_capability;

  IF TG_OP = 'UPDATE' THEN
    v_canonical_cancel_cleanup :=
      OLD.status IN ('draft', 'unposted')
      AND NEW.status = 'cancelled'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_void_cleanup :=
      OLD.status NOT IN ('cancelled', 'voided')
      AND NEW.status = 'voided'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_delete_cleanup :=
      OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NOT NULL
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    -- A posted invoice may legitimately survive an order cancellation. Keep
    -- payment state, due dates, and other accounting metadata maintainable,
    -- while forbidding a draft from being activated or any source/amount rewrite.
    v_existing_accounting_update :=
      OLD.status IN ('posted', 'overdue', 'paid')
      AND NEW.status IN ('posted', 'overdue', 'paid')
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;
  END IF;

  -- Exact historical exception: only the canonical recovery writer/poster may
  -- touch a matching completed-delivery invoice on a soft-deleted, otherwise
  -- fulfilled order. Cancelled and voided orders never receive this bypass.
  IF v_order_deleted_at IS NOT NULL
     AND v_order_status IN ('fulfilled', 'partially_fulfilled')
     AND v_valid_completed_delivery
     AND auth.uid() IS NOT NULL
     AND (
       (TG_OP = 'INSERT' AND v_has_writer_capability)
       OR (TG_OP = 'UPDATE' AND (v_has_writer_capability OR v_has_poster_capability))
     ) THEN
    RETURN NEW;
  END IF;

  IF v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL THEN
    IF v_canonical_cancel_cleanup
       OR v_canonical_void_cleanup
       OR v_canonical_delete_cleanup
       OR v_existing_accounting_update THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach or update a nonterminal invoice on cancelled, voided, or deleted order %',
      COALESCE(v_order_number, NEW.order_id::text);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_invoice_terminal_order()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_guard_invoice_terminal_order ON public.invoices;
CREATE TRIGGER trg_guard_invoice_terminal_order
BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.guard_invoice_terminal_order();

CREATE OR REPLACE FUNCTION public.guard_terminal_order_invoice_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.invoice_id ELSE OLD.invoice_id END;
  v_invoice_status text;
  v_order_status text;
  v_order_deleted_at timestamptz;
  v_delivery_id uuid;
  v_has_writer_capability boolean := false;
  v_valid_completed_delivery boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'INVOICE_ITEM_LINEAGE_IMMUTABLE: invoice_id cannot change after line creation';
  END IF;
  BEGIN
    SELECT i.status, o.status, o.deleted_at, i.delivery_id
      INTO v_invoice_status, v_order_status, v_order_deleted_at, v_delivery_id
      FROM public.invoices i
      JOIN public.orders o ON o.id = i.order_id
     WHERE i.id = v_invoice_id
     FOR UPDATE OF o NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'ORDER_LIFECYCLE_BUSY_RETRY: this order is being cancelled or voided; wait a moment and retry';
  END;
  IF FOUND AND (v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL) THEN
    IF TG_OP = 'DELETE'
       AND v_invoice_status IN ('cancelled', 'voided')
       AND public._is_admin_override() THEN
      RETURN OLD;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
       WHERE c.transaction_id = txid_current()
         AND c.purpose = 'writer'
         AND c.delivery_id = v_delivery_id
         AND c.actor_id = auth.uid()
    ), EXISTS (
      SELECT 1
        FROM public.deliveries d
        JOIN public.invoices i ON i.id = v_invoice_id
       WHERE d.id = v_delivery_id
         AND d.order_id = i.order_id
         AND d.customer_id = i.customer_id
         AND d.status = 'completed'
         AND d.deleted_at IS NULL
    ) INTO v_has_writer_capability, v_valid_completed_delivery;
    IF v_order_deleted_at IS NOT NULL
       AND v_order_status IN ('fulfilled', 'partially_fulfilled')
       AND v_valid_completed_delivery
       AND v_has_writer_capability
       AND auth.uid() IS NOT NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: invoice items cannot change on a cancelled, voided, or deleted order';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_terminal_order_invoice_items()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_guard_terminal_order_invoice_items ON public.invoice_items;
CREATE TRIGGER trg_guard_terminal_order_invoice_items
BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
FOR EACH ROW
EXECUTE FUNCTION public.guard_terminal_order_invoice_items();

-- Historical payment allocations and reversed write-offs are audit records, not
-- current customer credit. The report includes only active sets/entries.
CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(
  p_customer_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  transaction_date date,
  transaction_type text,
  reference_number text,
  description text,
  debit_cents bigint,
  credit_cents bigint,
  running_balance_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.require_admin();
  RETURN QUERY
  WITH all_transactions AS (
    SELECT i.invoice_date AS tx_date,
           'Invoice' AS tx_type,
           i.invoice_number AS ref_num,
           CASE i.invoice_type
             WHEN 'chemical_sale' THEN 'Chemical Sale'
             WHEN 'field_application' THEN 'Field Application'
             WHEN 'misc_charge' THEN 'Misc Charge'
             ELSE COALESCE(i.invoice_type, 'Invoice')
           END AS descr,
           i.total_amount_cents AS debit,
           0::bigint AS credit
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT als.payment_date,
           'Payment',
           COALESCE(als.reference_number, als.check_number, 'PMT-' || LEFT(als.id::text, 8)),
           COALESCE(als.payment_method, 'Payment') ||
             CASE WHEN als.check_number IS NOT NULL THEN ' #' || als.check_number ELSE '' END ||
             COALESCE(' — ' || als.notes, ''),
           0::bigint,
           ila.amount_cents
      FROM public.allocation_sets als
      JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = als.id
     WHERE als.customer_id = p_customer_id
       AND als.entity_type = 'payment'
       AND als.is_active = true
       AND als.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT pa.applied_at::date,
           'Prepay Applied',
           'PP-' || LEFT(pa.id::text, 8),
           'Prepay credit applied',
           0::bigint,
           pa.applied_amount_cents
      FROM public.prepay_applications pa
      JOIN public.invoices i ON i.id = pa.invoice_id
     WHERE i.customer_id = p_customer_id
       AND i.deleted_at IS NULL
       AND pa.applied_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT w.created_at::date,
           'Write-Off',
           'WO-' || LEFT(w.id::text, 8),
           COALESCE(w.reason, 'Write-off'),
           0::bigint,
           w.amount_cents
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.reversed_at IS NULL
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date,
         t.tx_type,
         t.ref_num,
         t.descr,
         t.debit,
         t.credit,
         (SUM(t.debit - t.credit) OVER (
           ORDER BY t.tx_date, t.tx_type, t.ref_num
         ))::bigint
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type, t.ref_num;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_transaction_review(uuid, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_transaction_review(uuid, date, date)
  TO authenticated, service_role;

-- Close the Data API backdoor. SELECT is intentionally untouched. Current
-- production writers are SECURITY DEFINER RPCs and retain their owner rights.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
ON TABLE public.invoices, public.invoice_items
FROM PUBLIC, anon, authenticated, service_role;

-- These legacy endpoints are tombstoned by earlier applied migrations. Remove
-- every browser/service grant as defense in depth; approved replacements remain.
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_source text;
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.void_invoice(uuid,text,text)'::regprocedure))
       <> 'c7a488d58bd876e92565bca9bd4edc90'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.void_invoice_group(uuid,text,text)'::regprocedure))
       <> 'fa19808b6ab6b0663663cd28c89a3326'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure))
       <> 'f7e0fe8f494fe160039df9aef46067df'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._void_invoice_group_guard_impl_20260720(uuid,text,text)'::regprocedure))
       <> '9f1656542c5c6a667b1c8a67034c5c3f'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'::regprocedure))
       <> '6eb68b6248b52328bfc94284e790ef85'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._cancel_order_provenance_wrapper_20260719(uuid,uuid,text)'::regprocedure))
       <> '26c8b52a1f1e1a5bdf460bd89b730111'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'::regprocedure))
       <> '6f7bfd6e0cc06bae9afb25e41610ebc8'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._post_invoice_public_impl_20260718(uuid,text)'::regprocedure))
       <> '39b9f427eb843e6cba859a1db62553a8'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'::regprocedure))
       <> '2fc0102fe8702f6c2d63c326a99c15dd' THEN
    RAISE EXCEPTION 'POSTFLIGHT: a wrapped live implementation changed during migration';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure;
  IF v_source NOT LIKE '%SPLIT_INVOICE_EDIT_REQUIRES_REISSUE%'
     OR v_source NOT LIKE '%_save_invoice_governed_split_guard_impl_20260720%'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure)
     OR NOT ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure
        ))
     OR has_function_privilege('anon', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.save_invoice(jsonb,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: governed split save guard drifted during migration';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.void_invoice(uuid,text,text)'::regprocedure;
  IF v_source NOT LIKE '%SPLIT_INVOICE_GROUP_VOID_REQUIRED%'
     OR v_source NOT LIKE '%_void_invoice_group_guard_impl_20260720%'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.void_invoice(uuid,text,text)'::regprocedure)
     OR NOT ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.void_invoice(uuid,text,text)'::regprocedure
        ))
     OR has_function_privilege('anon', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.void_invoice(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: governed split singular-void guard drifted during migration';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.void_invoice_group(uuid,text,text)'::regprocedure;
  IF v_source NOT LIKE '%void_invoice_group_v1%'
     OR v_source NOT LIKE '%_claim_bound_lifecycle_idempotency%'
     OR v_source NOT LIKE '%_bind_completed_lifecycle_idempotency%'
     OR v_source NOT LIKE '%every active member must have exact governed split provenance%'
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.void_invoice_group(uuid,text,text)'::regprocedure)
     OR NOT ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.void_invoice_group(uuid,text,text)'::regprocedure
        ))
     OR has_function_privilege('anon', 'public.void_invoice_group(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_invoice_group(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.void_invoice_group(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: governed split group-void contract drifted during migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'),
        ('public._void_invoice_group_guard_impl_20260720(uuid,text,text)')
      ) AS governed_private(signature)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(governed_private.signature)
     WHERE p.oid IS NULL
        OR NOT p.prosecdef
        OR ('search_path=public, pg_temp' = ANY (
             COALESCE(p.proconfig, ARRAY[]::text[])
           )) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: governed split private function properties drifted during migration';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.revert_quote_status(uuid,text,uuid,text)'::regprocedure;
  IF md5(v_source) <> 'fb0cc5def3766270b13c401810b61f3e'
     OR v_source NOT LIKE '%pg_advisory_xact_lock%'
     OR (length(v_source) - length(replace(v_source, 'pg_advisory_xact_lock', '')))
          / length('pg_advisory_xact_lock') < 2
     OR v_source NOT LIKE '%revert_quote_status_v1%'
     OR v_source NOT LIKE '%request_fingerprint%'
     OR v_source NOT LIKE '%IDEMPOTENCY_UNBOUND_REPLAY%'
     OR v_source NOT LIKE '%IDEMPOTENCY_REQUEST_MISMATCH%'
     OR v_source NOT LIKE '%INSERT INTO idempotency_keys%'
     OR v_source NOT LIKE '%UPDATE idempotency_keys%'
     OR 1 <> (
       SELECT count(*) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'revert_quote_status'
     )
     OR NOT (SELECT prosecdef FROM pg_proc
              WHERE oid = 'public.revert_quote_status(uuid,text,uuid,text)'::regprocedure)
     OR NOT ('search_path=public, pg_temp' = ANY (
          SELECT unnest(proconfig) FROM pg_proc
           WHERE oid = 'public.revert_quote_status(uuid,text,uuid,text)'::regprocedure
        ))
     OR EXISTS (
       SELECT 1
         FROM pg_proc p,
              aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE p.oid = 'public.revert_quote_status(uuid,text,uuid,text)'::regprocedure
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege('anon', 'public.revert_quote_status(uuid,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.revert_quote_status(uuid,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.revert_quote_status(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: governed revert_quote_status contract drifted during migration';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc
           WHERE oid = 'public.prevent_oifa_edit_after_post()'::regprocedure))
       <> '90a83898c13b7273d6e895691c619b88'
     OR md5((SELECT prosrc FROM pg_proc
              WHERE oid = 'public.guard_mono_invoice_split_billing_post()'::regprocedure))
       <> 'e643f573e529a7117c10ff1e8b89fad0'
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.order_item_field_allocations'::regclass
          AND tgname = 'trg_oifa_lock_when_posted'
          AND tgenabled <> 'D'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.invoices'::regclass
          AND tgname = 'guard_mono_invoice_split_billing_post'
          AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: upstream split-billing concurrency guard drifted during migration';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc
           WHERE oid = 'public.create_split_invoices_from_order(uuid,uuid,text,text)'::regprocedure))
       <> '398030fbb64006b4750e7e89a61b6cb9'
     OR md5((SELECT prosrc FROM pg_proc
              WHERE oid = 'public.delete_invoices(uuid[],uuid,text)'::regprocedure))
       <> '24c271164caa2369c57c3bdc5d88c50a'
     OR md5((SELECT prosrc FROM pg_proc
              WHERE oid = 'public.guard_split_invoice_provenance_identity()'::regprocedure))
       <> '639875d6641556c78c25d633c67821f1'
     OR md5((SELECT prosrc FROM pg_proc
              WHERE oid = 'public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)'::regprocedure))
       <> '0d6fe6c0c9ea71f11ce8cc233665eba2'
     OR md5((SELECT prosrc FROM pg_proc
              WHERE oid = 'public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)'::regprocedure))
       <> '5c72187a25c2a5b7c807edda36bac2cd' THEN
    RAISE EXCEPTION 'POSTFLIGHT: upstream split provenance or bound retry contract drifted during migration';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM (VALUES
           ('split_invoice_creation_claims'),
           ('split_invoice_mutation_claims'),
           ('split_invoice_provenance')
         ) AS protected(table_name)
         LEFT JOIN pg_class c
           ON c.oid = to_regclass(format('public.%I', protected.table_name))
        WHERE c.oid IS NULL OR NOT c.relrowsecurity
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('split_invoice_creation_claims'),
           ('split_invoice_mutation_claims'),
           ('split_invoice_provenance')
         ) AS protected(table_name)
        WHERE 1 <> (
          SELECT count(*)
            FROM pg_policies p
           WHERE p.schemaname = 'public'
             AND p.tablename = protected.table_name
        )
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('split_invoice_creation_claims'),
           ('split_invoice_mutation_claims'),
           ('split_invoice_provenance')
         ) AS protected(table_name)
         CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS access(privilege_name)
        WHERE has_table_privilege(
          api.role_name,
          format('public.%I', protected.table_name),
          access.privilege_name
        )
     ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: split claim/provenance tables are not private and fail-closed';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_constraint c
        WHERE c.conrelid = 'public.split_invoice_mutation_claims'::regclass
          AND c.conname = 'split_invoice_mutation_claims_operation_check'
          AND pg_get_constraintdef(c.oid) LIKE '%save_invoice%'
          AND pg_get_constraintdef(c.oid) LIKE '%delete_invoices%'
          AND pg_get_constraintdef(c.oid) LIKE '%void_invoice%'
          AND pg_get_constraintdef(c.oid) LIKE '%cancel_order%'
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.invoices'::regclass, 'require_split_invoice_creation_claim'),
           ('public.invoices'::regclass, 'guard_split_invoice_provenance_identity'),
           ('public.invoice_items'::regclass, 'guard_split_invoice_provenance_items'),
           ('public.invoices'::regclass, 'guard_mono_invoice_split_billing_post')
         ) AS required_trigger(table_oid, trigger_name)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_trigger t
           WHERE t.tgrelid = required_trigger.table_oid
             AND t.tgname = required_trigger.trigger_name
             AND t.tgenabled <> 'D'
             AND NOT t.tgisinternal
        )
     ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: split provenance constraint or trigger chain drifted during migration';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_class
        WHERE oid = 'public.invoice_delivery_recovery_capabilities'::regclass
          AND relrowsecurity
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'invoice_delivery_recovery_capabilities'
          AND policyname = 'invoice_delivery_recovery_capabilities_deny_all'
     )
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'SELECT')
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'INSERT')
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'UPDATE')
     OR has_table_privilege('anon', 'public.invoice_delivery_recovery_capabilities', 'DELETE')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'SELECT')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoice_delivery_recovery_capabilities', 'DELETE')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'SELECT')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'INSERT')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'UPDATE')
     OR has_table_privilege('service_role', 'public.invoice_delivery_recovery_capabilities', 'DELETE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: recovery capability table is not private and fail-closed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.create_invoice_for_unbilled_delivery(uuid,uuid,text)'::regprocedure;
  IF v_source NOT LIKE '%invoice_delivery_recovery_capabilities%'
     OR v_source NOT LIKE '%o.deleted_at IS NOT NULL%'
     OR v_source NOT LIKE '%o.status IN (''fulfilled'', ''partially_fulfilled'')%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: deleted completed-delivery recovery writer markers missing';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.post_invoice(uuid,text)'::regprocedure;
  IF v_source NOT LIKE '%_post_deleted_delivery_recovery_invoice_20260719%'
     OR v_source NOT LIKE '%_post_invoice_public_impl_20260718%'
     OR v_source NOT LIKE '%o.customer_id = i.customer_id%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: recovery/ordinary posting router markers missing';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public._post_deleted_delivery_recovery_invoice_20260719(uuid)'::regprocedure;
  IF v_source NOT LIKE '%v_inv.customer_id IS DISTINCT FROM v_order_customer_id%'
     OR v_source NOT LIKE '%FROM public.orders%FOR UPDATE%'
     OR v_source NOT LIKE '%FROM public.invoices%FOR UPDATE%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: recovery poster customer validation or lock hierarchy missing';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.cancel_order(uuid,uuid,text)'::regprocedure;
  IF v_source NOT LIKE '%_close_undelivered_order_remainder_20260718%'
     OR v_source NOT LIKE '%_cancel_order_provenance_wrapper_20260719%'
     OR v_source NOT LIKE '%_claim_bound_lifecycle_idempotency%'
     OR v_source NOT LIKE '%_bind_completed_lifecycle_idempotency%'
     OR v_source NOT LIKE '%cancel_order_v1%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: cancel_order wrapper markers missing';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public.get_customer_transaction_review(uuid,date,date)'::regprocedure;
  IF v_source NOT LIKE '%als.is_active = true%'
     OR v_source NOT LIKE '%w.reversed_at IS NULL%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: transaction report active-history filters missing';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid = 'public._enforce_delivery_items_parent_lock()'::regprocedure;
  IF v_source NOT LIKE '%FOR UPDATE OF d NOWAIT%'
     OR v_source NOT LIKE '%FOR UPDATE OF oi NOWAIT%'
     OR v_source NOT LIKE '%DELIVERY_ITEM_LINEAGE_INVALID%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: delivery-item serialization or lineage markers missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.order_items'::regclass
       AND tgname = 'guard_order_item_delivery_lineage'
       AND tgenabled <> 'D'
  ) OR (SELECT prosrc FROM pg_proc
         WHERE oid = 'public._guard_order_item_delivery_lineage()'::regprocedure)
       NOT LIKE '%ORDER_ITEM_DELIVERY_LINEAGE_LOCKED%' THEN
    RAISE EXCEPTION 'POSTFLIGHT: order-item delivery-lineage guard missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.orders'::regclass
       AND tgname = 'guard_order_delivered_activity_cancel'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.orders'::regclass
       AND tgname = 'guard_order_customer_source_lineage'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.invoices'::regclass
       AND tgname = 'trg_guard_invoice_terminal_order'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.invoice_items'::regclass
       AND tgname = 'trg_guard_terminal_order_invoice_items'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: lifecycle guard trigger missing or disabled';
  END IF;

  IF has_table_privilege('authenticated', 'public.invoices', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoices', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoices', 'DELETE')
     OR has_table_privilege('authenticated', 'public.invoices', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'DELETE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.invoices', 'INSERT')
     OR has_table_privilege('service_role', 'public.invoices', 'UPDATE')
     OR has_table_privilege('service_role', 'public.invoices', 'DELETE')
     OR has_table_privilege('service_role', 'public.invoices', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.invoice_items', 'INSERT')
     OR has_table_privilege('service_role', 'public.invoice_items', 'UPDATE')
     OR has_table_privilege('service_role', 'public.invoice_items', 'DELETE')
     OR has_table_privilege('service_role', 'public.invoice_items', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: an API role retains direct invoice DML';
  END IF;
  IF has_table_privilege('anon', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('anon', 'public.financial_audit_log', 'UPDATE')
     OR has_table_privilege('anon', 'public.financial_audit_log', 'DELETE')
     OR has_table_privilege('anon', 'public.financial_audit_log', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'DELETE')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'UPDATE')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'DELETE')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'TRUNCATE')
     OR EXISTS (
       SELECT 1
         FROM pg_class c,
              aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
        WHERE c.oid = 'public.financial_audit_log'::regclass
          AND acl.grantee = 0
          AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: direct financial audit-log mutation privilege returned';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.invoices', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.invoice_items', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT: invoice SELECT access was accidentally removed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public._split_invoice_content_claim(uuid)'),
        ('public.require_split_invoice_creation_claim()'),
        ('public.guard_split_invoice_provenance_identity()'),
        ('public.guard_split_invoice_provenance_items()'),
        ('public.guard_mono_invoice_split_billing_post()'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'),
        ('public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)'),
        ('public._delete_invoices_split_provenance_impl_20260719(uuid[],uuid,text)'),
        ('public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)'),
        ('public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)'),
        ('public._void_invoice_split_provenance_impl_20260719(uuid,text,text)'),
        ('public._void_invoice_group_guard_impl_20260720(uuid,text,text)'),
        ('public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'),
        ('public._cancel_order_split_provenance_impl_20260719(uuid,uuid,text)'),
        ('public._cancel_order_provenance_wrapper_20260719(uuid,uuid,text)'),
        ('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'),
        ('public._post_invoice_public_impl_20260718(uuid,text)'),
        ('public._post_invoice_impl_20260714(uuid,text)'),
        ('public._post_invoice_customer_scope_impl(uuid,text)'),
        ('public._post_deleted_delivery_recovery_invoice_20260719(uuid)'),
        ('public._create_invoice_for_unbilled_delivery_impl_20260718(uuid,uuid,text)'),
        ('public._close_undelivered_order_remainder_20260718(uuid,uuid)'),
        ('public._enforce_delivery_items_parent_lock()'),
        ('public._guard_order_item_delivery_lineage()'),
        ('public._guard_order_customer_source_lineage()'),
        ('public.guard_order_delivered_activity_cancel()'),
        ('public.guard_invoice_terminal_order()'),
        ('public.guard_terminal_order_invoice_items()')
      ) AS private_fn(signature)
      CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
     WHERE to_regprocedure(private_fn.signature) IS NULL
        OR has_function_privilege(api.role_name, private_fn.signature, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: a browser or service role can execute a private money implementation';
  END IF;

  IF has_function_privilege('authenticated', 'public.record_invoice_payment(uuid,bigint,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.record_invoice_payment(uuid,bigint,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.restore_cancelled_order(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.restore_cancelled_order(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: a retired legacy endpoint remains executable';
  END IF;
END;
$postflight$;
