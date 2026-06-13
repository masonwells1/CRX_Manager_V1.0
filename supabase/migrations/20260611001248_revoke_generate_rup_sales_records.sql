-- ============================================================================
-- generate_rup_sales_records(uuid, text): grants-only hardening — REVOKE
-- EXECUTE from authenticated/anon/PUBLIC, keep service_role + owner (W1 class)
-- ----------------------------------------------------------------------------
-- TASK: CHIP task_7819c8d0 (db-invariant sweep predicate d, first full run
--       2026-06-10 — docs/audits/2026-06-10-error-prevention-execution-log.md
--       §3 C1 + §4 follow-up item 5).
--
-- BUG (W1 class — authenticated SECDEF mutator that binds auth.uid() but
-- never checks role):
--   public.generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key
--   text DEFAULT NULL) is SECURITY DEFINER, owner postgres, and is
--   EXECUTE-granted to `authenticated` on live. Its body INSERTs regulatory
--   compliance rows into rup_sales_records (binding auth.uid() as created_by)
--   with NO role gate and NO invoice-status gate — any logged-in user
--   (driver/applicator) can call it directly via PostgREST and fabricate RUP
--   sales/compliance records for any invoice id. (Note: p_idempotency_key is
--   declared but unused in the live body — pre-existing, NOT changed here;
--   the per-(invoice_id, product_id) NOT EXISTS dedup is the effective guard.)
--
-- CALLER EVIDENCE (B10 rule — per-function disposition marker below):
--   * .claude/caller-graph.json (generated_at 2026-06-10T19:00:03Z,
--     live_queried_at 2026-06-10T18:57:18Z): generate_rup_sales_records has
--     NO entry in rpc_callers, edge_callers (incl. ?action= branches), or
--     cron_callers — zero UI / Edge / cron callsites.
--   * The ONLY legitimate caller is in-DB: public.post_invoice(uuid, text)
--     does `PERFORM generate_rup_sales_records(p_invoice_id);`. post_invoice
--     is itself SECURITY DEFINER owned by postgres, so that internal call
--     executes with the OWNER's privileges — owner EXECUTE is implicit and
--     unaffected by any REVOKE here. Same pattern already proven live by
--     20260526201319 (check_idempotency) and 20260609203541 (save_idempotency):
--     SECDEF-internal calls keep working after the authenticated REVOKE.
--
-- FIX (grants-only — ZERO body changes; EXHAUSTIVE delta list):
--   D1  REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated.
--       Live pre-state (read 2026-06-10): authenticated = TRUE (the bug),
--       anon = FALSE, PUBLIC = none (proacl non-NULL, no empty-grantee
--       entry) — the anon/PUBLIC legs are belt-and-braces no-ops.
--   D2  GRANT EXECUTE ... TO service_role (restate; already held live —
--       keeps backend/service callers working).
--   There is NO CREATE OR REPLACE in this migration.
--
-- BASELINE (verbatim-from-live, read 2026-06-10 AFTER the other session's
-- live-applied 20260610185741_fix_generate_rup_sales_records_phantom_column):
--   md5(prosrc) generate_rup_sales_records = 0eda980c393a5c078e97af13d1b30161
--   context only, NOT touched by this migration:
--   md5(prosrc) post_invoice               = 1f987dfe0ec99cad0499f4813d269ffb
--
-- SENTINELS: because this migration is grants-only there are no in-body
-- delta sentinels (no body is shipped); each grant delta is bracketed by
-- BEGIN/END DELTA markers below, and the self-verification block asserts the
-- body is STILL byte-identical to the recorded baseline md5 (the grants-only
-- analog of "delta markers present"), SECDEF + pinned search_path survive,
-- exactly one overload exists, and the final grant matrix is exactly:
-- owner(postgres) + service_role IN; authenticated / anon / PUBLIC OUT.
--
-- ROLLBACK: re-grant in a follow-up migration if ever needed:
--   GRANT EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) TO authenticated;
--
-- caller-analysis: generate_rup_sales_records :: zero UI/Edge/cron callers (caller-graph.json 2026-06-10); in-DB caller post_invoice executes as owner, unaffected by EXECUTE grants
-- ============================================================================

-- >>> BEGIN DELTA D1: close the direct-call surface (authenticated/anon/PUBLIC)
REVOKE EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) FROM PUBLIC, anon, authenticated;
-- <<< END DELTA D1

-- >>> BEGIN DELTA D2: service_role retained explicitly
GRANT EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) TO service_role;
-- <<< END DELTA D2

-- ---------------------------------------------------------------------------
-- Self-verification (any failed expectation aborts the whole migration txn)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count       int;
  v_md5         text;
  v_secdef      boolean;
  v_config      text[];
  v_acl         aclitem[];
  v_public_exec int;
  v_post_src    text;
BEGIN
  -- 1. Exactly one overload of the target function
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'generate_rup_sales_records'
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: generate_rup_sales_records overload count = %, expected 1', v_count;
  END IF;

  -- 2. Grants-only fidelity: body byte-identical to the recorded live baseline
  SELECT md5(prosrc), prosecdef, proconfig, proacl
  INTO v_md5, v_secdef, v_config, v_acl
  FROM pg_proc
  WHERE proname = 'generate_rup_sales_records'
    AND pronamespace = 'public'::regnamespace;
  IF v_md5 <> '0eda980c393a5c078e97af13d1b30161' THEN
    RAISE EXCEPTION 'VERIFY FAIL: generate_rup_sales_records prosrc md5 = % — expected baseline 0eda980c393a5c078e97af13d1b30161. This migration is grants-only; the live body drifted since the baseline read (2026-06-10, post-20260610185741). Re-read live and re-baseline before applying.', v_md5;
  END IF;

  -- 3. SECDEF + pinned search_path survive (grants cannot change these; assert anyway)
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VERIFY FAIL: generate_rup_sales_records is no longer SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) AS c WHERE c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAIL: generate_rup_sales_records lost its SET search_path';
  END IF;

  -- 4. Final grant matrix
  IF has_function_privilege('authenticated', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: authenticated still has EXECUTE on generate_rup_sales_records';
  END IF;
  IF has_function_privilege('anon', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: anon still has EXECUTE on generate_rup_sales_records';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role lost EXECUTE on generate_rup_sales_records';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.generate_rup_sales_records(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: owner postgres lost EXECUTE on generate_rup_sales_records';
  END IF;
  -- PUBLIC: a NULL proacl means default grants (PUBLIC could execute) —
  -- assert non-NULL and no empty-grantee (grantee oid 0 = PUBLIC) EXECUTE entry.
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAIL: proacl is NULL (default grants — PUBLIC would have EXECUTE)';
  END IF;
  SELECT count(*) INTO v_public_exec
  FROM aclexplode(v_acl) AS a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_public_exec <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: PUBLIC still has EXECUTE on generate_rup_sales_records';
  END IF;

  -- 5. The legit in-DB caller relationship still holds, and the UI posting
  --    path (post_invoice) keeps its authenticated grant.
  SELECT prosrc INTO v_post_src
  FROM pg_proc
  WHERE proname = 'post_invoice'
    AND pronamespace = 'public'::regnamespace;
  IF v_post_src IS NULL OR v_post_src NOT LIKE '%generate_rup_sales_records%' THEN
    RAISE EXCEPTION 'VERIFY FAIL: post_invoice no longer calls generate_rup_sales_records — caller analysis is stale; re-verify before applying this REVOKE';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.post_invoice(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: post_invoice lost its authenticated EXECUTE (UI invoice-posting path would break)';
  END IF;

  RAISE NOTICE 'VERIFY OK: generate_rup_sales_records — 1 overload, baseline md5 intact, SECDEF + search_path intact, grants = owner + service_role only';
END $$;
