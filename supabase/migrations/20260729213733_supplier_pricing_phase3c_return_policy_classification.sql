-- Supplier Pricing Phase 3C: owner-approved return-policy classification.
--
-- Stage A shipped the columns (products.return_policy, is_full_tote_only) and
-- Stage B shipped the enforcement guard: create_return / approve_return /
-- receive_return / issue_return_credit all call assert_phase3_return_policy(),
-- which raises RETURN_POLICY_NO_RETURN for any product classified 'no_return'.
-- Every product has sat at the inert default 'unknown' since then, so the guard
-- has never fired. This migration supplies the classification data that turns
-- the shipped guard on.
--
-- Owner decisions (Mason, 2026-07-29), from a review of all 604 catalog rows:
--   * 21 products -> 'no_return'. Each states NO RETURN in its own product name
--     and carries a supplier SKU ending in NR. No inference was involved.
--   * 10 of those 21 also -> is_full_tote_only, being the ones whose name says
--     FULL TOTE.
--   * 2 products -> 'returnable' as explicit owner overrides.
--   * The remaining 581 products stay at 'unknown' and keep behaving exactly as
--     they do today. This migration does not touch them.
--   * product_family_id and packaging_variant are deliberately left untouched;
--     family grouping is parked for separate work.
--
-- Rows are addressed by primary key, not by SKU, for two reasons: one supplier
-- SKU is duplicated across two rows that receive OPPOSITE policies, and keying on id
-- keeps catalog names/SKUs out of version control per the Phase 3C containment
-- rule. All 23 ids were read back with their names/SKUs and confirmed by Mason
-- in the approving session before this file was written.
--
-- WRITE PATH. Stage A (20260723193312, trailing comment) requires Stage C SQL to
-- go through set_product_phase3_metadata() so the Product advisory lock is taken
-- before the UPDATE. That RPC cannot be called from a migration: it opens with
-- `auth.uid()` + `is_admin()` and a mandatory idempotency key, and a migration
-- has no authenticated actor. This migration therefore reproduces the RPC's
-- protocol step for step against the same helpers, in the same order:
--   lock_phase3_product_policy_products() -> read + verify expected state ->
--   assert_phase3_product_metadata_change_safe() -> authorize -> UPDATE ->
--   de-authorize.
-- The lock ordering the Stage A rule exists to protect is preserved; only the
-- actor/idempotency wrapper, which is meaningless here, is absent.
--
-- REVERT (restores today's behavior exactly; run as the migration role). It
-- repeats the SAME literal id lists as the DECLARE block below, on purpose:
-- selecting the set with `WHERE return_policy <> 'unknown'` would (a) write rows
-- it never advisory-locked, reintroducing in the escape hatch exactly the race
-- this migration takes the lock to avoid, and (b) wipe any later, unrelated
-- owner classification that this migration never made.
--   DO $revert$
--   DECLARE
--     v_all uuid[] := ARRAY[
--       '8a2eba33-7495-465d-b60a-331e27f3df14','d4301bfb-5d8a-45d0-aa79-84ef5a0d2679',
--       'e08a58ef-ba9a-4403-87fc-a143c4492b29','d3f22412-db3c-479d-8029-4d46438ca2fa',
--       'c3c0472f-8ba3-4a62-bb36-044606e5acd4','7e258d60-eac5-443f-882b-267406fb2368',
--       'a1fa7747-4a54-4c27-9a80-5f7ad8302441','533dcb50-1d27-4f5f-9120-065aec16ca51',
--       '91b68f1d-086d-42c8-b099-30dae9285bf8','d231d19a-c4ad-4d7e-ae6a-bbc8ae2aaf35',
--       'f8c8c627-b65f-498e-8842-a04eb3177c0b','e9794b17-2070-4605-b4ef-4023fa562f75',
--       '39c8c270-277e-4d97-8e63-91be02c0eca2','74898959-5ce8-4021-94be-9f43d5373d64',
--       '35f88a97-96bb-4d45-9213-4f8871260ce7','7a762878-d6c1-4170-b3a5-1f70965a9763',
--       'bad6e6f3-27ed-4769-8ee8-2dafdb9de44e','bd12e851-d51e-41a2-ba71-788c454b3f61',
--       '052d0f6e-22d4-4af3-84f4-8593934aa1ca','7a0d43a1-f3e3-43e8-96e1-792303663b47',
--       'ee736893-e4eb-48dc-923c-0f9d322a4ee4','e83effaf-90a7-4afa-a86a-e052c5a59a46',
--       '5543ce33-a32c-4f61-94c9-8a0222f0cb46'
--     ]::uuid[];
--     v_full_tote uuid[] := ARRAY[
--       'e08a58ef-ba9a-4403-87fc-a143c4492b29','d3f22412-db3c-479d-8029-4d46438ca2fa',
--       '74898959-5ce8-4021-94be-9f43d5373d64','35f88a97-96bb-4d45-9213-4f8871260ce7',
--       '7a762878-d6c1-4170-b3a5-1f70965a9763','bad6e6f3-27ed-4769-8ee8-2dafdb9de44e',
--       'bd12e851-d51e-41a2-ba71-788c454b3f61','052d0f6e-22d4-4af3-84f4-8593934aa1ca',
--       '7a0d43a1-f3e3-43e8-96e1-792303663b47','ee736893-e4eb-48dc-923c-0f9d322a4ee4'
--     ]::uuid[];
--   BEGIN
--     PERFORM set_config('lock_timeout', '10s', true);
--     PERFORM public.lock_phase3_product_policy_products(v_all);
--     PERFORM set_config('app.phase3_metadata_authorized', 'true', true);
--     UPDATE public.products SET return_policy = 'unknown', updated_at = now()
--      WHERE id = ANY (v_all) AND return_policy <> 'unknown';
--     UPDATE public.products SET is_full_tote_only = false, updated_at = now()
--      WHERE id = ANY (v_full_tote) AND is_full_tote_only;
--     PERFORM set_config('app.phase3_metadata_authorized', 'false', true);
--   END $revert$;

DO $$
DECLARE
  v_no_return uuid[] := ARRAY[
    '8a2eba33-7495-465d-b60a-331e27f3df14',
    'd4301bfb-5d8a-45d0-aa79-84ef5a0d2679',
    'e08a58ef-ba9a-4403-87fc-a143c4492b29',
    'd3f22412-db3c-479d-8029-4d46438ca2fa',
    'c3c0472f-8ba3-4a62-bb36-044606e5acd4',
    '7e258d60-eac5-443f-882b-267406fb2368',
    'a1fa7747-4a54-4c27-9a80-5f7ad8302441',
    '533dcb50-1d27-4f5f-9120-065aec16ca51',
    '91b68f1d-086d-42c8-b099-30dae9285bf8',
    'd231d19a-c4ad-4d7e-ae6a-bbc8ae2aaf35',
    'f8c8c627-b65f-498e-8842-a04eb3177c0b',
    'e9794b17-2070-4605-b4ef-4023fa562f75',
    '39c8c270-277e-4d97-8e63-91be02c0eca2',
    '74898959-5ce8-4021-94be-9f43d5373d64',
    '35f88a97-96bb-4d45-9213-4f8871260ce7',
    '7a762878-d6c1-4170-b3a5-1f70965a9763',
    'bad6e6f3-27ed-4769-8ee8-2dafdb9de44e',
    'bd12e851-d51e-41a2-ba71-788c454b3f61',
    '052d0f6e-22d4-4af3-84f4-8593934aa1ca',
    '7a0d43a1-f3e3-43e8-96e1-792303663b47',
    'ee736893-e4eb-48dc-923c-0f9d322a4ee4'
  ]::uuid[];

  -- Strict subset of v_no_return: the ones whose product name states FULL TOTE.
  v_full_tote uuid[] := ARRAY[
    'e08a58ef-ba9a-4403-87fc-a143c4492b29',
    'd3f22412-db3c-479d-8029-4d46438ca2fa',
    '74898959-5ce8-4021-94be-9f43d5373d64',
    '35f88a97-96bb-4d45-9213-4f8871260ce7',
    '7a762878-d6c1-4170-b3a5-1f70965a9763',
    'bad6e6f3-27ed-4769-8ee8-2dafdb9de44e',
    'bd12e851-d51e-41a2-ba71-788c454b3f61',
    '052d0f6e-22d4-4af3-84f4-8593934aa1ca',
    '7a0d43a1-f3e3-43e8-96e1-792303663b47',
    'ee736893-e4eb-48dc-923c-0f9d322a4ee4'
  ]::uuid[];

  -- Explicit owner overrides: returnable despite adjacent evidence (a stale
  -- "no returns" internal note; an NR SKU shared with a different, genuinely
  -- no-return row). is_full_tote_only is deliberately not touched for these.
  v_returnable uuid[] := ARRAY[
    'e83effaf-90a7-4afa-a86a-e052c5a59a46',
    '5543ce33-a32c-4f61-94c9-8a0222f0cb46'
  ]::uuid[];

  v_all      uuid[];
  v_expected integer;
  v_present  integer;
  v_bad      integer;
  v_updated  integer;
BEGIN
  -- Fail fast rather than block a live user. Everything below waits on the
  -- Product advisory lock, and a user mid-return holds it; without this the
  -- apply would hang indefinitely instead of erroring and rolling back.
  -- set_config(...,true) is the PL/pgSQL-safe spelling of SET LOCAL.
  PERFORM set_config('lock_timeout', '10s', true);

  v_all      := v_no_return || v_returnable;
  v_expected := array_length(v_no_return, 1) + array_length(v_returnable, 1);

  SELECT count(*) INTO v_present
  FROM public.products
  WHERE id = ANY (v_all);

  -- A database that has never seen this catalog (fresh local/CI) matches
  -- nothing; skip rather than fail. A PARTIAL match means the catalog drifted
  -- from the reviewed snapshot, which must stop the migration.
  IF v_present = 0 THEN
    RAISE NOTICE 'phase3c: no target products present; skipping classification.';
    RETURN;
  END IF;

  IF v_present <> v_expected THEN
    RAISE EXCEPTION
      'PHASE3C_TARGET_DRIFT: expected % classified products, found %',
      v_expected, v_present;
  END IF;

  -- Same protocol as set_product_phase3_metadata(): advisory lock in UUID order
  -- BEFORE reading or writing policy, so a concurrent create_return cannot read
  -- a stale 'unknown' and commit a return against a product being classified.
  PERFORM public.lock_phase3_product_policy_products(v_all);

  -- Optimistic-concurrency equivalent of the RPC's expected-state check. Each
  -- target must be either untouched (the 'unknown' default) or already at its
  -- intended final value, which keeps this migration re-runnable. Anything else
  -- means someone classified these rows by another path; stop rather than
  -- silently overwrite an owner decision.
  SELECT count(*) INTO v_bad
  FROM public.products p
  WHERE p.id = ANY (v_all)
    AND NOT (
      (p.id = ANY (v_no_return) AND (
        (p.return_policy = 'unknown'   AND p.is_full_tote_only = false)
        OR
        (p.return_policy = 'no_return' AND p.is_full_tote_only = (p.id = ANY (v_full_tote)))
      ))
      OR
      (p.id = ANY (v_returnable)
        AND p.return_policy IN ('unknown', 'returnable')
        AND p.is_full_tote_only = false)
    );

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'PHASE3C_UNEXPECTED_PRIOR_STATE: % target product(s) already classified differently',
      v_bad;
  END IF;

  -- Mirrors the RPC: explicit safety assert before authorizing the write. The
  -- guard trigger repeats this per row; calling it here fails fast and keeps
  -- this file readable as the same protocol.
  --
  -- Scoped to rows the UPDATEs below will actually change, not to all 23. On a
  -- re-run every target is already at its final value, so an unscoped assert
  -- would re-check rows this migration no longer touches -- and could refuse to
  -- complete because of an open return against a product being marked
  -- RETURNABLE, which is precisely the case that should never be blocked.
  PERFORM public.assert_phase3_product_metadata_change_safe(p.id)
  FROM public.products p
  WHERE (p.id = ANY (v_no_return)
         AND (p.return_policy IS DISTINCT FROM 'no_return'
              OR p.is_full_tote_only IS DISTINCT FROM (p.id = ANY (v_full_tote))))
     OR (p.id = ANY (v_returnable)
         AND p.return_policy IS DISTINCT FROM 'returnable');

  -- guard_phase3_product_metadata() requires this authorization for any write
  -- to the Phase 3 columns. Transaction-local: it does not outlive this apply.
  PERFORM set_config('app.phase3_metadata_authorized', 'true', true);

  UPDATE public.products
     SET return_policy     = 'no_return',
         is_full_tote_only = (id = ANY (v_full_tote)),
         updated_at        = now()
   WHERE id = ANY (v_no_return)
     AND (return_policy IS DISTINCT FROM 'no_return'
          OR is_full_tote_only IS DISTINCT FROM (id = ANY (v_full_tote)));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'phase3c: % product(s) set to no_return.', v_updated;

  UPDATE public.products
     SET return_policy = 'returnable',
         updated_at    = now()
   WHERE id = ANY (v_returnable)
     AND return_policy IS DISTINCT FROM 'returnable';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'phase3c: % product(s) set to returnable.', v_updated;

  -- Scope authorization to the governed UPDATEs above, exactly as the RPC does.
  -- A later Phase 3 metadata write in this transaction must not inherit it.
  PERFORM set_config('app.phase3_metadata_authorized', 'false', true);

  -- Post-conditions assert the end state, not rows changed, so they still hold
  -- on a re-run where both UPDATEs legitimately touch 0 rows. Scoped to the
  -- target set so an unrelated, legitimately-classified product elsewhere in
  -- the catalog cannot make this migration fail forever.
  IF (SELECT count(*) FROM public.products
       WHERE id = ANY (v_no_return) AND return_policy = 'no_return')
     <> array_length(v_no_return, 1) THEN
    RAISE EXCEPTION 'PHASE3C_POSTCHECK_FAILED: no_return set incomplete';
  END IF;

  IF (SELECT count(*) FROM public.products
       WHERE id = ANY (v_full_tote) AND is_full_tote_only)
     <> array_length(v_full_tote, 1) THEN
    RAISE EXCEPTION 'PHASE3C_POSTCHECK_FAILED: full-tote-only set incomplete';
  END IF;

  IF EXISTS (SELECT 1 FROM public.products
              WHERE id = ANY (v_no_return)
                AND id <> ALL (v_full_tote)
                AND is_full_tote_only) THEN
    RAISE EXCEPTION 'PHASE3C_POSTCHECK_FAILED: full-tote-only set too broad';
  END IF;

  IF (SELECT count(*) FROM public.products
       WHERE id = ANY (v_returnable) AND return_policy = 'returnable')
     <> array_length(v_returnable, 1) THEN
    RAISE EXCEPTION 'PHASE3C_POSTCHECK_FAILED: returnable set incomplete';
  END IF;

  -- Catalog-wide: nothing outside the reviewed list may end up blocking
  -- returns. Guards against a stray classification arriving alongside this one.
  IF EXISTS (SELECT 1 FROM public.products
              WHERE return_policy = 'no_return' AND id <> ALL (v_no_return)) THEN
    RAISE EXCEPTION 'PHASE3C_POSTCHECK_FAILED: unreviewed product classified no_return';
  END IF;
END
$$;
