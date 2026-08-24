-- Post-apply rollback-only regression proof for H4 (Live Foundation Gauntlet
-- 2026-07-18): restore_cancelled_order must REFUSE to reactivate a cancelled
-- order (it cannot safely reverse the cancel's inventory/commission/draw
-- side-effects, so a "restored" order would be corrupt).
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX function, restoring a cancelled order
-- SUCCEEDS (flips it back to 'confirmed' with released inventory / zeroed
-- commissions) -> this chain raises SMOKE_FAIL. Against the FIXED function the
-- restore raises ORDER_RESTORE_NOT_SUPPORTED, so the chain reaches
-- SMOKE_PASS_ROLLBACK.
--
-- One DO block, terminal exception -> nothing commits.
CREATE OR REPLACE FUNCTION pg_temp.convert_quote_to_order_smoke(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  -- Signature-newest-first. The below-cost approval work (20260812115237)
  -- widened this wrapper to (uuid,uuid,text,bigint,text) with
  -- p_below_cost_reason last, and every argument after the first carries a
  -- DEFAULT. That matters: the three-argument fallback at the bottom still
  -- RESOLVES against the widened function, silently defaulting
  -- p_expected_row_version to NULL, which the row-version guard rejects as
  -- QUOTE_STALE_WRITE long before the logic this chain exists to prove.
  -- Probing the widest signature first keeps the row version actually sent.
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4, NULL::text)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.convert_quote_to_order(
    p_quote_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$helper$;

DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_quote    uuid;
  v_sec      uuid;
  v_res      jsonb;
  v_order    uuid;
  v_status   text;
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- [E2E] marker satisfies the live-testdata guard; terminal rollback removes it.
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] H4 Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name)
  VALUES ('[E2E] H4 Herbicide ' || v_suffix) RETURNING id INTO v_product;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-H4-Q-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote, 'Main') RETURNING id INTO v_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote, v_sec, v_product, 10, 6, 100, 'gal');

  SELECT pg_temp.convert_quote_to_order_smoke(
    v_quote,
    v_admin,
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_quote)
  ) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  v_order := (v_res->>'order_id')::uuid;
  SELECT public.cancel_order(
    v_order, v_admin, 'smoke-forbid-restore-cancel-' || v_suffix
  ) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: cancel returned %, expected cancelled', v_res;
  END IF;

  -- ===== FAIL-FIRST: restore must be refused =====
  BEGIN
    SELECT public.restore_cancelled_order(v_order, 'H4 smoke: should be refused', v_admin, 'e2e-h4-restore-' || v_suffix)
    INTO v_res;
    -- Reached only on the PRE-FIX function: the cancelled order was restored.
    RAISE EXCEPTION 'SMOKE_FAIL: restore_cancelled_order succeeded — corrupt order restored (H4 live)';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_RESTORE_NOT_SUPPORTED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: restore_cancelled_order wrong error: %', v_err;
    END IF;
  END;

  -- The order stayed cancelled (restore did not mutate).
  SELECT status INTO v_status FROM public.orders WHERE id = v_order;
  IF v_status <> 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order status = % after refused restore, expected cancelled', v_status;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
