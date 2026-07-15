-- Rolled-back auth/idempotency guard for the batch prepayment entrypoint.
DO $smoke$
DECLARE
  v_admin uuid;
  v_nonadmin uuid;
  v_result jsonb;
  v_err text;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_nonadmin FROM profiles
  WHERE role <> 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_nonadmin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin and non-admin required';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_nonadmin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM batch_apply_prepayments('[]'::jsonb, v_nonadmin, 'smk-bp-deny-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: non-admin batch prepay was allowed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ADMIN_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected ADMIN_REQUIRED, got %', v_err;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  BEGIN
    PERFORM check_idempotency('   ', 'smoke_blank_key');
    RAISE EXCEPTION 'SMOKE_FAIL: blank idempotency key was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected IDEMPOTENCY_KEY_REQUIRED, got %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM save_idempotency('   ', 'smoke_blank_key', '{"ok":true}'::jsonb);
    RAISE EXCEPTION 'SMOKE_FAIL: save accepted a blank idempotency key';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected IDEMPOTENCY_KEY_REQUIRED on save, got %', v_err;
    END IF;
  END;

  PERFORM save_idempotency(
    'smk-cross-op-' || v_suffix, 'smoke_operation_a', '{"ok":true}'::jsonb
  );
  BEGIN
    PERFORM check_idempotency('smk-cross-op-' || v_suffix, 'smoke_operation_b');
    RAISE EXCEPTION 'SMOKE_FAIL: cross-operation key reuse was allowed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_CROSS_OP_KEY_REUSE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected IDEMPOTENCY_CROSS_OP_KEY_REUSE, got %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM batch_apply_prepayments('[]'::jsonb, v_nonadmin, 'smk-bp-forge-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: forged batch-prepay actor was allowed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH, got %', v_err;
    END IF;
  END;

  v_result := batch_apply_prepayments('[]'::jsonb, v_admin, 'smk-bp-ok-' || v_suffix);
  IF (v_result->>'success')::boolean IS DISTINCT FROM true
     OR (v_result->>'applied_count')::int <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: admin empty batch returned %', v_result;
  END IF;
  IF batch_apply_prepayments('[]'::jsonb, v_admin, 'smk-bp-ok-' || v_suffix)
       IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch replay changed result';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.check_idempotency(text,text)'::regprocedure
      AND prosrc LIKE '%pg_advisory_xact_lock%'
  ) THEN RAISE EXCEPTION 'SMOKE_FAIL: shared idempotency lock missing'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
