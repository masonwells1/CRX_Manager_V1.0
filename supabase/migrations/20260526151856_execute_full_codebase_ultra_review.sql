-- Execute 2026-05-25 full-codebase ultra review fixes.
-- idempotency-body-check: exempt
--   Every RPC in this file routes through the canonical check_idempotency /
--   save_idempotency helper pair instead of inlining the literal
--   `INSERT INTO idempotency_keys` / `SELECT FROM idempotency_keys` block.
--   The schema-aware hook's regex only recognizes the literal pattern, so
--   the file-level marker tells it to stand down — matches the convention
--   used by 20260513020000_canonical_commission_math and other helper-only
--   migrations.
--
-- Scope:
--   - Revoke anonymous write-oriented SECURITY DEFINER RPC access.
--   - Add strict auth/actor gates to high-risk financial RPCs.
--   - Restore server-side commission split validation and reconcile split
--     rounding through the canonical commission helper.
--   - Consolidate next_invoice_number to one overload and synchronize the
--     INV sequence with legacy MAX-scan callers under the same advisory lock.
--   - Honor idempotency on duplicate_quote, create_followup_delivery, and
--     generate_finance_charges; serialize finance charge generation.
--   - Allow unposted commission payments to be voided so commissions are not
--     stranded.
--   - Reject blank delivery signatures at the database boundary.

BEGIN;

-- ---------------------------------------------------------------------------
-- B6 (2026-05-26 parallel audit): ensure cm_invoice_number_seq exists.
-- The historical migration 20260316100002_return_credit_ar_integration.sql
-- creates this sequence on disk but was never applied to live (verified via
-- list_migrations). next_invoice_number('credit_memo') below references this
-- sequence and would crash on the first credit-memo issuance otherwise.
-- See docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §10.3 B6.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.cm_invoice_number_seq;

-- ---------------------------------------------------------------------------
-- RLS-1/RLS-2: remove anon/public write surfaces.
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM anon;

DO $$
DECLARE
  v_func record;
  v_func_sig text;
BEGIN
  FOR v_func IN
    SELECT
      p.oid,
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid) AS identity_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname !~ '^_'
      -- C1 (2026-05-26 parallel audit): include auto/retry/revert prefixes to
      -- cover auto_expire_quotes, retry_failed_notifications, revert_quote_status
      -- (each anon-callable SECURITY DEFINER, mutating-or-cron-style, missed
      -- by the original prefix set). See §10.4 of the disposition doc.
      AND p.proname ~* '^(apply|approve|auto|batch|cancel|close|complete|confirm|convert|create|delete|duplicate|edit|generate|issue|link|load|manual|mark|post|receive|reassign|record|reconcile|release|reopen|restore|retire|retry|reverse|revert|rollover|save|start|transition|transfer|unlink|update|void)'
  LOOP
    v_func_sig := format('%I.%I(%s)', v_func.nspname, v_func.proname, v_func.identity_args);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_func_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_func_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_func_sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- B4 (2026-05-26 parallel audit): execute_sql_readonly does not match the
-- prefix regex above (prefix execute_). It is SECURITY DEFINER owned by
-- postgres and accepts arbitrary SELECT/WITH, running as owner — anon would
-- bypass RLS on every public table. Only frontend caller is a dev test
-- (schemaIntegrityLive), so revoking anon EXECUTE has zero production impact.
-- See docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §10.3 B4.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.execute_sql_readonly(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.execute_sql_readonly(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.execute_sql_readonly(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- B5 (2026-05-26 parallel audit): unapply_credit_memo has the same actor-
-- forgery anti-pattern as the RLS-1 cluster — v_actor := COALESCE(p_performed_by,
-- auth.uid()) lets a caller pass any admin UUID and the SECURITY DEFINER role
-- check still passes because the function runs as postgres. The prefix
-- 'unapply' is not matched by the regex above. Latent today (zero credit_memo
-- rows in live) but exploitable once issue_return_credit creates them.
-- See docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §10.3 B5.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Shared commission validation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_commission_split_json(p_split jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_split jsonb;
  v_recipient text;
  v_seen text[] := ARRAY[]::text[];
  v_percentage numeric;
  v_total numeric := 0;
BEGIN
  IF p_split IS NULL OR p_split = 'null'::jsonb THEN
    RETURN;
  END IF;

  IF jsonb_typeof(p_split) <> 'object'
     OR NOT (p_split ? 'splits')
     OR jsonb_typeof(p_split->'splits') <> 'array' THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: expected object with splits array';
  END IF;

  IF jsonb_array_length(p_split->'splits') = 0 THEN
    RETURN;
  END IF;

  FOR v_split IN SELECT value FROM jsonb_array_elements(p_split->'splits')
  LOOP
    v_recipient := NULLIF(btrim(v_split->>'recipient'), '');
    IF v_recipient IS NULL THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient is required';
    END IF;

    IF lower(v_recipient) = ANY(v_seen) THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: duplicate recipient %', v_recipient;
    END IF;
    v_seen := array_append(v_seen, lower(v_recipient));

    BEGIN
      v_percentage := (v_split->>'percentage')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: invalid percentage for %', v_recipient;
    END;

    IF v_percentage <= 0 OR v_percentage > 100 THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentage out of range for %', v_recipient;
    END IF;

    v_total := v_total + v_percentage;
  END LOOP;

  IF abs(v_total - 100) > 0.01 THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentages total %.2f, expected 100.00', v_total;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_commission_split_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_commission_split_json(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.compute_commission_amount(
  p_profit numeric,
  p_percentage numeric
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT GREATEST(ROUND(COALESCE(p_profit, 0) * COALESCE(p_percentage, 0) / 100, 2), 0);
$$;

REVOKE ALL ON FUNCTION public.compute_commission_amount(numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_commission_amount(numeric, numeric) TO authenticated;

-- Note on SECURITY INVOKER (changed from SECURITY DEFINER in 20260513020000):
-- The 3 wrappers that reach this helper (convert_quote_to_order,
-- create_direct_order, create_quick_delivery) are SECURITY DEFINER owned by
-- `postgres`. When they call this helper, CURRENT_USER is already `postgres`
-- via the wrapper's security context, so the INSERT into commissions still
-- works (postgres owns the table and bypasses RLS). Marking the helper as
-- SECURITY INVOKER reduces blast radius: if the EXECUTE-revoke on the helper
-- ever regressed, a direct caller would run with their own privileges
-- (and hit the commissions RLS policy) instead of escalating to postgres.
CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id uuid,
  p_customer_id uuid,
  p_order_profit numeric,
  p_commission_split jsonb,
  p_order_date date DEFAULT current_date
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  WITH split_rows AS (
    SELECT
      s,
      ord,
      row_number() OVER (ORDER BY ord) AS rn,
      count(*) OVER () AS split_count,
      s->>'recipient' AS recipient,
      (s->>'percentage')::numeric AS percentage
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
    WHERE NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
      AND (s->>'percentage')::numeric > 0
  ),
  calculated AS (
    SELECT
      sr.*,
      CASE
        WHEN sr.rn = sr.split_count THEN
          GREATEST(ROUND(COALESCE(p_order_profit, 0), 2), 0)
          - COALESCE(
              SUM(public.compute_commission_amount(p_order_profit, sr.percentage))
                OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
              0
            )
        ELSE public.compute_commission_amount(p_order_profit, sr.percentage)
      END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT
    p_order_id,
    p_customer_id,
    c.recipient,
    (
      SELECT p.id
      FROM public.profiles p
      WHERE lower(trim(p.full_name)) = lower(trim(c.recipient))
        AND p.is_active = true
        AND (
          SELECT count(*)
          FROM public.profiles p2
          WHERE lower(trim(p2.full_name)) = lower(trim(c.recipient))
            AND p2.is_active = true
        ) = 1
      LIMIT 1
    ),
    c.percentage,
    c.reconciled_amount,
    COALESCE(p_order_profit, 0),
    p_order_date,
    'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM authenticated;

-- ---------------------------------------------------------------------------
-- COMM-2: save_customer validates default_commission_split server-side.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_customer(
  p_customer_id uuid,
  p_customer_payload jsonb,
  p_addresses jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_incoming_ids uuid[];
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor
      AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_customer');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
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
      finance_charge_rate, finance_charge_enabled, finance_charge_grace_days
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
      COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0)
    ) RETURNING id INTO v_customer_id;
  ELSE
    v_customer_id := p_customer_id;
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

  v_result := jsonb_build_object('status', 'saved', 'customer_id', v_customer_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_customer', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_customer(uuid, jsonb, jsonb, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS-1: strict actor gates on high-risk financial RPCs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_write_off(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_invoice record;
  v_wo_id uuid;
  v_cached_result jsonb;
  v_new_write_off bigint;
  v_new_balance bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := public.check_idempotency(p_idempotency_key, 'apply_write_off');
    IF v_cached_result IS NOT NULL THEN
      RETURN (v_cached_result->>'id')::uuid;
    END IF;
  END IF;

  SELECT id, customer_id, balance_cents, status, write_off_cents,
         invoice_number, invoice_date, total_amount_cents,
         paid_amount_cents, prepay_applied_cents
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;
  IF v_invoice.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'INVALID_INVOICE_STATUS: %', v_invoice.status;
  END IF;
  PERFORM public.check_period_open(CURRENT_DATE);
  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_amount_cents > v_invoice.balance_cents THEN RAISE EXCEPTION 'AMOUNT_EXCEEDS_BALANCE'; END IF;

  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, approved_by, created_by)
  VALUES (p_invoice_id, v_invoice.customer_id, p_amount_cents, p_reason, v_actor, v_actor)
  RETURNING id INTO v_wo_id;

  v_new_write_off := COALESCE(v_invoice.write_off_cents, 0) + p_amount_cents;
  v_new_balance := v_invoice.total_amount_cents
                 - v_invoice.paid_amount_cents
                 - v_invoice.prepay_applied_cents
                 - v_new_write_off;

  UPDATE public.invoices
     SET write_off_cents = v_new_write_off,
         status = CASE WHEN v_new_balance <= 0 THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'write_off_applied', 'write_off', v_wo_id,
    v_actor, -p_amount_cents,
    'Write-off of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
    ' on invoice ' || v_invoice.invoice_number || ': ' || p_reason ||
    CASE WHEN v_new_balance <= 0 THEN ' (fully settled - status set to paid)' ELSE '' END
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'apply_write_off',
      jsonb_build_object('id', v_wo_id)
    );
  END IF;

  RETURN v_wo_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_write_off(uuid, bigint, text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.issue_return_credit(
  p_return_id uuid,
  p_actor_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_return record;
  v_total bigint;
  v_invoice_id uuid;
  v_invoice_num text;
  v_customer_id uuid;
  v_order_id uuid;
  v_return_number text;
  v_salesman_id uuid;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT r.id, r.status, r.customer_id, r.order_id, r.return_number
    INTO v_return
    FROM returns r
   WHERE r.id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND'; END IF;
  IF v_return.status <> 'received' THEN RAISE EXCEPTION 'INVALID_RETURN_STATUS: %', v_return.status; END IF;

  v_customer_id := v_return.customer_id;
  v_order_id := v_return.order_id;
  v_return_number := v_return.return_number;

  PERFORM check_period_open(CURRENT_DATE);

  SELECT COALESCE(SUM(ri.extended_cents), 0)
    INTO v_total
    FROM return_items ri
   WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN RAISE EXCEPTION 'RETURN_CREDIT_EMPTY'; END IF;

  v_invoice_num := next_invoice_number('credit_memo');

  IF v_order_id IS NOT NULL THEN
    SELECT o.salesman_id INTO v_salesman_id
      FROM orders o
     WHERE o.id = v_order_id;
  END IF;

  INSERT INTO invoices (
    invoice_number, order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, paid_amount_cents,
    prepay_applied_cents, posted_by, posted_at, invoice_date, due_date,
    header_notes, parent_invoice_id
  ) VALUES (
    v_invoice_num, v_order_id, v_customer_id, 'credit_memo', 'posted', current_season(),
    v_salesman_id, v_actor, -v_total, 0, 0, v_actor, now(),
    CURRENT_DATE, CURRENT_DATE,
    'Credit memo for return ' || v_return_number, NULL
  )
  RETURNING id INTO v_invoice_id;

  UPDATE returns
     SET status = 'credited',
         total_credit_cents = v_total,
         credit_invoice_id = v_invoice_id,
         credited_at = now(),
         credited_by = v_actor,
         updated_at = now()
   WHERE id = p_return_id;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'credit_memo_created', 'credit_memo', v_invoice_id,
    v_actor, -v_total,
    'Credit memo ' || v_invoice_num || ' created for return ' || v_return_number,
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_num,
      'return_id', p_return_id,
      'return_number', v_return_number,
      'customer_id', v_customer_id,
      'credit_amount_cents', v_total
    )
  );

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    v_actor, -v_total,
    'Credit issued for return ' || v_return_number || ' -> invoice ' || v_invoice_num,
    jsonb_build_object(
      'credit_invoice_id', v_invoice_id,
      'credit_invoice_number', v_invoice_num,
      'credit_amount_cents', v_total,
      'customer_id', v_customer_id
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return_number,
    'credit_invoice_id', v_invoice_id,
    'credit_invoice_number', v_invoice_num,
    'credit_amount_cents', v_total,
    'customer_id', v_customer_id,
    'credited_at', now()
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'issue_return_credit', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_return_credit(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_order(
  p_order_id uuid,
  p_performed_by uuid,
  p_reason text DEFAULT 'Voided by admin',
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_order record;
  v_item record;
  v_invoice record;
  v_admin record;
  v_inventory_restored integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATUS: %', v_order.status;
  END IF;

  UPDATE public.orders
    SET status = 'voided',
        updated_at = now()
  WHERE id = p_order_id;

  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
    WHERE product_id = v_item.product_id
      AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'adjusted',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      v_actor,
      'Restored ' || v_item.quantity_delivered || ' units - order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  UPDATE public.commissions
    SET status = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type,
        related_entity_type,
        related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE public.invoices
        SET status = 'voided',
            voided_by = v_actor,
            voided_at = now(),
            void_reason = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number ||
          ' - order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;
    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type,
          related_entity_type,
          related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order - Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) voided.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'voided',
    'order_number', v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- MIG-1/MIG-2: one canonical invoice-number function.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text := extract(year FROM now())::text;
  v_seq int;
  v_max int;
  v_prefix text;
  v_sequence regclass;
BEGIN
  CASE p_invoice_type
    WHEN 'chemical_sale' THEN
      v_prefix := 'CS';
      v_sequence := 'public.cs_invoice_number_seq'::regclass;
    WHEN 'misc_charge' THEN
      v_prefix := 'MC';
      v_sequence := 'public.mc_invoice_number_seq'::regclass;
    WHEN 'credit_memo' THEN
      v_prefix := 'CM';
      v_sequence := 'public.cm_invoice_number_seq'::regclass;
    ELSE
      v_prefix := 'INV';
      v_sequence := 'public.invoice_number_seq'::regclass;
  END CASE;

  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));

  SELECT COALESCE(MAX(regexp_replace(invoice_number, '^' || v_prefix || '-[0-9]{4}-', '')::integer), 0)
    INTO v_max
    FROM public.invoices
   WHERE invoice_number ~ ('^' || v_prefix || '-' || v_year || '-[0-9]+$');

  v_seq := nextval(v_sequence);
  IF v_seq <= v_max THEN
    PERFORM setval(v_sequence, v_max, true);
    v_seq := nextval(v_sequence);
  END IF;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

ALTER TABLE public.invoices
  ALTER COLUMN invoice_number SET DEFAULT public.next_invoice_number('field_application');

DROP FUNCTION IF EXISTS public.next_invoice_number();

REVOKE ALL ON FUNCTION public.next_invoice_number(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.next_invoice_number(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.next_invoice_number(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- IDEM-1/IDEM-2: duplicate_quote, follow-up delivery, finance charges.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.duplicate_quote(uuid, uuid);
DROP FUNCTION IF EXISTS public.duplicate_quote(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.duplicate_quote(
  p_source_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_orig record;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section record;
  v_new_section_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'duplicate_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_orig FROM quotes WHERE id = p_source_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTE_NOT_FOUND'; END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, valid_days, expires_at,
    header_notes, footer_notes
  ) VALUES (
    v_new_quote_number,
    v_orig.customer_id,
    v_actor,
    v_orig.tier,
    'draft',
    v_orig.commission_split,
    v_orig.total_price,
    v_orig.total_cost,
    v_orig.total_profit,
    v_orig.total_margin_pct,
    COALESCE(v_orig.valid_days, 15),
    now() + (COALESCE(v_orig.valid_days, 15) || ' days')::interval,
    v_orig.header_notes,
    v_orig.footer_notes
  ) RETURNING id INTO v_new_quote_id;

  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_source_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (
      quote_id, section_name, sort_order, section_notes
    ) VALUES (
      v_new_quote_id,
      v_section.section_name,
      v_section.sort_order,
      v_section.section_notes
    ) RETURNING id INTO v_new_section_id;

    INSERT INTO quote_items (
      quote_id, section_id, product_id, sort_order, notes,
      price_per_unit, current_cost, suggested_rate, actual_rate,
      rate_unit, oz_per_acre, price_per_acre, acres,
      total_units_needed, unit_size, profit, total_price, net_margin
    )
    SELECT
      v_new_quote_id,
      v_new_section_id,
      product_id, sort_order, notes,
      price_per_unit, current_cost, suggested_rate, actual_rate,
      rate_unit, oz_per_acre, price_per_acre, acres,
      total_units_needed, unit_size, profit, total_price, net_margin
    FROM quote_items
    WHERE quote_id = p_source_quote_id AND section_id = v_section.id
    ORDER BY sort_order;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'quote_created',
    'Quote ' || v_new_quote_number || ' duplicated from ' || v_orig.quote_number,
    v_actor, 'quote', v_new_quote_id, v_orig.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'duplicated',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'duplicate_quote', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_quote(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.duplicate_quote(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.duplicate_quote(uuid, uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS public.create_followup_delivery(uuid, date, uuid);
DROP FUNCTION IF EXISTS public.create_followup_delivery(uuid, date, uuid, text);

CREATE OR REPLACE FUNCTION public.create_followup_delivery(
  p_original_delivery_id uuid,
  p_scheduled_date date DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_original record;
  v_rem record;
  v_new_del_id uuid;
  v_del_number text;
  v_item_count integer := 0;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_followup_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_original
  FROM deliveries
  WHERE id = p_original_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_NOT_FOUND'; END IF;

  PERFORM 1 FROM delivery_remainders
  WHERE original_delivery_id = p_original_delivery_id AND status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PENDING_REMAINDERS';
  END IF;

  SELECT next_delivery_number() INTO v_del_number;

  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, delivery_address_id,
    assigned_driver, scheduled_date, scheduled_time, delivery_notes,
    status, priority, created_by
  ) VALUES (
    v_del_number,
    v_original.order_id,
    v_original.customer_id,
    v_original.delivery_address_id,
    v_original.assigned_driver,
    COALESCE(p_scheduled_date, CURRENT_DATE + interval '1 day'),
    v_original.scheduled_time,
    'Follow-up for ' || v_original.delivery_number,
    'scheduled',
    v_original.priority,
    v_actor
  )
  RETURNING id INTO v_new_del_id;

  FOR v_rem IN
    SELECT * FROM delivery_remainders
    WHERE original_delivery_id = p_original_delivery_id AND status = 'pending'
    FOR UPDATE
  LOOP
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_new_del_id,
      v_rem.order_item_id,
      v_rem.product_id,
      v_rem.quantity_remaining,
      v_rem.unit_size
    );

    UPDATE delivery_remainders SET
      status = 'scheduled',
      followup_delivery_id = v_new_del_id,
      updated_at = now()
    WHERE id = v_rem.id;

    v_item_count := v_item_count + 1;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'delivery_created',
    'Follow-up delivery ' || v_del_number || ' created from ' || v_original.delivery_number || ' remainders (' || v_item_count || ' items)',
    v_actor, 'delivery', v_new_del_id, v_original.customer_id
  );

  IF v_original.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (
      user_id,
      title,
      message,
      notification_type,
      related_entity_type,
      related_entity_id
    )
    VALUES (
      v_original.assigned_driver,
      'Follow-up Delivery Scheduled',
      'Follow-up delivery ' || v_del_number || ' created for remaining items from ' || v_original.delivery_number || '.',
      'delivery_update', 'delivery', v_new_del_id
    );
  END IF;

  v_result := jsonb_build_object(
    'status', 'created',
    'delivery_id', v_new_del_id,
    'delivery_number', v_del_number,
    'item_count', v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_followup_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_followup_delivery(uuid, date, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_followup_delivery(uuid, date, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_followup_delivery(uuid, date, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_finance_charges(
  p_as_of_date date,
  p_performed_by uuid,
  p_customer_ids uuid[] DEFAULT NULL::uuid[],
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_min_balance bigint;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_finance_charges');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('generate_finance_charges:' || p_as_of_date::text));
  PERFORM public.check_period_open(p_as_of_date);

  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  FOR v_customer IN
    SELECT c.id AS customer_id, c.farm_name, c.finance_charge_rate,
           COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
           COALESCE(sum(i.balance_cents), 0) AS overdue_balance
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.invoice_type != 'misc_charge'
        AND i.due_date IS NOT NULL
        AND i.due_date < (p_as_of_date - (COALESCE(c.finance_charge_grace_days, 0) || ' days')::interval)
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
        AND COALESCE(c.finance_charge_enabled, true) = true
        AND (p_customer_ids IS NULL OR c.id = ANY(p_customer_ids))
      GROUP BY c.id, c.farm_name, c.finance_charge_rate, c.finance_charge_grace_days
      HAVING sum(i.balance_cents) >= v_min_balance
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.finance_charges
      WHERE customer_id = v_customer.customer_id
        AND period_end = p_as_of_date
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      v_inv_num := next_invoice_number('misc_charge');

      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents,
        header_notes, season, created_by
      ) VALUES (
        v_inv_num, v_customer.customer_id, 'misc_charge', 'unposted', p_as_of_date,
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') ||
        CASE WHEN v_customer.grace_days > 0
             THEN ' (after ' || v_customer.grace_days || ' day grace period)'
             ELSE '' END,
        CASE WHEN extract(month FROM p_as_of_date) >= 10
             THEN extract(year FROM p_as_of_date)::integer + 1
             ELSE extract(year FROM p_as_of_date)::integer END,
        v_actor
      ) RETURNING id INTO v_invoice_id;

      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, is_application_fee, sort_order
      ) VALUES (
        v_invoice_id,
        'Finance Charge - ' || v_customer.finance_charge_rate || '% annual rate on overdue balance',
        1, v_charge_amount, v_charge_amount,
        0, false, 1
      );

      INSERT INTO public.finance_charges (
        customer_id, invoice_id, amount_cents, charge_rate,
        base_amount_cents, period_start, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.finance_charge_rate, v_customer.overdue_balance,
        (p_as_of_date - interval '30 days')::date, p_as_of_date,
        v_actor
      );

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge', 'invoice', v_invoice_id,
        v_actor, v_charge_amount,
        'Finance charge generated for ' || v_customer.farm_name ||
        ': $' || to_char(v_charge_amount / 100.0, 'FM999,999,990.00') ||
        ' at ' || v_customer.finance_charge_rate || '% on $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') || ' overdue'
      );

      v_count := v_count + 1;
      v_charges := v_charges || jsonb_build_object(
        'customer', v_customer.farm_name,
        'base_balance_cents', v_customer.overdue_balance,
        'charge_cents', v_charge_amount,
        'rate', v_customer.finance_charge_rate,
        'invoice_number', v_inv_num,
        'grace_days', v_customer.grace_days
      );
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'charges_generated', v_count,
    'skipped_already_charged', v_skipped,
    'details', v_charges
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_finance_charges', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text) TO authenticated;

-- ---------------------------------------------------------------------------
-- COMM-3: unposted commission payments can be voided/released.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.void_commission_payment(
  p_payment_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_payment record;
  v_reset_count integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'COMMISSION_PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.status NOT IN ('posted', 'unposted') THEN
    RAISE EXCEPTION 'INVALID_COMMISSION_PAYMENT_STATUS: %', v_payment.status;
  END IF;

  UPDATE commission_payments SET
    status = 'voided',
    updated_at = now()
  WHERE id = p_payment_id;

  UPDATE commissions SET
    status = 'pending',
    paid_date = NULL
  WHERE id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  );

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_payment.status, 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'commissions_reset', v_reset_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_commission_payment(uuid, text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- PIPE-2: database-level signature guard for delivery completion.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_completed_delivery_signature()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'completed' AND NULLIF(btrim(COALESCE(NEW.signed_by, '')), '') IS NULL THEN
    RAISE EXCEPTION 'SIGNATURE_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_completed_delivery_signature() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_completed_delivery_signature() FROM anon;

DROP TRIGGER IF EXISTS trg_guard_completed_delivery_signature ON public.deliveries;
CREATE TRIGGER trg_guard_completed_delivery_signature
  BEFORE INSERT OR UPDATE OF status, signed_by ON public.deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_completed_delivery_signature();

-- ---------------------------------------------------------------------------
-- Verification.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_count int;
  v_anon_can_apply boolean;
  v_public_can_apply boolean;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'next_invoice_number';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'next_invoice_number overload consolidation failed: % overloads', v_count;
  END IF;

  SELECT has_function_privilege('anon', 'public.apply_write_off(uuid,bigint,text,uuid,text)', 'EXECUTE')
    INTO v_anon_can_apply;
  IF v_anon_can_apply THEN
    RAISE EXCEPTION 'anon still has EXECUTE on apply_write_off';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'apply_write_off'
      AND grantee = 'PUBLIC'
      AND privilege_type = 'EXECUTE'
  ) INTO v_public_can_apply;
  IF v_public_can_apply THEN
    RAISE EXCEPTION 'PUBLIC still has EXECUTE on apply_write_off';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'generate_finance_charges'
      AND prosrc LIKE '%check_idempotency(p_idempotency_key, ''generate_finance_charges'')%'
      AND prosrc LIKE '%pg_advisory_xact_lock(hashtext(''generate_finance_charges:%'
  ) THEN
    RAISE EXCEPTION 'generate_finance_charges idempotency/lock verification failed';
  END IF;

  -- B6 (2026-05-26 parallel audit): cm_invoice_number_seq must exist for
  -- next_invoice_number('credit_memo') to work on the first call.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = 'public'
      AND c.relname = 'cm_invoice_number_seq'
  ) THEN
    RAISE EXCEPTION 'B6 verification failed: cm_invoice_number_seq sequence missing';
  END IF;

  -- B4 (2026-05-26 parallel audit): anon must not have EXECUTE on execute_sql_readonly.
  IF has_function_privilege('anon', 'public.execute_sql_readonly(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B4 verification failed: anon still has EXECUTE on execute_sql_readonly';
  END IF;

  -- B5 (2026-05-26 parallel audit): anon must not have EXECUTE on unapply_credit_memo.
  IF has_function_privilege('anon', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B5 verification failed: anon still has EXECUTE on unapply_credit_memo';
  END IF;
END $$;

COMMIT;
