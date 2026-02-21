-- ============================================================
-- Migration: Rate Limiting for Critical RPCs
-- Purpose: Prevent abuse of financial and batch operations
-- ============================================================

-- 1. Rate limit log table
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  operation text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_log_lookup
  ON rate_limit_log (user_id, operation, created_at DESC);

ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;

-- No RLS policies needed — only SECURITY DEFINER functions access this table

-- 2. Rate limit check function
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id uuid,
  p_operation text,
  p_max_calls int DEFAULT 10,
  p_window_seconds int DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  -- Count recent calls within the window
  SELECT count(*) INTO v_count
  FROM rate_limit_log
  WHERE user_id = p_user_id
    AND operation = p_operation
    AND created_at > now() - (p_window_seconds || ' seconds')::interval;

  IF v_count >= p_max_calls THEN
    RAISE EXCEPTION 'Rate limit exceeded. Please wait before retrying.';
  END IF;

  -- Log this call
  INSERT INTO rate_limit_log (user_id, operation)
  VALUES (p_user_id, p_operation);

  -- Periodic cleanup: remove entries older than 1 hour (cheap, runs inline)
  DELETE FROM rate_limit_log
  WHERE created_at < now() - interval '1 hour';
END;
$$;

-- 3. Inject rate limit checks into critical RPCs
-- Uses dynamic SQL to read current function body and prepend the check.
-- This avoids duplicating the entire function definition in the migration.

DO $$
DECLARE
  v_funcname text;
  v_max_calls int;
  v_window_seconds int;
  v_funcdef text;
  v_new_def text;
  v_check_line text;
  v_funcs text[][] := ARRAY[
    ['allocate_payment',           '5',  '60'],
    ['create_quick_delivery',      '5',  '60'],
    ['batch_cancel_deliveries',    '3',  '60'],
    ['batch_void_invoices',        '3',  '60'],
    ['batch_apply_all_prepayments','3',  '60'],
    ['generate_finance_charges',   '3',  '300'],
    ['record_payment',             '10', '60'],
    ['apply_write_off',            '5',  '60']
  ];
  i int;
BEGIN
  FOR i IN 1..array_length(v_funcs, 1) LOOP
    v_funcname := v_funcs[i][1];
    v_max_calls := v_funcs[i][2]::int;
    v_window_seconds := v_funcs[i][3]::int;

    -- Get the current function definition
    SELECT pg_get_functiondef(p.oid) INTO v_funcdef
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = v_funcname
    LIMIT 1;

    IF v_funcdef IS NULL THEN
      RAISE NOTICE 'Function % not found, skipping', v_funcname;
      CONTINUE;
    END IF;

    -- Skip if already has rate limit check
    IF v_funcdef LIKE '%check_rate_limit%' THEN
      RAISE NOTICE 'Function % already has rate limit, skipping', v_funcname;
      CONTINUE;
    END IF;

    -- Build the rate limit check line
    v_check_line := format(
      'PERFORM check_rate_limit(auth.uid(), %L, %s, %s);',
      v_funcname, v_max_calls, v_window_seconds
    );

    -- Insert after first BEGIN
    v_new_def := regexp_replace(
      v_funcdef,
      'BEGIN',
      'BEGIN' || E'\n  ' || v_check_line,
      '' -- only replace first occurrence (default)
    );

    -- Execute the modified function definition
    EXECUTE v_new_def;
    RAISE NOTICE 'Added rate limit to %: % calls per % seconds', v_funcname, v_max_calls, v_window_seconds;
  END LOOP;
END;
$$;
