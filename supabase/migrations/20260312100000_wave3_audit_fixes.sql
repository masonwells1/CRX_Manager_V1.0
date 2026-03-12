-- ============================================================================
-- Wave 3 Audit Fixes
-- Migration: 20260312100000_wave3_audit_fixes.sql
--
-- Fixes discovered by 6-agent parallel audit on 2026-03-12:
--
-- CRITICAL:
--   1. Five broken RPCs: frontend sends p_idempotency_key but SQL doesn't accept it
--   2. Invoice CHECK constraint missing 'paid' and 'overdue' statuses
--   3. complete_delivery has 3 stale overloads with old business logic
--   4. void_invoice lost its admin role check + needs commission reversal
--   5. allocate_payment stale overload + missing role check
--
-- HIGH:
--   6. Multiple SECURITY DEFINER functions missing role checks
--   7. Stale overloads: update_order_items, admin_update_profile, apply_prepay_to_invoice
--   8. SET search_path missing on 12 SECURITY DEFINER functions
--   9. create_invoice_from_delivery: no auth, no idempotency, no FOR UPDATE
--
-- ============================================================================

BEGIN;

-- ============================================================================
-- FIX 1: Add p_idempotency_key to 5 broken RPCs
--
-- These functions are called from the frontend with p_idempotency_key but
-- the SQL doesn't accept it, causing PostgREST 404 "Could not find function".
-- Uses the same dynamic DO block pattern from 20260306200000.
-- ============================================================================

DO $$
DECLARE
  v_func_names text[] := ARRAY[
    'edit_prepay_credit',
    'delete_prepay_credit',
    'void_payment',
    'manual_inventory_add',
    'batch_apply_prepayments'
  ];
  v_func_name text;
  v_oid oid;
  v_funcdef text;
  v_new_param text := ', p_idempotency_key text DEFAULT NULL';
BEGIN
  FOREACH v_func_name IN ARRAY v_func_names
  LOOP
    SELECT p.oid INTO v_oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_func_name
      AND n.nspname = 'public'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE NOTICE 'Function public.% not found, skipping', v_func_name;
      CONTINUE;
    END IF;

    v_funcdef := pg_get_functiondef(v_oid);

    IF v_funcdef ILIKE '%p_idempotency_key%' THEN
      RAISE NOTICE 'Function % already has p_idempotency_key, skipping', v_func_name;
      CONTINUE;
    END IF;

    v_funcdef := regexp_replace(
      v_funcdef,
      E'\\)\n(\\s*RETURNS)',
      v_new_param || E')\n\\1'
    );

    EXECUTE v_funcdef;
    RAISE NOTICE 'Added p_idempotency_key to public.%', v_func_name;
  END LOOP;
END;
$$;


-- ============================================================================
-- FIX 2: Invoice CHECK constraint — add 'paid' and 'overdue'
--
-- The allocate_payment RPC sets status to 'paid' when fully paid, but the
-- CHECK constraint only allows (draft, unposted, posted, voided, cancelled).
-- Any attempt to fully pay an invoice CRASHES with a CHECK violation.
-- ============================================================================

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'unposted', 'posted', 'paid', 'overdue', 'voided', 'cancelled'));


-- ============================================================================
-- FIX 3: Drop stale function overloads
--
-- When CREATE OR REPLACE FUNCTION is called with a DIFFERENT parameter
-- signature, Postgres creates a NEW overload instead of replacing. The old
-- one has stale business logic. PostgREST can resolve to the wrong overload.
-- ============================================================================

-- complete_delivery: 3 stale overloads (3-param, 4-param, 6-param)
-- Latest is 7-param: (uuid, text, uuid, jsonb, text, text, text)
DROP FUNCTION IF EXISTS public.complete_delivery(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.complete_delivery(uuid, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.complete_delivery(uuid, text, uuid, jsonb, text, text);

-- allocate_payment: stale overload with different param types
-- Find and drop any overload that doesn't match the current signature
DO $$
DECLARE
  v_oid oid;
  v_latest_oid oid;
BEGIN
  -- Find the latest (most params) overload — that's the current one
  SELECT p.oid INTO v_latest_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'allocate_payment' AND n.nspname = 'public'
  ORDER BY p.pronargs DESC
  LIMIT 1;

  -- Drop all OTHER overloads
  FOR v_oid IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'allocate_payment' AND n.nspname = 'public'
      AND p.oid != v_latest_oid
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || v_oid::regprocedure;
    RAISE NOTICE 'Dropped stale overload: %', v_oid::regprocedure;
  END LOOP;
END;
$$;

-- update_order_items: stale 3-param version
DROP FUNCTION IF EXISTS public.update_order_items(uuid, jsonb, uuid);

-- admin_update_profile: stale 5-param version
DROP FUNCTION IF EXISTS public.admin_update_profile(uuid, text, text, text, boolean);

-- apply_prepay_to_invoice: stale 4-param version with p_performed_by
DROP FUNCTION IF EXISTS public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid);


-- ============================================================================
-- FIX 4: void_invoice — re-add admin role check + add commission reversal
--
-- The wave2 audit (20260311200000) added a role check to void_invoice.
-- The sprint1 financial compliance fix (20260325200000) recreated the function
-- WITHOUT the role check, silently removing the security fix.
--
-- Also: when an invoice is voided, commissions tied to it must be cancelled.
-- Otherwise the company pays commissions on revenue it never collected.
-- ============================================================================

DROP FUNCTION IF EXISTS public.void_invoice(uuid, text);
DROP FUNCTION IF EXISTS public.void_invoice(uuid, text, text);

CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
  v_commissions_cancelled int := 0;
BEGIN
  -- ROLE CHECK: admin only (re-added from wave2, was lost in sprint1 migration)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized: admin role required to void invoices';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status = 'voided' THEN
    RAISE EXCEPTION 'Invoice already voided';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot void a cancelled invoice';
  END IF;

  -- Reverse payment allocations
  FOR v_alloc IN
    SELECT ila.id, ila.allocated_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
  LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.allocated_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  -- Update allocation_sets: recalculate total_allocated_cents
  IF v_total_allocations_reversed > 0 THEN
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(allocated_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id IN (
      SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
      WHERE invoice_id = p_invoice_id
    );
  END IF;

  -- Restore prepay credits
  FOR v_prepay_app IN
    SELECT pa.id, pa.amount_cents, pa.prepay_credit_id
    FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id
  LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.amount_cents;

    UPDATE prepay_credits SET
      balance_cents = balance_cents + v_prepay_app.amount_cents,
      updated_at = now()
    WHERE id = v_prepay_app.prepay_credit_id;

    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now()
    WHERE id = v_inv.customer_id;
  END IF;

  -- Cancel commissions tied to this invoice
  -- Without this, commissions remain payable on revenue that was reversed.
  UPDATE commissions
  SET status = 'cancelled',
      notes = COALESCE(notes, '') || ' [Auto-cancelled: invoice ' || v_inv.invoice_number || ' voided]',
      updated_at = now()
  WHERE invoice_id = p_invoice_id
    AND status IN ('pending', 'approved')
  RETURNING 1 INTO v_commissions_cancelled;

  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Zero ALL component columns to ensure balance_cents = 0
  UPDATE invoices SET
    status = 'voided',
    voided_by = auth.uid(),
    voided_at = now(),
    void_reason = p_void_reason,
    total_amount_cents = 0,
    paid_amount_cents = 0,
    prepay_applied_cents = 0,
    write_off_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'status', v_inv.status,
      'total_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'write_off_cents', v_inv.write_off_cents
    ),
    jsonb_build_object(
      'status', 'voided',
      'void_reason', p_void_reason,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled
    ),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0
        THEN ' Cancelled ' || v_commissions_cancelled || ' commission(s).'
        ELSE '' END
  );

  -- Activity log
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_commissions_cancelled > 0
        THEN '. Cancelled ' || v_commissions_cancelled || ' commission(s).'
        ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- Notify admin about reversals
  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id,
      'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0
          THEN ' ' || v_commissions_cancelled || ' commission(s) cancelled.'
          ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p
    WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION void_invoice(uuid, text, text) TO authenticated;


-- ============================================================================
-- FIX 5: Add role checks to SECURITY DEFINER functions
--
-- These functions bypass RLS but don't verify the caller's role internally.
-- Any authenticated user (including drivers) can call them directly.
-- ============================================================================

-- Use DO block to inject role checks into existing functions
DO $$
DECLARE
  v_funcs text[][] := ARRAY[
    ARRAY['create_invoice_from_delivery', 'admin,sales_rep'],
    ARRAY['transfer_job_to_invoice', 'admin,sales_rep'],
    ARRAY['batch_post_invoices', 'admin,sales_rep'],
    ARRAY['create_commission_payment', 'admin'],
    ARRAY['post_commission_payment', 'admin'],
    ARRAY['receive_return', 'admin,sales_rep'],
    ARRAY['complete_cycle_count', 'admin'],
    ARRAY['apply_remaining_prepayments', 'admin,sales_rep'],
    ARRAY['allocate_payment', 'admin,sales_rep']
  ];
  v_entry text[];
  v_func_name text;
  v_roles text;
  v_oid oid;
  v_funcdef text;
  v_role_check text;
  v_roles_array text[];
  v_roles_sql text;
BEGIN
  FOREACH v_entry SLICE 1 IN ARRAY v_funcs
  LOOP
    v_func_name := v_entry[1];
    v_roles := v_entry[2];

    SELECT p.oid INTO v_oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_func_name AND n.nspname = 'public'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE NOTICE 'Function % not found, skipping role check', v_func_name;
      CONTINUE;
    END IF;

    v_funcdef := pg_get_functiondef(v_oid);

    -- Skip if already has role check
    IF v_funcdef ILIKE '%Not authorized%' OR v_funcdef ILIKE '%admin role required%' THEN
      RAISE NOTICE 'Function % already has role check, skipping', v_func_name;
      CONTINUE;
    END IF;

    -- Build the role check SQL
    v_roles_array := string_to_array(v_roles, ',');
    v_roles_sql := '''' || array_to_string(v_roles_array, ''',''') || '''';

    v_role_check := E'\n  -- Authorization check (added by wave3 audit)\n' ||
      '  IF NOT EXISTS (' || E'\n' ||
      '    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN (' || v_roles_sql || ')' || E'\n' ||
      '  ) THEN' || E'\n' ||
      '    RAISE EXCEPTION ''Not authorized: requires ' || v_roles || ' role'';' || E'\n' ||
      '  END IF;' || E'\n';

    -- Inject after BEGIN
    v_funcdef := regexp_replace(
      v_funcdef,
      E'BEGIN\n',
      E'BEGIN\n' || v_role_check
    );

    EXECUTE v_funcdef;
    RAISE NOTICE 'Added role check (%) to %', v_roles, v_func_name;
  END LOOP;
END;
$$;


-- ============================================================================
-- FIX 6: Add SET search_path to SECURITY DEFINER functions
-- ============================================================================

DO $$
DECLARE
  v_func_names text[] := ARRAY[
    'approve_return',
    'calculate_billing_splits',
    'create_prepay_credit',
    'get_customer_statement',
    'link_blend_ticket_to_order',
    'log_comment_activity',
    'log_note_activity',
    'notify_mentioned_users_in_comment',
    'unlink_blend_ticket_from_order',
    'update_allocation_set',
    'update_blend_ticket_billing_status'
  ];
  v_func_name text;
  v_oid oid;
BEGIN
  FOREACH v_func_name IN ARRAY v_func_names
  LOOP
    SELECT p.oid INTO v_oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_func_name AND n.nspname = 'public'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE NOTICE 'Function % not found, skipping search_path', v_func_name;
      CONTINUE;
    END IF;

    EXECUTE 'ALTER FUNCTION ' || v_oid::regprocedure || ' SET search_path TO ''public''';
    RAISE NOTICE 'Set search_path on %', v_func_name;
  END LOOP;
END;
$$;


-- ============================================================================
-- FIX 7: Add FOR UPDATE + idempotency to create_invoice_from_delivery
--
-- This function creates invoices but has no locking, no idempotency,
-- and no duplicate guard. Two concurrent calls create duplicate invoices.
-- ============================================================================

-- Note: The role check was already added by FIX 5 above via dynamic injection.
-- Here we add the idempotency parameter using the same DO block approach.

DO $$
DECLARE
  v_oid oid;
  v_funcdef text;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'create_invoice_from_delivery' AND n.nspname = 'public'
  ORDER BY p.oid DESC
  LIMIT 1;

  IF v_oid IS NULL THEN
    RAISE NOTICE 'create_invoice_from_delivery not found';
    RETURN;
  END IF;

  v_funcdef := pg_get_functiondef(v_oid);

  -- Add p_idempotency_key if not present
  IF v_funcdef NOT ILIKE '%p_idempotency_key%' THEN
    v_funcdef := regexp_replace(
      v_funcdef,
      E'\\)\n(\\s*RETURNS)',
      E', p_idempotency_key text DEFAULT NULL)\n\\1'
    );
  END IF;

  -- Add FOR UPDATE to the delivery SELECT if not present
  IF v_funcdef NOT ILIKE '%FOR UPDATE%' THEN
    v_funcdef := regexp_replace(
      v_funcdef,
      E'FROM deliveries WHERE id = p_delivery_id',
      E'FROM deliveries WHERE id = p_delivery_id FOR UPDATE'
    );
  END IF;

  -- Add duplicate invoice guard after BEGIN (before existing role check)
  IF v_funcdef NOT ILIKE '%invoice already exists%' THEN
    v_funcdef := regexp_replace(
      v_funcdef,
      E'BEGIN\n',
      E'BEGIN\n' ||
      E'  -- Guard: check for existing invoice for this delivery\n' ||
      E'  IF EXISTS (SELECT 1 FROM invoices WHERE delivery_id = p_delivery_id AND status != ''cancelled'') THEN\n' ||
      E'    RAISE EXCEPTION ''An invoice already exists for this delivery'';\n' ||
      E'  END IF;\n\n'
    );
  END IF;

  EXECUTE v_funcdef;
  RAISE NOTICE 'Updated create_invoice_from_delivery with idempotency + FOR UPDATE + duplicate guard';
END;
$$;


COMMIT;
