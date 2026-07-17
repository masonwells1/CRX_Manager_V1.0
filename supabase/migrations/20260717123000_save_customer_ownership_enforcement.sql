-- Migration: save_customer ownership enforcement (Codex gauntlet finding, 2026-07-16)
-- Date: 2026-07-17  ·  Branch: claude/amazing-ptolemy-9e7e0a
--
-- WHAT / WHY
--   public.save_customer is SECURITY DEFINER and its permission gate only checked
--   role IN ('admin','sales_rep') + actor match. It never checked
--   customers.assigned_sales_rep, so ANY active sales rep could update ANY
--   customer's master record (credit_limit_cents, finance_charge_*,
--   default_commission_split, ...) by calling the RPC directly — bypassing the
--   customers_update RLS policy whose intent is admin OR assigned-rep-only.
--
--   This re-emits save_customer from the LIVE body verbatim (matches
--   20260707030000 exactly; live definition read and line-compared 2026-07-17)
--   with a minimal delta that mirrors the live customers RLS policies inside the
--   SECDEF function:
--     * UPDATE branch: non-admin actors must be the customer's assigned_sales_rep
--       (mirrors customers_update USING), and may not reassign the customer to
--       someone else (mirrors customers_update WITH CHECK).
--     * INSERT branch: non-admin actors must self-assign
--       (mirrors customers_insert WITH CHECK: assigned_sales_rep = auth.uid()).
--
-- GROUNDED LIVE (project rhyzpcqhnizqbxphqdkr, 2026-07-17):
--   * Live save_customer def has the role gate but NO ownership check; single
--     overload; body identical to 20260707030000.
--   * customers RLS: select/update/insert for sales_rep are all
--     assigned_sales_rep = auth.uid() scoped — a rep cannot even SELECT a
--     non-assigned customer, so no legitimate workflow relies on the gap.
--   * activity_feed: every customer_created/customer_updated event ever was
--     performed by an admin; the one active sales_rep has never edited a customer.
--   * Frontend (CustomerDetail.tsx): create defaults assigned_sales_rep to the
--     actor; edit form has no control to change it — payload echoes the loaded
--     value, which for a rep is always self (RLS-scoped load). Zero UI impact.
--   * CRM sync triggers on customers (mirror of same-customer contact fields)
--     fire inside this SECDEF context after the UPDATE; the new gates run before
--     the UPDATE and do not interact with them.

BEGIN;

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
    -- Ownership gate (mirrors customers_insert WITH CHECK): a sales rep may only
    -- create customers assigned to themselves; NULL/absent is rejected too.
    IF v_actor_role <> 'admin'
       AND (p_customer_payload->>'assigned_sales_rep')::uuid IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'REP_MUST_SELF_ASSIGN';
    END IF;

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

    -- Ownership gate (mirrors customers_update USING): non-admin actors may only
    -- update customers assigned to them. FOR UPDATE holds the row lock through
    -- the customer/address DML so a concurrent reassignment can't slip between
    -- this check and the UPDATE.
    IF v_actor_role <> 'admin' THEN
      IF NOT EXISTS (
        SELECT 1 FROM customers
        WHERE id = v_customer_id
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

-- Belt-and-suspenders grants: CREATE OR REPLACE preserves the live ACL (anon/PUBLIC
-- EXECUTE already revoked by the 20260526151856 SECDEF sweep); restated here so the
-- migration is self-contained on a from-scratch replay.
-- caller-analysis: save_customer :: sole caller src/pages/CustomerDetail.tsx:494 runs as an authenticated session user; REVOKE targets only anon/PUBLIC and the GRANT below keeps authenticated EXECUTE, so the caller is unaffected
REVOKE EXECUTE ON FUNCTION public.save_customer(uuid, jsonb, jsonb, uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_customer(uuid, jsonb, jsonb, uuid, text) TO authenticated;

-- Verification -------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  -- still a single overload
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_customer'
        AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: save_customer overload count <> 1';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
  WHERE proname = 'save_customer' AND pronamespace = 'public'::regnamespace;

  -- new ownership gates present
  IF v_src NOT LIKE '%NOT_CUSTOMER_OWNER%'
     OR v_src NOT LIKE '%REP_MUST_SELF_ASSIGN%'
     OR v_src NOT LIKE '%REP_CANNOT_REASSIGN%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: ownership gates missing from save_customer';
  END IF;

  -- prior behavior preserved (role gate + U3 column persistence)
  IF v_src NOT LIKE '%INSUFFICIENT_ROLE%'
     OR v_src NOT LIKE '%default_application_service_id%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: save_customer lost prior behavior in re-emit';
  END IF;
END $$;

COMMIT;
