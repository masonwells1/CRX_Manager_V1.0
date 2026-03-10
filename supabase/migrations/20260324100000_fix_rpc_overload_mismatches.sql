-- Fix RPC overload mismatches: drop stale function overloads and add
-- p_idempotency_key to all affected functions so frontend calls resolve
-- to the CORRECT (latest) business logic.
--
-- Root cause: Migration 20260306200000 dynamically added p_idempotency_key
-- to function signatures. Later migrations recreated functions WITHOUT it,
-- creating dual overloads. The frontend sends p_idempotency_key, so
-- PostgreSQL resolves to the OLD (stale) overload with wrong logic.
--
-- Fix strategy:
-- 1. Drop all stale overloads (ones WITH p_idempotency_key)
-- 2. Dynamically add p_idempotency_key DEFAULT NULL to the correct versions
-- 3. Create missing increment_customer_prepay function

-- ============================================================
-- STEP 1: Drop the 10 stale overloads (with p_idempotency_key)
-- ============================================================
DROP FUNCTION IF EXISTS public.post_invoice(uuid, text);
DROP FUNCTION IF EXISTS public.void_invoice(uuid, text, text);
DROP FUNCTION IF EXISTS public.confirm_delivery(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.transfer_job_to_invoice(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.create_commission_payment(uuid[], text, text, date, text, uuid, text);
DROP FUNCTION IF EXISTS public.post_commission_payment(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_cycle_count(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.apply_remaining_prepayments(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.receive_return(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.batch_void_invoices(uuid[], text, uuid, text);

-- ============================================================
-- STEP 2: Add p_idempotency_key to all 15 correct functions
-- Uses pg_get_functiondef to get the current body, then recreates
-- each function with the added parameter.
-- ============================================================
DO $$
DECLARE
  func_names TEXT[] := ARRAY[
    'post_invoice', 'void_invoice', 'confirm_delivery',
    'transfer_job_to_invoice', 'create_commission_payment',
    'post_commission_payment', 'complete_cycle_count',
    'apply_remaining_prepayments', 'receive_return', 'batch_void_invoices',
    'record_invoice_payment', 'create_vendor_bill',
    'record_vendor_payment', 'void_vendor_bill', 'generate_finance_charges'
  ];
  func_name TEXT;
  func_oid OID;
  func_def TEXT;
  func_args TEXT;
BEGIN
  FOREACH func_name IN ARRAY func_names
  LOOP
    -- Find the function OID (should be exactly one now after step 1)
    SELECT p.oid, pg_get_function_identity_arguments(p.oid)
    INTO func_oid, func_args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = func_name
      AND pg_get_function_identity_arguments(p.oid) NOT LIKE '%p_idempotency_key%'
    LIMIT 1;

    IF func_oid IS NULL THEN
      RAISE NOTICE 'Function % not found — skipping', func_name;
      CONTINUE;
    END IF;

    -- Get current function definition
    func_def := pg_get_functiondef(func_oid);

    -- Drop the current version so we can recreate with new signature
    EXECUTE format('DROP FUNCTION public.%I(%s)', func_name, func_args);

    -- Add OR REPLACE if not present
    func_def := regexp_replace(func_def, '^CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');

    -- Add p_idempotency_key parameter before closing paren of arg list
    -- Pattern: find the last ')' before 'RETURNS' and add the parameter
    func_def := regexp_replace(
      func_def,
      E'\\)\n RETURNS',
      E', p_idempotency_key text DEFAULT NULL)\n RETURNS'
    );

    -- Execute the modified definition
    EXECUTE func_def;

    RAISE NOTICE 'Updated % with p_idempotency_key', func_name;
  END LOOP;
END $$;

-- ============================================================
-- STEP 3: Create increment_customer_prepay (missing entirely)
-- Atomic increment avoids the race condition in the fallback code
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_customer_prepay(
  p_customer_id uuid,
  p_amount_cents bigint,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE customers
  SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + p_amount_cents
  WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer % not found', p_customer_id;
  END IF;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.increment_customer_prepay(uuid, bigint, text) TO authenticated;

-- ============================================================
-- STEP 4: Verify — each function should have exactly 1 overload
-- ============================================================
DO $$
DECLARE
  func_name TEXT;
  overload_count INT;
  func_names TEXT[] := ARRAY[
    'post_invoice', 'void_invoice', 'confirm_delivery',
    'transfer_job_to_invoice', 'create_commission_payment',
    'post_commission_payment', 'complete_cycle_count',
    'apply_remaining_prepayments', 'receive_return', 'batch_void_invoices',
    'record_invoice_payment', 'create_vendor_bill',
    'record_vendor_payment', 'void_vendor_bill', 'generate_finance_charges',
    'increment_customer_prepay'
  ];
BEGIN
  FOREACH func_name IN ARRAY func_names
  LOOP
    SELECT count(*) INTO overload_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = func_name;

    IF overload_count != 1 THEN
      RAISE WARNING 'Function % has % overloads (expected 1)', func_name, overload_count;
    END IF;
  END LOOP;
END $$;
