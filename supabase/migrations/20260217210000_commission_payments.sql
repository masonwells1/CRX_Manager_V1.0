-- Sprint 10: Commission Payments lifecycle
-- New tables: commission_payments, commission_payment_items
-- New RPCs: next_commission_payment_number, create_commission_payment, post_commission_payment

-- ─── commission_payments table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commission_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number   text UNIQUE NOT NULL,
  recipient_id     uuid NOT NULL REFERENCES public.profiles(id),
  total_amount     numeric NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'unposted' CHECK (status IN ('unposted','posted')),
  payment_method   text,
  reference_number text,
  payment_date     date NOT NULL DEFAULT CURRENT_DATE,
  posted_by        uuid REFERENCES public.profiles(id),
  posted_at        timestamptz,
  notes            text,
  season           integer,
  created_by       uuid REFERENCES public.profiles(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.commission_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "commission_payments_select_admin"
  ON public.commission_payments FOR SELECT
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "commission_payments_insert_admin"
  ON public.commission_payments FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "commission_payments_update_admin"
  ON public.commission_payments FOR UPDATE
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- ─── commission_payment_items table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commission_payment_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_payment_id  uuid NOT NULL REFERENCES public.commission_payments(id) ON DELETE CASCADE,
  commission_id          uuid NOT NULL REFERENCES public.commissions(id),
  amount                 numeric NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.commission_payment_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "commission_payment_items_select_admin"
  ON public.commission_payment_items FOR SELECT
  TO authenticated
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "commission_payment_items_insert_admin"
  ON public.commission_payment_items FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_commission_payment_items_payment
  ON public.commission_payment_items(commission_payment_id);
CREATE INDEX IF NOT EXISTS idx_commission_payment_items_commission
  ON public.commission_payment_items(commission_id);
CREATE INDEX IF NOT EXISTS idx_commission_payments_recipient
  ON public.commission_payments(recipient_id);
CREATE INDEX IF NOT EXISTS idx_commission_payments_status
  ON public.commission_payments(status);

-- ─── next_commission_payment_number ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.next_commission_payment_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_year text;
  v_seq  integer;
  v_num  text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('commission_payment_number'));
  v_year := to_char(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(
    MAX(
      regexp_replace(payment_number, '^CP-' || v_year || '-', '')::integer
    ), 0) + 1
    INTO v_seq
    FROM public.commission_payments
   WHERE payment_number LIKE 'CP-' || v_year || '-%';
  v_num := 'CP-' || v_year || '-' || lpad(v_seq::text, 4, '0');
  RETURN v_num;
END;
$$;

-- ─── create_commission_payment ───────────────────────────────────────────────
-- Atomic: creates payment + items, updates commissions.status='paid'
CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[],
  p_payment_method text,
  p_reference      text,
  p_payment_date   date,
  p_notes          text,
  p_performed_by   uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
BEGIN
  -- Validate at least one commission
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Verify all commissions exist and belong to the same recipient
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No unpaid commissions found for the given IDs';
  END IF;

  -- Check all belong to same recipient
  IF (SELECT count(DISTINCT c.recipient_user_id) FROM public.commissions c WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- Calculate total and determine season
  SELECT sum(c.commission_amount),
         (CASE WHEN extract(month FROM CURRENT_DATE) >= 7
               THEN extract(year FROM CURRENT_DATE)::integer
               ELSE extract(year FROM CURRENT_DATE)::integer - 1 END)
    INTO v_total, v_season
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  -- Generate payment number
  v_payment_num := public.next_commission_payment_number();

  -- Create the payment
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_season, p_performed_by
  ) RETURNING id INTO v_payment_id;

  -- Create line items
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM public.commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status != 'paid'
  LOOP
    INSERT INTO public.commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- Mark commissions as paid
  UPDATE public.commissions
     SET status = 'paid', updated_at = now()
   WHERE id = ANY(p_commission_ids)
     AND status != 'paid';

  RETURN v_payment_id;
END;
$$;

-- ─── post_commission_payment ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_commission_payment(
  p_payment_id   uuid,
  p_performed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
    FROM public.commission_payments
   WHERE id = p_payment_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found';
  END IF;

  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'Commission payment is already posted';
  END IF;

  UPDATE public.commission_payments
     SET status = 'posted',
         posted_by = p_performed_by,
         posted_at = now(),
         updated_at = now()
   WHERE id = p_payment_id;
END;
$$;
