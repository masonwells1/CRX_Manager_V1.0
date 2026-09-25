-- STATUS: NOT APPLIED. PR #652 PHASE 2. No applied migration is edited.
-- Require separately COMMITTED phase 1 (20260914101200), then take its advisory
-- key exclusively. If V1 holders remain, refuse installation rather than wait;
-- arrivals during installation fail fast rather than wait on old code.
-- A fresh READ COMMITTED catalog/safety scan refuses ANY other open database
-- transaction or prepared transaction, and any still-valid save_invoice receipt that
-- could replay a FIELD-APPLICATION save: one resolving to a live field_application
-- invoice, or one whose invoice_id resolves to no live invoice at all (unidentifiable,
-- so treated as if it were a field save). A receipt resolving to a live invoice of
-- another type does NOT block -- this cutover does not change those paths, and blocking
-- on them demanded a 24-hour freeze on ALL invoice saving. See the SCOPE note at the
-- gate itself. Do NOT wait out unrelated receipts.
-- Refusal leaves phase 1 and legitimate committed retries unchanged. Wait for natural
-- expiry of the blocking receipts; NEVER delete/backfill receipts or override the gate.
-- Once safe, refuse NEW generic field invoices before key-only lookup/delegation.
-- Dedicated field-app/job/blend creators and existing generic edits are unchanged.
-- Two phases must be separately committed. Quiet traffic is recommended to reduce
-- retries; the advisory/transaction/prepared gates enforce the drain in SQL. Require
-- exact-head proof, current read-only checks, live approval and postapply checks.
-- No production execution is authorized by this pending file or its container proof.
-- ORDERING: strict. No ahead-of-pending marker; its reason was obsolete and it would have
-- waved through 20260908140000 (PR #726), the season guard and phase one. 20260908140000
-- APPLIED LIVE 2026-09-20 (ledger version 20260920051333), so do NOT reapply it. This file
-- is LAST of the four: apply 20260914101000, then 20260914101100, then 20260914101200, then
-- this one. Every older pending migration applies first, in ascending order -- including
-- all eight 20260914100* commission migrations (restamped 2026-09-21 above them; see the
-- season guard's header for the reverse hazard).
-- idempotency-body-check: exempt The existing operation-scoped check_idempotency and
-- delegated key-only receipt behavior remain intact; no new intent binding is claimed.

SET LOCAL lock_timeout = '15s';
CREATE TEMP TABLE generic_field_cutover_phase2_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.save_invoice(jsonb,jsonb,text)')::oid AS function_oid;

DO $cutover$
DECLARE
  v_oid oid := to_regprocedure('public.save_invoice(jsonb,jsonb,text)');
  v_body text;
BEGIN
  IF to_regclass('pg_temp.generic_field_cutover_phase2_tx') IS NULL THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_IN_TRANSACTION: phase 2 requires one READ COMMITTED transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.generic_field_cutover_phase2_tx)
        IS DISTINCT FROM pg_current_xact_id()::text
     OR current_setting('transaction_isolation') <> 'read committed'
     OR current_setting('lock_timeout') <> '15s' THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_IN_TRANSACTION: phase 2 requires one READ COMMITTED transaction';
  END IF;

  -- Same key as V1; fail fast BEFORE any scan or table lock if holders remain.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(20260912, 652) THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_BUSY: another save request holds the barrier; retry later';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_invoice') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) IN ('82c68c993dcff32eabd7b70c70f11527', 'cb932dc51a680442affde5aeba2eaee3')
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_GENERIC_FIELD_CREATION_DRIFT: phase 1 or exact phase 2 replay contract required';
  END IF;

  SELECT md5(prosrc) INTO v_body FROM pg_proc WHERE oid = v_oid;
  IF v_body = '82c68c993dcff32eabd7b70c70f11527'
     AND (to_regclass('pg_temp.generic_field_cutover_phase1_tx') IS NOT NULL
          OR (SELECT xmin = pg_current_xact_id()::xid FROM pg_proc WHERE oid = v_oid)
             IS DISTINCT FROM false) THEN
    -- Phase 1's ON COMMIT DROP sentinel remains through released savepoints,
    -- unlike a top-level-xid comparison alone. A separate COMMIT removes it.
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_BARRIER_UNCOMMITTED: commit phase 1 separately before phase 2';
  END IF;
  IF NOT (current_setting('is_superuser') = 'on'
          OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')) THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_STATS_BLIND: cannot prove old requests drained';
  END IF;
  -- Include background workers as well as client backends. Do not filter by
  -- our transaction timestamp: an old invocation may have started while we waited.
  IF EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = current_database()
             AND a.pid <> pg_backend_pid() AND a.xact_start IS NOT NULL) THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_NOT_QUIET: another transaction is open; retry after it finishes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database = current_database()) THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_PREPARED_XACT: resolve prepared work before applying';
  END IF;

  -- Stabilize the receipt scan against any writer outside the public entry.
  -- No invoice table lock: dedicated/source creators are not this cutover's target, and the
  -- quiet gate above has already established that no other backend holds an open transaction,
  -- so the invoices rows this scan resolves cannot change underneath it.
  -- A NULL expires_at is NOT covered by "wait for natural expiry" below. Ordinary
  -- save_invoice receipts take the column default, but idempotency_keys.expires_at is
  -- nullable, so a legacy or hand-inserted NULL-expiry row is possible and never expires.
  -- This gate deliberately treats it as still-valid and refuses, which is fail-closed and
  -- correct: it is a rollout signal requiring OPERATOR ADJUDICATION of that specific row,
  -- not a wait. Do not delete, backfill, re-date or otherwise bypass the gate to clear it.
  --
  -- SCOPE (CodeRabbit on PR #786): only the field-application branch of save_invoice changes
  -- here, so only a receipt that could replay a field-application save can be affected. The
  -- earlier form blocked on EVERY unexpired save_invoice receipt, including chemical-sale and
  -- miscellaneous-charge saves whose behaviour this cutover does not touch. Receipts live 24h
  -- (idempotency_keys.expires_at DEFAULT now() + interval '24 hours'), and the generic editor
  -- saves those types continuously on a working system, so that form required a 24-hour freeze
  -- on ALL invoice saving and in practice left phase 2 unappliable -- the same stranding hazard
  -- row 934 of docs/reference/migration-history.md records. This is NOT the quiet-window scan
  -- that row 933 forbids narrowing: that gate proves in-flight old-body REQUESTS have drained
  -- and still counts every backend type. This gate is about COMMITTED retries, and it keeps the
  -- property it exists to protect. Fail-closed is preserved where it can still matter: of the
  -- receipts that pass the expiry test above (NULL expiry included), one whose invoice_id is
  -- absent, malformed or no longer resolvable (i.id IS NULL) still BLOCKS, because an
  -- unidentifiable receipt could be a field save. ONLY a receipt that resolves to a live invoice
  -- of another type is allowed past -- including one with a NULL expiry, which by definition
  -- cannot replay a field-application save and so is not this gate's business.
  -- Every save_invoice receipt writer records jsonb_build_object('invoice_id', ...)
  -- (16 call sites through 20260904180000), so the cast target is the real key; the regex guard
  -- keeps a non-UUID value from raising instead of blocking.
  LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
  IF v_body = '82c68c993dcff32eabd7b70c70f11527' AND EXISTS (
    SELECT 1
      FROM public.idempotency_keys AS k
      LEFT JOIN public.invoices AS i
        ON i.id = CASE
             WHEN k.result->>'invoice_id' ~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN (k.result->>'invoice_id')::uuid
           END
     WHERE k.operation = 'save_invoice'
       AND (k.expires_at IS NULL OR k.expires_at >= transaction_timestamp())
       AND (i.id IS NULL OR i.invoice_type = 'field_application')
  ) THEN
    RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_ACTIVE_RECEIPTS: committed retries remain valid; wait for natural expiry';
  END IF;
END
$cutover$;

CREATE OR REPLACE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NULLIF(p_invoice->>'id', '') IS NULL AND p_invoice->>'invoice_type' = 'field_application' THEN
    RAISE EXCEPTION
      'FIELD_APPLICATION_VIA_SAVE_INVOICE_NOT_ALLOWED: create field invoices through the field-application, job-transfer or blend-ticket workflow'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public._begin_below_cost_money_write('save_invoice', NULL, p_items);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'save_invoice');
  END IF;
  RETURN public._save_invoice_below_cost_impl_20260810(p_invoice, p_items, p_idempotency_key);
END;
$function$;

DO $postflight$
DECLARE v_oid oid := to_regprocedure('public.save_invoice(jsonb,jsonb,text)');
BEGIN
  IF to_regclass('pg_temp.generic_field_cutover_phase2_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_CONTRACT: transaction was not preserved';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.generic_field_cutover_phase2_tx)
        IS DISTINCT FROM pg_current_xact_id()::text
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'cb932dc51a680442affde5aeba2eaee3'
     OR (SELECT position('GENERIC_FIELD_CUTOVER_BODY_V1' IN prosrc) FROM pg_proc WHERE oid = v_oid) <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_CONTRACT: transaction or final body drifted';
  END IF;
  IF v_oid IS DISTINCT FROM (SELECT function_oid FROM pg_temp.generic_field_cutover_phase2_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_IDENTITY: phase 2 must preserve the original function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_invoice') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_GENERIC_FIELD_CREATION_CONTRACT: final signature or access posture drifted';
  END IF;
  -- CREATE OR REPLACE preserves the preflight-pinned OID, owner, ACL, defaults,
  -- return type and dependencies; no grant repair or new private writer occurs.
  RAISE NOTICE 'POSTFLIGHT_OK: phase 2 NEW generic field-invoice refusal installed after safe receipt/request cutover';
END
$postflight$;
