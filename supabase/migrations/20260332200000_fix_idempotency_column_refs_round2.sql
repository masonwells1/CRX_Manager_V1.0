-- ============================================================================
-- Fix idempotency_keys column references in 10 RPCs (Round 2)
--
-- The March 31 migrations (20260331100000, 20260331110000, 20260331120000,
-- 20260331130000, 20260331300000) used CREATE OR REPLACE on functions that
-- were previously fixed by 20260315004110, re-introducing the same bugs:
--
--   SELECT: WHERE key = ...          (should be: WHERE idempotency_key = ...)
--   INSERT: (key, operation, result_id, expires_at)
--                                    (should be: (idempotency_key, operation, result, expires_at))
--
-- The idempotency_keys table schema (from 20260210000000):
--   idempotency_key text NOT NULL UNIQUE
--   operation text NOT NULL
--   result jsonb (nullable)
--
-- This migration uses pg_get_functiondef() + replace() to surgically fix
-- only the wrong column names, preserving all other function logic intact.
-- ============================================================================


-- ============================================================================
-- PART A: Fix 9 RPCs with (key, operation, result_id) pattern
-- ============================================================================

DO $$
DECLARE
  v_func_names text[] := ARRAY[
    'reopen_accounting_period',
    'reverse_write_off',
    'void_delivery',
    'void_commission_payment',
    'revert_quote_status',
    'restore_cancelled_order',
    'restore_cancelled_delivery',
    'unapply_credit_memo',
    'reverse_blend_ticket_approval'
  ];
  v_var_names text[] := ARRAY[
    'p_period_id',
    'p_write_off_id',
    'p_delivery_id',
    'p_payment_id',
    'p_quote_id',
    'p_order_id',
    'p_delivery_id',
    'p_credit_memo_id',
    'p_ticket_id'
  ];
  v_func_name text;
  v_var_name text;
  v_func_def text;
  v_func_oid oid;
  v_idx int := 1;
BEGIN
  FOREACH v_func_name IN ARRAY v_func_names LOOP
    v_var_name := v_var_names[v_idx];
    v_idx := v_idx + 1;

    -- Find the function OID
    SELECT p.oid INTO v_func_oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = v_func_name
    LIMIT 1;

    IF v_func_oid IS NULL THEN
      RAISE NOTICE 'Function % not found, skipping', v_func_name;
      CONTINUE;
    END IF;

    v_func_def := pg_get_functiondef(v_func_oid);

    -- Only fix if the function still has the wrong column names
    IF position('WHERE key = ' IN v_func_def) = 0 THEN
      RAISE NOTICE 'Function % already uses correct column names, skipping', v_func_name;
      CONTINUE;
    END IF;

    -- Fix 1: SELECT ... WHERE key = → WHERE idempotency_key =
    v_func_def := replace(v_func_def,
      'WHERE key = ',
      'WHERE idempotency_key = ');

    -- Fix 2: INSERT column names
    v_func_def := replace(v_func_def,
      '(key, operation, result_id, expires_at)',
      '(idempotency_key, operation, result, expires_at)');

    -- Fix 3: UUID value → jsonb (result column is jsonb, not uuid)
    v_func_def := replace(v_func_def,
      v_var_name || ', now()',
      'to_jsonb(' || v_var_name || '::text), now()');

    EXECUTE v_func_def;
    RAISE NOTICE 'Fixed idempotency columns in %', v_func_name;
  END LOOP;
END $$;


-- ============================================================================
-- PART B: Fix save_quote — uses different wrong column pattern
--         (key, entity_type, entity_id) instead of (idempotency_key, operation, result)
-- ============================================================================

DO $$
DECLARE
  v_func_def text;
  v_func_oid oid;
BEGIN
  SELECT p.oid INTO v_func_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'save_quote'
  LIMIT 1;

  IF v_func_oid IS NULL THEN
    RAISE NOTICE 'Function save_quote not found, skipping';
    RETURN;
  END IF;

  v_func_def := pg_get_functiondef(v_func_oid);

  -- Only fix if still has wrong column names
  IF position('WHERE key = ' IN v_func_def) = 0
     AND position('entity_type' IN v_func_def) = 0 THEN
    RAISE NOTICE 'save_quote already uses correct column names, skipping';
    RETURN;
  END IF;

  -- Fix 1: SELECT ... WHERE key = → WHERE idempotency_key =
  v_func_def := replace(v_func_def,
    'WHERE key = ',
    'WHERE idempotency_key = ');

  -- Fix 2: INSERT column names
  v_func_def := replace(v_func_def,
    '(key, entity_type, entity_id)',
    '(idempotency_key, operation, result)');

  -- Fix 3: VALUES — 'quote' → 'save_quote', UUID → jsonb
  v_func_def := replace(v_func_def,
    $$'quote', COALESCE(p_quote_id, gen_random_uuid())$$,
    $$'save_quote', to_jsonb(COALESCE(p_quote_id, gen_random_uuid())::text)$$);

  EXECUTE v_func_def;
  RAISE NOTICE 'Fixed idempotency columns in save_quote';
END $$;
