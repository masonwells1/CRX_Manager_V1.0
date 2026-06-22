-- 20260622010000_fix_generate_finance_charges_draft_insert.sql
--
-- OVERNIGHT BUG HUNT cycle 1, finding #1 (HIGH, both adversarial-verifier + Codex confirmed).
-- dedupeKey: invoices:generate_finance_charges:unposted-insert-blocked-by-draft-trigger
--
-- WHAT WAS WRONG
-- generate_finance_charges inserted the misc_charge invoice with status='unposted'.
-- The BEFORE INSERT trigger trg_invoice_draft_insert -> enforce_invoice_draft_on_insert()
-- raises on ANY non-'draft', non-'credit_memo' insert:
--     IF NEW.status <> 'draft' AND NEW.invoice_type <> 'credit_memo' THEN RAISE ...
-- A finance charge is status='unposted' AND invoice_type='misc_charge', so the insert
-- ALWAYS raised and the whole batch aborted on the first qualifying customer. The entire
-- finance-charge (interest on overdue AR) feature was dead on first use
-- (SELECT count(*) FROM finance_charges = 0 — it has never succeeded).
--
-- THE FIX (mirrors the sibling RPC transfer_job_to_invoice, which was patched for this
-- IDENTICAL trigger collision in 20260611002255 / 20260619140000): insert the invoice as
-- status='draft' (satisfies the trigger), build its item / finance_charges / audit rows,
-- then UPDATE status -> 'unposted'. draft->unposted is explicitly allowed by
-- _enforce_invoice_status_transition (verified live: OLD='draft' AND NEW IN
-- ('unposted','posted','cancelled')). Net end state is identical to the original intent
-- (a finance-charge invoice at 'unposted'), but it can now actually be created.
--
-- Only TWO lines change vs the live body: (1) the INSERT status literal 'unposted'->'draft',
-- (2) a new "UPDATE invoices SET status='unposted'" after the child rows are built. Everything
-- else is reproduced verbatim from the live function body.
--
-- ROLLBACK: re-apply the previous definition (status='unposted' in the INSERT, no flip) by
-- reverting the two marked OVERNIGHT FIX changes below.

CREATE OR REPLACE FUNCTION public.generate_finance_charges(p_as_of_date date, p_performed_by uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[], p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_min_balance bigint;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_finance_charges');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('generate_finance_charges:' || p_as_of_date::text));
  PERFORM public.check_period_open(p_as_of_date);

  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  FOR v_customer IN
    SELECT c.id AS customer_id, c.farm_name, c.finance_charge_rate,
           COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
           COALESCE(sum(i.balance_cents), 0) AS overdue_balance
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.invoice_type != 'misc_charge'
        AND i.due_date IS NOT NULL
        AND i.due_date < (p_as_of_date - (COALESCE(c.finance_charge_grace_days, 0) || ' days')::interval)
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
        AND COALESCE(c.finance_charge_enabled, true) = true
        AND (p_customer_ids IS NULL OR c.id = ANY(p_customer_ids))
      GROUP BY c.id, c.farm_name, c.finance_charge_rate, c.finance_charge_grace_days
      HAVING sum(i.balance_cents) >= v_min_balance
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.finance_charges
      WHERE customer_id = v_customer.customer_id
        AND period_end = p_as_of_date
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      v_inv_num := next_invoice_number('misc_charge');

      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents,
        header_notes, season, created_by
      ) VALUES (
        -- OVERNIGHT FIX (finding #1): insert as 'draft' — the BEFORE INSERT trigger
        -- rejects any non-draft, non-credit_memo insert. Flipped to 'unposted' below
        -- once the item / finance_charges / audit rows are built. Live literal was 'unposted'.
        v_inv_num, v_customer.customer_id, 'misc_charge', 'draft', p_as_of_date,
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') ||
        CASE WHEN v_customer.grace_days > 0
             THEN ' (after ' || v_customer.grace_days || ' day grace period)'
             ELSE '' END,
        CASE WHEN extract(month FROM p_as_of_date) >= 10
             THEN extract(year FROM p_as_of_date)::integer + 1
             ELSE extract(year FROM p_as_of_date)::integer END,
        v_actor
      ) RETURNING id INTO v_invoice_id;

      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, is_application_fee, sort_order
      ) VALUES (
        v_invoice_id,
        'Finance Charge - ' || v_customer.finance_charge_rate || '% annual rate on overdue balance',
        1, v_charge_amount, v_charge_amount,
        0, false, 1
      );

      INSERT INTO public.finance_charges (
        customer_id, invoice_id, amount_cents, charge_rate,
        base_amount_cents, period_start, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.finance_charge_rate, v_customer.overdue_balance,
        (p_as_of_date - interval '30 days')::date, p_as_of_date,
        v_actor
      );

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge', 'invoice', v_invoice_id,
        v_actor, v_charge_amount,
        'Finance charge generated for ' || v_customer.farm_name ||
        ': $' || to_char(v_charge_amount / 100.0, 'FM999,999,990.00') ||
        ' at ' || v_customer.finance_charge_rate || '% on $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') || ' overdue'
      );

      -- OVERNIGHT FIX (finding #1): now that the invoice and its child rows are fully
      -- built, flip draft -> unposted (the original intended end state). Allowed by
      -- _enforce_invoice_status_transition (draft -> unposted).
      UPDATE public.invoices SET status = 'unposted' WHERE id = v_invoice_id;

      v_count := v_count + 1;
      v_charges := v_charges || jsonb_build_object(
        'customer', v_customer.farm_name,
        'base_balance_cents', v_customer.overdue_balance,
        'charge_cents', v_charge_amount,
        'rate', v_customer.finance_charge_rate,
        'invoice_number', v_inv_num,
        'grace_days', v_customer.grace_days
      );
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'charges_generated', v_count,
    'skipped_already_charged', v_skipped,
    'details', v_charges
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_finance_charges', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
