-- Bind transfer_job_to_invoice retries to the authenticated actor and exact job.
--
-- PARKED / NOT APPLIED — DO NOT APPLY without migration review, a fresh exact-SHA
-- security verdict, and Mason's explicit in-chat approval. This forward-only
-- correction preserves the current
-- Chicago-date implementation by renaming it, then installs a narrow public
-- wrapper.
--
-- A legacy receipt is scoped only to (key, operation). It can therefore replay
-- another user's or another job's transfer. Cutover deliberately refuses while
-- an unexpired unbound transfer receipt exists; waiting for expiry is safer
-- than silently changing the meaning of a retryable request.
-- Before any preflight, the file takes ACCESS EXCLUSIVE on the receipt table
-- (bounded by lock_timeout), draining every reader and writer that has touched
-- it. Under that lock it deletes expired unbound transfer receipts, because a
-- legacy call waiting on the per-key advisory lock is not drained and would
-- otherwise replay one after cutover. An owner-only receipt trigger then makes
-- a cached legacy body that reaches its receipt INSERT after cutover fail with a
-- retry signal and roll back; the new wrapper marks its transaction first.
-- Every receipt check reads rows committed during the lock wait, so the file
-- refuses to run at any isolation level except READ COMMITTED.
--
-- Because of that purge, the repo's apply guard classes this file as
-- destructive (it deletes expired retry-cache rows, never invoices or jobs), so
-- it can only be applied in an attended session.
--
-- First-apply prerequisite: 20260905200400 has already replaced the reviewed
-- live preimage (md5 78b827f8509a2740ea9879364747c372) with its Chicago-date
-- postimage (md5 85cd07a0a6b978cb066edab7df369fea). The same Chicago postimage
-- is required again on replay when it is held under the private name.
--
-- The public wrapper delegates idempotency: check_idempotency_intent() answers
-- replays, the private body writes the receipt, and the wrapper binds it.
-- idempotency-body-check: exempt
-- caller-analysis: transfer_job_to_invoice :: REVOKE is from PUBLIC and anon only; EXECUTE is re-granted to authenticated and service_role in the same file, and both UI callers (JobDetail, UnbilledApplicationsPanel) run as signed-in authenticated users, so neither loses access; complete_job's auto-draft PERFORM runs inside that postgres-owned SECURITY DEFINER function, which the owner EXECUTE grant still covers

-- The sanctioned migration runner wraps this whole file in one transaction.
-- Under autocommit, ON COMMIT DROP removes this table after CREATE and the next
-- statement fails before any preflight or cutover DDL can change shared state.
CREATE TEMP TABLE crx_transfer_invoice_intent_transaction_guard (
  marker boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO crx_transfer_invoice_intent_transaction_guard(marker) VALUES (true);

-- The purge and the refusal below must see every receipt committed while this
-- file waited for its lock. At REPEATABLE READ or SERIALIZABLE the snapshot is
-- fixed by the statement above, before the lock is granted, so both could miss
-- a receipt committed during the wait and let it survive cutover.
DO $isolation_guard$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_ISOLATION: apply at READ COMMITTED, not %',
      current_setting('transaction_isolation');
  END IF;
END;
$isolation_guard$;

-- While the lock below waits, every receipt read and write in the app queues
-- behind it. 5s keeps that queue shorter than the app roles' 8s statement
-- timeout; the file refuses rather than wait longer.
SET LOCAL lock_timeout = '5s';

-- Take the strongest receipt-table lock first and hold it to commit. It waits,
-- for at most lock_timeout, for every transaction that has already read or
-- written idempotency_keys, then keeps new readers and writers out, so every
-- check below sees one stable receipt set and no weaker lock is upgraded
-- mid-file. A legacy call still waiting on its key's advisory lock has not
-- touched the table and is not drained; the expired-receipt purge covers it.
LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_public regprocedure := to_regprocedure('public.transfer_job_to_invoice(uuid,uuid,text)');
  v_impl regprocedure := to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)');
  v_helper regprocedure := to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)');
  v_cutover_guard regprocedure := to_regprocedure('public.prevent_unwrapped_transfer_invoice_receipt_20260908()');
  v_public_src text;
  v_public_is_wrapper boolean := false;
BEGIN
  IF (SELECT count(*) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'transfer_job_to_invoice') <> 1
     OR (SELECT count(*) FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = '_transfer_job_to_invoice_intent_impl_20260908') <> (CASE WHEN v_impl IS NULL THEN 0 ELSE 1 END) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: transfer function overload drift detected';
  END IF;

  IF v_helper IS NULL
     OR (SELECT count(*) FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'check_idempotency_intent') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = v_helper
          AND p.prosecdef
          AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          AND p.prorettype = 'jsonb'::regtype
          AND p.proargtypes = ARRAY['text'::regtype::oid, 'text'::regtype::oid, 'uuid'::regtype::oid, 'text'::regtype::oid]::oidvector
          AND p.proargnames = ARRAY['p_key', 'p_operation', 'p_actor', 'p_fingerprint']::text[]
          AND p.pronargdefaults = 0
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND p.provolatile = 'v'
          AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u'
          AND p.procost = 100 AND p.prorows = 0
          AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
          AND obj_description(p.oid, 'pg_proc') = 'Intent-bound idempotency receipt check. NULL = no receipt; {"found":true,"result":...} = exact actor+intent replay; raises IDEMPOTENCY_ACTOR_MISMATCH / IDEMPOTENCY_INTENT_MISMATCH otherwise. Callers must already have authorized the actor.'
     )
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_helper)
          IS DISTINCT FROM 'edc73be809069669e8441eba7acf443d'
     OR (SELECT encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')
           FROM pg_proc p WHERE p.oid = v_helper)
          IS DISTINCT FROM '71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8'
     OR to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: reviewed intent helper, digest extension, owner, ACL, or body drifted';
  END IF;

  IF (SELECT count(*) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'prevent_unwrapped_transfer_invoice_receipt_20260908')
       <> (CASE WHEN v_cutover_guard IS NULL THEN 0 ELSE 1 END)
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid = 'public.idempotency_keys'::regclass
            AND t.tgname = 'trg_idempotency_keys_require_transfer_intent_20260908'
            AND NOT t.tgisinternal)
       <> (CASE WHEN v_cutover_guard IS NULL THEN 0 ELSE 1 END)
     OR (v_cutover_guard IS NOT NULL AND NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = v_cutover_guard
          AND NOT p.prosecdef
          AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          AND p.prorettype = 'trigger'::regtype
          AND p.proargtypes = ''::oidvector
          AND p.pronargdefaults = 0
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND p.provolatile = 'v'
          AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u'
          AND p.procost = 100 AND p.prorows = 0
          AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[]
          AND obj_description(p.oid, 'pg_proc') = 'Rejects stale pre-cutover transfer receipt inserts unless the intent-bound wrapper owns the transaction.'
          AND md5(p.prosrc) = '339762db7603acca00779ca62bc86772'
     ))
     OR (v_cutover_guard IS NOT NULL AND NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.idempotency_keys'::regclass
          AND t.tgname = 'trg_idempotency_keys_require_transfer_intent_20260908'
          AND t.tgfoid = v_cutover_guard
          AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND (t.tgtype & 1) = 1
          AND (t.tgtype & 2) = 2
          AND (t.tgtype & 4) = 4
          AND (t.tgtype & (8 | 16 | 32 | 64)) = 0
     )) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: cutover receipt guard or trigger drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.idempotency_keys'::regclass
          AND attname = 'request_actor_id' AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.idempotency_keys'::regclass
          AND attname = 'request_fingerprint' AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: idempotency receipt binding columns are missing';
  END IF;

  -- The wrapper and helper are safe only while browser roles cannot forge or
  -- alter receipts directly. Pin the owner, RLS state, sole deny-all policy,
  -- and browser-role posture before any shared-state cutover change.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_class c
        WHERE c.oid = 'public.idempotency_keys'::regclass
          AND c.relkind = 'r'
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity
          AND pg_get_userbyid(c.relowner) = 'postgres'
     )
     OR (SELECT count(*)
           FROM pg_policy pol
          WHERE pol.polrelid = 'public.idempotency_keys'::regclass) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_policy pol
        WHERE pol.polrelid = 'public.idempotency_keys'::regclass
          AND pol.polname = 'No direct client access to idempotency keys'
          AND pol.polpermissive
          AND pol.polcmd = '*'
          AND pol.polroles = ARRAY[0::oid]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'false'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'false'
     )
     OR (SELECT count(*) FROM pg_roles r
          WHERE r.rolname IN ('anon', 'authenticated')) <> 2
     OR EXISTS (
       SELECT 1
         FROM pg_roles browser_role
         CROSS JOIN pg_roles elevated_role
        WHERE browser_role.rolname IN ('anon', 'authenticated')
          AND (elevated_role.rolsuper OR elevated_role.rolbypassrls)
          AND pg_has_role(browser_role.oid, elevated_role.oid, 'MEMBER')
     )
     OR has_table_privilege('anon', 'public.idempotency_keys', 'INSERT')
     OR has_table_privilege('anon', 'public.idempotency_keys', 'UPDATE')
     OR has_table_privilege('anon', 'public.idempotency_keys', 'DELETE')
     OR has_table_privilege('anon', 'public.idempotency_keys', 'TRUNCATE')
     OR EXISTS (
       SELECT 1
         FROM pg_class c,
              LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
        WHERE c.oid = 'public.idempotency_keys'::regclass
          AND acl.grantee = 0
          AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     ) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted';
  END IF;

  IF v_impl IS NULL THEN
    IF v_public IS NULL THEN
      RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: public transfer_job_to_invoice(uuid,uuid,text) is missing';
    END IF;
    SELECT p.prosrc INTO v_public_src FROM pg_proc p WHERE p.oid = v_public;
    IF md5(v_public_src) IS DISTINCT FROM '85cd07a0a6b978cb066edab7df369fea'
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = v_public
            AND p.prosecdef
            AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND p.prorettype = 'jsonb'::regtype
            AND p.proargtypes = ARRAY['uuid'::regtype::oid, 'uuid'::regtype::oid, 'text'::regtype::oid]::oidvector
            AND p.proargnames = ARRAY['p_job_id', 'p_performed_by', 'p_idempotency_key']::text[]
            AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
            AND pg_get_userbyid(p.proowner) = 'postgres'
            AND p.pronargdefaults = 1
            AND pg_get_expr(p.proargdefaults, 0) = 'NULL::text'
            AND p.provolatile = 'v'
            AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u'
            AND p.procost = 100 AND p.prorows = 0
            AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
       )
       OR has_function_privilege('anon', v_public, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_public, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_public, 'EXECUTE') THEN
      RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: reviewed Chicago-date transfer implementation or ACL drifted';
    END IF;
  ELSE
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_impl)
         IS DISTINCT FROM '85cd07a0a6b978cb066edab7df369fea'
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = v_impl
            AND p.prosecdef
            AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
            AND pg_get_userbyid(p.proowner) = 'postgres'
       ) THEN
      RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: private transfer implementation drifted';
    END IF;
    IF v_public IS NOT NULL THEN
      SELECT p.prosrc INTO v_public_src FROM pg_proc p WHERE p.oid = v_public;
      v_public_is_wrapper := position('_transfer_job_to_invoice_intent_impl_20260908' IN v_public_src) > 0
        AND position('check_idempotency_intent' IN v_public_src) > 0
        AND position('IDEMPOTENCY_RECEIPT_MISSING' IN v_public_src) > 0
        AND md5(v_public_src) = 'b083dd371b091d7b70bb4cdc015c9bc8'
        AND EXISTS (
          SELECT 1 FROM pg_proc p
           WHERE p.oid = v_public
            AND p.prosecdef
            AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
            AND p.prorettype = 'jsonb'::regtype
            AND p.proargtypes = ARRAY['uuid'::regtype::oid, 'uuid'::regtype::oid, 'text'::regtype::oid]::oidvector
            AND p.proargnames = ARRAY['p_job_id', 'p_performed_by', 'p_idempotency_key']::text[]
            AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
            AND pg_get_userbyid(p.proowner) = 'postgres'
            AND p.pronargdefaults = 1
            AND pg_get_expr(p.proargdefaults, 0) = 'NULL::text'
            AND p.provolatile = 'v'
            AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u'
            AND p.procost = 100 AND p.prorows = 0
            AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[]
            AND obj_description(p.oid, 'pg_proc') = 'Transfers one job to invoice exactly once, binding retries to the authenticated actor and job intent.'
        )
        AND NOT has_function_privilege('anon', v_public, 'EXECUTE')
        AND has_function_privilege('authenticated', v_public, 'EXECUTE')
        AND has_function_privilege('service_role', v_public, 'EXECUTE');
      IF NOT v_public_is_wrapper THEN
        RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: private implementation exists but public body, signature, security, or ACL is not this migration wrapper';
      END IF;
    END IF;
  END IF;
END;
$preflight$;

-- Browser clients need SELECT for two schema-capability probes, but all receipt
-- writes must remain owner-executed through reviewed SECURITY DEFINER RPCs.
-- RLS does not govern TRUNCATE, so normalize every direct mutation/schema ACL
-- before installing the cutover trigger. A later refusal rolls this back with
-- the rest of the migration because the sanctioned runner uses one transaction.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.idempotency_keys
FROM PUBLIC, anon, authenticated;

DO $receipt_acl_preflight$
BEGIN
  IF EXISTS (
       SELECT 1
         FROM unnest(ARRAY['anon', 'authenticated']::text[]) AS browser_role(role_name)
         CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]) AS forbidden(privilege_name)
        WHERE has_table_privilege(browser_role.role_name, 'public.idempotency_keys', forbidden.privilege_name)
     )
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['anon', 'authenticated']::text[]) AS browser_role(role_name)
         CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'REFERENCES']::text[]) AS forbidden(privilege_name)
        WHERE has_any_column_privilege(browser_role.role_name, 'public.idempotency_keys', forbidden.privilege_name)
     )
     OR EXISTS (
       SELECT 1
         FROM pg_class c,
              LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
        WHERE c.oid = 'public.idempotency_keys'::regclass
          AND acl.grantee = 0
          AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
     )
     OR EXISTS (
       SELECT 1
         FROM pg_attribute a,
              LATERAL aclexplode(a.attacl) acl
        WHERE a.attrelid = 'public.idempotency_keys'::regclass
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND acl.grantee = 0
          AND acl.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
     ) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: browser role retains direct idempotency receipt mutation privilege';
  END IF;
END;
$receipt_acl_preflight$;

CREATE OR REPLACE FUNCTION public.prevent_unwrapped_transfer_invoice_receipt_20260908()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $cutover_guard$
BEGIN
  IF NEW.operation = 'transfer_job_to_invoice'
     AND (NEW.request_actor_id IS NULL OR NEW.request_fingerprint IS NULL)
     AND current_setting('crx.transfer_invoice_intent_wrapper', true) IS DISTINCT FROM '20260908' THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_CUTOVER_RETRY';
  END IF;
  RETURN NEW;
END;
$cutover_guard$;

REVOKE ALL ON FUNCTION public.prevent_unwrapped_transfer_invoice_receipt_20260908()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prevent_unwrapped_transfer_invoice_receipt_20260908()
  TO postgres;
COMMENT ON FUNCTION public.prevent_unwrapped_transfer_invoice_receipt_20260908() IS
  'Rejects stale pre-cutover transfer receipt inserts unless the intent-bound wrapper owns the transaction.';

DROP TRIGGER IF EXISTS trg_idempotency_keys_require_transfer_intent_20260908
  ON public.idempotency_keys;
CREATE TRIGGER trg_idempotency_keys_require_transfer_intent_20260908
BEFORE INSERT ON public.idempotency_keys
FOR EACH ROW
EXECUTE FUNCTION public.prevent_unwrapped_transfer_invoice_receipt_20260908();

-- The ACCESS EXCLUSIVE lock from the top of this file is still held. A legacy
-- call can start while its receipt is unexpired, then wait on the per-key
-- advisory lock in check_idempotency() without touching this table, so the lock
-- does not drain it. After cutover its DELETE judges expiry by its own
-- transaction-start now() and keeps the row, and its SELECT would replay that
-- unbound receipt with no actor or job check (Sol, PR #638). Delete every
-- expired unbound transfer receipt now, so none survives cutover. These are
-- expired retry-cache rows, not invoices or jobs; check_idempotency() would
-- otherwise delete each one only when its key is next used. This predicate and
-- the refusal below must stay exact complements on the same now().
DELETE FROM public.idempotency_keys
 WHERE operation = 'transfer_job_to_invoice'
   AND expires_at <= now()
   AND (request_actor_id IS NULL OR request_fingerprint IS NULL);

-- With expired rows gone, this refusal leaves no unbound transfer receipt at
-- commit, and the trigger above rejects any new one outside the wrapper. A
-- legacy call that therefore finds no unbound receipt reaches its INSERT, the
-- trigger rejects it, and its whole transaction rolls back so the caller can
-- retry through the wrapper. It could still replay a BOUND receipt that a
-- wrapper call commits for the same key after cutover; both invoice screens
-- refuse a result for another job.
DO $receipt_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
     WHERE operation = 'transfer_job_to_invoice'
       AND (expires_at IS NULL OR expires_at > now())
       AND (request_actor_id IS NULL OR request_fingerprint IS NULL)
  ) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_PREFLIGHT: unexpired legacy transfer_job_to_invoice receipts exist; wait for expiry before applying';
  END IF;
END;
$receipt_preflight$;

DO $rename$
BEGIN
  IF to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL THEN
    ALTER FUNCTION public.transfer_job_to_invoice(uuid, uuid, text)
      RENAME TO _transfer_job_to_invoice_intent_impl_20260908;
  END IF;
END;
$rename$;

REVOKE ALL ON FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid, uuid, text)
  TO postgres;

CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(
  p_job_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NULL
     OR p_idempotency_key COLLATE "C" !~ '^[!-~]{1,200}$' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: transfer_job_to_invoice requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object('actor_id', v_actor, 'job_id', p_job_id)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'transfer_job_to_invoice', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    v_result := v_replay -> 'result';
    IF v_result IS NULL
       OR jsonb_typeof(v_result) <> 'object'
       OR (v_result ->> 'job_id') IS DISTINCT FROM p_job_id::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_result;
  END IF;

  PERFORM set_config('crx.transfer_invoice_intent_wrapper', '20260908', true);
  v_result := public._transfer_job_to_invoice_intent_impl_20260908(
    p_job_id, p_performed_by, p_idempotency_key
  );
  IF v_result IS NULL
     OR jsonb_typeof(v_result) <> 'object'
     OR (v_result ->> 'job_id') IS DISTINCT FROM p_job_id::text THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_RESULT_INVALID';
  END IF;

  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'transfer_job_to_invoice'
     AND request_actor_id IS NULL
     AND request_fingerprint IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text)
  TO authenticated, service_role;
COMMENT ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text) IS
  'Transfers one job to invoice exactly once, binding retries to the authenticated actor and job intent.';

DO $postflight$
DECLARE
  v_public regprocedure := to_regprocedure('public.transfer_job_to_invoice(uuid,uuid,text)');
  v_impl regprocedure := to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)');
  v_cutover_guard regprocedure := to_regprocedure('public.prevent_unwrapped_transfer_invoice_receipt_20260908()');
  v_src text;
BEGIN
  IF EXISTS (
       SELECT 1
         FROM unnest(ARRAY['anon', 'authenticated']::text[]) AS browser_role(role_name)
         CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]) AS forbidden(privilege_name)
        WHERE has_table_privilege(browser_role.role_name, 'public.idempotency_keys', forbidden.privilege_name)
     )
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['anon', 'authenticated']::text[]) AS browser_role(role_name)
         CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'REFERENCES']::text[]) AS forbidden(privilege_name)
        WHERE has_any_column_privilege(browser_role.role_name, 'public.idempotency_keys', forbidden.privilege_name)
     )
     OR EXISTS (
       SELECT 1
         FROM pg_class c,
              LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
        WHERE c.oid = 'public.idempotency_keys'::regclass
          AND acl.grantee = 0
          AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
     )
     OR EXISTS (
       SELECT 1
         FROM pg_attribute a,
              LATERAL aclexplode(a.attacl) acl
        WHERE a.attrelid = 'public.idempotency_keys'::regclass
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND acl.grantee = 0
          AND acl.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
     ) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_POSTFLIGHT: browser role retains direct idempotency receipt mutation privilege';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'transfer_job_to_invoice') <> 1
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '_transfer_job_to_invoice_intent_impl_20260908') <> 1
     OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'prevent_unwrapped_transfer_invoice_receipt_20260908') <> 1
     OR v_public IS NULL OR v_impl IS NULL OR v_cutover_guard IS NULL THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_POSTFLIGHT: expected exactly one public wrapper, private implementation, and cutover guard';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_public;
  IF v_src IS NULL
     OR position('AUTH_REQUIRED' IN v_src) = 0
     OR position('ACTOR_MISMATCH' IN v_src) = 0
     OR position('IDEMPOTENCY_KEY_REQUIRED' IN v_src) = 0
     OR position('check_idempotency_intent' IN v_src) = 0
     OR position('_transfer_job_to_invoice_intent_impl_20260908' IN v_src) = 0
     OR position('IDEMPOTENCY_RECEIPT_MISSING' IN v_src) = 0
     OR position('check_idempotency_intent' IN v_src) > position('_transfer_job_to_invoice_intent_impl_20260908' IN v_src)
     OR position('_transfer_job_to_invoice_intent_impl_20260908' IN v_src) > position('request_fingerprint' IN v_src) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_POSTFLIGHT: wrapper guard or receipt-binding order is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_public AND p.prosecdef AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.prorettype = 'jsonb'::regtype AND p.proargtypes = ARRAY['uuid'::regtype::oid, 'uuid'::regtype::oid, 'text'::regtype::oid]::oidvector AND p.proargnames = ARRAY['p_job_id', 'p_performed_by', 'p_idempotency_key']::text[] AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres' AND p.pronargdefaults = 1 AND pg_get_expr(p.proargdefaults, 0) = 'NULL::text' AND p.provolatile = 'v' AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u' AND p.procost = 100 AND p.prorows = 0 AND p.proacl = ARRAY['postgres=X/postgres', 'authenticated=X/postgres', 'service_role=X/postgres']::aclitem[] AND obj_description(p.oid, 'pg_proc') = 'Transfers one job to invoice exactly once, binding retries to the authenticated actor and job intent.' AND md5(p.prosrc) = 'b083dd371b091d7b70bb4cdc015c9bc8')
     OR has_function_privilege('anon', v_public, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public, 'EXECUTE') THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_POSTFLIGHT: public wrapper security, default, or grants drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_impl AND p.prosecdef AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.prorettype = 'jsonb'::regtype AND p.proargtypes = ARRAY['uuid'::regtype::oid, 'uuid'::regtype::oid, 'text'::regtype::oid]::oidvector AND p.proargnames = ARRAY['p_job_id', 'p_performed_by', 'p_idempotency_key']::text[] AND p.pronargdefaults = 1 AND pg_get_expr(p.proargdefaults, 0) = 'NULL::text' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres' AND p.provolatile = 'v' AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u' AND p.procost = 100 AND p.prorows = 0 AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[] AND md5(p.prosrc) = '85cd07a0a6b978cb066edab7df369fea')
     OR has_function_privilege('anon', v_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_impl, 'EXECUTE') THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_POSTFLIGHT: private implementation ACL drifted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_cutover_guard AND NOT p.prosecdef AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') AND p.prorettype = 'trigger'::regtype AND p.proargtypes = ''::oidvector AND p.pronargdefaults = 0 AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres' AND p.provolatile = 'v' AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel = 'u' AND p.procost = 100 AND p.prorows = 0 AND p.proacl = ARRAY['postgres=X/postgres']::aclitem[] AND obj_description(p.oid, 'pg_proc') = 'Rejects stale pre-cutover transfer receipt inserts unless the intent-bound wrapper owns the transaction.' AND md5(p.prosrc) = '339762db7603acca00779ca62bc86772')
     OR has_function_privilege('anon', v_cutover_guard, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cutover_guard, 'EXECUTE')
     OR has_function_privilege('service_role', v_cutover_guard, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_cutover_guard, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.idempotency_keys'::regclass
          AND t.tgname = 'trg_idempotency_keys_require_transfer_intent_20260908'
          AND t.tgfoid = v_cutover_guard
          AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND (t.tgtype & 1) = 1
          AND (t.tgtype & 2) = 2
          AND (t.tgtype & 4) = 4
          AND (t.tgtype & (8 | 16 | 32 | 64)) = 0
     ) THEN
    RAISE EXCEPTION 'TRANSFER_INVOICE_INTENT_POSTFLIGHT: cutover receipt guard or trigger drifted';
  END IF;
END;
$postflight$;
