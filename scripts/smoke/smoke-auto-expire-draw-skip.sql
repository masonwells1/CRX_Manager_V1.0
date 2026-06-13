-- ============================================================================
-- SMOKE TEST (rolled back by design): auto_expire_quotes skips partial draws
-- ----------------------------------------------------------------------------
-- Verifies 20260610190200_auto_expire_skip_partially_drawn.sql:
--   * a sent quote PAST its expires_at WITH a quote_product_draws row
--     (quantity_drawn > 0) is left untouched by the expiry sweep;
--   * a control quote PAST its expires_at with NO draws is expired (the sweep
--     itself still works);
--   * the run COMPLETES and returns its counters — exercising the migration's
--     change (2): the activity_feed summary insert (zero-uuid performed_by,
--     NOT NULL + FK to profiles -> guaranteed FK violation pre-fix) is now
--     best-effort and can no longer abort the sweep. No activity_feed
--     assertion is made (the row still cannot land until a real system
--     profile exists).
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success it raises
-- 'SMOKE_PASS_ROLLBACK' — so nothing here ever commits.
--
-- Calling context: auto_expire_quotes is owner/service_role-only since
-- 20260609203541 (live-verified proacl = {postgres,service_role};
-- authenticated/anon EXECUTE = false). Its real callers (pg_cron /
-- service_role) carry NO JWT claims, so this block deliberately calls it as
-- the DO-block owner WITHOUT set_config('request.jwt.claims', ...).
--
-- Side note: within this (rolled-back) transaction the sweep will also expire
-- any REAL sent/revised quotes past expiry and briefly hold their row locks
-- (FOR UPDATE SKIP LOCKED). All of it rolls back; run off-hours if cautious.
-- ============================================================================

DO $$
DECLARE
  v_customer uuid;
  v_admin uuid;
  v_product uuid;
  v_quote_drawn uuid;   -- partially-drawn booking, expiry date in the past
  v_quote_ctrl uuid;    -- control quote, no draws, expiry date in the past
  v_status_drawn text;
  v_status_ctrl text;
  v_result jsonb;
BEGIN
  -- Synthetic fixtures reference one existing customer/admin/product row
  -- (FK targets only; nothing existing is modified).
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
  SELECT id INTO v_customer FROM customers LIMIT 1;
  SELECT id INTO v_product FROM products LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: need at least one active admin profile, one customer, and one product';
  END IF;

  -- Fixture 1: open season booking with a partial draw, long past expires_at
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split, expires_at)
  VALUES ('SMOKE-A5-DRAWN-' || substr(gen_random_uuid()::text, 1, 8), v_customer, v_admin,
          'sent', '{"splits": []}'::jsonb, CURRENT_DATE - 30)
  RETURNING id INTO v_quote_drawn;

  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES (v_quote_drawn, v_product, 200);

  -- Fixture 2: control quote, no draws, long past expires_at
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split, expires_at)
  VALUES ('SMOKE-A5-CTRL-' || substr(gen_random_uuid()::text, 1, 8), v_customer, v_admin,
          'sent', '{"splits": []}'::jsonb, CURRENT_DATE - 30)
  RETURNING id INTO v_quote_ctrl;

  -- Run the sweep in its real calling context (owner, no claims).
  -- Pre-fix this call would ABORT with an FK violation on the activity_feed
  -- summary row the moment it expired anything; completing at all is part of
  -- the assertion surface.
  v_result := public.auto_expire_quotes();
  RAISE NOTICE 'auto_expire_quotes() -> %', v_result;

  IF COALESCE((v_result->>'expired_count')::int, 0) < 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expired_count=% — the sweep did not report expiring the control quote', v_result->>'expired_count';
  END IF;

  SELECT status INTO v_status_drawn FROM quotes WHERE id = v_quote_drawn;
  SELECT status INTO v_status_ctrl  FROM quotes WHERE id = v_quote_ctrl;

  IF v_status_drawn <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: partially-drawn booking was expired (status = %) — the skip predicate did not hold', v_status_drawn;
  END IF;

  IF v_status_ctrl <> 'expired' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: control quote was NOT expired (status = %) — the sweep no longer expires anything', v_status_ctrl;
  END IF;

  -- Belt-and-braces: re-assert the hardened grants in the same run
  IF has_function_privilege('authenticated', 'public.auto_expire_quotes()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auto_expire_quotes()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated/anon can EXECUTE auto_expire_quotes — 20260609203541 hardening regressed';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
