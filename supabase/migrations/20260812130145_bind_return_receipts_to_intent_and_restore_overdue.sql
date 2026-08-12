-- Bind the six return-lifecycle idempotency receipts to the authenticated
-- actor and exact mutation intent, and restore the correct open-invoice status
-- after a credit application is reversed.
--
-- The business bodies are renamed, not retyped. This preserves the existing
-- source-derived credit math, Product/invoice locks, immutable application
-- ledger, accounting-period gates, return transition flag, RLS and audit rows.

DO $preflight$
DECLARE
  v_name text;
  v_sig regprocedure;
  v_expected_md5 text;
  v_actual_md5 text;
  v_authenticated_execute boolean;
BEGIN
  IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'check_idempotency_intent(text,text,uuid,text) is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'idempotency_keys'
       AND column_name = 'request_actor_id'
  ) OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'idempotency_keys'
       AND column_name = 'request_fingerprint'
  ) THEN
    RAISE EXCEPTION 'idempotency_keys actor/fingerprint binding columns are required';
  END IF;

  FOR v_name, v_sig, v_expected_md5, v_authenticated_execute IN
    SELECT * FROM (VALUES
      ('create_return', to_regprocedure('public.create_return(jsonb,jsonb,text)'), '80b3f9fd43c3ab3e56eae2935c525dcd', true),
      ('approve_return', to_regprocedure('public.approve_return(uuid,uuid,text)'), '35af7e79842a2a6a52f27808cd2dbe0d', true),
      ('reject_return', to_regprocedure('public.reject_return(uuid,uuid,text)'), 'f44a65e0cf47dd7f9df75f827006dade', true),
      ('cancel_return', to_regprocedure('public.cancel_return(uuid,text,uuid,text)'), '3af6073d9e608274dba2b183d02c918b', true),
      ('receive_return', to_regprocedure('public.receive_return(uuid,uuid,text)'), 'c43084461f30b9305bd0bb19f6605d89', true),
      ('issue_return_credit', to_regprocedure('public.issue_return_credit(uuid,uuid,text)'), '1e9647da071aa1a53f3add5e38515da8', true),
      ('_reverse_credit_memo_application', to_regprocedure('public._reverse_credit_memo_application(uuid,uuid,text,text)'), '96662c1913666a49b778973ca881d8d6', false)
    ) AS expected(name, signature, body_md5, authenticated_execute)
  LOOP
    IF v_sig IS NULL THEN
      RAISE EXCEPTION '% expected signature is missing', v_name;
    END IF;
    IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name) <> 1 THEN
      RAISE EXCEPTION '% must have exactly one public overload before wrapping', v_name;
    END IF;
    SELECT md5(p.prosrc) INTO v_actual_md5
      FROM pg_proc p
     WHERE p.oid = v_sig
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') = v_authenticated_execute
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_actual_md5 IS NULL THEN
      RAISE EXCEPTION '% owner/security/search_path/ACL drifted; refusing to wrap an unsafe implementation', v_name;
    END IF;
    IF v_actual_md5 IS DISTINCT FROM v_expected_md5 THEN
      RAISE EXCEPTION '% body drifted (expected md5 %, found %); refusing to wrap an unreviewed implementation',
        v_name, v_expected_md5, v_actual_md5;
    END IF;
  END LOOP;

  IF to_regprocedure('public._create_return_intent_impl_20260812(jsonb,jsonb,text)') IS NOT NULL
     OR to_regprocedure('public._approve_return_intent_impl_20260812(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._reject_return_intent_impl_20260812(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._cancel_return_intent_impl_20260812(uuid,text,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._receive_return_intent_impl_20260812(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public._reverse_credit_memo_application_status_impl_20260812(uuid,uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'private implementation name already exists; refusing ambiguous replay';
  END IF;
END
$preflight$;

ALTER FUNCTION public.create_return(jsonb, jsonb, text)
  RENAME TO _create_return_intent_impl_20260812;
ALTER FUNCTION public.approve_return(uuid, uuid, text)
  RENAME TO _approve_return_intent_impl_20260812;
ALTER FUNCTION public.reject_return(uuid, uuid, text)
  RENAME TO _reject_return_intent_impl_20260812;
ALTER FUNCTION public.cancel_return(uuid, text, uuid, text)
  RENAME TO _cancel_return_intent_impl_20260812;
ALTER FUNCTION public.receive_return(uuid, uuid, text)
  RENAME TO _receive_return_intent_impl_20260812;
ALTER FUNCTION public.issue_return_credit(uuid, uuid, text)
  RENAME TO _issue_return_credit_intent_impl_20260812;
ALTER FUNCTION public._reverse_credit_memo_application(uuid, uuid, text, text)
  RENAME TO _reverse_credit_memo_application_status_impl_20260812;

REVOKE ALL ON FUNCTION public._create_return_intent_impl_20260812(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._approve_return_intent_impl_20260812(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._reject_return_intent_impl_20260812(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cancel_return_intent_impl_20260812(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._receive_return_intent_impl_20260812(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._issue_return_credit_intent_impl_20260812(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._reverse_credit_memo_application_status_impl_20260812(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public._create_return_intent_impl_20260812(jsonb, jsonb, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._approve_return_intent_impl_20260812(uuid, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._reject_return_intent_impl_20260812(uuid, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._cancel_return_intent_impl_20260812(uuid, text, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._receive_return_intent_impl_20260812(uuid, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._issue_return_credit_intent_impl_20260812(uuid, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._reverse_credit_memo_application_status_impl_20260812(uuid, uuid, text, text) TO postgres;

CREATE OR REPLACE FUNCTION public.create_return(
  p_return jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_return requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'return', p_return,
    'items', p_items
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._create_return_intent_impl_20260812(p_return, p_items, p_idempotency_key);
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'create_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_return(
  p_return_id uuid,
  p_approved_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: approve_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'approve_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._approve_return_intent_impl_20260812(p_return_id, p_approved_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'approve_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_return(
  p_return_id uuid,
  p_rejected_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reject_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reject_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._reject_return_intent_impl_20260812(p_return_id, p_rejected_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'reject_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_return(
  p_return_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is required to cancel a return'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id, 'reason', p_reason)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'cancel_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._cancel_return_intent_impl_20260812(p_return_id, p_reason, p_performed_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'cancel_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_return(
  p_return_id uuid,
  p_received_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: receive_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'receive_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._receive_return_intent_impl_20260812(p_return_id, p_received_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'receive_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_return_credit(
  p_return_id uuid,
  p_actor_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: issue_return_credit requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'issue_return_credit', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._issue_return_credit_intent_impl_20260812(p_return_id, p_actor_id, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'issue_return_credit';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

-- Keep the shared reversal boundary and its callers, but correct the target
-- invoice's restored open status after the existing ledger/money body runs.
CREATE OR REPLACE FUNCTION public._reverse_credit_memo_application(
  p_application_id uuid,
  p_actor uuid,
  p_actor_role text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_previous_admin_override text := current_setting('app.admin_override', true);
  v_session_actor uuid := auth.uid();
BEGIN
  -- idempotency-body-check: exempt
  -- Internal helper: idempotency is owned by each public SECDEF caller. Keep
  -- the inherited service_role grant, but do not let a direct caller forge the
  -- actor written to the immutable reversal ledger.
  IF v_session_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM v_session_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  PERFORM public._reverse_credit_memo_application_status_impl_20260812(
    p_application_id, p_actor, p_actor_role, p_reason
  );

  -- This trusted re-derivation can legitimately move an overdue invoice back
  -- to posted after its due date was corrected forward. Keep the existing
  -- global transition matrix closed and scope its established override to
  -- this one status-only UPDATE, restoring the caller's prior setting.
  PERFORM set_config('app.admin_override', 'true', true);
  BEGIN
    UPDATE public.invoices i
       SET status = CASE
         WHEN i.due_date < CURRENT_DATE THEN 'overdue'
         ELSE 'posted'
       END,
           updated_at = now()
      FROM public.credit_memo_applications a
     WHERE a.id = p_application_id
       AND i.id = a.target_invoice_id
       AND i.status IN ('paid', 'posted', 'overdue')
       AND i.balance_cents > 0;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.admin_override', COALESCE(v_previous_admin_override, ''), true);
    RAISE;
  END;
  PERFORM set_config('app.admin_override', COALESCE(v_previous_admin_override, ''), true);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_return(jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_return(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.issue_return_credit(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_return(jsonb, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_return(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_return(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_return(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_return(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_return_credit(uuid, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public._reverse_credit_memo_application(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reverse_credit_memo_application(uuid, uuid, text, text) TO postgres, service_role;

COMMENT ON FUNCTION public.create_return(jsonb, jsonb, text) IS 'Creates one return; retry receipt is bound to auth.uid() and the exact return/items JSON payload.';
COMMENT ON FUNCTION public.approve_return(uuid, uuid, text) IS 'Approves one return; retry receipt is bound to auth.uid() and return id.';
COMMENT ON FUNCTION public.reject_return(uuid, uuid, text) IS 'Rejects one return; retry receipt is bound to auth.uid() and return id.';
COMMENT ON FUNCTION public.cancel_return(uuid, text, uuid, text) IS 'Cancels one return; retry receipt is bound to auth.uid(), return id, and exact reason.';
COMMENT ON FUNCTION public.receive_return(uuid, uuid, text) IS 'Receives one return; retry receipt is bound to auth.uid() and return id.';
COMMENT ON FUNCTION public.issue_return_credit(uuid, uuid, text) IS 'Issues one server-derived return credit; retry receipt is bound to auth.uid() and return id.';

DO $verify$
DECLARE
  v_sig regprocedure;
  v_name text;
  v_src text;
  v_proname text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'create_return(jsonb,jsonb,text)',
    'approve_return(uuid,uuid,text)',
    'reject_return(uuid,uuid,text)',
    'cancel_return(uuid,text,uuid,text)',
    'receive_return(uuid,uuid,text)',
    'issue_return_credit(uuid,uuid,text)'
  ] LOOP
    v_sig := to_regprocedure('public.' || v_name);
    IF v_sig IS NULL THEN RAISE EXCEPTION 'public.% is missing', v_name; END IF;
    v_proname := split_part(v_name, '(', 1);
    IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_proname) <> 1 THEN
      RAISE EXCEPTION 'public.% has an unexpected overload', v_proname;
    END IF;
    SELECT p.prosrc INTO v_src
      FROM pg_proc p
     WHERE p.oid = v_sig
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[];
    IF v_src NOT LIKE '%check_idempotency_intent%'
       OR v_src NOT LIKE '%request_actor_id%'
       OR v_src NOT LIKE '%request_fingerprint%'
       OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE')
       OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'public.% failed intent-binding or ACL postcondition', v_name;
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY ARRAY[
    '_create_return_intent_impl_20260812(jsonb,jsonb,text)',
    '_approve_return_intent_impl_20260812(uuid,uuid,text)',
    '_reject_return_intent_impl_20260812(uuid,uuid,text)',
    '_cancel_return_intent_impl_20260812(uuid,text,uuid,text)',
    '_receive_return_intent_impl_20260812(uuid,uuid,text)',
    '_issue_return_credit_intent_impl_20260812(uuid,uuid,text)',
    '_reverse_credit_memo_application_status_impl_20260812(uuid,uuid,text,text)'
  ] LOOP
    v_sig := to_regprocedure('public.' || v_name);
    v_proname := split_part(v_name, '(', 1);
    IF v_sig IS NULL
       OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_proname) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = v_sig
            AND pg_get_userbyid(p.proowner) = 'postgres'
            AND p.prosecdef
            AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       )
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'private implementation public.% failed ACL postcondition', v_name;
    END IF;
  END LOOP;

  v_sig := to_regprocedure('public._reverse_credit_memo_application(uuid,uuid,text,text)');
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_sig;
  IF v_sig IS NULL OR v_src NOT LIKE '%due_date < CURRENT_DATE%'
     OR v_src NOT LIKE '%THEN ''overdue''%'
     OR v_src NOT LIKE '%ELSE ''posted''%'
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION '_reverse_credit_memo_application failed restored-status or ACL postcondition';
  END IF;
END
$verify$;
