-- delete_invoices — soft-delete invoices through a guarded SECURITY DEFINER RPC.
--
-- Replaces the raw `.update({ deleted_at })` the UI issued from Invoices.tsx
-- (handleBatchDelete) and FieldApplicationInvoice.tsx (handleDelete), which had
-- no role/actor check at the DB layer and wrote NO financial_audit_log row
-- (nightly-debug finding frontend:Invoices:raw-softdelete-no-audit / item #9).
--
-- Soft-deletable statuses = draft / unposted / voided — the union of the two UI
-- gates (Invoices.tsx selectedDeletable = draft|voided; FieldApplicationInvoice
-- canEdit = draft|unposted). Posted / paid / overdue invoices are NOT deletable
-- (void them instead — batch_void_invoices). Non-deletable rows in the batch are
-- skipped, mirroring batch_void_invoices' CONTINUE. Modeled on batch_void_invoices
-- for actor binding, rate limit, canonical idempotency, and the FOR UPDATE lock —
-- BUT the role gate is require_admin() (admin-only), NOT require_admin_or_sales_rep().
-- Rationale: the live invoices_update / invoices_delete RLS policies are USING
-- (is_admin()), so today only admins can soft-delete an invoice (a sales_rep's raw
-- .update is RLS-blocked). This SECURITY DEFINER fn bypasses RLS, so it must
-- re-impose the SAME admin-only gate — widening delete to sales_reps would be an
-- unintended policy change. (Verified live 2026-06-16: both policies = is_admin().)
--
-- caller-analysis: delete_invoices :: NEW fn; UI callers (Invoices.tsx handleBatchDelete, FieldApplicationInvoice.tsx handleDelete) run as authenticated and are served by the GRANT below; the REVOKE only strips the implicit PUBLIC/anon grant, which has no legitimate caller.

CREATE OR REPLACE FUNCTION public.delete_invoices(
  p_invoice_ids uuid[],
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv        record;
  v_count      integer := 0;
  v_actor      uuid;
  v_actor_role text;
  v_existing   jsonb;
BEGIN
  PERFORM require_admin();  -- admin-only: matches invoices_update/invoices_delete RLS (is_admin())
  PERFORM check_rate_limit(auth.uid(), 'delete_invoices', 5, 60);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_invoices');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'deleted_count')::integer; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOR v_inv IN
    SELECT id, status, invoice_number, total_amount_cents
    FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Only draft / unposted / voided invoices are soft-deletable (matches the UI gates).
    IF v_inv.status NOT IN ('draft', 'unposted', 'voided') THEN CONTINUE; END IF;

    UPDATE invoices SET deleted_at = now() WHERE id = v_inv.id;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_deleted', 'invoice', v_inv.id, v_actor_role,
      jsonb_build_object(
        'status', v_inv.status,
        'invoice_number', v_inv.invoice_number,
        'total_amount_cents', v_inv.total_amount_cents
      ),
      jsonb_build_object('deleted_at', now()),
      0,
      'Soft-deleted invoice ' || v_inv.invoice_number || ' (status ' || v_inv.status || ')'
    );

    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_invoices', jsonb_build_object('deleted_count', v_count));
  END IF;

  RETURN v_count;
END;
$$;

-- Supabase default-grants EXECUTE to anon AND authenticated on new public
-- functions, so PUBLIC alone is not enough — anon holds a direct grant. Revoke
-- both PUBLIC and anon to keep this off the anon-executable-SECDEF sweep (53 baseline).
REVOKE ALL ON FUNCTION public.delete_invoices(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_invoices(uuid[], uuid, text) TO authenticated;
