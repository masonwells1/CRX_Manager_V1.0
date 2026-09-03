-- idempotency-body-check: exempt
-- ============================================================================
-- Restore stable, ledger-backed commission history and reconciliation detail.
--
-- Historical boundary: 2026-03-09 is the first commission order_date in the
-- verified pre-payout dataset. Two older-model cancelled rows have no recoverable
-- cancellation timestamp or pre-cancellation amount; they remain NULL-stamped and
-- are treated as cancelled from inception.
--
-- Safety window: when these columns are first installed, production must still
-- have no posted/voided commission payment, no payment item, no paid commission,
-- and exactly the two known legacy cancellations. If that changes, this migration
-- aborts so an incomplete history is never presented as exact.
--
-- Money: existing dollar columns remain exact PostgreSQL numeric. This migration
-- adds their now-safe finite whole-cent constraints and stores the new cancellation
-- snapshot as bigint cents. No existing money row is rewritten.
--
-- Rollback: keep the fail-closed report in place before dropping the detail RPC,
-- trigger, trigger function, constraints, FK, and four columns. Dropping the
-- history columns after real payouts/cancellations would destroy evidence and is
-- not an autonomous rollback.
-- ============================================================================

-- Freeze every writer that can close the cheap-history window before reading
-- the precondition counts. The bounded lock timeout makes a busy production
-- system fail fast instead of waiting indefinitely.
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.commission_payments,
           public.commission_payment_items,
           public.commissions
  IN SHARE ROW EXCLUSIVE MODE;

DO $precondition$
DECLARE
  v_history_columns integer;
  v_cancelled_count bigint;
  v_report_body_md5 text;
  v_void_body_md5 text;
BEGIN
  SELECT count(*)
    INTO v_history_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (
       (table_name = 'commission_payments' AND column_name IN ('voided_at', 'voided_by'))
       OR
       (table_name = 'commissions' AND column_name IN ('cancelled_at', 'cancelled_amount_cents'))
     );

  IF v_history_columns NOT IN (0, 4) THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_SCHEMA_DRIFT: expected none or all four history columns, found %',
      v_history_columns;
  END IF;

  -- A fresh schema replay has no business rows and is safe. On the first apply to
  -- a populated system, pin the exact evidence window verified with Mason.
  IF v_history_columns = 0 AND EXISTS (SELECT 1 FROM public.commissions) THEN
    IF EXISTS (SELECT 1 FROM public.commission_payment_items)
       OR EXISTS (
         SELECT 1 FROM public.commission_payments
          WHERE status IN ('posted', 'voided') OR posted_at IS NOT NULL
       )
       OR EXISTS (
         SELECT 1 FROM public.commissions
          WHERE status = 'paid' OR paid_date IS NOT NULL
       ) THEN
      RAISE EXCEPTION
        'COMMISSION_HISTORY_CHEAP_WINDOW_CLOSED: payout activity exists; reconstruct and set a later ledger boundary before applying';
    END IF;

    SELECT count(*)
      INTO v_cancelled_count
      FROM public.commissions
     WHERE status = 'cancelled';

    IF v_cancelled_count <> 2
       OR EXISTS (
         SELECT 1
           FROM public.commissions
          WHERE status = 'cancelled'
            AND (
              order_date IS DISTINCT FROM DATE '2026-03-16'
              OR commission_amount IS DISTINCT FROM 0::numeric
              OR deleted_at IS NOT NULL
            )
       ) THEN
      RAISE EXCEPTION
        'COMMISSION_HISTORY_CANCELLATION_DRIFT: expected exactly two zero-dollar legacy cancellations dated 2026-03-16, found %',
        v_cancelled_count;
    END IF;
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'get_commission_balance_report') <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_OVERLOAD_DRIFT: get_commission_balance_report must have exactly one overload';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.get_commission_balance_report(date)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPORT_TRUST_DRIFT: existing report owner or security contract is not the reviewed one';
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = '_void_commission_payment_intent_impl_20260809') <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_OVERLOAD_DRIFT: void implementation must have exactly one overload';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_VOID_TRUST_DRIFT: existing void implementation owner or security contract is not the reviewed one';
  END IF;

  SELECT md5(prosrc)
    INTO v_report_body_md5
    FROM pg_proc
   WHERE oid = 'public.get_commission_balance_report(date)'::regprocedure;
  SELECT md5(prosrc)
    INTO v_void_body_md5
    FROM pg_proc
   WHERE oid = 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'::regprocedure;

  IF v_history_columns = 0 THEN
    -- Populated fresh apply: only the exact live functions reviewed on
    -- 2026-09-03 may be replaced. An empty schema rebuild may also start from
    -- the tracked pre-refusal report body because the live refusal migration's
    -- source has not landed yet. This prevents a later hotfix with the same
    -- trust attributes from being silently overwritten in production.
    IF (
         EXISTS (SELECT 1 FROM public.commissions)
         AND v_report_body_md5 <> '0ea6b39cc91141362461598e3ab91294'
       ) OR (
         NOT EXISTS (SELECT 1 FROM public.commissions)
         AND v_report_body_md5 NOT IN (
           '0ea6b39cc91141362461598e3ab91294',
           'db37145a51829352d4178bba5da6a1c3'
         )
       ) OR v_void_body_md5 <> '60246ff3ed8168f8b69bfc201de6ccbb' THEN
      RAISE EXCEPTION
        'COMMISSION_HISTORY_PREIMAGE_DRIFT: report md5 %, void md5 %',
        v_report_body_md5, v_void_body_md5;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('get_commission_payment_detail_report', 'stamp_commission_cancellation_history')
    ) OR EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.commissions'::regclass
         AND tgname = 'trg_commissions_stamp_cancellation_history'
         AND NOT tgisinternal
    ) OR EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname IN (
         'commission_payments_voided_by_fkey',
         'commissions_cancelled_amount_cents_non_negative_chk',
         'commissions_cancellation_history_pair_chk',
         'commission_payments_void_history_chk',
         'commissions_commission_amount_whole_cents_chk',
         'commission_payments_total_amount_whole_cents_chk',
         'commission_payment_items_amount_whole_cents_chk'
       )
       AND conrelid IN (
         'public.commissions'::regclass,
         'public.commission_payments'::regclass,
         'public.commission_payment_items'::regclass
       )
    ) THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_SCHEMA_DRIFT: fresh apply found pre-existing candidate artifacts';
    END IF;
  ELSE
    -- Replay is allowed only over this exact candidate. Merely finding four
    -- same-named columns is not proof that history was installed safely.
    IF v_report_body_md5 <> '3f652b4f46ce1b584e933de12eeda701'
       OR v_void_body_md5 <> '985fb1a42ab3b4d911c68898c14ce637'
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc
          WHERE oid = 'public.get_commission_payment_detail_report(date)'::regprocedure
            AND proowner = 'postgres'::regrole
            AND prosecdef
            AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
            AND md5(prosrc) = 'a4f1091ee4a557d4053243c37eb7560d'
       ) OR NOT EXISTS (
         SELECT 1 FROM pg_proc
          WHERE oid = 'public.stamp_commission_cancellation_history()'::regprocedure
            AND proowner = 'postgres'::regrole
            AND NOT prosecdef
            AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
            AND md5(prosrc) = 'd1b9a4c61618e4f20bc6c5b736d7f445'
       ) THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: candidate function bodies or trust attributes differ';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('commission_payments', 'voided_at', 'timestamp with time zone'),
          ('commission_payments', 'voided_by', 'uuid'),
          ('commissions', 'cancelled_at', 'timestamp with time zone'),
          ('commissions', 'cancelled_amount_cents', 'bigint')
        ) expected(table_name, column_name, data_type)
        LEFT JOIN information_schema.columns c
          ON c.table_schema = 'public'
         AND c.table_name = expected.table_name
         AND c.column_name = expected.column_name
       WHERE c.column_name IS NULL
          OR c.data_type <> expected.data_type
          OR c.is_nullable <> 'YES'
          OR c.column_default IS NOT NULL
          OR c.is_generated <> 'NEVER'
          OR c.is_identity <> 'NO'
    ) THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: history column shape differs';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (VALUES
          ('public.commissions'::regclass, 'commissions_cancelled_amount_cents_non_negative_chk', 'CHECK (((cancelled_amount_cents IS NULL) OR (cancelled_amount_cents >= 0)))'),
          ('public.commissions'::regclass, 'commissions_cancellation_history_pair_chk', 'CHECK ((((cancelled_at IS NULL) AND (cancelled_amount_cents IS NULL)) OR ((cancelled_at IS NOT NULL) AND (cancelled_amount_cents IS NOT NULL))))'),
          ('public.commission_payments'::regclass, 'commission_payments_void_history_chk', 'CHECK ((((status = ''voided''::text) AND (voided_at IS NOT NULL) AND (voided_by IS NOT NULL)) OR ((status <> ''voided''::text) AND (voided_at IS NULL) AND (voided_by IS NULL))))'),
          ('public.commissions'::regclass, 'commissions_commission_amount_whole_cents_chk', 'CHECK (((commission_amount IS NULL) OR ((commission_amount = round(commission_amount, 2)) AND (commission_amount > ''-Infinity''::numeric) AND (commission_amount < ''Infinity''::numeric))))'),
          ('public.commission_payments'::regclass, 'commission_payments_total_amount_whole_cents_chk', 'CHECK (((total_amount IS NULL) OR ((total_amount = round(total_amount, 2)) AND (total_amount > ''-Infinity''::numeric) AND (total_amount < ''Infinity''::numeric))))'),
          ('public.commission_payment_items'::regclass, 'commission_payment_items_amount_whole_cents_chk', 'CHECK (((amount IS NULL) OR ((amount = round(amount, 2)) AND (amount > ''-Infinity''::numeric) AND (amount < ''Infinity''::numeric))))')
        ) expected(table_oid, constraint_name, definition)
        LEFT JOIN pg_constraint c
          ON c.conrelid = expected.table_oid
         AND c.conname = expected.constraint_name
         AND c.contype = 'c'
         AND c.convalidated
         AND pg_get_constraintdef(c.oid) = expected.definition
       WHERE c.oid IS NULL
    ) THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: required CHECK definition differs';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.commission_payments'::regclass
         AND c.conname = 'commission_payments_voided_by_fkey'
         AND c.contype = 'f'
         AND c.confrelid = 'public.profiles'::regclass
         AND c.convalidated
         AND c.confupdtype = 'a'
         AND c.confdeltype = 'a'
         AND c.confmatchtype = 's'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.commissions'::regclass
         AND tgname = 'trg_commissions_stamp_cancellation_history'
         AND NOT tgisinternal
         AND tgenabled = 'O'
         -- ROW + BEFORE + INSERT + UPDATE. Pin the complete behavior-bearing
         -- catalog shape so a same-named trigger cannot conceal missed history.
         AND tgtype = 23
         AND tgfoid = 'public.stamp_commission_cancellation_history()'::regprocedure
         AND tgqual IS NULL
         AND tgnargs = 0
         AND octet_length(tgargs) = 0
         AND tgattr::text = ''
    ) OR has_function_privilege('anon', 'public.get_commission_balance_report(date)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.get_commission_balance_report(date)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.get_commission_balance_report(date)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
       OR has_function_privilege('service_role', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: FK, trigger, or grant boundary differs';
    END IF;
  END IF;
END
$precondition$;

ALTER TABLE public.commission_payments
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid;

ALTER TABLE public.commissions
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_amount_cents bigint;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commission_payments'::regclass
       AND conname = 'commission_payments_voided_by_fkey'
  ) THEN
    ALTER TABLE public.commission_payments
      ADD CONSTRAINT commission_payments_voided_by_fkey
      FOREIGN KEY (voided_by) REFERENCES public.profiles(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commissions'::regclass
       AND conname = 'commissions_cancelled_amount_cents_non_negative_chk'
  ) THEN
    ALTER TABLE public.commissions
      ADD CONSTRAINT commissions_cancelled_amount_cents_non_negative_chk
      CHECK (cancelled_amount_cents IS NULL OR cancelled_amount_cents >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commissions'::regclass
       AND conname = 'commissions_cancellation_history_pair_chk'
  ) THEN
    ALTER TABLE public.commissions
      ADD CONSTRAINT commissions_cancellation_history_pair_chk
      CHECK (
        (cancelled_at IS NULL AND cancelled_amount_cents IS NULL)
        OR (cancelled_at IS NOT NULL AND cancelled_amount_cents IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commission_payments'::regclass
       AND conname = 'commission_payments_void_history_chk'
  ) THEN
    ALTER TABLE public.commission_payments
      ADD CONSTRAINT commission_payments_void_history_chk
      CHECK (
        (status = 'voided' AND voided_at IS NOT NULL AND voided_by IS NOT NULL)
        OR (status <> 'voided' AND voided_at IS NULL AND voided_by IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commissions'::regclass
       AND conname = 'commissions_commission_amount_whole_cents_chk'
  ) THEN
    ALTER TABLE public.commissions
      ADD CONSTRAINT commissions_commission_amount_whole_cents_chk
      CHECK (commission_amount IS NULL OR (
        commission_amount = ROUND(commission_amount, 2)
        AND commission_amount > '-Infinity'::numeric
        AND commission_amount < 'Infinity'::numeric
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commission_payments'::regclass
       AND conname = 'commission_payments_total_amount_whole_cents_chk'
  ) THEN
    ALTER TABLE public.commission_payments
      ADD CONSTRAINT commission_payments_total_amount_whole_cents_chk
      CHECK (total_amount IS NULL OR (
        total_amount = ROUND(total_amount, 2)
        AND total_amount > '-Infinity'::numeric
        AND total_amount < 'Infinity'::numeric
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commission_payment_items'::regclass
       AND conname = 'commission_payment_items_amount_whole_cents_chk'
  ) THEN
    ALTER TABLE public.commission_payment_items
      ADD CONSTRAINT commission_payment_items_amount_whole_cents_chk
      CHECK (amount IS NULL OR (
        amount = ROUND(amount, 2)
        AND amount > '-Infinity'::numeric
        AND amount < 'Infinity'::numeric
      ));
  END IF;
END
$constraints$;

-- One trigger fills immutable reporting labels and covers every current/future
-- cancellation writer. It sees OLD.commission_amount before cancellation
-- functions zero the current amount.
CREATE OR REPLACE FUNCTION public.stamp_commission_cancellation_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- The order commission helper intentionally stores IDs, not display fields.
  -- Fill those existing snapshot columns before the first payout, then keep a
  -- populated snapshot immutable so later order/customer renames cannot rewrite
  -- historical reconciliation detail.
  IF NEW.order_number IS NULL AND NEW.order_id IS NOT NULL THEN
    SELECT o.order_number INTO NEW.order_number
      FROM public.orders o
     WHERE o.id = NEW.order_id;
  END IF;
  IF NEW.customer_name IS NULL AND NEW.customer_id IS NOT NULL THEN
    SELECT c.farm_name INTO NEW.customer_name
      FROM public.customers c
     WHERE c.id = NEW.customer_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.order_number IS NOT NULL THEN
      NEW.order_number := OLD.order_number;
    END IF;
    IF OLD.customer_name IS NOT NULL THEN
      NEW.customer_name := OLD.customer_name;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'cancelled' THEN
      NEW.cancelled_at := transaction_timestamp();
      NEW.cancelled_amount_cents := (ROUND(NEW.commission_amount, 2) * 100)::bigint;
    ELSE
      NEW.cancelled_at := NULL;
      NEW.cancelled_amount_cents := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' THEN
    IF NEW.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'COMMISSION_CANCELLATION_HISTORY_IMMUTABLE: cancelled commissions cannot be reopened';
    END IF;
    NEW.cancelled_at := OLD.cancelled_at;
    NEW.cancelled_amount_cents := OLD.cancelled_amount_cents;
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN
    NEW.cancelled_at := transaction_timestamp();
    NEW.cancelled_amount_cents := (ROUND(OLD.commission_amount, 2) * 100)::bigint;
  ELSE
    NEW.cancelled_at := NULL;
    NEW.cancelled_amount_cents := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.stamp_commission_cancellation_history()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_commissions_stamp_cancellation_history ON public.commissions;
CREATE TRIGGER trg_commissions_stamp_cancellation_history
  BEFORE INSERT OR UPDATE ON public.commissions
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_commission_cancellation_history();

-- Preserve the mature private implementation byte-for-byte except for the three
-- new void-history assignments on the payment header.
CREATE OR REPLACE FUNCTION public._void_commission_payment_intent_impl_20260809(
  p_payment_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_payment record;
  v_reset_count integer;
  v_cancelled_count integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'COMMISSION_PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.status NOT IN ('posted', 'unposted') THEN
    RAISE EXCEPTION 'INVALID_COMMISSION_PAYMENT_STATUS: %', v_payment.status;
  END IF;

  PERFORM check_period_open(COALESCE(v_payment.payment_date, CURRENT_DATE));

  UPDATE commission_payments SET
    status = 'voided',
    voided_at = transaction_timestamp(),
    voided_by = v_actor,
    updated_at = now()
  WHERE id = p_payment_id;

  UPDATE commissions c SET
    status = 'pending',
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = c.order_id
      AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
  )
  AND NOT (
    c.job_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = c.invoice_id
        AND i.status NOT IN ('voided', 'cancelled')
        AND i.deleted_at IS NULL
    )
  )
  AND c.status <> 'cancelled';
  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  UPDATE commissions c SET
    status = 'cancelled',
    commission_amount = 0,
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = c.order_id
        AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
    )
    OR (
      c.job_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.id = c.invoice_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND i.deleted_at IS NULL
      )
    )
  );
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_payment.status, 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count, 'commissions_cancelled_dead_order', v_cancelled_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'commissions_reset', v_reset_count,
    'commissions_cancelled_dead_order', v_cancelled_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._void_commission_payment_intent_impl_20260809(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_commission_balance_report(p_as_of_date date)
RETURNS TABLE(
  recipient_id uuid,
  recipient_name text,
  total_earned numeric,
  total_paid numeric,
  outstanding_balance numeric,
  pending_count bigint,
  paid_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_history_start_date constant date := DATE '2026-03-09';
BEGIN
  PERFORM public.require_admin();

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_DATE_REQUIRED: p_as_of_date is required';
  END IF;
  IF p_as_of_date < v_history_start_date THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_BEFORE_LEDGER_START: exact history is available on or after %',
      v_history_start_date;
  END IF;
  IF p_as_of_date > v_today THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_FUTURE_DATE_UNAVAILABLE: as-of date must be on or before %',
      v_today;
  END IF;

  RETURN QUERY
  WITH earned AS (
    SELECT
      cm.id AS commission_id,
      cm.recipient_user_id,
      COALESCE(NULLIF(cm.recipient, ''), p.full_name, '[Unknown recipient]'::text) AS resolved_recipient_name,
      CASE
        -- The two pre-ledger cancellations have no recoverable date or amount.
        WHEN cm.status = 'cancelled' AND cm.cancelled_at IS NULL THEN NULL::numeric
        WHEN cm.cancelled_at IS NOT NULL
             AND (cm.cancelled_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
          THEN NULL::numeric
        WHEN cm.cancelled_at IS NOT NULL
          THEN cm.cancelled_amount_cents::numeric / 100::numeric
        ELSE cm.commission_amount
      END AS earned_amount
    FROM public.commissions cm
    LEFT JOIN public.profiles p ON p.id = cm.recipient_user_id
    WHERE cm.order_date <= p_as_of_date
  ),
  paid AS (
    SELECT
      cpi.commission_id,
      SUM(cpi.amount)::numeric AS paid_amount
    FROM public.commission_payment_items cpi
    JOIN public.commission_payments cp ON cp.id = cpi.commission_payment_id
    WHERE cp.status IN ('posted', 'voided')
      AND cp.posted_at IS NOT NULL
      AND (cp.posted_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
      AND cp.payment_date <= p_as_of_date
      AND (
        cp.voided_at IS NULL
        OR (cp.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
      )
    GROUP BY cpi.commission_id
  )
  SELECT
    e.recipient_user_id,
    MIN(e.resolved_recipient_name),
    ROUND(SUM(e.earned_amount), 2),
    ROUND(SUM(COALESCE(pd.paid_amount, 0::numeric)), 2),
    ROUND(SUM(e.earned_amount - COALESCE(pd.paid_amount, 0::numeric)), 2),
    COUNT(*) FILTER (WHERE pd.commission_id IS NULL),
    COUNT(*) FILTER (WHERE pd.commission_id IS NOT NULL)
  FROM earned e
  LEFT JOIN paid pd ON pd.commission_id = e.commission_id
  WHERE e.earned_amount IS NOT NULL
  GROUP BY e.recipient_user_id,
           CASE
             WHEN e.recipient_user_id IS NULL THEN e.resolved_recipient_name
             ELSE NULL::text
           END
  ORDER BY ROUND(SUM(e.earned_amount - COALESCE(pd.paid_amount, 0::numeric)), 2) DESC,
           MIN(e.resolved_recipient_name);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_commission_balance_report(date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_commission_balance_report(date)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_commission_payment_detail_report(p_as_of_date date)
RETURNS TABLE(
  payment_id uuid,
  payment_number text,
  payment_date date,
  recipient_id uuid,
  recipient_name text,
  commission_id uuid,
  source_type text,
  source_number text,
  customer_name text,
  commission_order_date date,
  settled_amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_today date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_history_start_date constant date := DATE '2026-03-09';
BEGIN
  PERFORM public.require_admin();

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_DATE_REQUIRED: p_as_of_date is required';
  END IF;
  IF p_as_of_date < v_history_start_date THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_BEFORE_LEDGER_START: exact history is available on or after %',
      v_history_start_date;
  END IF;
  IF p_as_of_date > v_today THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_FUTURE_DATE_UNAVAILABLE: as-of date must be on or before %',
      v_today;
  END IF;

  RETURN QUERY
  SELECT
    cp.id,
    cp.payment_number,
    cp.payment_date,
    cp.recipient_id,
    COALESCE(NULLIF(cm.recipient, ''), p.full_name, '[Unknown recipient]'::text),
    cm.id,
    CASE WHEN cm.order_id IS NOT NULL THEN 'order'::text ELSE 'job'::text END,
    COALESCE(cm.order_number, o.order_number, j.job_number, i.invoice_number, cm.order_id::text, cm.job_id::text),
    COALESCE(NULLIF(cm.customer_name, ''), customer.farm_name, '[Unknown customer]'::text),
    cm.order_date,
    cpi.amount
  FROM public.commission_payment_items cpi
  JOIN public.commission_payments cp ON cp.id = cpi.commission_payment_id
  JOIN public.commissions cm ON cm.id = cpi.commission_id
  LEFT JOIN public.profiles p ON p.id = cp.recipient_id
  LEFT JOIN public.orders o ON o.id = cm.order_id
  LEFT JOIN public.jobs j ON j.id = cm.job_id
  LEFT JOIN public.invoices i ON i.id = cm.invoice_id
  LEFT JOIN public.customers customer ON customer.id = cm.customer_id
  WHERE cp.status IN ('posted', 'voided')
    AND cp.posted_at IS NOT NULL
    AND (cp.posted_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
    AND cp.payment_date <= p_as_of_date
    AND (
      cp.voided_at IS NULL
      OR (cp.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
    )
    AND cm.order_date <= p_as_of_date
    AND NOT (cm.status = 'cancelled' AND cm.cancelled_at IS NULL)
    AND (
      cm.cancelled_at IS NULL
      OR (cm.cancelled_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
    )
  ORDER BY cp.payment_date, cp.payment_number, cm.order_date, cm.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_commission_payment_detail_report(date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_commission_payment_detail_report(date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_commission_balance_report(date) IS
  'Admin-only exact commission earned, paid, and outstanding balances from 2026-03-09 through Chicago-today. Two pre-ledger cancellations are excluded from inception.';

COMMENT ON FUNCTION public.get_commission_payment_detail_report(date) IS
  'Admin-only payment and settled-commission reconciliation detail as of a supported historical date.';

DO $postcondition$
DECLARE
  v_bad_columns bigint;
BEGIN
  SELECT count(*)
    INTO v_bad_columns
    FROM (VALUES
      ('commission_payments', 'voided_at', 'timestamp with time zone'),
      ('commission_payments', 'voided_by', 'uuid'),
      ('commissions', 'cancelled_at', 'timestamp with time zone'),
      ('commissions', 'cancelled_amount_cents', 'bigint')
    ) expected(table_name, column_name, data_type)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = expected.table_name
     AND c.column_name = expected.column_name
     AND c.data_type = expected.data_type
   WHERE c.column_name IS NULL
      OR c.is_nullable <> 'YES'
      OR c.column_default IS NOT NULL
      OR c.is_generated <> 'NEVER'
      OR c.is_identity <> 'NO';

  IF v_bad_columns <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: % history column(s) missing or wrong type', v_bad_columns;
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.commissions'::regclass
         AND tgname = 'trg_commissions_stamp_cancellation_history'
         AND NOT tgisinternal
         AND tgenabled = 'O'
         AND tgtype = 23
         AND tgfoid = 'public.stamp_commission_cancellation_history()'::regprocedure
         AND tgqual IS NULL
         AND tgnargs = 0
         AND octet_length(tgargs) = 0
         AND tgattr::text = '') <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: cancellation history trigger catalog shape differs';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.commission_payments'::regclass
       AND c.conname = 'commission_payments_voided_by_fkey'
       AND c.contype = 'f'
       AND c.confrelid = 'public.profiles'::regclass
       AND c.convalidated
       AND c.confupdtype = 'a'
       AND c.confdeltype = 'a'
       AND c.confmatchtype = 's'
       AND c.conkey = ARRAY[
         (SELECT attnum::smallint
            FROM pg_attribute
           WHERE attrelid = 'public.commission_payments'::regclass
             AND attname = 'voided_by'
             AND NOT attisdropped)
       ]::smallint[]
       AND c.confkey = ARRAY[
         (SELECT attnum::smallint
            FROM pg_attribute
           WHERE attrelid = 'public.profiles'::regclass
             AND attname = 'id'
             AND NOT attisdropped)
       ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: voided_by foreign key is missing or has the wrong target';
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'get_commission_balance_report') <> 1
     OR (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'get_commission_payment_detail_report') <> 1
     OR (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'stamp_commission_cancellation_history') <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: function overload drift';
  END IF;

  IF has_function_privilege('anon', 'public.get_commission_balance_report(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_commission_balance_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_commission_balance_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: function grant boundary drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.get_commission_balance_report(date)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = '3f652b4f46ce1b584e933de12eeda701'
       AND prosrc LIKE '%PERFORM public.require_admin()%'
       AND prosrc LIKE '%commission_payment_items%'
       AND prosrc LIKE '%posted_at AT TIME ZONE ''America/Chicago''%'
       AND prosrc LIKE '%voided_at%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.get_commission_payment_detail_report(date)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = 'a4f1091ee4a557d4053243c37eb7560d'
       AND prosrc LIKE '%PERFORM public.require_admin()%'
       AND prosrc LIKE '%commission_payment_items%'
       AND prosrc LIKE '%posted_at AT TIME ZONE ''America/Chicago''%'
       AND prosrc LIKE '%voided_at%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.stamp_commission_cancellation_history()'::regprocedure
       AND proowner = 'postgres'::regrole
       AND NOT prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = 'd1b9a4c61618e4f20bc6c5b736d7f445'
       AND prosrc LIKE '%ROUND(OLD.commission_amount, 2) * 100%'
       AND prosrc LIKE '%NEW.order_number%'
       AND prosrc LIKE '%NEW.customer_name%'
       AND prosrc LIKE '%cancelled commissions cannot be reopened%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = '985fb1a42ab3b4d911c68898c14ce637'
       AND prosrc LIKE '%voided_at = transaction_timestamp()%'
       AND prosrc LIKE '%voided_by = v_actor%'
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: reviewed function body or security contract drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.commissions'::regclass, 'commissions_cancelled_amount_cents_non_negative_chk', 'CHECK (((cancelled_amount_cents IS NULL) OR (cancelled_amount_cents >= 0)))'),
        ('public.commissions'::regclass, 'commissions_cancellation_history_pair_chk', 'CHECK ((((cancelled_at IS NULL) AND (cancelled_amount_cents IS NULL)) OR ((cancelled_at IS NOT NULL) AND (cancelled_amount_cents IS NOT NULL))))'),
        ('public.commissions'::regclass, 'commissions_commission_amount_whole_cents_chk', 'CHECK (((commission_amount IS NULL) OR ((commission_amount = round(commission_amount, 2)) AND (commission_amount > ''-Infinity''::numeric) AND (commission_amount < ''Infinity''::numeric))))'),
        ('public.commission_payments'::regclass, 'commission_payments_void_history_chk', 'CHECK ((((status = ''voided''::text) AND (voided_at IS NOT NULL) AND (voided_by IS NOT NULL)) OR ((status <> ''voided''::text) AND (voided_at IS NULL) AND (voided_by IS NULL))))'),
        ('public.commission_payments'::regclass, 'commission_payments_total_amount_whole_cents_chk', 'CHECK (((total_amount IS NULL) OR ((total_amount = round(total_amount, 2)) AND (total_amount > ''-Infinity''::numeric) AND (total_amount < ''Infinity''::numeric))))'),
        ('public.commission_payment_items'::regclass, 'commission_payment_items_amount_whole_cents_chk', 'CHECK (((amount IS NULL) OR ((amount = round(amount, 2)) AND (amount > ''-Infinity''::numeric) AND (amount < ''Infinity''::numeric))))')
      ) expected(table_oid, constraint_name, definition)
      LEFT JOIN pg_constraint c
        ON c.conrelid = expected.table_oid
       AND c.conname = expected.constraint_name
       AND c.contype = 'c'
       AND c.convalidated
       AND pg_get_constraintdef(c.oid) = expected.definition
     WHERE c.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: required validated money constraint missing';
  END IF;
END
$postcondition$;
