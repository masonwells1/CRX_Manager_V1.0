-- idempotency-body-check: exempt  (uses check_idempotency/save_idempotency helpers)
--
-- ─── PROVENANCE: recovered from live 2026-05-30 ─────────────────────────────
-- This file was applied LIVE as migration version 20260530192441 but had no
-- disk file (a "live-only correction"). It is recovered here verbatim from
-- supabase_migrations.schema_migrations so the disk migration list matches the
-- live version list exactly (no phantom live-only version → avoids the B7-class
-- re-apply drift the project guards against).
--
-- History: 20260530191823_batch_rpc_idempotency first applied this function with
-- audit entity_type 'system', which violates financial_audit_log_entity_type_check;
-- a post-apply smoke test caught it and this stamp (20260530192441) re-applied the
-- function with the CHECK-valid 'batch'. The committed 20260530191823 disk file
-- already encodes the final 'batch' state for single-file clarity, so on a fresh
-- replay this CREATE OR REPLACE is idempotent (re-asserts the identical body).
-- Only batch_apply_all_prepayments changes; re-stated in full for clarity.
-- ────────────────────────────────────────────────────────────────────────────

-- P2-3 correction: entity_type 'system' (CHECK-invalid) -> 'batch' in the
-- batch_apply_all_prepayments audit summary row. (Supersedes the earlier apply
-- which used 'system' and would still have failed the entity_type CHECK.)
-- Only batch_apply_all_prepayments changes; re-stated here in full for clarity.

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
  v_actor := COALESCE(p_performed_by, auth.uid());

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
