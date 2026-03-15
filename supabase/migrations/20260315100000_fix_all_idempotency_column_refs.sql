-- Fix idempotency_keys column references in 11 RPCs
--
-- The idempotency_keys table has columns: idempotency_key, operation, result (jsonb), expires_at
-- Many RPCs reference non-existent columns: "key", "entity_type", "entity_id", "result_id"
-- This causes "column does not exist" errors whenever p_idempotency_key is provided.
--
-- Uses pg_get_functiondef() + targeted string replacement to fix only the
-- idempotency blocks while preserving all business logic exactly.
--
-- Migration 20260315004110 previously fixed save_quote, but migration
-- 20260331300000 redefined save_quote with the bug re-introduced.
-- This migration fixes ALL 11 RPCs definitively.
--
-- RPCs fixed:
--   1.  save_quote                    (20260331300000 latest)
--   2.  receive_po_items              (20260304200000 latest)
--   3.  reopen_accounting_period      (20260331100000 latest)
--   4.  reverse_write_off             (20260331100000 latest)
--   5.  void_commission_payment       (20260331120000 latest)
--   6.  revert_quote_status           (20260331130000 latest)
--   7.  restore_cancelled_order       (20260331130000 latest)
--   8.  restore_cancelled_delivery    (20260331130000 latest)
--   9.  unapply_credit_memo           (20260331130000 latest)
--   10. reverse_blend_ticket_approval (20260331130000 latest)
--   11. void_delivery                 (20260332000000 latest)

-- 1. save_quote
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'save_quote' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'save_quote not found'; RETURN; END IF;

  v_src := replace(v_src,
    'WHERE key = p_idempotency_key AND created_at > now()',
    'WHERE idempotency_key = p_idempotency_key AND created_at > now()');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, entity_type, entity_id)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'quote\', COALESCE(p_quote_id, gen_random_uuid()))',
    E'VALUES (p_idempotency_key, \'save_quote\', to_jsonb(COALESCE(p_quote_id, gen_random_uuid())))');

  EXECUTE v_src;
  RAISE NOTICE 'save_quote: fixed';
END;
$fn$;

-- 2. receive_po_items
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'receive_po_items' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'receive_po_items not found'; RETURN; END IF;

  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result)');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'receive_po_items: fixed';
END;
$fn$;

-- 3. reopen_accounting_period
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'reopen_accounting_period' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'reopen_accounting_period not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'reopen_accounting_period\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'reopen_accounting_period\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'reopen_accounting_period\', p_period_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'reopen_accounting_period\', to_jsonb(p_period_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'reopen_accounting_period: fixed';
END;
$fn$;

-- 4. reverse_write_off
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'reverse_write_off' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'reverse_write_off not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'reverse_write_off\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'reverse_write_off\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'reverse_write_off\', p_write_off_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'reverse_write_off\', to_jsonb(p_write_off_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'reverse_write_off: fixed';
END;
$fn$;

-- 5. void_commission_payment
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'void_commission_payment' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'void_commission_payment not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'void_commission_payment\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'void_commission_payment\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'void_commission_payment\', p_payment_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'void_commission_payment\', to_jsonb(p_payment_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'void_commission_payment: fixed';
END;
$fn$;

-- 6. revert_quote_status
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'revert_quote_status' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'revert_quote_status not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'revert_quote_status\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'revert_quote_status\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'revert_quote_status\', p_quote_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'revert_quote_status\', to_jsonb(p_quote_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'revert_quote_status: fixed';
END;
$fn$;

-- 7. restore_cancelled_order
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'restore_cancelled_order' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'restore_cancelled_order not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'restore_cancelled_order\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'restore_cancelled_order\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'restore_cancelled_order\', p_order_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'restore_cancelled_order\', to_jsonb(p_order_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'restore_cancelled_order: fixed';
END;
$fn$;

-- 8. restore_cancelled_delivery
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'restore_cancelled_delivery' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'restore_cancelled_delivery not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'restore_cancelled_delivery\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'restore_cancelled_delivery\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'restore_cancelled_delivery\', p_delivery_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'restore_cancelled_delivery\', to_jsonb(p_delivery_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'restore_cancelled_delivery: fixed';
END;
$fn$;

-- 9. unapply_credit_memo
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'unapply_credit_memo' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'unapply_credit_memo not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'unapply_credit_memo\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'unapply_credit_memo\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'unapply_credit_memo\', p_credit_memo_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'unapply_credit_memo\', to_jsonb(p_credit_memo_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'unapply_credit_memo: fixed';
END;
$fn$;

-- 10. reverse_blend_ticket_approval
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'reverse_blend_ticket_approval' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'reverse_blend_ticket_approval not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'reverse_blend_ticket_approval\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'reverse_blend_ticket_approval\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'reverse_blend_ticket_approval\', p_ticket_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'reverse_blend_ticket_approval\', to_jsonb(p_ticket_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'reverse_blend_ticket_approval: fixed';
END;
$fn$;

-- 11. void_delivery
DO $fn$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'void_delivery' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN RAISE NOTICE 'void_delivery not found'; RETURN; END IF;

  v_src := replace(v_src,
    E'WHERE key = p_idempotency_key AND operation = \'void_delivery\'',
    E'WHERE idempotency_key = p_idempotency_key AND operation = \'void_delivery\'');
  v_src := replace(v_src,
    'INSERT INTO idempotency_keys (key, operation, result_id, expires_at)',
    'INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
  v_src := replace(v_src,
    E'VALUES (p_idempotency_key, \'void_delivery\', p_delivery_id, now() + interval \'24 hours\')',
    E'VALUES (p_idempotency_key, \'void_delivery\', to_jsonb(p_delivery_id), now() + interval \'24 hours\')');
  v_src := replace(v_src,
    'ON CONFLICT (key) DO NOTHING',
    'ON CONFLICT (idempotency_key) DO NOTHING');

  EXECUTE v_src;
  RAISE NOTICE 'void_delivery: fixed';
END;
$fn$;

-- Verification: confirm no RPCs still reference wrong columns on idempotency_keys
DO $fn$
DECLARE
  v_bad_count int;
  v_func record;
BEGIN
  v_bad_count := 0;
  FOR v_func IN
    SELECT proname, pg_get_functiondef(oid) AS src
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND pg_get_functiondef(oid) LIKE '%idempotency_keys%'
  LOOP
    IF v_func.src LIKE '%WHERE key = p_idempotency_key%'
       OR v_func.src LIKE '%idempotency_keys (key,%'
       OR v_func.src LIKE '%ON CONFLICT (key)%'
       OR v_func.src LIKE '%, result_id,%'
       OR v_func.src LIKE '%, entity_type,%' THEN
      RAISE WARNING 'RPC % still has wrong idempotency column refs!', v_func.proname;
      v_bad_count := v_bad_count + 1;
    END IF;
  END LOOP;

  IF v_bad_count = 0 THEN
    RAISE NOTICE 'All RPCs verified: idempotency column references are correct';
  ELSE
    RAISE WARNING '% RPCs still have incorrect idempotency column references', v_bad_count;
  END IF;
END;
$fn$;
