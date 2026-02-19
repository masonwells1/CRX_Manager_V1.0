-- ============================================================================
-- Add Idempotency Key Parameter to All Mutating RPCs
-- Migration: 20260306200000_add_idempotency_to_remaining_rpcs.sql
--
-- The frontend now sends p_idempotency_key on every mutating RPC call.
-- This migration adds p_idempotency_key text DEFAULT NULL to each RPC
-- that doesn't already have it, using pg_get_functiondef() to preserve
-- the existing function body while injecting the new parameter.
--
-- The DEFAULT NULL ensures backward compatibility — existing callers
-- that omit the parameter continue to work as before.
-- ============================================================================

DO $$
DECLARE
  v_func_names text[] := ARRAY[
    'save_quote',
    'convert_quote_to_order',
    'save_invoice',
    'post_invoice',
    'void_invoice',
    'record_invoice_payment',
    'save_job',
    'complete_job',
    'transfer_job_to_invoice',
    'edit_delivery',
    'cancel_delivery',
    'create_followup_delivery',
    'confirm_delivery',
    'complete_delivery',
    'reassign_delivery',
    'create_quick_delivery',
    'batch_cancel_deliveries',
    'batch_reschedule_deliveries',
    'batch_post_invoices',
    'batch_void_invoices',
    'save_blend_ticket',
    'link_blend_ticket_to_order',
    'unlink_blend_ticket_from_order',
    'create_order_from_blend_ticket',
    'create_application_record_from_blend_ticket',
    'create_commission_payment',
    'post_commission_payment',
    'close_accounting_period',
    'generate_batch_statements',
    'apply_remaining_prepayments',
    'batch_apply_all_prepayments',
    'approve_return',
    'receive_return',
    'issue_return_credit',
    'complete_cycle_count',
    'duplicate_quote',
    'save_purchase_order',
    'delete_purchase_order'
  ];
  v_func_name text;
  v_oid oid;
  v_funcdef text;
  v_new_param text := ', p_idempotency_key text DEFAULT NULL';
BEGIN
  FOREACH v_func_name IN ARRAY v_func_names
  LOOP
    -- Find the function OID (most recent if multiple overloads)
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

    -- Get current function definition
    v_funcdef := pg_get_functiondef(v_oid);

    -- Skip if already has idempotency parameter
    IF v_funcdef ILIKE '%p_idempotency_key%' THEN
      RAISE NOTICE 'Function % already has p_idempotency_key, skipping', v_func_name;
      CONTINUE;
    END IF;

    -- Inject p_idempotency_key before the closing paren of the parameter list.
    -- pg_get_functiondef output has the pattern:
    --   CREATE OR REPLACE FUNCTION public.func_name(param1 type, param2 type)
    --    RETURNS ...
    -- We need to find the ')' that ends the parameter list (before RETURNS).
    -- Use the pattern: last ')' on a line followed by a newline and whitespace
    -- before RETURNS.
    v_funcdef := regexp_replace(
      v_funcdef,
      E'\\)\n(\\s*RETURNS)',
      v_new_param || E')\n\\1'
    );

    -- Execute the modified definition
    EXECUTE v_funcdef;

    RAISE NOTICE 'Added p_idempotency_key to public.%', v_func_name;
  END LOOP;
END;
$$;
