-- ============================================================================
-- soft_delete_customer_document: let an active sales rep remove a document of
-- a customer assigned to them (admins keep the same ability through the same
-- path) without widening any read or write policy on public.customer_documents.
-- STATUS: NOT APPLIED — PARKED CANDIDATE. Adds ONE new function; no table,
-- policy, trigger or data change.
--
-- APPLY ORDER: this stamp sorts ABOVE the parked commission cohort
-- (20260914100500, 100600, 100800, 100900). Applying it first would raise the
-- live ordering high-water past those files and strand them. Apply it only
-- after the cohort has applied (or after they are deliberately restamped).
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
-- caller-analysis: soft_delete_customer_document :: new function created here; the only caller is the browser (src/components/customers/CustomerDocuments.tsx handleDelete) signed in as authenticated; REVOKE from PUBLIC, anon and service_role removes the Supabase default grants on a brand-new function, nothing server-side calls it and service_role has no auth.uid() so it could only be refused
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
-- LOCKS: the document row FOR UPDATE, then (rep path) the customer row
-- FOR SHARE, so a concurrent reassignment of the customer waits for this
-- transaction instead of racing the assignment check. Nothing that locks
-- customers FOR UPDATE takes a customer_documents lock, so there is no cycle.
-- IDEMPOTENCY: the request is fingerprinted (actor, document id);
-- check_idempotency_intent replays only a receipt bound to THIS actor and
-- THIS document, refuses another actor (IDEMPOTENCY_ACTOR_MISMATCH) and a
-- different document under the same key (IDEMPOTENCY_INTENT_MISMATCH).
-- RESIDUAL, KNOWN AND ACCEPTED: the caller's own profile is read, not locked;
-- a deactivation committed in the same instant as the call can still see one
-- removal succeed. A removal is a reversible-by-admin metadata flag, not money.
--
-- Atomicity: no BEGIN/COMMIT of its own. Apply ONLY through
-- scripts/apply-migration-file.mjs (or psql -1), which wraps the whole file in
-- one transaction.
--
-- PREFLIGHT: check_idempotency_intent(text,text,uuid,text) and
-- extensions.digest(bytea,text) installed, the helper not executable by anon,
-- authenticated or service_role; idempotency_keys carries both binding
-- columns; customer_documents owned by postgres, row security enabled and NOT
-- forced; guard_customer_document_update trigger present and enabled; no
-- other overload of soft_delete_customer_document.
-- POSTFLIGHT: exactly one overload with the pinned argument list;
-- postgres-owned SECURITY DEFINER plpgsql with search_path=public, pg_temp;
-- the role gate sits before the receipt lookup (position-checked); no
-- key-only check_idempotency/save_idempotency call; ACL — only authenticated
-- (and the owner) can execute.
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
  v_role       text;
  v_count      integer;
BEGIN
  IF to_regprocedure(v_helper_sig) IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: % is not installed (20260811130000).', v_helper_sig;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_helper_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT_ACL: % can execute %; the receipt binding relies on it being reachable only from postgres-owned SECURITY DEFINER functions.', v_role, v_helper_sig;
    END IF;
  END LOOP;
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
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.customer_documents'::regclass
       AND NOT t.tgisinternal
       AND t.tgname = 'customer_documents_guard_editable_fields'
       AND t.tgfoid = to_regprocedure('public.guard_customer_document_update()')
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_TRIGGER: customer_documents_guard_editable_fields is missing or disabled; the function relies on it for immutability and deleted_by attribution.';
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
  SELECT p.role = 'admin'
    INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.role IN ('admin', 'sales_rep')
     AND p.is_active = true;
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins and sales reps can remove customer documents';
  END IF;

  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: soft_delete_customer_document requires p_idempotency_key';
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
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'soft_delete_customer_document', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT d.customer_id
    INTO v_customer_id
    FROM public.customer_documents d
   WHERE d.id = p_document_id
     AND d.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- A rep may remove only documents of a customer assigned to them right now.
  -- FOR SHARE makes a concurrent reassignment wait for this transaction.
  IF NOT v_is_admin THEN
    PERFORM 1
       FROM public.customers c
      WHERE c.id = v_customer_id
        AND c.assigned_sales_rep = v_actor
        FOR SHARE;
    IF NOT FOUND THEN
      -- Same message as a missing document: no existence probe for reps.
      RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
    END IF;
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
REVOKE ALL ON FUNCTION public.soft_delete_customer_document(uuid, text) FROM PUBLIC, anon, service_role;
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
     OR position('INSUFFICIENT_ROLE' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('AUTH_REQUIRED' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('check_idempotency(' IN v_src) > 0
     OR position('save_idempotency(' IN v_src) > 0
     OR position('request_actor_id, request_fingerprint' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: the installed soft_delete_customer_document does not authenticate and role-check before its bound receipt lookup.';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % can execute %.', v_role, v_sig;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure(v_sig)
       AND a.grantee = 0
       AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: PUBLIC can execute %.', v_sig;
  END IF;
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
