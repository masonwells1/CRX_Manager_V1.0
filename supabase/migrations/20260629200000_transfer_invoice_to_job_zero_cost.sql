-- 20260629200000_transfer_invoice_to_job_zero_cost.sql
--
-- Field-app parity P3 remediation (Wave 3): zero the internal COGS header on the
-- cancel path of transfer_invoice_to_job.
--
-- THE BUG (Codex P3, verified live)
-- transfer_invoice_to_job (orig migration 20260625120000) reverses a draft/unposted
-- field_application invoice back to its source job: it cancels the invoice, deletes
-- its invoice_items + invoice_shares, and zeroes the customer-facing money columns
-- (total_amount_cents / paid_amount_cents / prepay_applied_cents). But it left
-- invoices.total_cost_cents at the FORWARD value — so a cancelled, line-less invoice
-- kept a nonzero internal cost-of-goods header with no lines behind it. (Month-end is
-- unaffected — total_cost_cents is an internal COGS figure, not AR — but a cancelled-
-- invoice PDF would print a stale cost total.)
--
-- THE FIX
-- CREATE OR REPLACE the SAME function (one overload — verified), reproducing the body
-- faithfully (SECURITY DEFINER, SET search_path, role gate, strict actor, idempotency,
-- locks, guards, audit + activity rows), adding ONLY `total_cost_cents = 0` to the
-- cancel UPDATE alongside the other zeroed money columns. No behaviour change anywhere
-- else; the forward transfer (transfer_job_to_invoice) is untouched.
--
-- SAFETY: single overload confirmed (SELECT proname, count(*) ... = 1). Re-applies the
-- exact grants. Smoke: scripts/smoke/smoke-transfer-invoice-to-job.sql (#27 chain)
-- re-run after apply asserts the cancelled invoice now has total_cost_cents = 0 and the
-- forward re-transfer still works.

CREATE OR REPLACE FUNCTION public.transfer_invoice_to_job(
  p_invoice_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv RECORD;
  v_job RECORD;
  v_existing jsonb;
  v_result jsonb;
  v_actor_role text;
BEGIN
  -- Role gate (active admin/sales_rep) on the authenticated user.
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- Strict actor: the recorded performer must be the authenticated user
  -- (mirrors transfer_job_to_invoice / complete_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_invoice_to_job');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;

  IF v_inv.invoice_type IS DISTINCT FROM 'field_application' THEN
    RAISE EXCEPTION 'Only a field application invoice can be transferred back to a job';
  END IF;
  IF v_inv.job_id IS NULL THEN
    RAISE EXCEPTION 'This invoice was not created from a job, so it cannot be returned to scheduling';
  END IF;
  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Only a draft or unposted invoice can be returned to scheduling (status: %). Void the invoice first.', v_inv.status;
  END IF;

  -- Lock the source job and confirm it still owns this invoice (no race / double reverse).
  SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source job not found: %', v_inv.job_id; END IF;
  IF v_job.status <> 'invoiced' THEN
    RAISE EXCEPTION 'Source job % is no longer invoiced (status: %); cannot return this invoice to scheduling', v_job.job_number, v_job.status;
  END IF;
  IF v_job.invoice_id IS DISTINCT FROM p_invoice_id THEN
    RAISE EXCEPTION 'Source job % no longer points at this invoice; refusing to reverse', v_job.job_number;
  END IF;

  -- Detach the as-applied legal records from this invoice (inverse of the forward
  -- UPDATE application_records SET invoice_id = v_invoice_id ...).
  UPDATE application_records SET invoice_id = NULL
    WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;

  -- Tear down the invoice contents the forward transfer built.
  DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
  DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;

  -- Cancel the invoice (draft|unposted -> cancelled is an allowed transition; no override).
  -- total/paid/prepay are already 0 on a never-posted invoice; zero them defensively.
  -- total_cost_cents (the internal COGS header) is ALSO zeroed here (P3 remediation) so a
  -- cancelled, line-less invoice does not keep a stale forward cost total on its PDF.
  UPDATE invoices SET
    status = 'cancelled',
    void_reason = 'Returned to scheduling (job ' || v_job.job_number || ')',
    total_amount_cents = 0,
    paid_amount_cents = 0,
    prepay_applied_cents = 0,
    total_cost_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Return the job to 'completed' so it is editable / re-transferable. The reverse
  -- invoiced -> completed transition is only sanctioned via the admin-override GUC
  -- (SET LOCAL = transaction-scoped); RESET immediately after the single UPDATE.
  SET LOCAL app.admin_override = 'true';
  UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
  RESET app.admin_override;

  -- Append-only money ledger: record the cancellation (mirrors void_invoice's
  -- draft/unposted -> cancelled audit row), with the source-job provenance.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_cancelled', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'job_id', v_inv.job_id),
    jsonb_build_object('status', 'cancelled', 'reason', 'transfer_to_scheduling', 'job_id', v_inv.job_id),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Invoice ' || v_inv.invoice_number || ' returned to scheduling (job ' || v_job.job_number || ')'
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_transferred_to_scheduling',
    'Invoice ' || v_inv.invoice_number || ' returned to scheduling — job ' || v_job.job_number || ' reopened',
    COALESCE(p_performed_by, auth.uid()), 'job', v_inv.job_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'job_id', v_inv.job_id,
    'job_number', v_job.job_number,
    'invoice_status', 'cancelled',
    'job_status', 'completed'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_invoice_to_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Lock down execution: authenticated + service_role only (the in-body role gate is the
-- real boundary; this mirrors the forward transfer's grants and keeps anon off it).
REVOKE ALL ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.transfer_invoice_to_job(uuid, uuid, text) IS
  'Field-app parity #27: reverse of transfer_job_to_invoice. Returns a draft/unposted '
  'field_application invoice to its source job (invoice -> cancelled, items/shares deleted, '
  'application_records detached, job invoiced -> completed). Cancel path zeroes total_cost_cents '
  'too (P3 remediation). Admin/sales_rep, strict-actor, idempotent.';
