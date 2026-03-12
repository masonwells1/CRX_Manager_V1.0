-- Wave 4 Security & Integrity Fixes
-- H17: create_commission_payment missing admin role check
-- H19: create_prepay_credit missing admin role check
-- M25: customers.prepay_balance_cents can go negative (no CHECK)
-- M26: order_items.quantity can be negative (no CHECK)
-- M6:  create_prepay_check_splits — atomic batch prepay insert + balance update

BEGIN;

-- =============================================================
-- H17: Add admin role check to create_commission_payment
-- Latest version is in 20260315200001 (SET search_path = '')
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[],
  p_payment_method text,
  p_reference      text,
  p_payment_date   date,
  p_notes          text,
  p_performed_by   uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
  v_actor_role   text;
BEGIN
  -- H17: Admin-only guard
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = p_performed_by;

  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can create commission payments';
  END IF;

  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  -- Enforce accounting period
  PERFORM public.check_period_open(v_payment_dt);

  -- Validate at least one commission
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Lock commissions FOR UPDATE to prevent double-pay
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid'
     FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No unpaid commissions found for the given IDs';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM public.commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- Calculate total
  SELECT sum(c.commission_amount)
    INTO v_total
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  -- Season uses end-year convention
  v_season := CASE
    WHEN extract(month FROM v_payment_dt) >= 7
    THEN extract(year FROM v_payment_dt)::integer + 1
    ELSE extract(year FROM v_payment_dt)::integer
  END;

  -- Generate payment number
  v_payment_num := public.next_commission_payment_number();

  -- Create the payment
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, p_performed_by
  ) RETURNING id INTO v_payment_id;

  -- Create line items
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM public.commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status != 'paid'
  LOOP
    INSERT INTO public.commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- Mark commissions as paid
  UPDATE public.commissions
     SET status = 'paid', updated_at = now()
   WHERE id = ANY(p_commission_ids)
     AND status != 'paid';

  -- Financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    p_performed_by, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created for $' ||
    to_char(v_total, 'FM999,999,990.00')
  );

  RETURN v_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) TO authenticated;


-- =============================================================
-- H19: Add admin role check to create_prepay_credit
-- Original is in 20260213100000 (no search_path, uses auth.uid())
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_prepay_credit(
  p_customer_id      uuid,
  p_amount_cents     bigint,
  p_payment_method   text DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit_id  uuid;
  v_actor_role text;
BEGIN
  -- H19: Admin-only guard
  SELECT role INTO v_actor_role
    FROM profiles
   WHERE id = auth.uid();

  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can create prepay credits';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Prepay amount must be positive';
  END IF;

  INSERT INTO prepay_credits (
    customer_id, original_amount_cents, balance_cents,
    payment_method, reference_number, notes
  ) VALUES (
    p_customer_id, p_amount_cents, p_amount_cents,
    p_payment_method, p_reference_number, p_notes
  )
  RETURNING id INTO v_credit_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_created', 'prepay', v_credit_id,
    v_actor_role,
    jsonb_build_object('customer_id', p_customer_id, 'amount_cents', p_amount_cents),
    p_amount_cents,
    'Prepay credit of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' created'
  );

  -- Activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'prepay_created',
    'Prepay credit of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' created',
    auth.uid(), 'prepay', v_credit_id, p_customer_id
  );

  RETURN v_credit_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_prepay_credit(uuid, bigint, text, text, text) TO authenticated;


-- =============================================================
-- M6: Atomic batch prepay credit creation (replaces non-atomic
--     insert + increment pattern in PrepaymentManager.tsx)
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_prepay_check_splits(
  p_customer_id      uuid,
  p_reference_number text,
  p_splits           jsonb,   -- [{label, amount_cents}]
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role    text;
  v_split         jsonb;
  v_total_cents   bigint := 0;
  v_credit_id     uuid;
  v_credit_ids    uuid[] := '{}';
  v_label         text;
  v_amount_cents  bigint;
BEGIN
  -- Admin-only
  SELECT role INTO v_actor_role
    FROM profiles
   WHERE id = p_performed_by;

  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can create prepay credits';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE
      v_existing jsonb;
    BEGIN
      v_existing := public.check_idempotency(p_idempotency_key, 'create_prepay_check_splits');
      IF (v_existing->>'status') = 'completed' THEN
        RETURN v_existing->'result';
      END IF;
    END;
  END IF;

  -- Validate splits
  IF jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'At least one split is required';
  END IF;

  -- Insert each split and accumulate total
  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits)
  LOOP
    v_label       := v_split->>'label';
    v_amount_cents := (v_split->>'amount_cents')::bigint;

    IF v_amount_cents <= 0 THEN
      RAISE EXCEPTION 'Each split amount must be positive';
    END IF;

    INSERT INTO prepay_credits (
      customer_id, original_amount_cents, balance_cents,
      payment_method, reference_number, notes
    ) VALUES (
      p_customer_id, v_amount_cents, v_amount_cents,
      'check',
      p_reference_number,
      'Check #' || p_reference_number || ' — ' || v_label
    )
    RETURNING id INTO v_credit_id;

    v_credit_ids  := v_credit_ids || v_credit_id;
    v_total_cents := v_total_cents + v_amount_cents;
  END LOOP;

  -- Atomically update customer aggregate balance
  UPDATE customers
     SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_cents
   WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer % not found', p_customer_id;
  END IF;

  -- Single audit log entry for the whole batch
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_check_splits_created', 'customer', p_customer_id,
    v_actor_role,
    jsonb_build_object(
      'reference_number', p_reference_number,
      'splits', jsonb_array_length(p_splits),
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Check #' || p_reference_number || ' split into ' ||
    jsonb_array_length(p_splits) || ' bucket(s) — $' ||
    (v_total_cents / 100.0)::numeric(12,2)
  );

  DECLARE
    v_result jsonb;
  BEGIN
    v_result := jsonb_build_object(
      'credit_ids', to_jsonb(v_credit_ids),
      'total_cents', v_total_cents
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM public.save_idempotency(
        p_idempotency_key,
        'create_prepay_check_splits',
        v_result
      );
    END IF;

    RETURN v_result;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text) TO authenticated;


-- =============================================================
-- M25: Prevent customers.prepay_balance_cents from going negative
-- =============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'customers'
       AND constraint_name = 'chk_customers_prepay_balance_non_negative'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT chk_customers_prepay_balance_non_negative
      CHECK (prepay_balance_cents >= 0);
  END IF;
END $$;


-- =============================================================
-- M26: Prevent order_items.quantity from being negative
-- quantity_delivered and quantity_remaining already have checks
-- =============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'order_items'
       AND constraint_name = 'chk_oi_quantity_non_negative'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT chk_oi_quantity_non_negative
      CHECK (quantity >= 0);
  END IF;
END $$;


COMMIT;
