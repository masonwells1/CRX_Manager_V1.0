-- 20260625130000_unpost_invoice.sql
--
-- Field-app parity #28 (POST and UNPOST on the field-app invoice screen) — the UNPOST leg.
--
-- WHAT THIS ADDS
-- unpost_invoice(p_invoice_id, p_performed_by, p_idempotency_key): the inverse of
-- post_invoice. ChemMan's Posted list has an "Unpost All" action and an individual
-- unpost path (open a posted invoice -> Unpost -> it returns to the Unposted list).
-- post_invoice existed (20260614144252) and was wired to a button; NO unpost RPC
-- existed anywhere (grep: only the 'unposted' status string, no unpost_invoice in
-- src or migrations), so the Posted list's "Unpost All" was an honest info-toast
-- placeholder and there was no post->unpost round-trip. This closes that gap.
--
-- WHAT IT DOES (the exact inverse of post_invoice's status flag)
--   post_invoice:  draft|unposted -> posted, stamps posted_by/posted_at,
--                  check_period_open(invoice_date), audit 'invoice_posted'.
--   unpost_invoice: posted|overdue -> unposted, clears posted_by/posted_at,
--                  check_period_open(invoice_date), audit 'invoice_unposted'.
-- It deliberately touches ONLY the posting status + posted_* stamps. It does NOT
-- recompute money, delete RUP records, or re-open any allocation — see below.
--
-- PRECONDITIONS / HONEST ERRORS (no fake success, no silent money loss):
--   * caller must be an active admin or sales_rep (role gate on auth.uid()), and
--     p_performed_by must match auth.uid() (strict actor — mirrors post_invoice_group /
--     transfer_invoice_to_job). post_invoice allows admin+sales_rep, so unpost does too.
--   * invoice must exist and be 'posted' or 'overdue'. A 'draft'/'unposted' invoice is
--     not posted (nothing to reverse); a 'paid' invoice has payment fully applied; a
--     'voided'/'cancelled' invoice is terminal. All raise a plain-English exception.
--   * MONEY GUARD — refuse if ANY money is attached to the invoice: a row in
--     invoice_line_allocations (a recorded payment allocated to it) OR a row in
--     prepay_applications (prepay applied to it) OR a non-zero paid_amount_cents /
--     prepay_applied_cents / write_off_cents header value. Unposting is meant to undo
--     an accidental/early posting on a still-unpaid bill; if money has landed on it the
--     user must un-apply the payment(s)/prepay/write-off FIRST (or void instead). This
--     keeps the money ledger and the invoice header in lock-step — unpost never
--     orphans an allocation pointing at a now-unposted invoice.
--   * PERIOD GUARD — check_period_open(invoice_date): if the invoice's month-end batch
--     is CLOSED, refuse (the same guard post_invoice and void_invoice's posted path use).
--     We never silently mutate a posted record inside a closed accounting period; the
--     admin must reopen the period first.
--
-- WHY THE ADMIN-OVERRIDE GUC ON THE INVOICE UPDATE
-- _enforce_invoice_status_transition() (20260616120604) whitelists posted ->
-- {voided, paid, overdue} and overdue -> {paid, voided} — it does NOT include the
-- reverse posted|overdue -> unposted (a committed invoice must not silently
-- un-post via a raw .update()). The enforcer's only sanctioned escape hatch is
-- _is_admin_override() (current_setting('app.admin_override')='true'). post_invoice
-- itself brackets its status write with this GUC; this RPC is the ONE sanctioned,
-- audited caller of the REVERSE, so it sets the GUC transaction-scoped (set_config
-- '...',true = auto-cleared at COMMIT/ROLLBACK) around the single invoice UPDATE only,
-- then resets it immediately. The enforcer is left UNCHANGED (no widening of the
-- whitelist) — the override is the minimal, transaction-local, audited hatch, matching
-- the #27 transfer_invoice_to_job pattern.
--
-- WHY NO RUP / ALLOCATION CLEANUP
-- post_invoice calls generate_rup_sales_records, but that function early-returns 0 for a
-- field_application invoice (it JOINs orders, which a job-built field invoice has none of)
-- and otherwise de-dups per (invoice_id, product_id) via NOT EXISTS, so a re-post is a
-- no-op on already-recorded RUP rows. RUP sales records are an append-only legal/
-- compliance trail (a restricted-use-pesticide sale DID happen at post time); unposting
-- the bill does not unsell the chemical, so we intentionally leave them. And because the
-- money guard above refuses any invoice that carries allocations/prepay/write-off, there
-- is never an allocation to reverse here — that is what void_invoice (with its full
-- reversal path) is for.
--
-- IDEMPOTENCY: canonical idempotency_keys via check_idempotency / save_idempotency,
-- scoped to operation='unpost_invoice' (a replay returns the saved result and mutates
-- nothing — no 2nd audit row). SECURITY DEFINER + SET search_path = public, pg_temp.
--
-- ALSO: adds 'invoice_unposted' to the financial_audit_log.operation_type CHECK so the
-- unpost audit row is a distinct, honest operation type. STRICT SUPERSET — it only ADDS
-- one value; every existing value is preserved, so no existing audit insert can break.
-- Reviewed against live: financial_audit_log entity_type already includes 'invoice'.

-- ── 1. financial_audit_log.operation_type CHECK — additive superset ─────────
-- Drop + recreate the CHECK with the existing values PLUS 'invoice_unposted'. The
-- full existing list is reproduced verbatim (read live before writing) so nothing
-- is removed. Idempotent: only re-adds if our value is not already present.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.financial_audit_log'::regclass
     AND conname  = 'financial_audit_log_operation_type_check';

  IF v_def IS NOT NULL AND position('invoice_unposted' in v_def) = 0 THEN
    ALTER TABLE public.financial_audit_log
      DROP CONSTRAINT financial_audit_log_operation_type_check;
    ALTER TABLE public.financial_audit_log
      ADD CONSTRAINT financial_audit_log_operation_type_check CHECK (operation_type = ANY (ARRAY[
        'invoice_created','invoice_posted','invoice_unposted','invoice_voided','invoice_cancelled',
        'invoice_updated','invoice_deleted','invoice_marked_overdue','payment_recorded','payment_allocation',
        'payment_voided','payment_allocated','split_modified','split_invoices_generated','prepay_created',
        'prepay_applied','prepay_credit_created','prepay_batch_applied','prepay_edited','prepay_deleted',
        'prepay_reconciliation','batch_prepay_apply','write_off_recorded','write_off_reversed','write_off_applied',
        'finance_charge','finance_charge_generated','finance_charge_voided','credit_memo_created','credit_memo_applied',
        'credit_memo_unapplied','return_created','return_approved','return_received','return_credit_issued',
        'order_created','order_updated','order_voided','order_cancelled','order_restored','delivery_created',
        'delivery_updated','delivery_cancelled','delivery_voided','delivery_restored','quote_converted',
        'blend_ticket_linked','blend_ticket_unlinked','commission_payment_created','commission_payment_posted',
        'commission_payment_voided','batch_post','batch_void','batch_payment','period_reopened','quote_status_reverted',
        'blend_ticket_approval_reversed','cycle_count_completed','vendor_bill_created','vendor_bill_voided',
        'vendor_bill_updated','vendor_payment_recorded','vendor_payment_voided'
      ]));
  END IF;
END $$;

-- ── 2. unpost_invoice() — the reverse of post_invoice ───────────────────────
CREATE OR REPLACE FUNCTION public.unpost_invoice(
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
  v_actor_role text;
  v_existing jsonb;
  v_result jsonb;
  v_alloc_count int := 0;
  v_prepay_count int := 0;
BEGIN
  -- Role gate (active admin/sales_rep) on the authenticated user. post_invoice allows
  -- both roles to post, so unpost matches it.
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- Strict actor: the recorded performer must be the authenticated user.
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'unpost_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;

  -- Status guard: only a posted/overdue invoice can be unposted. Honest refusals
  -- for every other state (never unpost a paid/voided/cancelled/draft/unposted one).
  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    IF v_inv.status IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Invoice % is not posted (status: %); there is nothing to unpost', v_inv.invoice_number, v_inv.status;
    ELSE
      RAISE EXCEPTION 'Cannot unpost a % invoice (%). Only a posted, unpaid invoice can be returned to the Unposted list.', v_inv.status, v_inv.invoice_number;
    END IF;
  END IF;

  -- MONEY GUARD: refuse if any payment/prepay/write-off has landed on this invoice.
  -- Unposting only undoes the posting flag on a still-unpaid bill; if money is applied
  -- the user must un-apply it first (or void the invoice instead). This keeps the money
  -- ledger and the invoice header consistent — unpost never strands an allocation.
  SELECT count(*) INTO v_alloc_count FROM invoice_line_allocations WHERE invoice_id = p_invoice_id;
  SELECT count(*) INTO v_prepay_count FROM prepay_applications     WHERE invoice_id = p_invoice_id;
  IF v_alloc_count > 0
     OR v_prepay_count > 0
     OR COALESCE(v_inv.paid_amount_cents, 0)    <> 0
     OR COALESCE(v_inv.prepay_applied_cents, 0) <> 0
     OR COALESCE(v_inv.write_off_cents, 0)      <> 0
  THEN
    RAISE EXCEPTION 'Cannot unpost invoice % — it has payments, prepay, or write-offs applied. Unallocate those first (or void the invoice instead).', v_inv.invoice_number;
  END IF;

  -- PERIOD GUARD: never mutate a posted record inside a closed accounting period.
  -- Same guard post_invoice / void_invoice's posted path use. Reopen the period first.
  PERFORM check_period_open(v_inv.invoice_date);

  -- Reverse the posting flag. posted|overdue -> unposted is NOT in the status-transition
  -- whitelist, so bracket ONLY this single UPDATE with the transaction-local admin
  -- override (set_config '...', true = auto-cleared at COMMIT/ROLLBACK), then reset.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE invoices SET
    status      = 'unposted',
    posted_by   = NULL,
    posted_at   = NULL,
    updated_at  = now()
  WHERE id = p_invoice_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- Append-only money ledger: mirror the 'invoice_posted' entry with its inverse.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_unposted', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'posted_at', v_inv.posted_at),
    jsonb_build_object('status', 'unposted', 'unposted_at', now()::text),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Unposted ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — $' || (COALESCE(v_inv.total_amount_cents,0) / 100.0)::numeric(12,2)
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_unposted',
    'Unposted invoice ' || v_inv.invoice_number || ' — returned to the Unposted list',
    COALESCE(p_performed_by, auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'invoice_number', v_inv.invoice_number,
    'previous_status', v_inv.status,
    'status', 'unposted'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unpost_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Lock down execution: authenticated + service_role only (the in-body role gate is the
-- real boundary; this mirrors post_invoice_group / transfer_invoice_to_job and keeps anon off it).
REVOKE ALL ON FUNCTION public.unpost_invoice(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unpost_invoice(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unpost_invoice(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.unpost_invoice(uuid, uuid, text) IS
  'Field-app parity #28: reverse of post_invoice. Returns a posted/overdue invoice with NO '
  'payments/prepay/write-off applied to ''unposted'' (clears posted_by/posted_at), respecting '
  'check_period_open. Admin/sales_rep, strict-actor, idempotent, append-only audit (invoice_unposted).';
