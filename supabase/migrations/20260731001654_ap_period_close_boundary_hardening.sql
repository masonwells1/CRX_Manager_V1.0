-- ============================================================================
-- AP accounting-period boundary hardening
--
-- Completes the vendor-bill protocol introduced by the 2026-07-30 period-close
-- race fix:
--   * record_vendor_payment and void_vendor_payment take a shared lock on the
--     payment month before checking whether it is open;
--   * void_vendor_bill takes a shared lock on the original bill month before
--     checking whether it is open;
--   * browser roles lose direct accounting_periods writes, so close/reopen RPCs
--     are the only authenticated mutation boundary.
--
-- Lock order is deliberate. Each AP RPC preserves its existing row-lock order,
-- then takes the shared month advisory lock, then calls check_period_open, then
-- mutates. close_accounting_period takes the same month lock exclusively before
-- closing the period, so either the AP mutation finishes first or it waits and
-- fails closed. Reopen does not create the check-open-then-close race and remains
-- unchanged.
--
-- This is an AP-only boundary fix. Other financial check_period_open callers
-- require their own protocol review and are not represented as covered here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT CURRENT_DATE, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payment_id uuid; v_bill record; v_new_paid bigint; v_new_status text;
  v_actor uuid; v_actor_role text; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_vendor_payment');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'payment_id')::uuid; END IF;
  END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  IF v_bill.status = 'voided' THEN RAISE EXCEPTION 'BILL_VOIDED: cannot record payment on a voided bill'; END IF;
  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: payment amount must be positive'; END IF;
  IF p_amount_cents > v_bill.balance_cents THEN
    RAISE EXCEPTION 'OVER_PAYMENT: payment of $% exceeds remaining balance $%',
      (p_amount_cents / 100.0)::numeric(12,2), (v_bill.balance_cents / 100.0)::numeric(12,2);
  END IF;

  PERFORM public._lock_accounting_months(ARRAY[p_payment_date], false);
  PERFORM check_period_open(p_payment_date);

  INSERT INTO vendor_payments (vendor_bill_id, payment_date, amount_cents, payment_method,
    reference_number, notes, created_by)
  VALUES (p_vendor_bill_id, p_payment_date, p_amount_cents, p_payment_method,
    p_reference_number, p_notes, v_actor)
  RETURNING id INTO v_payment_id;

  v_new_paid := COALESCE(v_bill.paid_cents, 0) + p_amount_cents;
  v_new_status := CASE
    WHEN v_new_paid >= v_bill.total_cents THEN 'paid'
    WHEN v_new_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid' END;

  UPDATE vendor_bills SET paid_cents = v_new_paid, status = v_new_status, updated_at = now()
    WHERE id = p_vendor_bill_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description)
  VALUES ('vendor_payment_recorded', 'vendor_payment', v_payment_id, v_actor, v_actor_role,
    jsonb_build_object('vendor_bill_id', p_vendor_bill_id, 'amount_cents', p_amount_cents,
      'payment_method', p_payment_method, 'reference_number', p_reference_number, 'new_bill_status', v_new_status),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
      ' on vendor bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_vendor_bill_id::text));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'record_vendor_payment', jsonb_build_object('payment_id', v_payment_id));
  END IF;

  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_payment(p_payment_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_payment record; v_bill record; v_new_paid_cents bigint;
  v_new_status text; v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can void vendor payments';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment FROM vendor_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.voided_at IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_ALREADY_VOIDED'; END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = v_payment.vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: parent vendor_bill of this payment is missing'; END IF;

  -- Vendor-liveness gate: serialize with delete_vendor.
  PERFORM 1 FROM vendors WHERE id = v_bill.vendor_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'VENDOR_DELETED: vendor % of this bill is soft-deleted; restore the vendor before voiding its payments',
      v_bill.vendor_id;
  END IF;

  PERFORM public._lock_accounting_months(ARRAY[v_payment.payment_date], false);
  PERFORM check_period_open(v_payment.payment_date);

  v_new_paid_cents := GREATEST(v_bill.paid_cents - v_payment.amount_cents, 0);
  v_new_status := CASE
    WHEN v_new_paid_cents = 0 THEN 'unpaid'
    WHEN v_new_paid_cents < v_bill.total_cents THEN 'partially_paid'
    ELSE 'paid' END;

  UPDATE vendor_bills SET paid_cents = v_new_paid_cents, status = v_new_status, updated_at = now()
    WHERE id = v_bill.id;

  UPDATE vendor_payments SET voided_at = now(), voided_by = v_actor, void_reason = p_reason
    WHERE id = p_payment_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description)
  VALUES ('vendor_payment_voided', 'vendor_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('amount_cents', v_payment.amount_cents,
      'bill_id', v_bill.id, 'bill_status_before', v_bill.status,
      'bill_paid_cents_before', v_bill.paid_cents),
    jsonb_build_object('voided_at', now()::text, 'void_reason', p_reason,
      'bill_status_after', v_new_status, 'bill_paid_cents_after', v_new_paid_cents),
    -1 * v_payment.amount_cents,
    'Voided vendor payment of $' || (v_payment.amount_cents / 100.0)::numeric(12,2) ||
    ' on bill — ' || p_reason);

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id)
  VALUES ('vendor_payment_voided',
    'Voided vendor payment $' || (v_payment.amount_cents / 100.0)::numeric(12,2) || ' — ' || p_reason,
    v_actor, 'vendor_payment', p_payment_id);

  v_result := jsonb_build_object('success', true, 'payment_id', p_payment_id,
    'bill_id', v_bill.id, 'voided_amount_cents', v_payment.amount_cents,
    'new_paid_cents', v_new_paid_cents, 'new_bill_status', v_new_status);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_vendor_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_bill(p_vendor_bill_id uuid, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bill record; v_actor uuid; v_actor_role text; v_existing jsonb; v_active_payments int;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to void vendor bills';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: void requires a reason string';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  IF v_bill.status = 'voided' THEN RAISE EXCEPTION 'BILL_ALREADY_VOIDED'; END IF;

  SELECT count(*) INTO v_active_payments
    FROM vendor_payments
   WHERE vendor_bill_id = p_vendor_bill_id AND voided_at IS NULL;

  IF v_active_payments > 0 THEN
    RAISE EXCEPTION
      'BILL_HAS_ACTIVE_PAYMENTS: bill has % active payment(s); void each payment first',
      v_active_payments;
  END IF;

  PERFORM public._lock_accounting_months(ARRAY[v_bill.bill_date], false);
  PERFORM check_period_open(v_bill.bill_date);

  UPDATE vendor_bills SET
    status = 'voided', voided_at = now(), voided_by = v_actor,
    void_reason = p_reason, updated_at = now()
  WHERE id = p_vendor_bill_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description)
  VALUES ('vendor_bill_voided', 'vendor_bill', p_vendor_bill_id, v_actor, v_actor_role,
    jsonb_build_object('status', v_bill.status),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -v_bill.total_cents,
    'Vendor bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_vendor_bill_id::text) ||
      ' voided: ' || p_reason);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_vendor_bill',
      jsonb_build_object('voided', true, 'bill_id', p_vendor_bill_id));
  END IF;
END;
$function$;

ALTER FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) OWNER TO postgres;
ALTER FUNCTION public.void_vendor_payment(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.void_vendor_bill(uuid, text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_vendor_payment(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_vendor_bill(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_vendor_payment(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_vendor_bill(uuid, text, text) TO authenticated, service_role;

-- Authenticated admins must use close_accounting_period/reopen_accounting_period.
-- Remove every browser-side table capability (including TRIGGER, REFERENCES,
-- and MAINTAIN), then restore authenticated read access. service_role and
-- metabase_ro retain their explicit operational/read grants deliberately.
REVOKE ALL PRIVILEGES ON TABLE public.accounting_periods FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.accounting_periods TO authenticated;

DROP POLICY IF EXISTS accounting_periods_insert_admin ON public.accounting_periods;
DROP POLICY IF EXISTS accounting_periods_update_admin ON public.accounting_periods;
DROP POLICY IF EXISTS accounting_periods_admin_delete ON public.accounting_periods;

DO $verify$
DECLARE
  v_name text;
  v_body text;
  v_prerequisite_pos integer;
  v_lock_pos integer;
  v_check_pos integer;
  v_mutation_pos integer;
  v_count integer;
  v_is_secdef boolean;
  v_owner text;
  v_search_path text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'record_vendor_payment',
    'void_vendor_payment',
    'void_vendor_bill'
  ]
  LOOP
    SELECT count(*)::integer,
           bool_and(p.prosecdef),
           min(r.rolname),
           min(array_to_string(p.proconfig, ', ')),
           min(p.prosrc)
      INTO v_count, v_is_secdef, v_owner, v_search_path, v_body
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_name;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'AP boundary verification: expected one public.% overload, found %',
        v_name, v_count;
    END IF;
    IF NOT v_is_secdef OR v_owner <> 'postgres' THEN
      RAISE EXCEPTION 'AP boundary verification: public.% owner/security drift (% / %)',
        v_name, v_owner, v_is_secdef;
    END IF;
    IF v_search_path NOT LIKE '%search_path=public, pg_temp%' THEN
      RAISE EXCEPTION 'AP boundary verification: public.% unsafe search_path (%)',
        v_name, v_search_path;
    END IF;

    v_lock_pos := strpos(v_body, '_lock_accounting_months');
    v_check_pos := strpos(v_body, 'check_period_open');
    CASE v_name
      WHEN 'record_vendor_payment' THEN
        v_prerequisite_pos := strpos(v_body, 'FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE');
        v_mutation_pos := strpos(v_body, 'INSERT INTO vendor_payments');
      WHEN 'void_vendor_payment' THEN
        v_prerequisite_pos := strpos(v_body, 'deleted_at IS NULL FOR UPDATE');
        v_mutation_pos := strpos(v_body, 'UPDATE vendor_bills SET');
      WHEN 'void_vendor_bill' THEN
        v_prerequisite_pos := strpos(v_body, 'IF v_active_payments > 0 THEN');
        v_mutation_pos := strpos(v_body, 'UPDATE vendor_bills SET');
    END CASE;
    IF v_prerequisite_pos = 0
       OR v_lock_pos = 0
       OR v_check_pos = 0
       OR v_mutation_pos = 0
       OR NOT (
         v_prerequisite_pos < v_lock_pos
         AND v_lock_pos < v_check_pos
         AND v_check_pos < v_mutation_pos
       ) THEN
      RAISE EXCEPTION
        'AP boundary verification: public.% must preserve prerequisite row locks, then month lock, period check, mutation',
        v_name;
    END IF;
  END LOOP;

  IF EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = ANY (ARRAY[
           'record_vendor_payment',
           'void_vendor_payment',
           'void_vendor_bill'
         ])
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege('anon', 'public.record_vendor_payment(uuid, bigint, date, text, text, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.record_vendor_payment(uuid, bigint, date, text, text, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_vendor_payment(uuid, bigint, date, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.void_vendor_payment(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_vendor_payment(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.void_vendor_payment(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.void_vendor_bill(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_vendor_bill(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.void_vendor_bill(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AP boundary verification: RPC execute ACL drift';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_class c
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
       WHERE c.oid = 'public.accounting_periods'::regclass
         AND acl.grantee = 0
     )
     OR has_table_privilege('anon', 'public.accounting_periods', 'SELECT')
     OR has_table_privilege('anon', 'public.accounting_periods', 'INSERT')
     OR has_table_privilege('anon', 'public.accounting_periods', 'UPDATE')
     OR has_table_privilege('anon', 'public.accounting_periods', 'DELETE')
     OR has_table_privilege('anon', 'public.accounting_periods', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.accounting_periods', 'REFERENCES')
     OR has_table_privilege('anon', 'public.accounting_periods', 'TRIGGER')
     OR has_table_privilege('anon', 'public.accounting_periods', 'MAINTAIN')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'INSERT')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'DELETE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'MAINTAIN') THEN
    RAISE EXCEPTION 'AP boundary verification: browser role retains direct period mutation privilege';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.accounting_periods', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.accounting_periods', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'AP boundary verification: intended period table access was lost';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.accounting_periods'::regclass
      AND polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'AP boundary verification: accounting_periods retains a browser write policy';
  END IF;
  IF NOT (
    SELECT c.relrowsecurity
    FROM pg_class c
    WHERE c.oid = 'public.accounting_periods'::regclass
  ) THEN
    RAISE EXCEPTION 'AP boundary verification: accounting_periods RLS was disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.accounting_periods'::regclass
      AND polname = 'accounting_periods_select_admin'
      AND polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'AP boundary verification: authenticated SELECT policy was lost';
  END IF;

  RAISE NOTICE 'AP boundary verification passed: three mutators serialize with close and direct browser writes are revoked.';
END;
$verify$;
