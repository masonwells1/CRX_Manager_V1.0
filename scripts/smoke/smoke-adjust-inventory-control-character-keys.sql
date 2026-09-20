-- Rolled-back smoke chain: adjust_inventory refuses idempotency keys that
-- carry an ASCII control character, and refuses a key made only of non-ASCII
-- text, WITHOUT refusing an ordinary key.
--
-- Covers adjust_inventory after
-- 20260911130000_refuse_control_character_adjust_inventory_keys.sql.
--
-- CONTAINER ONLY: plants [SMOKE] auth.users / profiles / product / inventory
-- rows itself, which the live-data guard correctly refuses. Run via
-- scripts/smoke/prove-adjust-inventory-control-character-keys.mjs.
--
-- Proves:
--   * a key carrying a C0 control character (a UUID with a trailing newline --
--     the exact shape the 20260911120000 check accepted, because it carries
--     plenty of printable ASCII) is refused with IDEMPOTENCY_KEY_REQUIRED;
--   * a key carrying DEL (U+007F) is refused, which is the "plus DEL" half of
--     the documented refused set;
--   * a key carrying a C1 control (U+0085 NEL) is refused. PostgreSQL's
--     [[:cntrl:]] covers U+0080-U+009F too, so the refused set is C0 + DEL + C1.
--     An earlier draft of the migration header said C1 controls PASS; this case
--     exists so that error cannot come back;
--   * the boundary on the other side holds: NBSP (U+00A0), one code point above
--     the C1 block, is ACCEPTED;
--   * a key made only of non-ASCII text is refused -- not whitespace and not a
--     control character, so the COLLATE "C" [!-~] test is the ONLY thing that
--     refuses it. That is what makes that line load-bearing and the
--     [^[:space:]] line beside it redundant;
--   * every refusal happens BEFORE any work: no receipt, no ledger row, no
--     stock movement;
--   * an ORDINARY key still works -- stock moves once, one 'adjusted' ledger
--     row, one receipt bound to the actor and the request. Without this the
--     chain would pass for a body that refused everything;
--   * SCOPE, stated honestly rather than aspirationally: a key carrying ZWSP
--     (U+200B) is ACCEPTED. ZWSP is not an ASCII control character, and this
--     migration does not claim to reject it. If a later change starts refusing
--     it, this case fails and the claim in the migration header must be
--     rewritten rather than quietly widened.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin    uuid := '5d000000-0000-4000-8000-00000000000a';
  v_product  uuid := '5d000000-0000-4000-8000-0000000000f1';
  v_inv      uuid;
  v_qty      numeric;
  v_count    integer;
  v_bound    uuid;
  v_fp       text;
  v_res      jsonb;
  v_nl_key   text;
  v_del_key  text;
  v_c1_key   text;
  v_utf8_key text;
  v_nbsp_key text;
  v_ok_key   text;
  v_zwsp_key text;
BEGIN
  ----------------------------------------------------------------------------
  -- Fixtures (rolled back with everything else)
  ----------------------------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin, 'smoke-ctrlkey-admin@example.invalid',
     '{"full_name":"[SMOKE] Ctrl Key Admin","role":"admin"}'::jsonb)
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO v_count FROM public.profiles
   WHERE id = v_admin AND role = 'admin' AND is_active;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: signup trigger did not create the admin fixture profile (found %)', v_count;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.products (id, product_name, sku, is_active)
  VALUES (v_product, '[SMOKE] Ctrl Key Product', 'SMOKE-CTRL-1', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_product, 'Main Warehouse', 100, 0, 0)
  RETURNING id INTO v_inv;

  ----------------------------------------------------------------------------
  -- 1. Control-character and non-ASCII-only keys refused before any work
  ----------------------------------------------------------------------------
  -- A real-shaped key with a trailing newline. chr(10) is a C0 control. This
  -- key carries 36 printable ASCII characters, so the pre-20260911130000 check
  -- ("at least one [!-~]") accepted it.
  v_nl_key := gen_random_uuid()::text || chr(10);
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'newline key', v_admin, v_nl_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a key carrying a newline was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;

  -- DEL (U+007F). Not a C0 control, but POSIX [[:cntrl:]] includes it, which is
  -- why the header says "the C0 controls plus DEL".
  v_del_key := gen_random_uuid()::text || chr(127);
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'del key', v_admin, v_del_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a key carrying DEL was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;

  -- C1 control (U+0085 NEL). POSIX [[:cntrl:]] in PostgreSQL covers U+0080 to
  -- U+009F as well as C0 and DEL, so this IS refused. An earlier draft of the
  -- migration header claimed C1 controls pass; measured on live 2026-09-20 they
  -- do not. This case exists so that claim can never drift back.
  v_c1_key := gen_random_uuid()::text || chr(133);
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'c1 key', v_admin, v_c1_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a key carrying a C1 control (U+0085) was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;

  -- Non-ASCII only (U+00E9 repeated). Not whitespace, so [^[:space:]] passes
  -- it; not a control character, so [[:cntrl:]] passes it. Only the COLLATE "C"
  -- [!-~] test refuses it.
  v_utf8_key := repeat(chr(233), 8);
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'non-ascii key', v_admin, v_utf8_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a non-ASCII-only key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;

  -- Refused BEFORE any work: no receipt, no ledger row, no stock movement.
  SELECT count(*) INTO v_count FROM public.idempotency_keys
   WHERE idempotency_key IN (v_nl_key, v_del_key, v_c1_key, v_utf8_key);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused key left % receipt(s)', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_transactions WHERE product_id = v_product;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  IF v_qty <> 100 OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused key moved stock or wrote a ledger row (qty %, ledger rows %)', v_qty, v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 2. An ORDINARY key still works. Without this the chain would also pass for
  --    a body that refused every key.
  ----------------------------------------------------------------------------
  v_ok_key := gen_random_uuid()::text;
  v_res := public.adjust_inventory(v_inv, 5, 'ordinary key', v_admin, v_ok_key);
  IF v_res ->> 'status' IS DISTINCT FROM 'adjusted'
     OR (v_res ->> 'new_quantity')::numeric IS DISTINCT FROM 105
     OR (v_res ->> 'product_id')::uuid IS DISTINCT FROM v_product THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an ordinary key returned %', v_res;
  END IF;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  SELECT count(*) INTO v_count FROM public.inventory_transactions
   WHERE product_id = v_product AND transaction_type = 'adjusted';
  IF v_qty <> 105 OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an ordinary key left qty % and % ledger row(s)', v_qty, v_count;
  END IF;
  SELECT request_actor_id, request_fingerprint INTO v_bound, v_fp
    FROM public.idempotency_keys
   WHERE idempotency_key = v_ok_key AND operation = 'adjust_inventory';
  IF v_bound IS DISTINCT FROM v_admin OR v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ordinary-key receipt not bound (actor=%, fingerprint=%)', v_bound, v_fp;
  END IF;

  ----------------------------------------------------------------------------
  -- 3. Documented scope limit: ZWSP is NOT an ASCII control and is ACCEPTED.
  --    This case exists to keep the migration header honest. If a later change
  --    makes this refuse, rewrite the header claim -- do not delete this case.
  ----------------------------------------------------------------------------
  v_zwsp_key := gen_random_uuid()::text || chr(8203);
  v_res := public.adjust_inventory(v_inv, 3, 'zwsp key', v_admin, v_zwsp_key);
  IF v_res ->> 'status' IS DISTINCT FROM 'adjusted'
     OR (v_res ->> 'new_quantity')::numeric IS DISTINCT FROM 108 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a ZWSP-bearing key was refused or misbehaved: % (the migration header claims it is accepted)', v_res;
  END IF;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  SELECT count(*) INTO v_count FROM public.inventory_transactions
   WHERE product_id = v_product AND transaction_type = 'adjusted';
  IF v_qty <> 108 OR v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the ZWSP key left qty % and % ledger row(s)', v_qty, v_count;
  END IF;

  -- NBSP (U+00A0) sits directly beside the C1 block that IS refused, so it is
  -- the sharpest boundary case: one code point higher than U+009F and accepted.
  v_nbsp_key := gen_random_uuid()::text || chr(160);
  v_res := public.adjust_inventory(v_inv, 2, 'nbsp key', v_admin, v_nbsp_key);
  IF v_res ->> 'status' IS DISTINCT FROM 'adjusted'
     OR (v_res ->> 'new_quantity')::numeric IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an NBSP-bearing key was refused or misbehaved: % (the migration header claims it is accepted)', v_res;
  END IF;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  SELECT count(*) INTO v_count FROM public.inventory_transactions
   WHERE product_id = v_product AND transaction_type = 'adjusted';
  IF v_qty <> 110 OR v_count <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the NBSP key left qty % and % ledger row(s)', v_qty, v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
