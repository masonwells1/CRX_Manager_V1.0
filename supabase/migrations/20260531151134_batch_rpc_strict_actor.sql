-- idempotency-body-check: exempt  (uses check_idempotency/save_idempotency helpers)
--
-- 2026-05-31 — Batch-RPC strict-actor hardening (post-Codex review follow-up).
--
-- Codex's 2026-05-31 pre-push review + an independent live re-check confirmed two
-- HIGH actor-forgery findings: batch_apply_all_prepayments and batch_void_invoices
-- derived v_actor := COALESCE(p_performed_by, auth.uid()) with NO ACTOR_MISMATCH
-- check, so an authenticated admin/sales_rep could pass another user's UUID as
-- p_performed_by and mis-attribute immutable financial_audit_log rows (and, for the
-- prepay batch, apply_remaining_prepayments' actor_user_id) to that user.
--
-- This replaces ONLY the actor-derivation line in each function with the project's
-- canonical strict-actor block (identical to 20260530020412_reverse_write_off_strict_actor).
-- Every other line is byte-faithful to the live function definition (introspected
-- 2026-05-31). require_admin_or_sales_rep() still gates the caller's role.
-- See docs/audits/2026-05-31-codex-review-verification-and-followup.md.

CREATE OR REPLACE FUNCTION public.batch_apply_all_prepayments(p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cust       record;
  v_result     jsonb;
  v_details    jsonb := '[]'::jsonb;
  v_total_customers integer := 0;
  v_total_applied   bigint  := 0;
  v_actor      uuid;
  v_existing   jsonb;
  v_final      jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();
  PERFORM check_rate_limit(auth.uid(), 'batch_apply_all_prepayments', 5, 60);
  -- 2026-05-31 strict-actor hardening (post-Codex): replaces the forgeable
  -- COALESCE(p_performed_by, auth.uid()). See 20260530020412.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- P2-3: idempotency — check before any mutation (after authz/rate-limit).
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_apply_all_prepayments');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  FOR v_cust IN
    SELECT c.id, c.farm_name, c.prepay_balance_cents
    FROM customers c
    WHERE c.prepay_balance_cents > 0
      AND c.is_active = true
      AND EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.customer_id = c.id
          AND i.status = 'posted'
          AND i.balance_cents > 0
          AND i.deleted_at IS NULL
      )
    ORDER BY c.farm_name
    FOR UPDATE OF c
  LOOP
    v_result := apply_remaining_prepayments(v_cust.id, v_actor);

    IF (v_result->>'applied_cents')::bigint > 0 THEN
      v_total_customers := v_total_customers + 1;
      v_total_applied := v_total_applied + (v_result->>'applied_cents')::bigint;
      v_details := v_details || jsonb_build_object(
        'customer_id', v_cust.id,
        'farm_name', v_cust.farm_name,
        'applied_count', (v_result->>'applied_count')::integer,
        'applied_cents', (v_result->>'applied_cents')::bigint,
        'remaining_prepay_cents', (v_result->>'remaining_prepay_cents')::bigint
      );
    END IF;
  END LOOP;

  -- P2-3 bugfix: the live body inserted entity_id = NULL here, but
  -- financial_audit_log.entity_id is NOT NULL — so EVERY call failed (0 rows
  -- ever written; the "Apply all prepayments" button was silently broken). A
  -- batch spans all customers (no single entity), so attribute the summary row
  -- to the operator: entity_type 'batch' (a CHECK-valid value), entity_id =
  -- the admin who ran it.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'batch_prepay_apply', 'batch', v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('total_customers_checked', (
      SELECT count(*) FROM customers WHERE prepay_balance_cents > 0 AND is_active = true
    )),
    jsonb_build_object('total_customers_applied', v_total_customers, 'total_applied_cents', v_total_applied),
    v_total_applied,
    'Batch applied prepayments: ' || v_total_customers || ' customer(s), ' ||
      '$' || ROUND(v_total_applied / 100.0, 2) || ' total'
  );

  v_final := jsonb_build_object(
    'total_customers', v_total_customers,
    'total_applied_cents', v_total_applied,
    'details', v_details
  );

  -- P2-3: persist result for replay.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_apply_all_prepayments', v_final);
  END IF;

  RETURN v_final;
END;
$function$;

CREATE OR REPLACE FUNCTION public.batch_void_invoices(p_invoice_ids uuid[], p_void_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv       record;
  v_count     integer := 0;
  v_actor     uuid;
  v_actor_role text;
  v_existing  jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();
  PERFORM check_rate_limit(auth.uid(), 'batch_void_invoices', 5, 60);
  -- 2026-05-31 strict-actor hardening (post-Codex): replaces the forgeable
  -- COALESCE(p_performed_by, auth.uid()). See 20260530020412.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  -- P2-3: idempotency — check before any mutation (after authz/rate-limit).
  -- Result stored as jsonb {voided_count}; cached integer read back below.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_void_invoices');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'voided_count')::integer; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  -- Delegate to void_invoice for each posted invoice to get full reversal logic
  FOR v_inv IN
    SELECT id, status FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id FOR UPDATE
  LOOP
    IF v_inv.status <> 'posted' THEN CONTINUE; END IF;

    -- void_invoice handles: allocation reversal, prepay restore, write-off reversal,
    -- total zeroing, order balance update, audit log, activity feed, admin notifications
    PERFORM void_invoice(v_inv.id, p_void_reason);

    v_count := v_count + 1;
  END LOOP;

  -- Batch summary audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'batch_void', 'invoice', p_invoice_ids[1], v_actor_role,
    jsonb_build_object('invoice_count', array_length(p_invoice_ids, 1)),
    jsonb_build_object('voided_count', v_count, 'void_reason', p_void_reason),
    0, 'Batch voided ' || v_count || ' invoice(s) — ' || p_void_reason
  );

  -- P2-3: persist result for replay.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_void_invoices', jsonb_build_object('voided_count', v_count));
  END IF;

  RETURN v_count;
END;
$function$;
