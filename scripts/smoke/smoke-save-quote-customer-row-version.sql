-- Real rollback-only fixture proof for 20260730031925_quote_customer_row_version_guard.
-- Run only against a disposable restored schema or after the governed apply,
-- as one transaction. PASS is exactly SMOKE_PASS_ROLLBACK; any other result
-- is failure. The block calls the real save_quote/save_customer functions.
BEGIN;

DO $smoke$
DECLARE
  v_admin uuid; v_rep uuid; v_nonoffice uuid; v_customer uuid; v_quote uuid; v_product uuid;
  v_q jsonb; v_q_replay jsonb; v_c jsonb; v_c_replay jsonb;
  v_quote_before bigint; v_customer_before bigint; v_quote_after bigint; v_quote_after_second bigint; v_quote_stale_draft bigint; v_customer_after bigint; v_customer_money_after bigint;
  v_prepay_before bigint; v_prepay_after bigint;
  v_versions_before integer; v_orders_before integer;
  v_note_before text; v_admin_name text; v_addresses_before jsonb; v_error text;
  v_sent_at_first timestamptz; v_sent_at_after timestamptz; v_split_after jsonb;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_sections jsonb;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_nonoffice FROM public.profiles WHERE role NOT IN ('admin', 'sales_rep') AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_nonoffice IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin, sales rep, and non-office profile required';
  END IF;
  SELECT full_name INTO v_admin_name FROM public.profiles WHERE id = v_admin;
  IF NULLIF(btrim(v_admin_name), '') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin must have a display name for commission persistence proof';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] RV quote customer ' || v_suffix, v_admin) RETURNING id INTO v_customer;
  -- Supplier-pricing hardening permits only a pricing-free shell here. The
  -- concurrency smoke deliberately does not forge a pricing change set; its
  -- server-math assertion below proves the client-supplied 999 cannot land.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[SMOKE] RV product ' || v_suffix, 'gal') RETURNING id INTO v_product;
  v_sections := jsonb_build_array(jsonb_build_object('section_name', 'S', 'sort_order', 0, 'items', jsonb_build_array(
    jsonb_build_object('product_id', v_product, 'calc_mode', 'units_direct', 'total_units_needed', 2, 'price_per_unit', 999, 'current_cost', 999, 'sort_order', 0))));

  -- New quote and exact idempotent replay: creation remains token-free and
  -- returns the original result instead of another quote. Keep this fixture
  -- planned so the exact token assertions also exercise the full planned-hold
  -- synchronization helper chain.
  v_q := public.save_quote(NULL, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'draft', 'tier', 1, 'is_planned', true), v_sections, v_admin, 'rv-quote-create-' || v_suffix);
  v_quote := (v_q->>'quote_id')::uuid;
  v_q_replay := public.save_quote(NULL, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'draft', 'tier', 1, 'is_planned', true), v_sections, v_admin, 'rv-quote-create-' || v_suffix);
  IF v_q_replay IS DISTINCT FROM v_q OR (SELECT count(*) FROM quotes WHERE id = v_quote) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote idempotent creation replay changed outcome';
  END IF;
  BEGIN
    PERFORM public.save_quote(NULL, jsonb_build_object('quote_number', 'CONFLICT-' || v_suffix, 'customer_id', v_customer, 'status', 'draft', 'tier', 1), '[]'::jsonb, v_admin, 'rv-quote-create-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote idempotent replay accepted a different payload';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'IDEMPOTENCY_PAYLOAD_CONFLICT' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: quote payload-bound replay raised %', v_error;
    END IF;
  END;
  SELECT row_version INTO v_quote_before FROM quotes WHERE id = v_quote;
  -- The insert starts at the column default (1), then the one consolidated
  -- header/totals UPDATE advances it exactly once.
  IF v_quote_before <> 2
     OR (v_q->>'row_version')::bigint <> v_quote_before
     OR NOT (SELECT is_planned FROM quotes WHERE id = v_quote) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: new planned quote row_version %, expected returned token 2 after one consolidated update and planned-hold sync', v_quote_before;
  END IF;

  -- Fresh existing-row save proves header/sections/items and server math still
  -- execute through the canonical RPC; client price 999 must not win.
  v_q := public.save_quote(v_quote, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'draft', 'tier', 1, 'header_notes', 'fresh', 'row_version_expected', v_quote_before), v_sections, v_admin, 'rv-quote-fresh-' || v_suffix);
  SELECT row_version, header_notes INTO v_quote_after, v_note_before FROM quotes WHERE id = v_quote;
  IF v_q->>'status' <> 'saved' OR (v_q->>'row_version')::bigint <> v_quote_after OR v_quote_after <> v_quote_before + 1
     OR v_note_before <> 'fresh' OR (SELECT count(*) FROM quote_sections WHERE quote_id = v_quote) <> 1
     OR (SELECT count(*) FROM quote_items WHERE quote_id = v_quote) <> 1
     -- The Product shell has no governed price/cost data.  Forged client 999s
     -- must therefore be replaced with the Product-derived zero values at
     -- both the stored item and returned/stored quote-total boundaries.
     OR (SELECT price_per_unit FROM quote_items WHERE quote_id = v_quote) <> 0
     OR (SELECT current_cost FROM quote_items WHERE quote_id = v_quote) <> 0
     OR (SELECT total_price FROM quote_items WHERE quote_id = v_quote) <> 0
     OR (SELECT profit FROM quote_items WHERE quote_id = v_quote) <> 0
     OR (SELECT total_price FROM quotes WHERE id = v_quote) <> 0
     OR (SELECT total_cost FROM quotes WHERE id = v_quote) <> 0
     OR (SELECT total_profit FROM quotes WHERE id = v_quote) <> 0
     OR (v_q->'server_totals'->>'total_price')::numeric <> 0
     OR (v_q->'server_totals'->>'total_cost')::numeric <> 0
     OR (v_q->'server_totals'->>'total_profit')::numeric <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fresh quote save lost canonical section/item/math behavior';
  END IF;

  -- The returned token must be immediately usable by the same page. A second
  -- save reaches exactly N+2 without a recovery reread or stale rejection.
  v_q := public.save_quote(v_quote, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'draft', 'tier', 1, 'header_notes', 'fresh-second', 'row_version_expected', v_quote_after), v_sections, v_admin, 'rv-quote-fresh-second-' || v_suffix);
  SELECT row_version, header_notes INTO v_quote_after_second, v_note_before FROM quotes WHERE id = v_quote;
  IF v_q->>'status' <> 'saved'
     OR (v_q->>'row_version')::bigint <> v_quote_after_second
     OR v_quote_after_second <> v_quote_after + 1
     OR v_note_before <> 'fresh-second' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: second same-session quote save did not advance exactly N+1 to N+2';
  END IF;
  v_quote_after := v_quote_after_second;
  v_quote_stale_draft := v_quote_after;

  -- Exercise the canonical lifecycle assignments that were moved into the
  -- single consolidated UPDATE. A valid draft -> sent save must bump exactly
  -- once, stamp sent_at once, and persist the supplied money-routing
  -- split. Saving sent again must preserve both the timestamp and split.
  v_q := public.save_quote(v_quote, jsonb_build_object(
    'quote_number', '[SMOKE] RVQ-' || v_suffix,
    'customer_id', v_customer,
    'status', 'sent',
    'tier', 1,
    'header_notes', 'fresh-sent',
    'commission_split_expected', (SELECT commission_split FROM quotes WHERE id = v_quote),
    'commission_split', jsonb_build_object('splits', jsonb_build_array(jsonb_build_object(
      'recipient', v_admin_name, 'recipient_user_id', v_admin, 'percentage', 100))),
    'row_version_expected', v_quote_after),
    v_sections, v_admin, 'rv-quote-sent-' || v_suffix);
  SELECT row_version, sent_at, commission_split
    INTO v_quote_after_second, v_sent_at_first, v_split_after
  FROM quotes WHERE id = v_quote;
  IF v_q->>'status' <> 'saved'
     OR (v_q->>'row_version')::bigint <> v_quote_after_second
     OR v_quote_after_second <> v_quote_after + 1
     OR (SELECT status FROM quotes WHERE id = v_quote) <> 'sent'
     OR v_sent_at_first IS NULL
     OR v_q->'commission_split' IS DISTINCT FROM v_split_after
     OR v_split_after#>>'{splits,0,recipient_user_id}' IS DISTINCT FROM v_admin::text
     OR (v_split_after#>>'{splits,0,percentage}')::numeric IS DISTINCT FROM 100::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draft-to-sent save lost status, sent_at, commission split, or exact N+1 token';
  END IF;
  v_quote_after := v_quote_after_second;

  v_q := public.save_quote(v_quote, jsonb_build_object(
    'quote_number', '[SMOKE] RVQ-' || v_suffix,
    'customer_id', v_customer,
    'status', 'sent',
    'tier', 1,
    'header_notes', 'fresh-sent-again',
    'row_version_expected', v_quote_after),
    v_sections, v_admin, 'rv-quote-sent-again-' || v_suffix);
  SELECT row_version, sent_at
    INTO v_quote_after_second, v_sent_at_after
  FROM quotes WHERE id = v_quote;
  IF v_q->>'status' <> 'saved'
     OR (v_q->>'row_version')::bigint <> v_quote_after_second
     OR v_quote_after_second <> v_quote_after + 1
     OR (SELECT status FROM quotes WHERE id = v_quote) <> 'sent'
     OR v_sent_at_after IS DISTINCT FROM v_sent_at_first
     OR (SELECT commission_split FROM quotes WHERE id = v_quote) IS DISTINCT FROM v_split_after THEN
    RAISE EXCEPTION 'SMOKE_FAIL: repeated sent save reset sent_at, lost commission split, or missed exact N+1 token';
  END IF;
  v_quote_after := v_quote_after_second;

  -- A tab that still holds the earlier draft snapshot must reach the generic
  -- stale-write recovery path after another real save_quote call advances the
  -- stored quote to sent. Lifecycle validation must not hide that conflict.
  BEGIN
    PERFORM public.save_quote(v_quote, jsonb_build_object(
      'quote_number', '[SMOKE] RVQ-' || v_suffix,
      'customer_id', v_customer,
      'status', 'draft',
      'tier', 1,
      'header_notes', 'STALE-DRAFT-MUST-NOT-LAND',
      'row_version_expected', v_quote_stale_draft),
      '[]'::jsonb, v_admin, 'rv-quote-stale-draft-after-sent-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: stale draft after sent succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'QUOTE_STALE_WRITE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale draft after sent raised % instead of QUOTE_STALE_WRITE', v_error;
    END IF;
  END;
  IF (SELECT row_version FROM quotes WHERE id = v_quote) <> v_quote_after
     OR (SELECT status FROM quotes WHERE id = v_quote) <> 'sent'
     OR (SELECT header_notes FROM quotes WHERE id = v_quote) <> 'fresh-sent-again'
     OR (SELECT sent_at FROM quotes WHERE id = v_quote) IS DISTINCT FROM v_sent_at_first
     OR (SELECT count(*) FROM quote_sections WHERE quote_id = v_quote) <> 1
     OR (SELECT count(*) FROM quote_items WHERE quote_id = v_quote) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected stale draft after sent changed status, header, children, timestamp, or version';
  END IF;

  -- The older token cannot mutate either the header or replaced children.
  BEGIN
    PERFORM public.save_quote(v_quote, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'sent', 'tier', 1, 'header_notes', 'STALE-MUST-NOT-LAND', 'row_version_expected', v_quote_before), '[]'::jsonb, v_admin, 'rv-quote-stale-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: stale quote save succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'QUOTE_STALE_WRITE:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stale quote raised %', v_error; END IF;
  END;
  IF (SELECT row_version FROM quotes WHERE id = v_quote) <> v_quote_after OR (SELECT header_notes FROM quotes WHERE id = v_quote) <> 'fresh-sent-again'
     OR (SELECT count(*) FROM quote_sections WHERE quote_id = v_quote) <> 1 OR (SELECT count(*) FROM quote_items WHERE quote_id = v_quote) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected stale quote changed header or children';
  END IF;
  BEGIN
    PERFORM public.save_quote(NULL, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'draft', 'tier', 1, 'is_planned', true), v_sections, v_admin, 'rv-quote-create-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote creation replay returned a cached token after later writes';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'QUOTE_STALE_WRITE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: advanced quote replay raised %', v_error;
    END IF;
  END;

  -- Split-specific conflict remains first even with a current whole-record token.
  UPDATE quotes SET commission_split = NULL WHERE id = v_quote;
  SELECT row_version INTO v_quote_after FROM quotes WHERE id = v_quote;
  BEGIN
    PERFORM public.save_quote(v_quote, jsonb_build_object('quote_number', '[SMOKE] RVQ-' || v_suffix, 'customer_id', v_customer, 'status', 'sent', 'tier', 1, 'commission_split_expected', '{"splits":[]}'::jsonb, 'commission_split', '{"splits":[]}'::jsonb, 'row_version_expected', v_quote_after), v_sections, v_admin, 'rv-quote-split-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote split conflict did not reject';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'COMMISSION_SPLIT_CONFLICT:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: quote split precedence was %', v_error; END IF;
  END;

  -- New customer, address insert, and exact replay stay valid and token-free.
  v_c := public.save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] RVC ' || v_suffix, 'assigned_sales_rep', v_admin, 'assigned_tier', 1), jsonb_build_array(jsonb_build_object('label', 'main', 'address_line', '1 Fresh Rd', 'is_default', true)), v_admin, 'rv-customer-create-' || v_suffix);
  v_customer := (v_c->>'customer_id')::uuid;
  v_c_replay := public.save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] RVC ' || v_suffix, 'assigned_sales_rep', v_admin, 'assigned_tier', 1), jsonb_build_array(jsonb_build_object('label', 'main', 'address_line', '1 Fresh Rd', 'is_default', true)), v_admin, 'rv-customer-create-' || v_suffix);
  IF v_c_replay IS DISTINCT FROM v_c OR (SELECT count(*) FROM customer_addresses WHERE customer_id = v_customer) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer idempotent creation/address behavior regressed';
  END IF;
  BEGIN
    PERFORM public.save_customer(NULL, jsonb_build_object('farm_name', 'CONFLICT-' || v_suffix, 'assigned_sales_rep', v_admin), '[]'::jsonb, v_admin, 'rv-customer-create-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: customer idempotent replay accepted a different payload';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'IDEMPOTENCY_PAYLOAD_CONFLICT' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: customer payload-bound replay raised %', v_error;
    END IF;
  END;
  SELECT row_version INTO v_customer_before FROM customers WHERE id = v_customer;
  v_c := public.save_customer(v_customer, jsonb_build_object('farm_name', '[SMOKE] RVC fresh ' || v_suffix, 'row_version_expected', v_customer_before), jsonb_build_array(jsonb_build_object('label', 'main', 'address_line', '2 Fresh Rd', 'is_default', true)), v_admin, 'rv-customer-fresh-' || v_suffix);
  SELECT row_version INTO v_customer_after FROM customers WHERE id = v_customer;
  SELECT jsonb_agg(jsonb_build_object('label', label, 'address_line', address_line) ORDER BY id) INTO v_addresses_before FROM customer_addresses WHERE customer_id = v_customer;
  IF v_c->>'status' <> 'saved' OR (v_c->>'row_version')::bigint <> v_customer_after OR v_customer_after <= v_customer_before
     OR (SELECT farm_name FROM customers WHERE id = v_customer) <> '[SMOKE] RVC fresh ' || v_suffix THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fresh customer save did not return stored version';
  END IF;
  BEGIN
    PERFORM public.save_customer(v_customer, jsonb_build_object('farm_name', 'STALE-MUST-NOT-LAND', 'row_version_expected', v_customer_before), '[]'::jsonb, v_admin, 'rv-customer-stale-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: stale customer save succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'CUSTOMER_STALE_WRITE:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: stale customer raised %', v_error; END IF;
  END;
  IF (SELECT row_version FROM customers WHERE id = v_customer) <> v_customer_after
     OR (SELECT farm_name FROM customers WHERE id = v_customer) <> '[SMOKE] RVC fresh ' || v_suffix
     OR (SELECT jsonb_agg(jsonb_build_object('label', label, 'address_line', address_line) ORDER BY id) FROM customer_addresses WHERE customer_id = v_customer) IS DISTINCT FROM v_addresses_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected stale customer changed header or addresses';
  END IF;

  -- A non-editor money-path update must also invalidate an open whole-record
  -- editor. This is deliberately fail-closed: the typed header/address payload
  -- stays untouched until the operator reloads the newly committed customer.
  SELECT COALESCE(prepay_balance_cents, 0) INTO v_prepay_before
  FROM customers WHERE id = v_customer;
  UPDATE customers
  SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + 1
  WHERE id = v_customer;
  SELECT row_version, COALESCE(prepay_balance_cents, 0)
    INTO v_customer_money_after, v_prepay_after
  FROM customers WHERE id = v_customer;
  IF v_customer_money_after <> v_customer_after + 1
     OR v_prepay_after <> v_prepay_before + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer money-path update did not advance the whole-record token exactly once';
  END IF;
  BEGIN
    PERFORM public.save_customer(
      v_customer,
      jsonb_build_object(
        'farm_name', 'MONEY-RACE-MUST-NOT-LAND',
        'row_version_expected', v_customer_after),
      jsonb_build_array(jsonb_build_object(
        'label', 'main',
        'address_line', 'MONEY-RACE-MUST-NOT-LAND',
        'is_default', true)),
      v_admin,
      'rv-customer-money-race-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: customer editor stayed writable after a concurrent money-path update';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'CUSTOMER_STALE_WRITE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: customer money-path race raised %', v_error;
    END IF;
  END;
  IF (SELECT row_version FROM customers WHERE id = v_customer) <> v_customer_money_after
     OR (SELECT COALESCE(prepay_balance_cents, 0) FROM customers WHERE id = v_customer) <> v_prepay_after
     OR (SELECT farm_name FROM customers WHERE id = v_customer) <> '[SMOKE] RVC fresh ' || v_suffix
     OR (SELECT jsonb_agg(jsonb_build_object('label', label, 'address_line', address_line) ORDER BY id) FROM customer_addresses WHERE customer_id = v_customer) IS DISTINCT FROM v_addresses_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected customer money-path race changed editor fields, addresses, money, or version';
  END IF;
  v_customer_after := v_customer_money_after;
  BEGIN
    PERFORM public.save_customer(NULL, jsonb_build_object('farm_name', '[SMOKE] RVC ' || v_suffix, 'assigned_sales_rep', v_admin, 'assigned_tier', 1), jsonb_build_array(jsonb_build_object('label', 'main', 'address_line', '1 Fresh Rd', 'is_default', true)), v_admin, 'rv-customer-create-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: customer creation replay returned a cached token after later writes';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'CUSTOMER_STALE_WRITE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: advanced customer replay raised %', v_error;
    END IF;
  END;

  UPDATE customers SET default_commission_split = NULL WHERE id = v_customer;
  SELECT row_version INTO v_customer_after FROM customers WHERE id = v_customer;
  BEGIN
    PERFORM public.save_customer(v_customer, jsonb_build_object('farm_name', '[SMOKE] RVC fresh ' || v_suffix, 'default_commission_split_expected', '{"splits":[]}'::jsonb, 'default_commission_split', '{"splits":[]}'::jsonb, 'row_version_expected', v_customer_after), '[]'::jsonb, v_admin, 'rv-customer-split-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: customer split conflict did not reject';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'COMMISSION_SPLIT_CONFLICT:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: customer split precedence was %', v_error; END IF;
  END;

  -- Simulate a second writer advancing the quote after this action read its
  -- token. Both lifecycle mutators must reject that stale token while holding
  -- the real quote row lock, before creating a version or an order.
  SELECT row_version,
         (SELECT count(*) FROM public.quote_versions WHERE quote_id = v_quote),
         (SELECT count(*) FROM public.orders WHERE quote_id = v_quote AND deleted_at IS NULL)
    INTO v_quote_stale_draft, v_versions_before, v_orders_before
  FROM public.quotes
  WHERE id = v_quote;
  UPDATE public.quotes SET updated_at = updated_at WHERE id = v_quote;

  BEGIN
    PERFORM public.create_quote_version(
      v_quote, v_admin, 'emailed', 'rv-version-stale-' || v_suffix, v_quote_stale_draft);
    RAISE EXCEPTION 'SMOKE_FAIL: stale quote token created a quote version';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'QUOTE_STALE_WRITE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale quote-version action raised %', v_error;
    END IF;
  END;
  BEGIN
    PERFORM public.convert_quote_to_order(
      v_quote, v_admin, 'rv-convert-stale-' || v_suffix, v_quote_stale_draft);
    RAISE EXCEPTION 'SMOKE_FAIL: stale quote token converted a quote';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'QUOTE_STALE_WRITE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: stale quote-conversion action raised %', v_error;
    END IF;
  END;
  IF (SELECT count(*) FROM public.quote_versions WHERE quote_id = v_quote) <> v_versions_before
     OR (SELECT count(*) FROM public.orders WHERE quote_id = v_quote AND deleted_at IS NULL) <> v_orders_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected stale lifecycle action changed downstream rows';
  END IF;

  -- The fresh action succeeds once, records the request/post versions in its
  -- cache, and an exact replay returns the same version without another write.
  SELECT row_version INTO v_quote_after FROM public.quotes WHERE id = v_quote;
  v_q := public.create_quote_version(
    v_quote, v_admin, 'emailed', 'rv-version-fresh-' || v_suffix, v_quote_after);
  SELECT row_version INTO v_quote_after_second FROM public.quotes WHERE id = v_quote;
  IF v_q->>'status' <> 'created'
     OR v_quote_after_second <> v_quote_after + 1
     OR (SELECT count(*) FROM public.quote_versions WHERE quote_id = v_quote) <> v_versions_before + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fresh quote-version action did not commit exactly once';
  END IF;
  v_q_replay := public.create_quote_version(
    v_quote, v_admin, 'emailed', 'rv-version-fresh-' || v_suffix, v_quote_after);
  IF v_q_replay->>'status' <> 'duplicate'
     OR v_q_replay->>'version_id' IS DISTINCT FROM v_q->>'version_id'
     OR (SELECT row_version FROM public.quotes WHERE id = v_quote) <> v_quote_after_second
     OR (SELECT count(*) FROM public.quote_versions WHERE quote_id = v_quote) <> v_versions_before + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote-version replay was not bound to the original versioned request';
  END IF;
  v_quote_after := v_quote_after_second;

  -- Auth and role gates still run before a stale payload can write.
  PERFORM set_config('request.jwt.claims', '{}'::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN PERFORM public.save_customer(v_customer, jsonb_build_object('row_version_expected', v_customer_after), '[]'::jsonb, v_admin, NULL); RAISE EXCEPTION 'SMOKE_FAIL: unauthenticated customer save succeeded';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM <> 'AUTH_REQUIRED' THEN RAISE EXCEPTION 'SMOKE_FAIL: customer auth gate %', SQLERRM; END IF; END;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN PERFORM public.save_customer(v_customer, jsonb_build_object('farm_name', 'REP-MUST-NOT-OWN', 'row_version_expected', v_customer_after), '[]'::jsonb, v_rep, NULL); RAISE EXCEPTION 'SMOKE_FAIL: non-owner sales rep customer save succeeded';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM <> 'NOT_CUSTOMER_OWNER' THEN RAISE EXCEPTION 'SMOKE_FAIL: customer ownership gate %', SQLERRM; END IF; END;
  BEGIN
    PERFORM public.save_quote(
      v_quote,
      jsonb_build_object(
        'quote_number', '[SMOKE] RVQ-' || v_suffix,
        'customer_id', v_customer,
        'status', 'sent',
        'tier', 1,
        'header_notes', 'REP-MUST-NOT-OWN',
        'row_version_expected', v_quote_after),
      v_sections,
      v_rep,
      'rv-quote-nonowner-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: non-owner sales rep quote save succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'NOT_QUOTE_OWNER' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: quote ownership gate %', v_error;
    END IF;
  END;
  BEGIN
    PERFORM public.save_quote(
      NULL,
      jsonb_build_object(
        'quote_number', 'REPLAY-MUST-NOT-LEAK-' || v_suffix,
        'customer_id', v_customer,
        'status', 'draft',
        'tier', 1),
      '[]'::jsonb,
      v_rep,
      'rv-quote-create-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: non-owner sales rep received another actor''s quote replay';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'NOT_QUOTE_OWNER' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: quote replay ownership gate %', v_error;
    END IF;
  END;
  BEGIN
    PERFORM public.create_quote_version(
      v_quote, v_rep, 'emailed', 'rv-version-nonowner-' || v_suffix, v_quote_after);
    RAISE EXCEPTION 'SMOKE_FAIL: non-owner sales rep created another rep''s quote version';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'NOT_QUOTE_OWNER' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: quote-version ownership gate %', v_error;
    END IF;
  END;
  BEGIN
    PERFORM public.convert_quote_to_order(
      v_quote, v_rep, 'rv-convert-nonowner-' || v_suffix, v_quote_after);
    RAISE EXCEPTION 'SMOKE_FAIL: non-owner sales rep converted another rep''s quote';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error <> 'NOT_QUOTE_OWNER' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: quote-conversion ownership gate %', v_error;
    END IF;
  END;
  IF (SELECT row_version FROM quotes WHERE id = v_quote) <> v_quote_after
     OR (SELECT header_notes FROM quotes WHERE id = v_quote) <> 'fresh-sent-again' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected non-owner quote save/replay changed the quote';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_nonoffice, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_nonoffice::text, true);
  BEGIN PERFORM public.save_quote(v_quote, jsonb_build_object('status', 'sent', 'tier', 1, 'row_version_expected', v_quote_after), v_sections, v_nonoffice, NULL); RAISE EXCEPTION 'SMOKE_FAIL: non-office quote save succeeded';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF; IF SQLERRM <> 'Not authorized to save quotes' THEN RAISE EXCEPTION 'SMOKE_FAIL: quote role gate %', SQLERRM; END IF; END;

  -- Keep fixtures addressable after this privileged setup so the following
  -- authenticated-role block can prove child writes are RPC-only.
  PERFORM set_config('crx.row_version_smoke_quote_id', v_quote::text, true);
  PERFORM set_config('crx.row_version_smoke_customer_id', v_customer::text, true);
  PERFORM set_config('crx.row_version_smoke_product_id', v_product::text, true);
  PERFORM set_config('crx.row_version_smoke_admin_id', v_admin::text, true);
END $smoke$;

-- This is the normal application database role, with the active admin JWT
-- above. It proves a child cannot change between a stable parent-version read
-- and the next save: all three direct DML verbs fail before RLS can admit a
-- row, while the SECURITY DEFINER parent RPC still replaces the collection.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('crx.row_version_smoke_admin_id', true)::uuid, 'role', 'authenticated')::text,
  true
);
SELECT set_config('request.jwt.claim.sub', current_setting('crx.row_version_smoke_admin_id', true), true);
DO $authenticated_child_dml$
DECLARE
  v_quote uuid := current_setting('crx.row_version_smoke_quote_id', true)::uuid;
  v_customer uuid := current_setting('crx.row_version_smoke_customer_id', true)::uuid;
  v_product uuid := current_setting('crx.row_version_smoke_product_id', true)::uuid;
  v_quote_version bigint;
  v_customer_version bigint;
  v_q jsonb;
  v_c jsonb;
  v_child_table text;
  v_sql text;
  v_sections jsonb;
BEGIN
  IF v_quote IS NULL OR v_customer IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated child-DML fixture IDs are missing';
  END IF;

  -- A stable parent-version read is possible for the normal app role, but no
  -- direct child mutation can slip in before the parent-locking save RPC.
  SELECT row_version INTO v_quote_version FROM public.quotes WHERE id = v_quote;
  SELECT row_version INTO v_customer_version FROM public.customers WHERE id = v_customer;
  IF v_quote_version IS NULL OR v_customer_version IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated role could not read owned parent versions';
  END IF;

  FOREACH v_child_table IN ARRAY ARRAY['quote_sections', 'quote_items', 'customer_addresses'] LOOP
    FOREACH v_sql IN ARRAY ARRAY[
      format('INSERT INTO public.%I DEFAULT VALUES', v_child_table),
      format('UPDATE public.%I SET id = id WHERE false', v_child_table),
      format('DELETE FROM public.%I WHERE false', v_child_table)
    ] LOOP
      BEGIN
        EXECUTE v_sql;
        RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct child DML succeeded on %', v_child_table;
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
    END LOOP;
  END LOOP;

  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Authenticated RPC child write', 'sort_order', 0,
    'items', jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'calc_mode', 'units_direct',
      'total_units_needed', 1, 'sort_order', 0))));
  v_q := public.save_quote(v_quote, jsonb_build_object(
    'quote_number', (SELECT quote_number FROM public.quotes WHERE id = v_quote),
    'customer_id', v_customer, 'status', 'sent', 'tier', 1,
    'header_notes', 'authenticated-rpc-child-write',
    'row_version_expected', v_quote_version),
    v_sections,
    current_setting('request.jwt.claim.sub', true)::uuid,
    'rv-quote-auth-child-' || substr(md5(random()::text), 1, 8));
  IF (v_q->>'row_version')::bigint <> (SELECT row_version FROM public.quotes WHERE id = v_quote)
     OR (SELECT count(*) FROM public.quote_sections WHERE quote_id = v_quote) <> 1
     OR (SELECT count(*) FROM public.quote_items WHERE quote_id = v_quote) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated save_quote did not manage children through the parent lock';
  END IF;

  v_c := public.save_customer(v_customer, jsonb_build_object(
    'farm_name', '[SMOKE] authenticated customer update',
    'row_version_expected', v_customer_version),
    jsonb_build_array(jsonb_build_object('label', 'authenticated', 'address_line', '3 RPC-only Rd', 'is_default', true)),
    current_setting('request.jwt.claim.sub', true)::uuid,
    'rv-customer-auth-child-' || substr(md5(random()::text), 1, 8));
  IF (v_c->>'row_version')::bigint <> (SELECT row_version FROM public.customers WHERE id = v_customer)
     OR (SELECT count(*) FROM public.customer_addresses WHERE customer_id = v_customer) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated save_customer did not manage addresses through the parent lock';
  END IF;
END $authenticated_child_dml$;
RESET ROLE;

DO $rollback_marker$
BEGIN
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $rollback_marker$;
