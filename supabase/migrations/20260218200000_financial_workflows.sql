-- Sprint 11: Financial Workflows
-- New columns on customers: credit_limit_cents, finance_charge_rate
-- New tables: write_offs, finance_charges
-- New RPCs: apply_write_off, generate_finance_charges, get_customer_transaction_review, apply_remaining_prepayments

-- ─── Add credit limit and finance charge fields to customers ─────────────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS credit_limit_cents bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finance_charge_rate numeric DEFAULT 0;

-- ─── write_offs table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.write_offs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES public.invoices(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason      text NOT NULL,
  approved_by uuid REFERENCES public.profiles(id),
  created_by  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.write_offs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "write_offs_select_admin"
  ON public.write_offs FOR SELECT
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "write_offs_insert_admin"
  ON public.write_offs FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE INDEX IF NOT EXISTS idx_write_offs_invoice ON public.write_offs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_write_offs_customer ON public.write_offs(customer_id);

-- ─── finance_charges table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES public.customers(id),
  invoice_id       uuid REFERENCES public.invoices(id), -- the generated charge invoice
  amount_cents     bigint NOT NULL,
  charge_rate      numeric NOT NULL,
  base_amount_cents bigint NOT NULL,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  created_by       uuid REFERENCES public.profiles(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "finance_charges_select_admin"
  ON public.finance_charges FOR SELECT
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "finance_charges_insert_admin"
  ON public.finance_charges FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE INDEX IF NOT EXISTS idx_finance_charges_customer ON public.finance_charges(customer_id);

-- ─── apply_write_off ─────────────────────────────────────────────────────────
-- Reduces invoice balance by write-off amount, creates record
CREATE OR REPLACE FUNCTION public.apply_write_off(
  p_invoice_id   uuid,
  p_amount_cents bigint,
  p_reason       text,
  p_performed_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice record;
  v_wo_id uuid;
BEGIN
  -- Lock invoice
  SELECT id, customer_id, balance_cents, status
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.status != 'posted' THEN
    RAISE EXCEPTION 'Can only write off posted invoices (current status: %)', v_invoice.status;
  END IF;

  IF p_amount_cents > v_invoice.balance_cents THEN
    RAISE EXCEPTION 'Write-off amount (%) exceeds balance (%)',
      p_amount_cents, v_invoice.balance_cents;
  END IF;

  -- Create write-off record
  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, approved_by, created_by)
  VALUES (p_invoice_id, v_invoice.customer_id, p_amount_cents, p_reason, p_performed_by, p_performed_by)
  RETURNING id INTO v_wo_id;

  -- Reduce invoice balance
  UPDATE public.invoices
     SET balance_cents = balance_cents - p_amount_cents,
         updated_at = now()
   WHERE id = p_invoice_id;

  RETURN v_wo_id;
END;
$$;

-- ─── generate_finance_charges ────────────────────────────────────────────────
-- Calculates interest on overdue invoices, creates misc_charge invoices
CREATE OR REPLACE FUNCTION public.generate_finance_charges(
  p_as_of_date   date,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
BEGIN
  FOR v_customer IN
    SELECT c.id AS customer_id, c.farm_name, c.finance_charge_rate,
           COALESCE(sum(i.balance_cents), 0) AS overdue_balance
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status = 'posted'
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.due_date IS NOT NULL
        AND i.due_date < p_as_of_date
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
      GROUP BY c.id, c.farm_name, c.finance_charge_rate
      HAVING sum(i.balance_cents) > 0
  LOOP
    -- Monthly rate = annual rate / 12
    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      -- Generate invoice number for finance charge
      PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
      SELECT 'FC-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
             lpad((COALESCE(MAX(regexp_replace(invoice_number, '^FC-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
        INTO v_inv_num
        FROM public.invoices
       WHERE invoice_number LIKE 'FC-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

      -- Create misc_charge invoice for the finance charge
      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents, balance_cents,
        header_notes, season, created_by
      ) VALUES (
        v_inv_num, v_customer.customer_id, 'misc_charge', 'unposted', p_as_of_date,
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0, v_charge_amount,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of ' ||
        (v_customer.overdue_balance / 100.0)::text,
        CASE WHEN extract(month FROM p_as_of_date) >= 7
             THEN extract(year FROM p_as_of_date)::integer
             ELSE extract(year FROM p_as_of_date)::integer - 1 END,
        p_performed_by
      ) RETURNING id INTO v_invoice_id;

      -- Create finance charge record
      INSERT INTO public.finance_charges (
        customer_id, invoice_id, amount_cents, charge_rate,
        base_amount_cents, period_start, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.finance_charge_rate, v_customer.overdue_balance,
        (p_as_of_date - interval '30 days')::date, p_as_of_date,
        p_performed_by
      );

      v_count := v_count + 1;
      v_charges := v_charges || jsonb_build_object(
        'customer', v_customer.farm_name,
        'base_balance_cents', v_customer.overdue_balance,
        'charge_cents', v_charge_amount,
        'rate', v_customer.finance_charge_rate,
        'invoice_number', v_inv_num
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'charges_generated', v_count,
    'details', v_charges
  );
END;
$$;

-- ─── get_customer_transaction_review ─────────────────────────────────────────
-- Full history: invoices, payments, prepays, finance charges, write-offs, running balance
CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(
  p_customer_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS TABLE (
  transaction_date date,
  transaction_type text,
  reference_number text,
  description text,
  debit_cents bigint,
  credit_cents bigint,
  running_balance_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH all_transactions AS (
    -- Invoices (debits)
    SELECT i.invoice_date AS tx_date,
           'Invoice' AS tx_type,
           i.invoice_number AS ref_num,
           CASE i.invoice_type
             WHEN 'chemical_sale' THEN 'Chemical Sale'
             WHEN 'field_application' THEN 'Field Application'
             WHEN 'misc_charge' THEN 'Misc Charge'
             ELSE i.invoice_type
           END AS descr,
           i.total_amount_cents AS debit,
           0::bigint AS credit
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status = 'posted'
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Payments (credits)
    SELECT p.payment_date AS tx_date,
           'Payment' AS tx_type,
           p.reference_number AS ref_num,
           COALESCE(p.payment_method, 'Payment') || COALESCE(' — ' || p.notes, '') AS descr,
           0::bigint AS debit,
           p.amount_cents AS credit
      FROM public.payments p
      INNER JOIN public.invoices i ON i.id = p.invoice_id
     WHERE i.customer_id = p_customer_id
       AND p.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Write-offs (credits)
    SELECT w.created_at::date AS tx_date,
           'Write-Off' AS tx_type,
           'WO' AS ref_num,
           w.reason AS descr,
           0::bigint AS debit,
           w.amount_cents AS credit
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date AS transaction_date,
         t.tx_type AS transaction_type,
         t.ref_num AS reference_number,
         t.descr AS description,
         t.debit AS debit_cents,
         t.credit AS credit_cents,
         sum(t.debit - t.credit) OVER (ORDER BY t.tx_date, t.tx_type) AS running_balance_cents
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type;
END;
$$;

-- ─── apply_remaining_prepayments ─────────────────────────────────────────────
-- Auto-applies prepay credits to oldest unpaid invoices
CREATE OR REPLACE FUNCTION public.apply_remaining_prepayments(
  p_customer_id  uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_available bigint;
  v_invoice record;
  v_apply bigint;
  v_applied_total bigint := 0;
  v_count integer := 0;
BEGIN
  -- Get available prepay balance
  SELECT COALESCE(c.prepay_balance_cents, 0)
    INTO v_available
    FROM public.customers c
   WHERE c.id = p_customer_id
     FOR UPDATE;

  IF v_available <= 0 THEN
    RETURN jsonb_build_object('applied_count', 0, 'applied_cents', 0, 'message', 'No prepay balance available');
  END IF;

  -- Apply to oldest unpaid invoices first
  FOR v_invoice IN
    SELECT id, invoice_number, balance_cents
      FROM public.invoices
     WHERE customer_id = p_customer_id
       AND status = 'posted'
       AND balance_cents > 0
       AND deleted_at IS NULL
     ORDER BY invoice_date ASC, created_at ASC
       FOR UPDATE
  LOOP
    EXIT WHEN v_available <= 0;

    v_apply := LEAST(v_available, v_invoice.balance_cents);

    UPDATE public.invoices
       SET prepay_applied_cents = COALESCE(prepay_applied_cents, 0) + v_apply,
           balance_cents = balance_cents - v_apply,
           updated_at = now()
     WHERE id = v_invoice.id;

    v_available := v_available - v_apply;
    v_applied_total := v_applied_total + v_apply;
    v_count := v_count + 1;
  END LOOP;

  -- Update customer prepay balance
  UPDATE public.customers
     SET prepay_balance_cents = GREATEST(0, COALESCE(prepay_balance_cents, 0) - v_applied_total),
         updated_at = now()
   WHERE id = p_customer_id;

  RETURN jsonb_build_object(
    'applied_count', v_count,
    'applied_cents', v_applied_total,
    'remaining_prepay_cents', v_available
  );
END;
$$;
