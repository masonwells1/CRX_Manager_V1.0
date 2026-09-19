-- Rolled-back smoke chain: adjust_inventory authenticates and role-gates the
-- caller BEFORE it can replay a saved receipt, serializes on the idempotency
-- key, and binds the receipt to the signed-in actor and the exact request.
--
-- Covers adjust_inventory after
-- 20260911120000_bind_adjust_inventory_receipt_to_intent.sql.
--
-- CONTAINER ONLY: plants [SMOKE] auth.users / profiles / product / inventory
-- rows itself, which the live-data guard correctly refuses. Run via
-- scripts/smoke/prove-adjust-inventory-intent-binding-real-schema.mjs.
--
-- Proves:
--   * a keyed adjustment moves stock once, writes ONE 'adjusted' ledger row
--     and ONE receipt carrying request_actor_id and request_fingerprint;
--   * the same key with an identical request (5 vs 5.0) replays the same
--     result and moves nothing;
--   * THE FINDING (CRX-IDEM-01): a caller holding someone else's key cannot
--     read the receipt. Unauthenticated -> AUTH_REQUIRED; a sales rep ->
--     INSUFFICIENT_ROLE; a deactivated admin -> INSUFFICIENT_ROLE; a caller
--     with no profile row -> INSUFFICIENT_ROLE; a forged p_performed_by ->
--     ACTOR_MISMATCH; a DIFFERENT active admin -> IDEMPOTENCY_ACTOR_MISMATCH.
--     The live body returned the cached receipt to every one of them;
--   * the same key with a changed delta, reason or inventory row is refused
--     with IDEMPOTENCY_INTENT_MISMATCH (DETAIL carries the committed result
--     for the ORIGINAL actor only) and moves nothing;
--   * a NULL or blank key is refused with IDEMPOTENCY_KEY_REQUIRED before any
--     work (the live body adjusted stock unreceipted);
--   * a NULL, zero, NaN or infinite delta is refused and moves nothing (the
--     live body wrote NaN into quantity_available);
--   * a pre-migration receipt (both binding columns NULL) fails closed;
--   * cross-operation key reuse still raises;
--   * the negative-stock and not-found guards are unchanged and leave no
--     receipt; a legitimate negative adjustment still works;
--   * CUTOVER: an UNBOUND adjust_inventory receipt -- what an in-flight call
--     of the old body would write via save_idempotency -- is refused with
--     ADJUST_INVENTORY_UNBOUND_RECEIPT, and a receipt for any other operation
--     still inserts freely;
--   * anon cannot execute adjust_inventory; authenticated can; the trigger
--     function is not executable by anon, authenticated or service_role.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin     uuid := '5b000000-0000-4000-8000-00000000000a';
  v_admin2    uuid := '5b000000-0000-4000-8000-00000000000e';
  v_rep       uuid := '5b000000-0000-4000-8000-00000000000b';
  v_inactive  uuid := '5b000000-0000-4000-8000-00000000000c';
  v_ghost     uuid := '5b000000-0000-4000-8000-00000000000d'; -- no profile row
  v_product   uuid := '5b000000-0000-4000-8000-0000000000f1';
  v_product2  uuid := '5b000000-0000-4000-8000-0000000000f2';
  v_sig       text := 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
  v_trg_sig   text := 'public._refuse_unbound_adjust_inventory_receipt_20260911()';
  v_inv       uuid;
  v_inv2      uuid;
  v_res       jsonb;
  v_res2      jsonb;
  v_qty       numeric;
  v_count     integer;
  v_bound     uuid;
  v_fp        text;
  v_detail    text;
  v_role      text;
  v_caller    uuid;
  v_bad       numeric;
BEGIN
  ----------------------------------------------------------------------------
  -- Fixtures (rolled back with everything else)
  ----------------------------------------------------------------------------
  -- handle_new_user creates each profile from the signup metadata. The ghost
  -- gets NO auth.users row and therefore no profile: auth.uid() only needs the
  -- JWT claim.
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin,    'smoke-adjust-admin@example.invalid',    '{"full_name":"[SMOKE] Adjust Admin","role":"admin"}'::jsonb),
    (v_admin2,   'smoke-adjust-admin2@example.invalid',   '{"full_name":"[SMOKE] Adjust Admin Two","role":"admin"}'::jsonb),
    (v_rep,      'smoke-adjust-rep@example.invalid',      '{"full_name":"[SMOKE] Adjust Rep","role":"sales_rep"}'::jsonb),
    (v_inactive, 'smoke-adjust-inactive@example.invalid', '{"full_name":"[SMOKE] Adjust Inactive","role":"admin"}'::jsonb)
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO v_count FROM public.profiles
   WHERE (id IN (v_admin, v_admin2, v_inactive) AND role = 'admin' AND is_active)
      OR (id = v_rep AND role = 'sales_rep' AND is_active);
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: signup trigger did not create the four fixture profiles (found %)', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_ghost) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: ghost fixture unexpectedly has a profile row';
  END IF;
  -- Deactivating a profile is admin-only (trg_guard_profile_role_lock).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET is_active = false WHERE id = v_inactive;

  INSERT INTO public.products (id, product_name, sku, is_active) VALUES
    (v_product,  '[SMOKE] Adjust Product',     'SMOKE-ADJ-1', true),
    (v_product2, '[SMOKE] Adjust Product Two', 'SMOKE-ADJ-2', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_product, 'Main Warehouse', 100, 0, 0)
  RETURNING id INTO v_inv;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_product2, 'Main Warehouse', 100, 0, 0)
  RETURNING id INTO v_inv2;

  ----------------------------------------------------------------------------
  -- 1. Keyed adjustment: stock moves once, one ledger row, one bound receipt
  ----------------------------------------------------------------------------
  v_res := public.adjust_inventory(v_inv, 5, 'smoke count', v_admin, 'smoke-adj-key-1');
  IF v_res ->> 'status' IS DISTINCT FROM 'adjusted'
     OR (v_res ->> 'new_quantity')::numeric IS DISTINCT FROM 105
     OR (v_res ->> 'product_id')::uuid IS DISTINCT FROM v_product THEN
    RAISE EXCEPTION 'SMOKE_FAIL: first adjustment returned %', v_res;
  END IF;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  IF v_qty <> 105 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stock is % after +5 (expected 105)', v_qty;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_transactions
   WHERE product_id = v_product AND transaction_type = 'adjusted'
     AND quantity = 5 AND performed_by = v_admin AND notes = 'smoke count';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 adjusted ledger row, found %', v_count;
  END IF;
  SELECT request_actor_id, request_fingerprint INTO v_bound, v_fp
    FROM public.idempotency_keys
   WHERE idempotency_key = 'smoke-adj-key-1' AND operation = 'adjust_inventory';
  IF v_bound IS DISTINCT FROM v_admin OR v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: receipt not bound (actor=%, fingerprint=%)', v_bound, v_fp;
  END IF;

  ----------------------------------------------------------------------------
  -- 2. Identical request replays (5.0 = 5) and moves nothing
  ----------------------------------------------------------------------------
  v_res2 := public.adjust_inventory(v_inv, 5.0, 'smoke count', v_admin, 'smoke-adj-key-1');
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay returned % instead of %', v_res2, v_res;
  END IF;
  -- p_performed_by may also be omitted (NULL) on a retry: it cannot shape the
  -- outcome, so it is not part of the fingerprint.
  v_res2 := public.adjust_inventory(v_inv, 5, 'smoke count', NULL, 'smoke-adj-key-1');
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay with NULL p_performed_by returned %', v_res2;
  END IF;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  SELECT count(*) INTO v_count FROM public.inventory_transactions WHERE product_id = v_product;
  IF v_qty <> 105 OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay moved stock (qty %, ledger rows %)', v_qty, v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 3. THE FINDING: holding the key is not enough to read the receipt
  ----------------------------------------------------------------------------
  -- (a) unauthenticated
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    v_res2 := public.adjust_inventory(v_inv, 5, 'smoke count', NULL, 'smoke-adj-key-1');
    RAISE EXCEPTION 'SMOKE_FAIL: unauthenticated caller read the receipt: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE; END IF;
  END;

  -- (b) sales rep, (c) deactivated admin, (d) no profile row
  FOREACH v_caller IN ARRAY ARRAY[v_rep, v_inactive, v_ghost] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_caller)::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_caller::text, true);
    BEGIN
      v_res2 := public.adjust_inventory(v_inv, 5, 'smoke count', NULL, 'smoke-adj-key-1');
      RAISE EXCEPTION 'SMOKE_FAIL: non-admin caller % read the receipt: %', v_caller, v_res2;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE; END IF;
    END;
  END LOOP;

  -- (e) forged p_performed_by: a rep naming the admin
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    v_res2 := public.adjust_inventory(v_inv, 5, 'smoke count', v_admin, 'smoke-adj-key-1');
    RAISE EXCEPTION 'SMOKE_FAIL: forged p_performed_by read the receipt: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;

  -- (f) a DIFFERENT active admin: passes the role gate, refused by the binding,
  -- and the refusal must not carry the committed result.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin2)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin2::text, true);
  BEGIN
    v_res2 := public.adjust_inventory(v_inv, 5, 'smoke count', v_admin2, 'smoke-adj-key-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a second admin consumed the first admin''s receipt: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF coalesce(v_detail, '') LIKE '%new_quantity%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the actor-mismatch refusal disclosed the receipt: %', v_detail;
    END IF;
  END;

  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  SELECT count(*) INTO v_count FROM public.inventory_transactions WHERE product_id = v_product;
  IF v_qty <> 105 OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused caller moved stock (qty %, ledger rows %)', v_qty, v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 4. Changed request on the retained key: refused, moves nothing
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 6, 'smoke count', v_admin, 'smoke-adj-key-1');
    RAISE EXCEPTION 'SMOKE_FAIL: changed delta was accepted on the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail::jsonb ->> 'operation' IS DISTINCT FROM 'adjust_inventory'
       OR (v_detail::jsonb -> 'result' ->> 'new_quantity')::numeric IS DISTINCT FROM 105 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: mismatch DETAIL did not carry the committed result: %', v_detail;
    END IF;
  END;
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 5, 'edited reason', v_admin, 'smoke-adj-key-1');
    RAISE EXCEPTION 'SMOKE_FAIL: changed reason was accepted on the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.adjust_inventory(v_inv2, 5, 'smoke count', v_admin, 'smoke-adj-key-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a different inventory row was accepted on the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  IF v_qty <> 105 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused retry moved stock on row 1 (qty %)', v_qty;
  END IF;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv2;
  IF v_qty <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused retry moved stock on row 2 (qty %)', v_qty;
  END IF;

  ----------------------------------------------------------------------------
  -- 5. NULL / blank key refused before any work
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'keyless', v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: NULL key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'keyless', v_admin, E'  \t ');
    RAISE EXCEPTION 'SMOKE_FAIL: blank key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;

  ----------------------------------------------------------------------------
  -- 6. NULL, zero, NaN and infinite deltas refused, nothing moves
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 0, 'zero', v_admin, 'smoke-adj-key-zero');
    RAISE EXCEPTION 'SMOKE_FAIL: zero delta was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Adjustment quantity cannot be zero%' THEN RAISE; END IF;
  END;
  FOREACH v_bad IN ARRAY ARRAY[NULL::numeric, 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric] LOOP
    BEGIN
      PERFORM public.adjust_inventory(v_inv, v_bad, 'bad delta', v_admin, 'smoke-adj-key-bad');
      RAISE EXCEPTION 'SMOKE_FAIL: delta % was accepted', coalesce(v_bad::text, 'NULL');
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'INVALID_ADJUSTMENT_QUANTITY%' THEN RAISE; END IF;
    END;
  END LOOP;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  SELECT count(*) INTO v_count FROM public.idempotency_keys
   WHERE idempotency_key IN ('smoke-adj-key-zero', 'smoke-adj-key-bad');
  IF v_qty <> 105 OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused delta moved stock or left a receipt (qty %, receipts %)', v_qty, v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 7. Pre-migration receipt fails closed; cross-operation reuse still raises
  ----------------------------------------------------------------------------
  -- Stands for a row written BEFORE this migration, so it is planted the way
  -- such a row got there: without the cutover trigger. The re-enable is
  -- asserted so a disabled trigger cannot leak into section 9.
  ALTER TABLE public.idempotency_keys DISABLE TRIGGER refuse_unbound_adjust_inventory_receipt_20260911;
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES ('smoke-adj-key-legacy', 'adjust_inventory',
          jsonb_build_object('status', 'adjusted', 'new_quantity', 999, 'product_id', v_product),
          now() + interval '1 hour');
  ALTER TABLE public.idempotency_keys ENABLE TRIGGER refuse_unbound_adjust_inventory_receipt_20260911;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.idempotency_keys'::regclass
       AND tgname = 'refuse_unbound_adjust_inventory_receipt_20260911'
       AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cutover trigger was not re-enabled after the legacy fixture';
  END IF;
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'legacy', v_admin, 'smoke-adj-key-legacy');
    RAISE EXCEPTION 'SMOKE_FAIL: a pre-migration receipt was replayed or re-executed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES ('smoke-adj-key-xop', 'some_other_operation', '{"ok":true}'::jsonb, now() + interval '1 hour');
  BEGIN
    PERFORM public.adjust_inventory(v_inv, 1, 'xop', v_admin, 'smoke-adj-key-xop');
    RAISE EXCEPTION 'SMOKE_FAIL: a key owned by another operation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_CROSS_OP_KEY_REUSE%' THEN RAISE; END IF;
  END;
  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
  IF v_qty <> 105 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused key moved stock (qty %)', v_qty;
  END IF;

  ----------------------------------------------------------------------------
  -- 8. Business guards unchanged; refusals leave no receipt
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.adjust_inventory(v_inv, -1000, 'too much', v_admin, 'smoke-adj-key-negative');
    RAISE EXCEPTION 'SMOKE_FAIL: a negative-going adjustment was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Adjustment would result in negative inventory%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.adjust_inventory(gen_random_uuid(), 1, 'missing', v_admin, 'smoke-adj-key-missing');
    RAISE EXCEPTION 'SMOKE_FAIL: an unknown inventory row was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Inventory record not found%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.idempotency_keys
   WHERE idempotency_key IN ('smoke-adj-key-negative', 'smoke-adj-key-missing');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused adjustment left % receipt(s)', v_count;
  END IF;

  -- A legitimate negative adjustment with a blank reason still works, gets the
  -- default ledger note, and is receipted.
  v_res := public.adjust_inventory(v_inv, -10, '   ', v_admin, 'smoke-adj-key-2');
  IF (v_res ->> 'new_quantity')::numeric IS DISTINCT FROM 95 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: -10 returned % (expected new_quantity 95)', v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_transactions
   WHERE product_id = v_product AND quantity = -10
     AND notes = 'Manual adjustment of -10 units';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the -10 adjustment did not write its default ledger note (% rows)', v_count;
  END IF;
  SELECT request_actor_id INTO v_bound FROM public.idempotency_keys
   WHERE idempotency_key = 'smoke-adj-key-2' AND operation = 'adjust_inventory';
  IF v_bound IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the -10 receipt is not bound to the admin (actor=%)', v_bound;
  END IF;

  ----------------------------------------------------------------------------
  -- 9. CUTOVER: an unbound adjust_inventory receipt cannot be written
  --
  -- The old body wrote its receipt with save_idempotency(), which inserts no
  -- binding columns. A call that resolved the old function before the swap and
  -- reached its receipt write after it would do exactly this.
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.save_idempotency('smoke-adj-key-cutover', 'adjust_inventory',
      jsonb_build_object('status', 'adjusted', 'new_quantity', 1, 'product_id', v_product));
    RAISE EXCEPTION 'SMOKE_FAIL: the old receipt writer landed an UNBOUND adjust_inventory receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ADJUST_INVENTORY_UNBOUND_RECEIPT%' THEN RAISE; END IF;
  END;
  -- Half-bound is still unbound.
  BEGIN
    INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id)
    VALUES ('smoke-adj-key-cutover2', 'adjust_inventory', '{}'::jsonb, v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: a receipt with an actor but no fingerprint was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ADJUST_INVENTORY_UNBOUND_RECEIPT%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.idempotency_keys
   WHERE idempotency_key IN ('smoke-adj-key-cutover', 'smoke-adj-key-cutover2');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused cutover write left % receipt(s)', v_count;
  END IF;
  -- The trigger is scoped to adjust_inventory, not a table-wide lock.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES ('smoke-adj-key-otherop', 'some_other_operation', '{}'::jsonb, now() + interval '1 hour');
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = 'smoke-adj-key-otherop') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cutover trigger blocked an unrelated operation''s receipt';
  END IF;

  ----------------------------------------------------------------------------
  -- 10. Grants
  ----------------------------------------------------------------------------
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute adjust_inventory';
  END IF;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost EXECUTE on adjust_inventory';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_trg_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % can execute the cutover trigger function', v_role;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
