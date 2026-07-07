-- Migration: customers.default_application_service_id (N2-3 / U3 follow-up, finding #52)
-- Date: 2026-07-06  ·  Branch: fix/business-workflow-2026-07
--
-- WHAT / WHY
--   Adds a per-customer default application service so a NEW job for a customer who
--   always gets the same machine service can prefill the JobDetail picker. This is the
--   deferrable convenience follow-up to U3 (the billable per-acre fee shipped separately
--   via 20260706020000 + the JobDetail picker). Re-stamped from the parked draft
--   scripts/.staging-migrations/workflow-fix-parked/u3-optional/20260706021000_*.sql.
--
-- CHANGES (two parts, both additive / non-breaking):
--   1. One nullable FK column on customers -> application_services(id) + COMMENT.
--      Purely additive; no backfill; inherits the existing customers RLS policies.
--   2. save_customer re-emit — LIVE text verbatim + a minimal delta that persists the
--      new key. save_customer takes a jsonb payload (p_customer_payload), so persisting
--      the column is just "add a key" in the INSERT and the UPDATE, following the exact
--      pattern already used for the other nullable-uuid columns (assigned_sales_rep,
--      parent_customer_id). Signature is UNCHANGED (still one overload). Absent key =>
--      column left untouched on update / NULL on insert (COALESCE-safe).
--
-- GROUNDED LIVE (project rhyzpcqhnizqbxphqdkr, 2026-07-06):
--   * customers has NO default_application_service_id column yet (count = 0).
--   * public.application_services exists (FK target valid).
--   * save_customer identity args: (uuid, jsonb, jsonb, uuid, text) — single overload,
--     jsonb payload confirmed (full live def saved at
--     .claude/session-state/live-defs/u3b-save_customer.sql).
--   * customers RLS: UPDATE allowed for is_admin() OR (is_sales_rep() AND owns row) —
--     so a scoped direct .update() would also work for admin/owning-sales, but the
--     canonical persistence path is save_customer (SECDEF, already role-gated to
--     admin/sales_rep), which this migration wires up.

BEGIN;

-- 1) Additive nullable FK column ------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS default_application_service_id uuid
    REFERENCES public.application_services(id);

COMMENT ON COLUMN public.customers.default_application_service_id IS
  'Optional default application service prefilled into new jobs for this customer (U3, finding #52 follow-up).';

-- 2) save_customer re-emit: LIVE verbatim + persist the new key -----------------------
CREATE OR REPLACE FUNCTION public.save_customer(p_customer_id uuid, p_customer_payload jsonb, p_addresses jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  v_result := jsonb_build_object('status', 'saved', 'customer_id', v_customer_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_customer', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- 3) Verification ---------------------------------------------------------------------
DO $$
BEGIN
  -- column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers'
      AND column_name = 'default_application_service_id'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: customers.default_application_service_id not created';
  END IF;

  -- FK to application_services present
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_attribute a
      ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'public.customers'::regclass
      AND con.contype = 'f'
      AND con.confrelid = 'public.application_services'::regclass
      AND a.attname = 'default_application_service_id'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: FK customers.default_application_service_id -> application_services missing';
  END IF;

  -- save_customer still a single overload
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_customer'
        AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: save_customer overload count <> 1';
  END IF;

  -- save_customer body now persists the new key (both INSERT column + UPDATE branch)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'save_customer' AND pronamespace = 'public'::regnamespace
      AND prosrc LIKE '%default_application_service_id%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: save_customer does not persist default_application_service_id';
  END IF;
END $$;

COMMIT;
