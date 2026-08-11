-- Rolled-back smoke chain: commission payout idempotency is bound to the
-- authenticated actor and the exact payout intent.
--
-- Covers create_commission_payment / post_commission_payment /
-- void_commission_payment after
-- 20260811130000_bind_commission_payout_idempotency_to_intent.sql.
--
-- Proves, for each of the three operations:
--   * the same key with an identical intent replays exactly once (no second effect);
--   * the same key with a changed selection / payment / reason / notes is rejected
--     with IDEMPOTENCY_INTENT_MISMATCH and performs nothing;
--   * another admin cannot consume the original receipt (IDEMPOTENCY_ACTOR_MISMATCH);
--   * pre-migration receipts (both binding columns NULL) fail closed;
--   * cross-operation key reuse still fails;
--   * a NULL or blank key is refused with IDEMPOTENCY_KEY_REQUIRED before the
--     wrapper delegates, so the refused call performs no work at all;
--   * the pre-existing auth / p_performed_by / admin / reason guards are unchanged.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_actor_a  uuid := '11111111-1111-1111-1111-111111111111';
  v_actor_b  uuid := '22222222-2222-2222-2222-222222222222';
  v_actor_c  uuid := '33333333-3333-3333-3333-333333333333';
  v_c1 uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_c2 uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  v_c3 uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  v_p1 uuid;
  v_p2 uuid;
  v_p3 uuid;
  v_p4 uuid;
  v_replay uuid;
  v_msg text;
  v_res jsonb;
  v_res2 jsonb;
  v_count integer;
  v_fp text;
  v_bound uuid;
BEGIN
  ----------------------------------------------------------------------------
  -- create_commission_payment
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_a)::text, true);

  v_p1 := public.create_commission_payment(
    ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
    v_actor_a, 'key-create-1'
  );
  IF v_p1 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create returned NULL payment id';
  END IF;

  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'create_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 create effect, found %', v_count;
  END IF;

  -- The receipt must now carry the actor and a fingerprint.
  SELECT request_actor_id, request_fingerprint INTO v_bound, v_fp
    FROM public.idempotency_keys WHERE idempotency_key = 'key-create-1';
  IF v_bound IS DISTINCT FROM v_actor_a OR v_fp IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create receipt was not bound (actor=%, fingerprint=%)', v_bound, v_fp;
  END IF;

  -- Identical intent replays. Selection order and duplicates must not matter.
  v_replay := public.create_commission_payment(
    ARRAY[v_c2, v_c1, v_c1], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
    v_actor_a, 'key-create-1'
  );
  IF v_replay IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay returned % instead of %', v_replay, v_p1;
  END IF;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'create_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay performed a second create (% effects)', v_count;
  END IF;

  -- Changed commission selection on the retained key.
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c3], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
      v_actor_a, 'key-create-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed commission selection was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Changed notes on the retained key.
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-09', 'second batch',
      v_actor_a, 'key-create-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed notes were accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Changed payment method on the retained key.
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'ach', 'REF-1', DATE '2026-08-09', 'first batch',
      v_actor_a, 'key-create-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed payment method was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Changed cheque/ACH reference on the retained key. This is the field an admin
  -- is most likely to correct after a timeout, so it must break the fingerprint.
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-9', DATE '2026-08-09', 'first batch',
      v_actor_a, 'key-create-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed reference was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Changed payment date on the retained key.
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-10', 'first batch',
      v_actor_a, 'key-create-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed payment date was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- NULL and empty-string metadata must fingerprint identically, so an admin who
  -- clears a field and retries is not told the intent changed.
  v_p3 := public.create_commission_payment(
    ARRAY[v_c3], 'check', NULL, DATE '2026-08-09', NULL, v_actor_a, 'key-create-null'
  );
  v_replay := public.create_commission_payment(
    ARRAY[v_c3], 'check', '', DATE '2026-08-09', '   ', v_actor_a, 'key-create-null'
  );
  IF v_replay IS DISTINCT FROM v_p3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: empty-string metadata did not replay the NULL-metadata receipt';
  END IF;

  -- Blank-key parity with check_idempotency: a whitespace-only key is a caller
  -- bug and must keep raising IDEMPOTENCY_KEY_REQUIRED, not be treated as absent.
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1], 'check', 'REF-1', DATE '2026-08-09', NULL, v_actor_a, '   '
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a whitespace-only idempotency key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;

  -- Whitespace-only differences are not a change of intent.
  v_replay := public.create_commission_payment(
    ARRAY[v_c1, v_c2], 'check', '  REF-1 ', DATE '2026-08-09', ' first batch  ',
    v_actor_a, 'key-create-1'
  );
  IF v_replay IS DISTINCT FROM v_p1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: whitespace variant did not replay';
  END IF;

  -- A different admin cannot consume the receipt.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_b)::text, true);
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
      v_actor_b, 'key-create-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a second actor consumed the receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_a)::text, true);

  -- Pre-migration receipt: neither binding column set. Must fail closed.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES ('key-legacy', 'create_commission_payment', to_jsonb(gen_random_uuid()::text));
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
      v_actor_a, 'key-legacy'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: legacy unbound receipt was replayed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Cross-operation reuse of a create key still fails, AND still produces the
  -- original formatted message. A caller or test keying on that text must not
  -- start seeing a bare code just because the wrapper now checks first.
  BEGIN
    PERFORM public.post_commission_payment(v_p1, v_actor_a, 'key-create-1');
    RAISE EXCEPTION 'SMOKE_FAIL: cross-operation key reuse was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg NOT LIKE '%IDEMPOTENCY_CROSS_OP_KEY_REUSE%' THEN RAISE; END IF;
    IF v_msg NOT LIKE
       '%idempotency_key key-create-1 is already in use for operation create_commission_payment; cannot reuse it for operation post_commission_payment%'
    THEN
      RAISE EXCEPTION 'SMOKE_FAIL: cross-op message lost its detail: %', v_msg;
    END IF;
  END;

  -- A receipt whose stored result is SQL NULL must never be read as "not yet
  -- performed" — that is the exact shape that would re-run a committed payout.
  INSERT INTO public.idempotency_keys
    (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  SELECT 'key-null-result', 'create_commission_payment', NULL, request_actor_id, request_fingerprint
    FROM public.idempotency_keys WHERE idempotency_key = 'key-create-1';
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
      v_actor_a, 'key-null-result'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL stored result was replayed as success';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_RESULT_INVALID%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'create_commission_payment';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: NULL-result receipt re-ran the payout (% effects)', v_count;
  END IF;

  -- Same for a receipt holding JSON null rather than SQL NULL.
  INSERT INTO public.idempotency_keys
    (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  SELECT 'key-json-null', 'create_commission_payment', 'null'::jsonb, request_actor_id, request_fingerprint
    FROM public.idempotency_keys WHERE idempotency_key = 'key-create-1';
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', 'REF-1', DATE '2026-08-09', 'first batch',
      v_actor_a, 'key-json-null'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a JSON null stored result was replayed as success';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_RESULT_INVALID%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'create_commission_payment';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: JSON-null receipt re-ran the payout (% effects)', v_count;
  END IF;

  -- A NULL key is REFUSED, and the refused call pays out nothing. Omitting the
  -- key used to run the payout with no receipt and therefore no intent binding
  -- at all; that unbound door is closed.
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'create_commission_payment';
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c3], 'check', 'REF-2', DATE '2026-08-09', 'no key', v_actor_a, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL idempotency key was accepted by create';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.proof_effects
       WHERE operation = 'create_commission_payment') <> v_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused NULL-key create still paid out';
  END IF;

  -- A key made only of non-ASCII whitespace is refused too. The house predicate
  -- (!~ '[^[:space:]]') is collation-dependent, so on some clusters a key of one
  -- non-breaking space reads as non-blank and would be ACCEPTED as a real key —
  -- an unbindable key that every subsequent retry would collide on. The second,
  -- locale-independent predicate (!~ '[!-~]') is what makes this deterministic.
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'create_commission_payment';
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c3], 'check', 'REF-2', DATE '2026-08-09', 'nbsp key', v_actor_a,
      U&'\00A0\2003\3000'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a key with no printable ASCII was accepted by create';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.proof_effects
       WHERE operation = 'create_commission_payment') <> v_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused non-ASCII-blank create still paid out';
  END IF;

  v_p2 := public.create_commission_payment(
    ARRAY[v_c3], 'check', 'REF-2', DATE '2026-08-09', 'keyed', v_actor_a, 'key-create-2'
  );
  IF v_p2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: keyed create did not perform the work';
  END IF;

  ----------------------------------------------------------------------------
  -- post_commission_payment
  ----------------------------------------------------------------------------
  v_res := public.post_commission_payment(v_p1, v_actor_a, 'key-post-1');
  IF v_res->>'payment_id' IS DISTINCT FROM v_p1::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post returned %', v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'post_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 post effect, found %', v_count;
  END IF;

  v_res2 := public.post_commission_payment(v_p1, v_actor_a, 'key-post-1');
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post replay returned % instead of %', v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'post_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post replay performed a second post (% effects)', v_count;
  END IF;

  -- The audit's exact scenario: same retained key, a DIFFERENT payment.
  BEGIN
    PERFORM public.post_commission_payment(v_p2, v_actor_a, 'key-post-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a different payment was posted under the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'post_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected post still performed work (% effects)', v_count;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_b)::text, true);
  BEGIN
    PERFORM public.post_commission_payment(v_p1, v_actor_b, 'key-post-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a second actor consumed the post receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_a)::text, true);

  -- Pre-migration post receipt: neither binding column set. Must fail closed
  -- rather than replay, exactly as for create.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES ('key-legacy-post', 'post_commission_payment', jsonb_build_object('success', true));
  BEGIN
    PERFORM public.post_commission_payment(v_p1, v_actor_a, 'key-legacy-post');
    RAISE EXCEPTION 'SMOKE_FAIL: legacy unbound post receipt was replayed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- A post receipt whose stored result is SQL NULL must fail closed.
  INSERT INTO public.idempotency_keys
    (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  SELECT 'key-post-null', 'post_commission_payment', NULL, request_actor_id, request_fingerprint
    FROM public.idempotency_keys WHERE idempotency_key = 'key-post-1';
  BEGIN
    PERFORM public.post_commission_payment(v_p1, v_actor_a, 'key-post-null');
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL stored post result was replayed as success';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_RESULT_INVALID%' THEN RAISE; END IF;
  END;

  -- The p_performed_by guard runs BEFORE the receipt lookup, so a forged actor
  -- is refused even when a valid receipt for that key exists — the receipt can
  -- never be used to smuggle a different performer into the audit trail.
  BEGIN
    PERFORM public.post_commission_payment(v_p1, v_actor_b, 'key-post-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a forged p_performed_by was accepted on the post replay path';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%p_performed_by does not match authenticated user%' THEN RAISE; END IF;
  END;

  -- Post refuses a NULL key too, and the refused call posts nothing.
  v_p4 := public.create_commission_payment(
    ARRAY[v_c2], 'check', 'REF-4', DATE '2026-08-09', 'keyed post', v_actor_a, 'key-create-4'
  );
  BEGIN
    PERFORM public.post_commission_payment(v_p4, v_actor_a, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL idempotency key was accepted by post';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.proof_effects
       WHERE operation = 'post_commission_payment' AND entity_id = v_p4) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused NULL-key post still posted';
  END IF;
  PERFORM public.post_commission_payment(v_p4, v_actor_a, 'key-post-4');
  IF (SELECT count(*) FROM public.proof_effects
       WHERE operation = 'post_commission_payment' AND entity_id = v_p4) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: keyed post did not perform the work';
  END IF;

  ----------------------------------------------------------------------------
  -- void_commission_payment
  ----------------------------------------------------------------------------
  v_res := public.void_commission_payment(v_p1, 'duplicate batch', v_actor_a, 'key-void-1');
  IF v_res->>'payment_id' IS DISTINCT FROM v_p1::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void returned %', v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'void_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 void effect, found %', v_count;
  END IF;

  -- Identical reason, surrounding whitespace only: still the same intent.
  v_res2 := public.void_commission_payment(v_p1, '  duplicate batch ', v_actor_a, 'key-void-1');
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void replay returned % instead of %', v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.proof_effects
   WHERE operation = 'void_commission_payment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void replay performed a second void (% effects)', v_count;
  END IF;

  -- Changed reason on the retained key.
  BEGIN
    PERFORM public.void_commission_payment(v_p1, 'wrong recipient', v_actor_a, 'key-void-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a changed void reason was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Changed payment on the retained key.
  BEGIN
    PERFORM public.void_commission_payment(v_p2, 'duplicate batch', v_actor_a, 'key-void-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a different payment was voided under the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_b)::text, true);
  BEGIN
    PERFORM public.void_commission_payment(v_p1, 'duplicate batch', v_actor_b, 'key-void-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a second actor consumed the void receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_a)::text, true);

  -- Pre-migration void receipt: neither binding column set. Must fail closed.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES ('key-legacy-void', 'void_commission_payment', jsonb_build_object('success', true));
  BEGIN
    PERFORM public.void_commission_payment(v_p1, 'duplicate batch', v_actor_a, 'key-legacy-void');
    RAISE EXCEPTION 'SMOKE_FAIL: legacy unbound void receipt was replayed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- A void receipt whose stored result is SQL NULL must fail closed.
  INSERT INTO public.idempotency_keys
    (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  SELECT 'key-void-null', 'void_commission_payment', NULL, request_actor_id, request_fingerprint
    FROM public.idempotency_keys WHERE idempotency_key = 'key-void-1';
  BEGIN
    PERFORM public.void_commission_payment(v_p1, 'duplicate batch', v_actor_a, 'key-void-null');
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL stored void result was replayed as success';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_RESULT_INVALID%' THEN RAISE; END IF;
  END;

  -- See post: the actor guard precedes the receipt lookup on the void path too.
  BEGIN
    PERFORM public.void_commission_payment(v_p1, 'duplicate batch', v_actor_b, 'key-void-1');
    RAISE EXCEPTION 'SMOKE_FAIL: a forged p_performed_by was accepted on the void replay path';
  EXCEPTION WHEN OTHERS THEN
    -- Exact match, not LIKE: IDEMPOTENCY_ACTOR_MISMATCH also contains
    -- "ACTOR_MISMATCH", and only the guard firing first proves the point.
    IF SQLERRM <> 'ACTOR_MISMATCH' THEN RAISE; END IF;
  END;

  -- Void refuses a NULL key too, and the refused call voids nothing.
  BEGIN
    PERFORM public.void_commission_payment(v_p4, 'no key void', v_actor_a, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL idempotency key was accepted by void';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.proof_effects
       WHERE operation = 'void_commission_payment' AND entity_id = v_p4) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the refused NULL-key void still voided';
  END IF;
  PERFORM public.void_commission_payment(v_p4, 'keyed void', v_actor_a, 'key-void-4');
  IF (SELECT count(*) FROM public.proof_effects
       WHERE operation = 'void_commission_payment' AND entity_id = v_p4) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: keyed void did not perform the work';
  END IF;

  ----------------------------------------------------------------------------
  -- Pre-existing guards are unchanged
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.void_commission_payment(v_p2, '   ', v_actor_a, 'key-void-blank');
    RAISE EXCEPTION 'SMOKE_FAIL: blank void reason was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%REASON_REQUIRED%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1], 'check', 'REF-9', DATE '2026-08-09', NULL, v_actor_b, 'key-forge'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a forged p_performed_by was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%p_performed_by does not match authenticated user%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor_c)::text, true);
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1], 'check', 'REF-9', DATE '2026-08-09', NULL, v_actor_c, 'key-nonadmin'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a non-admin created a commission payment';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Admin access required to create a commission payment%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.post_commission_payment(v_p2, v_actor_c, 'key-nonadmin-post');
    RAISE EXCEPTION 'SMOKE_FAIL: a non-admin posted a commission payment';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Admin access required to post a commission payment%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.void_commission_payment(v_p2, 'nope', v_actor_c, 'key-nonadmin-void');
    RAISE EXCEPTION 'SMOKE_FAIL: a non-admin voided a commission payment';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INSUFFICIENT_ROLE%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.create_commission_payment(
      ARRAY[v_c1], 'check', 'REF-9', DATE '2026-08-09', NULL, NULL, 'key-anon'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: an unauthenticated caller created a commission payment';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Not authenticated%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.void_commission_payment(v_p2, 'nope', NULL, 'key-anon-void');
    RAISE EXCEPTION 'SMOKE_FAIL: an unauthenticated caller voided a commission payment';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%AUTH_REQUIRED%' THEN RAISE; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
