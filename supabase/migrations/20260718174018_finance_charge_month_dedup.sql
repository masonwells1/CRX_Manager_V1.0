-- H2 (Live Foundation Gauntlet 2026-07-18) — generate_finance_charges could
-- double-charge the same overdue balance.
--
-- The per-customer dedup skipped a customer only when a finance_charges row
-- already existed with period_end = EXACTLY p_as_of_date. Running the generator
-- twice in the same month on different as-of dates (e.g. the 15th and the 18th)
-- therefore charged the same overdue invoices twice — a full extra month of
-- interest — because period_end differed. A monthly finance charge must be
-- assessed at most once per customer per calendar month.
--
-- Safe fix: broaden the dedup to the calendar month —
--   date_trunc('month', period_end) = date_trunc('month', p_as_of_date)
-- so a second run in the same month skips (v_skipped++), while a genuinely
-- new month (e.g. Jul 31 then Aug 1) still charges. Same-date idempotent
-- replay is unaffected (the p_idempotency_key short-circuit still returns the
-- cached result before the loop). A DB-level unique index was considered but
-- rejected as the primary guard: duplicate charges may already exist in prod,
-- so a hard constraint could fail on apply — the function guard is the safe
-- practical prevention. Body otherwise reproduced verbatim from the live
-- catalog; only the dedup predicate changed.

-- Historical migrations created shorter overloads before the canonical
-- four-argument signature replaced them. They are absent from live production,
-- but dropping them defensively keeps replays from retaining stale behavior.
DROP FUNCTION IF EXISTS public.generate_finance_charges(date, uuid);
DROP FUNCTION IF EXISTS public.generate_finance_charges(date, uuid, uuid[]);

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

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CHARGE_DATE_REQUIRED';
  END IF;
  IF p_as_of_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'FUTURE_FINANCE_CHARGE_DATE: finance charges cannot be generated for a future business date';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_finance_charges');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- H2 fix: key the serialization lock on the MONTH, not the exact as-of date,
  -- so two concurrent runs in the same month (different as-of dates) serialize
  -- and the second sees the first's committed charge — matching the month-level
  -- dedup below. (Keying on the date let them take different locks and both pass
  -- the EXISTS check before either inserted — the double-charge this fixes.)
  PERFORM pg_advisory_xact_lock(hashtext('generate_finance_charges:' || to_char(p_as_of_date, 'YYYY-MM')));
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
    -- H2 fix: dedup on the CALENDAR MONTH, not the exact as-of date. Two runs
    -- in the same month (different as-of dates) must not both charge the same
    -- overdue balance; a genuinely new month still charges.
    IF EXISTS (
      SELECT 1 FROM public.finance_charges
      WHERE customer_id = v_customer.customer_id
        AND date_trunc('month', period_end) = date_trunc('month', p_as_of_date)
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

REVOKE EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text) TO authenticated, service_role;
