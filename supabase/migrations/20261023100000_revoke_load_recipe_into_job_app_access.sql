-- Written 2026-10-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 982). Stamp and row assigned by the CRX Coordinator
-- session 2026-10-23: lands after #1057 (20261022090000), cost lock B (20261022091000), #1058
-- (20261022100000) and #1065 (20261023090000). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- this file changes no function body; it only revokes EXECUTE.
--
-- WHAT: PR #1060 follow-up (Mason: "Yes, remove access", 2026-10-23). The app no longer calls
--   load_recipe_into_job: Job Detail loads a recipe client-side (src/lib/recipeHelpers.ts,
--   src/lib/cropProgramHelpers.ts) because this RPC DELETEs every job_chemicals row of the job
--   before inserting the recipe. A signed-in user could still call it directly and wipe a job's
--   chemical lines. This removes EXECUTE from PUBLIC, anon and authenticated. The function itself
--   is kept (not dropped), so the owner (postgres) and service_role can still run it.
--
-- NOT CHANGED: the function body, owner, SECURITY DEFINER, search_path; every other function,
--   policy, grant and row.
--
-- CALLERS (checked 2026-10-23):
-- caller-analysis: load_recipe_into_job :: no caller -- src/ and supabase/functions/ only mention it in comments, generated types and a Sentry context label; live: no other function, view, policy or cron job references it; scripts/smoke chains call it as postgres, which keeps EXECUTE
--
-- LIVE EVIDENCE (read-only, 2026-10-23): one overload load_recipe_into_job(uuid,uuid,text), owner
--   postgres, SECURITY DEFINER, search_path=public, pg_temp, ACL
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} (anon and PUBLIC hold
--   no EXECUTE already), body md5 (CR stripped) b661ec8eaf7ec2f8fdd9c40033456521.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) TO authenticated;
--   (Mason only; re-opens the direct call.) No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE revoke_load_recipe_into_job_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a runner that stops on the first error, as the apply script and psql -1 do).
  IF to_regclass('pg_temp.revoke_load_recipe_into_job_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.revoke_load_recipe_into_job_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'load_recipe_into_job') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly one public.load_recipe_into_job overload';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.load_recipe_into_job(uuid,uuid,text)');
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.body_md5 IS DISTINCT FROM 'b661ec8eaf7ec2f8fdd9c40033456521' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.load_recipe_into_job is not as read 2026-10-23 (md5 %)', v_fn.body_md5;
  END IF;
  IF v_fn.acl = '{postgres=X/postgres,service_role=X/postgres}' THEN
    -- Already applied.
    RAISE EXCEPTION 'LOAD_RECIPE_INTO_JOB_ALREADY_REVOKED: this migration has already run';
  END IF;
  IF v_fn.acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.load_recipe_into_job ACL is not as read 2026-10-23 (%)', v_fn.acl;
  END IF;
END;
$preflight$;

REVOKE EXECUTE ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.revoke_load_recipe_into_job_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.revoke_load_recipe_into_job_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.load_recipe_into_job(uuid,uuid,text)');
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM 'b661ec8eaf7ec2f8fdd9c40033456521' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public.load_recipe_into_job is not the expected body/attributes (md5 %, acl %)', v_fn.body_md5, v_fn.acl;
  END IF;
  IF has_function_privilege('anon', 'public.load_recipe_into_job(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.load_recipe_into_job(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: anon or authenticated can still execute public.load_recipe_into_job';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: public.load_recipe_into_job is no longer callable by the app';
END;
$postflight$;
