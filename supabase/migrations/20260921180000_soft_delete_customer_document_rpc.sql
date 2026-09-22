-- ============================================================================
-- soft_delete_customer_document: let an active sales rep remove a document of
-- a customer assigned to them (admins keep the same ability through the same
-- path) without widening any read or write policy on public.customer_documents.
-- STATUS: PARKED / NOT APPLIED — DO NOT APPLY without Mason's explicit in-chat approval.
-- Adds ONE new function; no table, policy, trigger or data change.
--
-- APPLY ORDER: apply only after EVERY parked candidate stamped below
-- 20260921180000 that still sorts above the live high-water has applied (or
-- been deliberately restamped); applying this first would raise the ordering
-- high-water past them and strand them. On 2026-09-22 UTC (after the
-- commission files 20260914100500 and 100600 applied live, at ledger versions
-- 20260922015509 and 20260922020038) that was
-- 20260914100450_customer_document_bytes_server_only (PR #761, same table,
-- independent of this file) and the commission files 20260914100800 and
-- 100900. Re-read the live ledger by name before applying.
--
-- WHAT THE PROOF DOES NOT COVER: the prover replays only what is live, so the
-- candidate is never proven on top of those three prerequisites. Read by hand
-- on 2026-09-22: 20260914100800 adds a BEFORE INSERT trigger on
-- public.idempotency_keys scoped to NEW.operation = 'transfer_job_to_invoice',
-- so it cannot affect this function's receipt INSERT; 20260914100900 rewrites
-- commission-history labels only; 20260914100450 is not on disk in this
-- checkout. Re-run the prover after each of them applies, which is when their
-- files drop out of its skip list.
--
-- idempotency-body-check: exempt — the body below DOES enforce
-- p_idempotency_key: it requires the key, calls public.check_idempotency_intent
-- (per-key advisory lock + actor/intent comparison + replay) BEFORE any
-- mutation, and writes the receipt with a direct INSERT INTO
-- public.idempotency_keys that carries request_actor_id and
-- request_fingerprint. save_idempotency cannot write the binding columns, so
-- the hook's check_idempotency(/save_idempotency( pair does not fit a bound
-- receipt (same shape as 20260911120000 adjust_inventory).
--
-- caller-analysis: soft_delete_customer_document :: new function created here; no caller exists at this commit - the only planned caller is the browser (src/components/customers/CustomerDocuments.tsx handleDelete, which still does a direct UPDATE here and is changed in a separate follow-up branch) signed in as authenticated; REVOKE from PUBLIC, anon and service_role removes the Supabase default grants on a brand-new function, nothing server-side calls it and service_role has no auth.uid() so it could only be refused
--
-- DEFECT (found 2026-09-21, reproduced on a local copy of the live policies):
-- the Documents tab's Remove action updated public.customer_documents
-- directly: SET deleted_at, deleted_by ... WHERE deleted_at IS NULL. For a
-- sales rep that UPDATE fails with "new row violates row-level security
-- policy" — with or without RETURNING — because PostgreSQL also checks an
-- UPDATE's new row against the table's SELECT policies, and
-- customer_documents_rep_select requires deleted_at IS NULL. The soft-deleted
-- row is, by design, invisible to reps, so the UPDATE that creates it is
-- refused. Admins are unaffected (customer_documents_admin_select is just
-- is_admin()). Live held 0 customer_documents rows on 2026-09-21.
--
-- WHY A FUNCTION AND NOT A POLICY CHANGE: the only policy fix is to let reps
-- SELECT soft-deleted rows, which would expose removed documents' metadata to
-- reps and, through customer_documents_objects_rep_select's EXISTS over this
-- table, weaken the "soft-deleted means GONE for reps" rule. The function
-- keeps every policy exactly as it is and grants one narrow action.
--
-- WHAT THE FUNCTION ALLOWS (and nothing else):
--   * caller signed in (AUTH_REQUIRED) with an ACTIVE admin or ACTIVE
--     sales_rep profile (INSUFFICIENT_ROLE) — the same predicates as
--     is_admin() / is_sales_rep();
--   * a non-blank idempotency key (IDEMPOTENCY_KEY_REQUIRED);
--   * the document exists and is not already soft-deleted, and — for a rep —
--     its customer is currently assigned to the caller. Every one of those
--     failures is the same CUSTOMER_DOCUMENT_NOT_FOUND, so a rep cannot use
--     the error to probe for documents of customers they cannot see.
--   * the row change is exactly deleted_at = now(), deleted_by = auth.uid().
--     The existing guard_customer_document_update trigger still runs (the
--     function does not bypass triggers) and still enforces identity
--     immutability, one-way soft delete and deleted_by = auth.uid().
--   RLS: the function is owned by postgres, which owns customer_documents
--   and the table does NOT force row security, so the UPDATE is not subject
--   to the rep SELECT policy. The preflight refuses to install if that stops
--   being true, because the function would then fail for reps again.
-- A removal is PERMANENT: guard_customer_document_update refuses every edit
-- to a soft-deleted row, for admins too, and nothing restores one. So the
-- races below are closed with locks rather than accepted.
-- LOCKS: the caller's own profile row FOR SHARE (a concurrent deactivation or
-- role change waits for this transaction, so an account being switched off
-- cannot squeeze in one removal), then ONE statement that locks the document
-- FOR UPDATE and its customer FOR SHARE and applies the assignment test in
-- the same WHERE clause. A rep therefore never locks a document of a customer
-- that is not theirs, and a concurrent reassignment of the customer waits for
-- this transaction; if the reassignment commits first, PostgreSQL re-checks
-- the WHERE clause against the new row and the rep is refused.
-- The lock order here is profiles, then (customer_documents, customers) in one
-- statement. A deadlock therefore needs a transaction that takes those rows in
-- a conflicting order: the same customer and then a document of it (for
-- example a hard DELETE of the customer, whose foreign-key check reaches the
-- document), or customers before profiles. A 2026-09-22 sweep of the
-- migrations found no such partner - assign_customers_sales_rep and
-- log_customer_sales_rep_assignment take profiles then customers, like this
-- function - but that is today's inventory, not a guarantee.
-- PostgreSQL detects it and cancels one side (40P01); nothing commits for the
-- cancelled side and the page keeps its key, so a retry is safe.
-- IDEMPOTENCY: the request is fingerprinted (actor, document id);
-- check_idempotency_intent replays only a receipt bound to THIS actor and
-- THIS document, refuses another actor (IDEMPOTENCY_ACTOR_MISMATCH) and a
-- different document under the same key (IDEMPOTENCY_INTENT_MISMATCH). Keys
-- longer than 255 characters are refused; the page's keys are ~105.
-- A REPLAY IS RE-AUTHORISED: the role gate runs first, and a rep's replay is
-- honoured only while the receipt's customer is still assigned to them —
-- otherwise it is the same CUSTOMER_DOCUMENT_NOT_FOUND. So a reassigned rep,
-- or an admin since demoted to a rep, cannot read a receipt for a customer
-- they can no longer see.
--
-- Atomicity: no BEGIN/COMMIT of its own. Apply live ONLY through
-- scripts/apply-migration-file.mjs, which wraps the whole file in one
-- transaction; `psql -1` is for the disposable local prover, never live.
--
-- PREFLIGHT: check_idempotency_intent(text,text,uuid,text) installed as a
-- postgres-owned SECURITY DEFINER function not executable by anon,
-- authenticated or service_role; extensions.digest(bytea,text) installed;
-- idempotency_keys carries both binding columns; customer_documents and
-- customers owned by postgres with row security NOT forced (the function's
-- reads and locks must not be filtered by the rep policies);
-- customer_documents_guard_editable_fields present, enabled, BEFORE UPDATE
-- FOR EACH ROW, unconditional and all-column, with guard_customer_document_update
-- matching its pinned body md5; no other overload of soft_delete_customer_document.
-- NOT CHECKED (platform-wide, not specific to this function): roles that
-- inherit EXECUTE through membership in authenticated.
-- POSTFLIGHT: exactly one overload with the pinned argument list;
-- postgres-owned SECURITY DEFINER plpgsql with search_path=public, pg_temp;
-- AUTH_REQUIRED, INSUFFICIENT_ROLE and IDEMPOTENCY_KEY_REQUIRED all appear
-- before the receipt lookup in the source (a text-position check — the
-- prover is what proves the behaviour); no key-only
-- check_idempotency/save_idempotency call; ACL is EXACTLY the owner and
-- authenticated. Grants to PUBLIC, anon, authenticated and service_role are
-- revoked before the one GRANT (so a re-run converges and the Supabase
-- defaults are cleared); a grant to ANY OTHER role — metabase_ro, or any
-- drifted grant surviving CREATE OR REPLACE — is not revoked here and fails
-- the apply, so a human looks at it.
-- ROLLBACK: a NEW forward migration that DROPs
-- public.soft_delete_customer_document(uuid, text). The page would then fail
-- closed on Remove (function not found) for every role until it is reverted.
-- PROOF: scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs
-- (network-disabled throwaway Supabase PostgreSQL 17 image on the checked-in
-- 2026-07-27 baseline plus every later migration).
-- ============================================================================

DO $preflight$
DECLARE
  v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';
  v_count      integer;
BEGIN
  IF to_regprocedure(v_helper_sig) IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: % is not installed (20260811130000).', v_helper_sig;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure(v_helper_sig)
       AND p.proowner = 'postgres'::regrole
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND position('operation IS DISTINCT FROM p_operation' IN p.prosrc) > 0
       AND position('request_actor_id IS DISTINCT FROM p_actor' IN p.prosrc) > 0
       AND position('request_fingerprint IS DISTINCT FROM p_fingerprint' IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_HELPER_SHAPE: % is not a postgres-owned SECURITY DEFINER function that compares the receipt operation, actor and fingerprint.', v_helper_sig;
  END IF;
  -- No grantee other than the owner, at all (PUBLIC, anon, authenticated,
  -- service_role, metabase_ro, anything): the receipt binding relies on the
  -- helper being reachable only from postgres-owned SECURITY DEFINER code.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure(v_helper_sig)
       AND a.grantee <> p.proowner
  ) OR (SELECT proacl IS NULL FROM pg_proc WHERE oid = to_regprocedure(v_helper_sig)) THEN
    RAISE EXCEPTION 'PREFLIGHT_ACL: % must be executable by its owner only (a NULL ACL means the PUBLIC default).', v_helper_sig;
  END IF;
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: extensions.digest(bytea, text) is not installed (pgcrypto).';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_attribute
   WHERE attrelid = 'public.idempotency_keys'::regclass
     AND attname IN ('request_actor_id', 'request_fingerprint')
     AND NOT attisdropped;
  IF v_count <> 2 THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_COLUMNS: idempotency_keys needs request_actor_id and request_fingerprint (20260803010917); found % of 2.',
      v_count;
  END IF;

  IF to_regclass('public.customer_documents') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_MISSING: public.customer_documents does not exist (20260717013415).';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
     WHERE c.oid = 'public.customer_documents'::regclass
       AND c.relowner = 'postgres'::regrole
       AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_TABLE: public.customer_documents must be owned by postgres with row security enabled and NOT forced; otherwise this SECURITY DEFINER UPDATE would still be refused by the rep SELECT policy.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
     WHERE c.oid = 'public.customers'::regclass
       AND c.relowner = 'postgres'::regrole
       AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_TABLE: public.customers must be owned by postgres with row security NOT forced; the assignment check reads and locks it as the owner.';
  END IF;

  -- tgtype 19 = FOR EACH ROW (1) | BEFORE (2) | UPDATE (16).
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.customer_documents'::regclass
       AND NOT t.tgisinternal
       AND t.tgname = 'customer_documents_guard_editable_fields'
       AND t.tgfoid = to_regprocedure('public.guard_customer_document_update()')
       AND t.tgenabled = 'O'
       AND t.tgtype = 19
       AND t.tgqual IS NULL          -- no WHEN clause that could skip it
       AND cardinality(t.tgattr::int2[]) = 0   -- not UPDATE OF <columns>
  ) OR NOT EXISTS (
    -- The guard's body is pinned exactly (md5 of the LF-normalized source,
    -- read read-only from live 2026-09-21: 1086 characters), so any drift in
    -- its enforcement — not just in its messages — refuses the install.
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.guard_customer_document_update()')
       AND md5(replace(p.prosrc, E'\r\n', E'\n')) = '49056708bdd24900db157ef617d763b3'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_TRIGGER: customer_documents_guard_editable_fields is missing, disabled, conditional, column-limited, not BEFORE UPDATE FOR EACH ROW, or guard_customer_document_update no longer matches its pinned body; the function relies on it. Re-verify the live guard before changing the pin.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'soft_delete_customer_document'
     AND oid <> COALESCE(to_regprocedure('public.soft_delete_customer_document(uuid,text)'), 0);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_OVERLOAD: % other overload(s) of soft_delete_customer_document exist. Reconcile before applying.', v_count;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.soft_delete_customer_document(
  p_document_id uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $soft_delete$
DECLARE
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_fingerprint text;
  v_replay jsonb;
  v_customer_id uuid;
  v_deleted_at timestamptz;
  v_result jsonb;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;

  -- Same predicates as is_admin() / is_sales_rep(): active profiles only.
  -- FOR SHARE holds off a concurrent deactivation or role change until this
  -- (permanent) removal has committed or rolled back.
  SELECT p.role = 'admin'
    INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.role IN ('admin', 'sales_rep')
     AND p.is_active = true
     FOR SHARE;
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins and sales reps can remove customer documents';
  END IF;

  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) > 255
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: soft_delete_customer_document requires a p_idempotency_key of at most 255 characters';
  END IF;

  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- The actor and the document are the whole request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'document_id', p_document_id
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction
  -- and replays only a receipt bound to THIS actor and THIS document.
  -- The helper's IDEMPOTENCY_INTENT_MISMATCH carries the committed receipt in
  -- DETAIL. Here that receipt names an earlier document and customer the
  -- caller may no longer be allowed to see (a key reused on another document
  -- after a reassignment), so it is re-raised with the same message and
  -- SQLSTATE but no DETAIL. The page keys per document and never hits this.
  BEGIN
    v_replay := public.check_idempotency_intent(
      p_idempotency_key, 'soft_delete_customer_document', v_actor, v_fingerprint
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH' USING ERRCODE = '22023';
  END;
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR v_replay -> 'result' ->> 'customer_id' IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    -- A replay returns only what the caller could do NOW: a rep whose customer
    -- has since been reassigned gets the same refusal as any other rep.
    -- FOR SHARE, as on the first call: a concurrent reassignment waits, or, if
    -- it committed first, the re-checked row no longer matches.
    IF NOT v_is_admin THEN
      PERFORM 1
         FROM public.customers c
        WHERE c.id = (v_replay -> 'result' ->> 'customer_id')::uuid
          AND c.assigned_sales_rep = v_actor
          FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
      END IF;
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- One statement: find the active document, apply the assignment test, and
  -- lock only a row the caller may remove (document FOR UPDATE, customer
  -- FOR SHARE so a concurrent reassignment waits; if one commits first,
  -- PostgreSQL re-checks this WHERE clause against the new customer row).
  -- Missing, removed and not-yours are one error: no existence probe for reps.
  SELECT d.customer_id
    INTO v_customer_id
    FROM public.customer_documents d
    JOIN public.customers c ON c.id = d.customer_id
   WHERE d.id = p_document_id
     AND d.deleted_at IS NULL
     AND (v_is_admin OR c.assigned_sales_rep = v_actor)
     FOR UPDATE OF d
     FOR SHARE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- guard_customer_document_update still fires and requires deleted_by to be
  -- auth.uid(), which v_actor is.
  UPDATE public.customer_documents
     SET deleted_at = now(),
         deleted_by = v_actor
   WHERE id = p_document_id
     AND deleted_at IS NULL
  RETURNING deleted_at INTO v_deleted_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'customer_id', v_customer_id,
    'deleted_at', v_deleted_at
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'soft_delete_customer_document', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$soft_delete$;

ALTER FUNCTION public.soft_delete_customer_document(uuid, text) OWNER TO postgres;
-- Clear every non-owner grant first (Supabase default privileges, or any grant
-- a CREATE OR REPLACE would keep), then grant exactly one. The postflight
-- refuses any other grantee that still survives.
REVOKE ALL ON FUNCTION public.soft_delete_customer_document(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_customer_document(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.soft_delete_customer_document(uuid, text) IS
  'Soft-deletes one active customer document. Active admins may remove any; active sales reps only documents of customers assigned to them. Requires p_idempotency_key, binds the receipt to the actor and document, and leaves every customer_documents policy unchanged.';

DO $verify$
DECLARE
  v_sig        text := 'public.soft_delete_customer_document(uuid,text)';
  v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';
  v_args_pin   text := 'p_document_id uuid, p_idempotency_key text DEFAULT NULL::text';
  v_count      integer;
  v_src        text;
  v_role       text;
  v_grantees   text;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: % is not installed.', v_sig;
  END IF;
  IF pg_get_function_arguments(to_regprocedure(v_sig)) <> v_args_pin THEN
    RAISE EXCEPTION 'POSTFLIGHT_ARGS: % has argument list "%", expected "%".',
      v_sig, pg_get_function_arguments(to_regprocedure(v_sig)), v_args_pin;
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'soft_delete_customer_document';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: soft_delete_customer_document has % overloads, expected 1.', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = to_regprocedure(v_sig)
       AND p.proowner = 'postgres'::regrole
       AND l.lanname = 'plpgsql'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SHAPE: % is not a postgres-owned plpgsql SECURITY DEFINER function with search_path=public, pg_temp.', v_sig;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_sig);
  IF position('public.check_idempotency_intent(' IN v_src) = 0
     OR position('INSUFFICIENT_ROLE' IN v_src) = 0
     OR position('INSUFFICIENT_ROLE' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('AUTH_REQUIRED' IN v_src) = 0
     OR position('AUTH_REQUIRED' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('IDEMPOTENCY_KEY_REQUIRED' IN v_src) = 0
     OR position('IDEMPOTENCY_KEY_REQUIRED' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('check_idempotency(' IN v_src) > 0
     OR position('save_idempotency(' IN v_src) > 0
     OR position('request_actor_id, request_fingerprint' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: the installed soft_delete_customer_document does not authenticate and role-check before its bound receipt lookup.';
  END IF;

  -- The ACL must be EXACTLY {owner, authenticated}. Any role that can execute
  -- a function reading auth.uid() can also set request.jwt.claims and act as
  -- any user, so an extra grantee (PUBLIC, anon, service_role, metabase_ro, a
  -- drifted grant) is a real boundary breach, not noise.
  SELECT string_agg(g.name, ',' ORDER BY g.name)
    INTO v_grantees
    FROM (
      SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS name
        FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.oid = to_regprocedure(v_sig)
         AND a.grantee <> p.proowner
    ) g;
  IF v_grantees IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: % must be executable by exactly the owner and authenticated; non-owner grantees are %.', v_sig, COALESCE(v_grantees, '(none)');
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_sig;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: authenticated cannot execute %.', v_sig;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_helper_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_helper_sig;
    END IF;
  END LOOP;
END;
$verify$;
