-- ============================================================================
-- SMOKE TEST (rolled back by design): idempotency lookup operation-scoping
-- sweep (staged migration scripts/.staging-migrations/
-- idempotency_operation_scope_sweep.sql — 20 functions; representative
-- function under test: batch_post_invoices)
-- ----------------------------------------------------------------------------
-- WHAT THIS PROVES (the exact bug class, on one representative function):
--   SCENARIO A (cross-operation collision — the restore_quote_version class):
--     a row cached in idempotency_keys under a DIFFERENT operation but the
--     SAME key must NOT be returned as batch_post_invoices' own cached
--     result. Post-fix, the scoped lookup ignores the foreign-op row and the
--     call proceeds INTO the real body — proven by it hitting the body's own
--     'No invoice IDs provided' guard (empty p_invoice_ids array). On a
--     PRE-FIX database this scenario FAILS LOUDLY: the unscoped lookup
--     short-circuits on the foreign row and returns
--     {success:true, count:0, idempotent:true} with no exception.
--   SCENARIO B (own duplicate IS honored): a row cached under
--     operation = 'batch_post_invoices' with the same key MUST short-circuit:
--     the call returns the cached-hit shape (idempotent:true, count:0) and
--     never reaches the 'No invoice IDs provided' guard.
--   Both scenarios need ZERO business fixtures (no invoices/orders touched —
--   the empty array guard fires before any mutation), so the only seeded rows
--   are two [SMOKE]-keyed idempotency_keys rows, rolled back with everything
--   else by the terminal RAISE.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or Management-API database/query) as postgres/service_role,
-- AFTER the sweep migration is applied. The DO block ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — every row created here is rolled
-- back; nothing persists. ANY other terminal error text = a real failure.
--
-- Auth: batch_post_invoices derives the actor from auth.uid() and requires an
-- 'admin' profiles row. Injected via set_config('request.jwt.claims', ...,
-- is_local => true) using a REAL active admin profile id selected at runtime
-- (raises SMOKE_SETUP if none exists).
--
-- DRY-VALIDATION (the 42703 discipline) — every reference below validated
-- against the LIVE catalog 2026-06-11 (pg_proc / information_schema /
-- pg_constraint), 30 refs in this file:
--  * 4 functions: public.batch_post_invoices(p_invoice_ids uuid[],
--    p_idempotency_key text) [exactly 1 overload, SECURITY DEFINER,
--    search_path=public, pg_temp, plpgsql_check 0 errors];
--    set_config(text,text,boolean); gen_random_uuid(); auth.uid() [exercised
--    inside the function under test].
--  * 10 idempotency_keys refs: columns id, idempotency_key, operation,
--    result, created_at (DEFAULT now()), expires_at (DEFAULT now()+24h —
--    seeded rows are unexpired); constraints idempotency_keys_pkey,
--    UNIQUE idempotency_keys_idempotency_key_key (key is globally unique
--    ACROSS operations — which is why scenario A's seed must use a FRESH
--    random key, and why post-fix cross-op reuse fails loud at save time);
--    indexes idx_idempotency_keys_key, idx_idempotency_keys_expires.
--  * 4 profiles columns: id, role, is_active, created_at.
--  * 6 live-prosrc facts of batch_post_invoices the control flow relies on
--    (read verbatim from live this session): the lookup line (post-sweep:
--    `WHERE idempotency_key = p_idempotency_key AND operation =
--    'batch_post_invoices'`); cached-hit return shape keys success/count/
--    idempotent; v_actor := auth.uid(); admin role gate literal 'Admin
--    access required to batch post invoices'; empty-array guard literal
--    'No invoice IDs provided' (fires BEFORE any mutation); terminal INSERT
--    INTO idempotency_keys (idempotency_key, operation, result).
--  * 6 setup-assertion catalog refs: pg_proc.proname/prosrc/pronamespace,
--    'public'::regnamespace.
--
-- [SMOKE] FIXTURE PROTOCOL: both seeded idempotency keys are prefixed
-- '[SMOKE] idemscope-' + gen_random_uuid() (collision-proof vs real rows);
-- the foreign operation literal is '[SMOKE] smoke_other_operation' (operation
-- is unconstrained text — no CHECK constraint on idempotency_keys).
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_src text;
  v_key_xop text := '[SMOKE] idemscope-xop-' || gen_random_uuid();
  v_key_own text := '[SMOKE] idemscope-own-' || gen_random_uuid();
  v_res jsonb;
  v_xop_proven boolean := false;
BEGIN
  -- ---------------------------------------------------------------- SETUP --
  -- (1) real active admin (auth context for the SECURITY DEFINER RPC)
  SELECT id INTO v_admin
    FROM profiles
    WHERE role = 'admin' AND is_active = true
    ORDER BY created_at
    LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- (2) the sweep must actually be applied, and the body literals this smoke
  --     depends on must still exist (guards against drift making it vacuous)
  SELECT prosrc INTO v_src
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'batch_post_invoices';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: batch_post_invoices not found';
  END IF;
  IF position(' AND operation = ''batch_post_invoices''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: sweep not applied — batch_post_invoices lookup is still operation-UNSCOPED';
  END IF;
  IF position('No invoice IDs provided' IN v_src) = 0
     OR position('idempotent' IN v_src) = 0 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: batch_post_invoices body drifted — expected guard/return literals missing';
  END IF;

  -- ----------------------------------------------------- SCENARIO A: ------
  -- a key cached under a DIFFERENT operation must NOT be returned as this
  -- function's cached result.
  INSERT INTO idempotency_keys (idempotency_key, operation, result)
  VALUES (
    v_key_xop,
    '[SMOKE] smoke_other_operation',
    jsonb_build_object('smoke_sentinel', 'foreign-operation cached result — must never be honored')
  );

  BEGIN
    v_res := public.batch_post_invoices(ARRAY[]::uuid[], v_key_xop);
    -- No exception => the call short-circuited on SOME cached row. With an
    -- empty array, the only way to return without raising is the cache path:
    -- the foreign-operation row was honored. That is the bug, still live.
    RAISE EXCEPTION
      'SMOKE_FAIL: cross-operation cached row WAS honored as batch_post_invoices'' own result (lookup still unscoped) — returned %',
      v_res;
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%No invoice IDs provided%' THEN
        -- Proof: the scoped lookup ignored the foreign-op row and execution
        -- proceeded into the real body (past auth, to the array guard).
        v_xop_proven := true;
      ELSIF SQLERRM LIKE 'SMOKE_FAIL%' THEN
        RAISE;  -- re-raise the explicit failure above
      ELSE
        RAISE EXCEPTION
          'SMOKE_FAIL: scenario A unexpected error (wanted ''No invoice IDs provided''): %',
          SQLERRM;
      END IF;
  END;
  IF NOT v_xop_proven THEN
    RAISE EXCEPTION 'SMOKE_FAIL: scenario A did not complete';
  END IF;

  -- ----------------------------------------------------- SCENARIO B: ------
  -- the function's OWN duplicate (same key, operation =
  -- 'batch_post_invoices') MUST short-circuit to the cached-hit return.
  INSERT INTO idempotency_keys (idempotency_key, operation, result)
  VALUES (
    v_key_own,
    'batch_post_invoices',
    jsonb_build_object('smoke_sentinel', 'own-operation cached result')
  );

  BEGIN
    v_res := public.batch_post_invoices(ARRAY[]::uuid[], v_key_own);
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%No invoice IDs provided%' THEN
        RAISE EXCEPTION
          'SMOKE_FAIL: own-operation cached row was NOT honored — call fell through to the empty-array guard (lookup over-scoped/broken)';
      END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: scenario B unexpected error: %', SQLERRM;
  END;
  -- Live cached-hit return shape (verbatim from the body):
  --   jsonb_build_object('success', true, 'count', 0, 'idempotent', true)
  IF v_res IS NULL
     OR (v_res ->> 'idempotent') IS DISTINCT FROM 'true'
     OR (v_res ->> 'count') IS DISTINCT FROM '0'
     OR (v_res ->> 'success') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: own-duplicate call did not return the cached-hit shape — got %',
      v_res;
  END IF;

  -- --------------------------------------------------------------- DONE ---
  RAISE NOTICE 'IDEMSCOPE SMOKE: scenario A (foreign-op row ignored) PASS; scenario B (own duplicate honored) PASS';
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
