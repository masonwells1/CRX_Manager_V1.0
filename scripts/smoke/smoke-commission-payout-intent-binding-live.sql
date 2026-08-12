-- ============================================================================
-- SMOKE TEST (rolled back by design): commission-payout idempotency receipts
-- are bound to the acting user AND the request intent
-- (migration 20260811130000_bind_commission_payout_idempotency_to_intent.sql,
-- applied live 2026-08-11; ledger version 20260811183437 carries that name)
-- ----------------------------------------------------------------------------
-- WHY A SECOND CHAIN. smoke-commission-payout-intent-binding.sql is the
-- exhaustive chain for this fix, but it is CONTAINER ONLY: it reads the
-- disposable public.proof_effects table and the synthetic ids that only
-- scripts/smoke/prove-commission-payout-intent-binding.mjs plants, so against
-- live it dies on a missing relation instead of SMOKE_PASS_ROLLBACK. THIS file
-- is the live-runnable counterpart: it seeds its own [SMOKE] fixtures, needs no
-- prover, and is the chain that actually certified the binding against
-- production on 2026-08-11. Keep both — the container chain covers more cases
-- (void, blank keys, cross-operation reuse, the unchanged guard surface); this
-- one is the part that can be re-run against the live database on demand.
--
-- THE BUG IT PINS: the three commission payout RPCs keyed their idempotency
-- receipts on (idempotency_key, operation) only. The browser-generated key text
-- embedded a user id, but the server never read, stored or validated it — so a
-- retained browser key could replay a DIFFERENT payout's cached success. The
-- fix stores request_actor_id + a SHA-256 request_fingerprint on every receipt
-- and fails closed on any mismatch.
--
-- WHAT THIS PROVES (9 assertions; the 9th needs a second active admin):
--   1. the receipt written by a real payout carries request_actor_id = the
--      acting admin and a 64-character request_fingerprint;
--   2. an identical intent replays to the SAME payment id, and the fingerprint
--      is insensitive to surrounding whitespace in the text arguments;
--   3. a CHANGED COMMISSION SELECTION on the retained key raises
--      IDEMPOTENCY_INTENT_MISMATCH (this is the original bug);
--   4. a CHANGED REFERENCE on the retained key raises the same;
--   5. a NULL key raises IDEMPOTENCY_KEY_REQUIRED and pays nothing — the
--      reverse of the pre-migration behaviour, where an omitted key did the
--      work unreceipted;
--   6. a legacy receipt with both binding columns NULL fails CLOSED rather
--      than replaying;
--   7. post_commission_payment replays correctly, and the same key aimed at a
--      DIFFERENT payment raises IDEMPOTENCY_INTENT_MISMATCH with that other
--      payment left 'unposted';
--   8. (7b/8b) neither refused call performed any work;
--   9. a second active admin cannot consume the first admin's receipt —
--      IDEMPOTENCY_ACTOR_MISMATCH.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or Management-API database/query) as postgres/service_role,
-- AFTER migration 20260811130000 is applied. The DO block ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — every [SMOKE] row created here is
-- rolled back; nothing persists. ANY other terminal error text = a real
-- failure. If the database has only one active admin the chain ends at 8/8 and
-- says so; that is still a PASS, but the cross-actor case went unproven.
--
-- LAST RUN GREEN: 2026-08-11 against production (rhyzpcqhnizqbxphqdkr),
-- terminal error text: SMOKE_PASS_ROLLBACK (9/9 incl. cross-actor).
-- ============================================================================
DO $bind$
DECLARE
  v_admin uuid; v_admin2 uuid;
  v_sfx text := substr(md5(random()::text), 1, 8);
  v_cust uuid; v_ord uuid; v_c1 uuid; v_c2 uuid; v_c3 uuid;
  v_p1 uuid; v_p2 uuid; v_replay uuid;
  v_bound uuid; v_fp text; v_err text; v_res jsonb;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_admin2 FROM profiles WHERE role='admin' AND is_active=true AND id <> v_admin ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SETUP: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] BIND Farm '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO orders (order_number, customer_id) VALUES ('[SMOKE]-BIND-'||v_sfx, v_cust) RETURNING id INTO v_ord;
  INSERT INTO commissions (order_id,customer_id,recipient,split_percentage,commission_amount,order_profit,status,recipient_user_id)
    VALUES (v_ord,v_cust,'[SMOKE] BIND',50,10.00,20.00,'pending',v_admin) RETURNING id INTO v_c1;
  INSERT INTO commissions (order_id,customer_id,recipient,split_percentage,commission_amount,order_profit,status,recipient_user_id)
    VALUES (v_ord,v_cust,'[SMOKE] BIND',50,20.00,40.00,'pending',v_admin) RETURNING id INTO v_c2;
  INSERT INTO commissions (order_id,customer_id,recipient,split_percentage,commission_amount,order_profit,status,recipient_user_id)
    VALUES (v_ord,v_cust,'[SMOKE] BIND',50,30.00,60.00,'pending',v_admin) RETURNING id INTO v_c3;

  -- 1. real payout through the wrapper
  v_p1 := create_commission_payment(ARRAY[v_c1], 'check', 'REF-A', CURRENT_DATE, 'note A', v_admin, '[SMOKE]-bind-'||v_sfx);

  -- 2. receipt is now bound to actor + fingerprint
  SELECT request_actor_id, request_fingerprint INTO v_bound, v_fp
    FROM idempotency_keys WHERE idempotency_key = '[SMOKE]-bind-'||v_sfx;
  IF v_bound IS DISTINCT FROM v_admin OR v_fp IS NULL OR length(v_fp) <> 64 THEN
    RAISE EXCEPTION 'FAIL(1): receipt not bound (actor=%, fp=%)', v_bound, v_fp;
  END IF;

  -- 3. identical intent replays: same id, whitespace-insensitive
  v_replay := create_commission_payment(ARRAY[v_c1], 'check', '  REF-A ', CURRENT_DATE, ' note A  ', v_admin, '[SMOKE]-bind-'||v_sfx);
  IF v_replay IS DISTINCT FROM v_p1 THEN RAISE EXCEPTION 'FAIL(2): replay returned % not %', v_replay, v_p1; END IF;

  -- 4. THE BUG: changed selection on the retained key must be refused
  v_err := NULL;
  BEGIN
    PERFORM create_commission_payment(ARRAY[v_c2], 'check', 'REF-A', CURRENT_DATE, 'note A', v_admin, '[SMOKE]-bind-'||v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE EXCEPTION 'FAIL(3): changed selection got: %', COALESCE(v_err,'ACCEPTED');
  END IF;

  -- 5. changed reference on the retained key must be refused
  v_err := NULL;
  BEGIN
    PERFORM create_commission_payment(ARRAY[v_c1], 'check', 'REF-Z', CURRENT_DATE, 'note A', v_admin, '[SMOKE]-bind-'||v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE EXCEPTION 'FAIL(4): changed reference got: %', COALESCE(v_err,'ACCEPTED');
  END IF;

  -- 6. NULL key is now refused outright, and pays nothing
  v_err := NULL;
  BEGIN
    PERFORM create_commission_payment(ARRAY[v_c3], 'check', 'REF-N', CURRENT_DATE, NULL, v_admin, NULL);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN
    RAISE EXCEPTION 'FAIL(5): NULL key got: %', COALESCE(v_err,'ACCEPTED');
  END IF;
  IF EXISTS (SELECT 1 FROM commission_payment_items WHERE commission_id = v_c3) THEN
    RAISE EXCEPTION 'FAIL(5b): refused NULL-key call still paid out';
  END IF;

  -- 7. legacy unbound receipt fails closed
  INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES ('[SMOKE]-legacy-'||v_sfx, 'create_commission_payment', to_jsonb(gen_random_uuid()::text));
  v_err := NULL;
  BEGIN
    PERFORM create_commission_payment(ARRAY[v_c3], 'check', 'REF-L', CURRENT_DATE, NULL, v_admin, '[SMOKE]-legacy-'||v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE EXCEPTION 'FAIL(6): legacy receipt got: %', COALESCE(v_err,'ACCEPTED');
  END IF;

  -- 8. post: retained key aimed at a DIFFERENT payment must be refused
  v_p2 := create_commission_payment(ARRAY[v_c3], 'check', 'REF-B', CURRENT_DATE, 'note B', v_admin, '[SMOKE]-bind2-'||v_sfx);
  v_res := post_commission_payment(v_p1, v_admin, '[SMOKE]-post-'||v_sfx);
  IF v_res->>'payment_id' IS DISTINCT FROM v_p1::text THEN RAISE EXCEPTION 'FAIL(7): post returned %', v_res; END IF;
  v_err := NULL;
  BEGIN
    PERFORM post_commission_payment(v_p2, v_admin, '[SMOKE]-post-'||v_sfx);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err IS NULL OR v_err NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE EXCEPTION 'FAIL(8): different payment under retained post key got: %', COALESCE(v_err,'ACCEPTED');
  END IF;
  IF (SELECT status FROM commission_payments WHERE id = v_p2) <> 'unposted' THEN
    RAISE EXCEPTION 'FAIL(8b): the refused post still posted the other payment';
  END IF;

  -- 9. a different admin cannot consume the receipt
  IF v_admin2 IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin2, 'role','authenticated')::text, true);
    v_err := NULL;
    BEGIN
      PERFORM create_commission_payment(ARRAY[v_c1], 'check', 'REF-A', CURRENT_DATE, 'note A', v_admin2, '[SMOKE]-bind-'||v_sfx);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    IF v_err IS NULL OR v_err NOT LIKE '%IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'FAIL(9): second actor got: %', COALESCE(v_err,'ACCEPTED');
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
    RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK (9/9 incl. cross-actor)';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK (8/8; only one active admin, cross-actor skipped)';
END $bind$;
