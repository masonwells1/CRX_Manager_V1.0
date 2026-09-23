-- Rollback-only chain for soft_delete_customer_document (20260921180000).
--
-- CONTAINER ONLY. It seeds its own [SMOKE] document rows, so the LIVE-DATA
-- GUARD correctly refuses it against production; it runs inside the disposable
-- PostgreSQL built by
-- scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs, which
-- asserts this file ends in SMOKE_PASS_ROLLBACK.
--
-- Why it exists next to that prover: the prover proves the whole story
-- (pre-fix RLS refusal, locks, committed races, ACL drift, a mutation test),
-- but nothing in the repository re-ran it, because run-smoke.mjs only loads
-- work from smoke-specs.json. This chain is the registered entry point for the
-- security core, so a later edit to guard_customer_document_update,
-- customer_documents_rep_select or check_idempotency_intent is caught.
--
-- Every document row, receipt and lock is inside this single transaction and
-- the final SMOKE_PASS_ROLLBACK exception guarantees nothing persists.

DO $smoke$
DECLARE
  v_rep uuid;
  v_other_rep uuid;
  v_customer uuid;
  v_other_customer uuid;
  v_doc uuid := gen_random_uuid();
  v_other_doc uuid := gen_random_uuid();
  v_key text := 'smoke:soft_delete_customer_document:' || gen_random_uuid()::text;
  v_result jsonb;
  v_replay jsonb;
  v_deleted_at timestamptz;
  v_deleted_by uuid;
  v_replayed_at timestamptz;
  v_ctid tid;
  v_replayed_ctid tid;
  v_refusal text;
BEGIN
  -- Two DIFFERENT active sales reps, each with an active customer of their own.
  -- Discovered, never created: profiles carry an auth.users FK, and this chain
  -- must not write outside public.customer_documents.
  SELECT c.assigned_sales_rep, c.id
    INTO v_rep, v_customer
    FROM public.customers c
    JOIN public.profiles p ON p.id = c.assigned_sales_rep
   WHERE c.is_active = true
     AND p.is_active = true
     AND p.role = 'sales_rep'
   ORDER BY c.id
   LIMIT 1;
  IF v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active customer assigned to an active sales rep is available';
  END IF;

  SELECT c.assigned_sales_rep, c.id
    INTO v_other_rep, v_other_customer
    FROM public.customers c
    JOIN public.profiles p ON p.id = c.assigned_sales_rep
   WHERE c.is_active = true
     AND p.is_active = true
     AND p.role = 'sales_rep'
     AND c.assigned_sales_rep <> v_rep
   ORDER BY c.id
   LIMIT 1;
  IF v_other_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: a second active sales rep with a customer is required';
  END IF;

  INSERT INTO public.customer_documents
    (id, customer_id, document_type, storage_path, filename, mime_type, size_bytes, uploaded_by, source)
  VALUES
    (v_doc, v_customer, 'other', v_customer || '/[SMOKE]-mine.pdf', '[SMOKE]-mine.pdf', 'application/pdf', 100, v_rep, 'rep'),
    (v_other_doc, v_other_customer, 'other', v_other_customer || '/[SMOKE]-other.pdf', '[SMOKE]-other.pdf', 'application/pdf', 100, v_other_rep, 'rep');

  -- GRANTS: only authenticated executes it. anon and service_role must not,
  -- and neither may reach the shared intent helper directly.
  IF has_function_privilege('anon', 'public.soft_delete_customer_document(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.soft_delete_customer_document(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.soft_delete_customer_document(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: EXECUTE must be granted to authenticated only';
  END IF;
  -- Every prohibited role, not just authenticated: a stray grant to anon or
  -- service_role coexists with the authenticated denial, and the helper is
  -- owner-only by contract.
  IF has_function_privilege('authenticated', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no client role may execute check_idempotency_intent directly';
  END IF;

  -- THE FIX: the assigned rep removes their own customer's document.
  -- auth.uid() reads BOTH settings in this schema, so impersonation has to set
  -- both; setting only the JSON claims leaves the actor NULL.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_result := public.soft_delete_customer_document(v_doc, v_customer, v_key);
  -- IS DISTINCT FROM, never <>: `NULL <> x` is NULL and IF NULL does not fire, so a function
  -- that returned an empty or partial object would pass every <> check silently.
  IF v_result->>'document_id' IS DISTINCT FROM v_doc::text
     OR v_result->>'customer_id' IS DISTINCT FROM v_customer::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the result confirmed a different document: %', v_result::text;
  END IF;
  SELECT d.deleted_at, d.deleted_by, d.ctid INTO v_deleted_at, v_deleted_by, v_ctid
    FROM public.customer_documents d WHERE d.id = v_doc;
  IF v_deleted_at IS NULL OR v_deleted_by IS DISTINCT FROM v_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the row was not stamped deleted_by = the acting rep';
  END IF;

  -- REPLAY: the same key returns the same receipt and does not rewrite the row.
  --
  -- ctid, not deleted_at, is what proves "did not rewrite". now() is fixed for the whole
  -- transaction, so a second UPDATE inside this chain would write the SAME deleted_at and a
  -- timestamp comparison could not tell a replay from a rewrite. An UPDATE always writes a new
  -- tuple version, so its ctid moves even within one transaction.
  v_replay := public.soft_delete_customer_document(v_doc, v_customer, v_key);
  SELECT d.deleted_at, d.ctid INTO v_replayed_at, v_replayed_ctid
    FROM public.customer_documents d WHERE d.id = v_doc;
  IF v_replay IS DISTINCT FROM v_result OR v_replayed_at IS DISTINCT FROM v_deleted_at THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the replay did not return the committed receipt unchanged';
  END IF;
  IF v_replayed_ctid IS DISTINCT FROM v_ctid THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the replay rewrote the row (ctid moved % -> %)', v_ctid, v_replayed_ctid;
  END IF;

  -- NO NEW ACCESS: another rep's document, and an already-removed document,
  -- are the same uniform refusal under a fresh key.
  BEGIN
    PERFORM public.soft_delete_customer_document(v_other_doc, v_other_customer, v_key || ':cross');
    RAISE EXCEPTION 'SMOKE_FAIL: a rep removed a document of a customer assigned to someone else';
  EXCEPTION WHEN raise_exception THEN
    v_refusal := SQLERRM;
    IF v_refusal LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_refusal NOT LIKE '%CUSTOMER_DOCUMENT_NOT_FOUND%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for another rep''s document: %', v_refusal;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.customer_documents d WHERE d.id = v_other_doc AND d.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the other rep''s document was removed anyway';
  END IF;

  BEGIN
    PERFORM public.soft_delete_customer_document(v_doc, v_customer, v_key || ':again');
    RAISE EXCEPTION 'SMOKE_FAIL: an already-removed document was removed twice';
  EXCEPTION WHEN raise_exception THEN
    v_refusal := SQLERRM;
    IF v_refusal LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_refusal NOT LIKE '%CUSTOMER_DOCUMENT_NOT_FOUND%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for an already-removed document: %', v_refusal;
    END IF;
  END;

  -- THE KEY IS REQUIRED: no key, and a blank key, are refused before any write.
  BEGIN
    PERFORM public.soft_delete_customer_document(v_other_doc, v_other_customer, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a removal ran without an idempotency key';
  EXCEPTION WHEN raise_exception THEN
    v_refusal := SQLERRM;
    IF v_refusal LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_refusal NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for a missing key: %', v_refusal;
    END IF;
  END;
  BEGIN
    PERFORM public.soft_delete_customer_document(v_other_doc, v_other_customer, '   ');
    RAISE EXCEPTION 'SMOKE_FAIL: a removal ran with a blank idempotency key';
  EXCEPTION WHEN raise_exception THEN
    v_refusal := SQLERRM;
    IF v_refusal LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_refusal NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for a blank key: %', v_refusal;
    END IF;
  END;

  -- NO CALLER IDENTITY: an unauthenticated caller is refused, not defaulted.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.soft_delete_customer_document(v_other_doc, v_other_customer, v_key || ':anon');
    RAISE EXCEPTION 'SMOKE_FAIL: a removal ran with no authenticated actor';
  EXCEPTION WHEN raise_exception THEN
    v_refusal := SQLERRM;
    IF v_refusal LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_refusal NOT LIKE '%AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal with no actor: %', v_refusal;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
