-- NOT APPLIED — DO NOT APPLY without Mason's explicit in-chat approval.
-- ============================================================================
-- Repair human-readable commission-history labels without rewriting history.
--
-- The original opening ledger capture correctly preserved commission value and
-- state, but older commission rows did not carry denormalized order/customer
-- labels. Their opening snapshots therefore fell back to UUIDs and
-- "[Unknown customer]" despite the linked canonical rows being present.
--
-- This is deliberately append-only. It freezes writers, refuses to run after
-- any settlement event exists, appends one current correction event per
-- affected commission, and makes all future recorder events resolve labels
-- from their canonical order/job/invoice/customer rows. It never updates an
-- existing ledger or settlement row, and it does not alter commissions.
-- ============================================================================

SET LOCAL lock_timeout = '10s';
LOCK TABLE public.commission_payments,
           public.commission_payment_items,
           public.commissions,
           public.commission_earned_state_ledger,
           public.commission_settlement_events
  IN SHARE ROW EXCLUSIVE MODE;

-- Refuse an unreviewed foundation instead of re-emitting a recorder over a
-- concurrent hotfix. The accepted preimage is the applied row-911 body only;
-- migration runners do not replay an already-applied file.
DO $preflight$
BEGIN
  IF to_regclass('public.commission_earned_state_ledger') IS NULL
     OR to_regclass('public.commission_settlement_events') IS NULL
     OR to_regclass('public.commission_history_cutover') IS NULL
     OR (SELECT count(*)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'record_commission_earned_state') <> 1
     OR (SELECT count(*)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'record_commission_settlement_event') <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.record_commission_earned_state()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
          AND md5(p.prosrc) = 'dc0577e8e694773e75a1c8099819ba6c'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.commissions'::regclass
          AND t.tgname = 'trg_commissions_record_earned_state'
          AND t.tgfoid = 'public.record_commission_earned_state()'::regprocedure
          AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND t.tgtype = 21
          AND t.tgnargs = 0
          AND octet_length(t.tgargs) = 0
          AND t.tgqual IS NULL
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.record_commission_settlement_event()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
          AND md5(p.prosrc) = 'feb0f260fd2ad9e2945f761e93e9a3dc'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.commission_payments'::regclass
          AND t.tgname = 'trg_commission_payments_record_settlement_event'
          AND t.tgfoid = 'public.record_commission_settlement_event()'::regprocedure
          AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND t.tgtype = 19
          AND t.tgnargs = 0
          AND octet_length(t.tgargs) = 0
          AND t.tgqual IS NULL
          AND t.tgattr::text = (
            SELECT a.attnum::text
              FROM pg_attribute a
             WHERE a.attrelid = 'public.commission_payments'::regclass
               AND a.attname = 'status'
               AND NOT a.attisdropped
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
        WHERE p.oid IN (
                'public.record_commission_earned_state()'::regprocedure,
                'public.record_commission_settlement_event()'::regprocedure
              )
          AND privilege.grantee <> p.proowner
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.prevent_commission_history_ledger_mutation()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND NOT p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
          AND md5(p.prosrc) = 'f31a41a2b139f101074f95d2e361308f'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.prevent_commission_history_ledger_truncate()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND NOT p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
          AND md5(p.prosrc) = 'add7928abcb610caedb7cfbea52b8602'
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.commission_earned_state_ledger'::regclass, 'commission_earned_state_ledger_admin_select'),
           ('public.commission_settlement_events'::regclass, 'commission_settlement_events_admin_select')
         ) expected(table_oid, policy_name)
         LEFT JOIN pg_class c ON c.oid = expected.table_oid
         LEFT JOIN pg_policy p
           ON p.polrelid = expected.table_oid
          AND p.polname = expected.policy_name
        WHERE c.relowner <> 'postgres'::regrole
           OR NOT c.relrowsecurity
           OR c.relforcerowsecurity
           OR p.oid IS NULL
           OR p.polcmd <> 'r'
           OR p.polroles <> ARRAY['authenticated'::regrole::oid]
           OR pg_get_expr(p.polqual, p.polrelid) NOT IN ('is_admin()', 'public.is_admin()')
           OR p.polwithcheck IS NOT NULL
     )
     OR EXISTS (
       SELECT 1
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) privilege
        WHERE c.oid IN (
                'public.commission_earned_state_ledger'::regclass,
                'public.commission_settlement_events'::regclass
              )
          AND privilege.grantee <> c.relowner
     )
     OR (SELECT count(*)
           FROM pg_policy p
          WHERE p.polrelid IN (
                  'public.commission_earned_state_ledger'::regclass,
                  'public.commission_settlement_events'::regclass
                )) <> 2
     OR EXISTS (
       SELECT 1
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) privilege
        WHERE c.oid IN (
                'public.commission_earned_state_ledger_id_seq'::regclass,
                'public.commission_settlement_events_id_seq'::regclass
              )
          AND (c.relowner <> 'postgres'::regrole OR privilege.grantee <> c.relowner)
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.commission_earned_state_ledger'::regclass, 'trg_commission_earned_state_ledger_immutable', 27::smallint, 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
           ('public.commission_earned_state_ledger'::regclass, 'trg_commission_earned_state_ledger_no_truncate', 34::smallint, 'public.prevent_commission_history_ledger_truncate()'::regprocedure),
           ('public.commission_settlement_events'::regclass, 'trg_commission_settlement_events_immutable', 27::smallint, 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
           ('public.commission_settlement_events'::regclass, 'trg_commission_settlement_events_no_truncate', 34::smallint, 'public.prevent_commission_history_ledger_truncate()'::regprocedure)
         ) expected(table_oid, trigger_name, trigger_type, function_oid)
         LEFT JOIN pg_trigger t
           ON t.tgrelid = expected.table_oid
          AND t.tgname = expected.trigger_name
          AND t.tgtype = expected.trigger_type
          AND t.tgfoid = expected.function_oid
          AND NOT t.tgisinternal
          AND t.tgenabled = 'O'
          AND t.tgnargs = 0
          AND octet_length(t.tgargs) = 0
          AND t.tgqual IS NULL
        WHERE t.oid IS NULL
     ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT: reviewed ledger recorder or trust boundary differs';
  END IF;

  IF EXISTS (SELECT 1 FROM public.commission_settlement_events) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_LABEL_REPAIR_SETTLED: settlement history exists; append a separately reviewed settlement-label correction instead';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commission_payments
     WHERE status <> 'unposted'
        OR posted_at IS NOT NULL
        OR voided_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_LABEL_REPAIR_SETTLED: payment state exists without an eligible pre-settlement window';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.record_commission_earned_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_recipient_name text;
  v_group_key text;
  v_old_group_key text;
  v_event_kind text;
  v_source_number text;
  v_customer_name text;
BEGIN
  IF NEW.order_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_ORDER_DATE_REQUIRED: commission % must have order_date before history is recorded', NEW.id;
  END IF;
  IF NEW.commission_amount IS NULL
     OR NEW.commission_amount <> round(NEW.commission_amount, 2)
     OR NEW.commission_amount <= '-Infinity'::numeric
     OR NEW.commission_amount >= 'Infinity'::numeric THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_AMOUNT_INVALID: commission % must have a finite whole-cent commission_amount', NEW.id;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.commission_amount IS NOT DISTINCT FROM OLD.commission_amount
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
     AND NEW.order_date IS NOT DISTINCT FROM OLD.order_date
     AND NEW.recipient_user_id IS NOT DISTINCT FROM OLD.recipient_user_id
     AND NEW.recipient IS NOT DISTINCT FROM OLD.recipient
     AND NEW.order_number IS NOT DISTINCT FROM OLD.order_number
     AND NEW.customer_name IS NOT DISTINCT FROM OLD.customer_name
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id
     AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
     AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
    RETURN NEW;
  END IF;

  SELECT
    CASE
      WHEN NEW.order_id IS NOT NULL THEN COALESCE(NULLIF(btrim(o.order_number), ''), NULLIF(btrim(NEW.order_number), ''), NEW.order_id::text)
      WHEN NEW.job_id IS NOT NULL THEN COALESCE(NULLIF(btrim(j.job_number), ''), NEW.job_id::text)
      WHEN NEW.invoice_id IS NOT NULL THEN COALESCE(NULLIF(btrim(i.invoice_number), ''), NEW.invoice_id::text)
      ELSE NEW.id::text
    END,
    COALESCE(NULLIF(btrim(c.farm_name), ''), NULLIF(btrim(NEW.customer_name), ''), '[Unknown customer]')
    INTO v_source_number, v_customer_name
    FROM (SELECT 1) anchor
    LEFT JOIN public.orders o ON o.id = NEW.order_id
    LEFT JOIN public.jobs j ON j.id = NEW.job_id
    LEFT JOIN public.invoices i ON i.id = NEW.invoice_id
    LEFT JOIN public.customers c ON c.id = NEW.customer_id;

  v_recipient_name := COALESCE(NULLIF(btrim(NEW.recipient), ''), '[Unknown recipient]');
  v_group_key := COALESCE(
    'user:' || NEW.recipient_user_id::text,
    NULLIF('name:' || lower(btrim(NEW.recipient)), 'name:'),
    'commission:' || NEW.id::text
  );

  IF TG_OP = 'UPDATE' THEN
    v_old_group_key := COALESCE(
      'user:' || OLD.recipient_user_id::text,
      NULLIF('name:' || lower(btrim(OLD.recipient)), 'name:'),
      'commission:' || OLD.id::text
    );
    IF v_group_key IS DISTINCT FROM v_old_group_key
       AND EXISTS (SELECT 1 FROM public.commission_settlement_events WHERE commission_id = NEW.id) THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_RECIPIENT_GROUP_IMMUTABLE_AFTER_SETTLEMENT: commission % already has settlement history', NEW.id;
    END IF;
  END IF;

  v_event_kind := CASE
    WHEN TG_OP = 'INSERT' THEN 'inserted'
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'soft_deleted'
    WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN 'restored'
    WHEN NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN 'cancelled'
    ELSE 'revised'
  END;

  INSERT INTO public.commission_earned_state_ledger (
    commission_id, event_kind, effective_at, recorded_by,
    recipient_id, recipient_group_key, recipient_name,
    source_type, source_number, customer_name, order_date, amount_cents, is_earned
  ) VALUES (
    NEW.id,
    v_event_kind,
    clock_timestamp(),
    auth.uid(),
    NEW.recipient_user_id,
    v_group_key,
    v_recipient_name,
    CASE WHEN NEW.order_id IS NOT NULL THEN 'order'
         WHEN NEW.job_id IS NOT NULL THEN 'job'
         WHEN NEW.invoice_id IS NOT NULL THEN 'invoice'
         ELSE 'commission' END,
    v_source_number,
    v_customer_name,
    NEW.order_date,
    (round(NEW.commission_amount, 2) * 100)::bigint,
    NEW.status <> 'cancelled' AND NEW.deleted_at IS NULL
  );
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_commission_earned_state()
  FROM PUBLIC, anon, authenticated, service_role;

-- Correct only the current state of an un-settled commission. The original
-- opening event remains immutable; reports after this repair observe the new
-- revised event, while no report is made to claim labels before the repair.
WITH repair_time AS (
  SELECT clock_timestamp() AS at
), latest AS (
  SELECT DISTINCT ON (s.commission_id)
    s.commission_id, s.recipient_id, s.recipient_group_key, s.recipient_name,
    s.source_type, s.source_number, s.customer_name, s.order_date,
    s.amount_cents, s.is_earned
  FROM public.commission_earned_state_ledger s
  ORDER BY s.commission_id, s.effective_at DESC, s.id DESC
), resolved AS (
  SELECT
    l.*,
    CASE
      WHEN c.order_id IS NOT NULL THEN 'order'
      WHEN c.job_id IS NOT NULL THEN 'job'
      WHEN c.invoice_id IS NOT NULL THEN 'invoice'
      ELSE 'commission'
    END AS resolved_source_type,
    CASE
      WHEN c.order_id IS NOT NULL THEN COALESCE(NULLIF(btrim(o.order_number), ''), NULLIF(btrim(c.order_number), ''), c.order_id::text)
      WHEN c.job_id IS NOT NULL THEN COALESCE(NULLIF(btrim(j.job_number), ''), c.job_id::text)
      WHEN c.invoice_id IS NOT NULL THEN COALESCE(NULLIF(btrim(i.invoice_number), ''), c.invoice_id::text)
      ELSE c.id::text
    END AS resolved_source_number,
    COALESCE(NULLIF(btrim(cu.farm_name), ''), NULLIF(btrim(c.customer_name), ''), '[Unknown customer]') AS resolved_customer_name
  FROM latest l
  JOIN public.commissions c ON c.id = l.commission_id
  LEFT JOIN public.orders o ON o.id = c.order_id
  LEFT JOIN public.jobs j ON j.id = c.job_id
  LEFT JOIN public.invoices i ON i.id = c.invoice_id
  LEFT JOIN public.customers cu ON cu.id = c.customer_id
)
INSERT INTO public.commission_earned_state_ledger (
  commission_id, event_kind, effective_at, recorded_by,
  recipient_id, recipient_group_key, recipient_name,
  source_type, source_number, customer_name, order_date, amount_cents, is_earned
)
SELECT
  r.commission_id, 'revised', t.at, NULL::uuid,
  r.recipient_id, r.recipient_group_key, r.recipient_name,
  r.resolved_source_type, r.resolved_source_number, r.resolved_customer_name,
  r.order_date, r.amount_cents, r.is_earned
FROM resolved r
CROSS JOIN repair_time t
WHERE r.source_type IS DISTINCT FROM r.resolved_source_type
   OR r.source_number IS DISTINCT FROM r.resolved_source_number
   OR r.customer_name IS DISTINCT FROM r.resolved_customer_name;

DO $postflight$
BEGIN
  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'record_commission_earned_state') <> 1
     OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = 'public.record_commission_earned_state()'::regprocedure
       AND p.proowner = 'postgres'::regrole
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(p.prosrc) = '5623b0d31181d357b303a36e563a77aa'
       AND p.prosrc LIKE '%LEFT JOIN public.jobs j ON j.id = NEW.job_id%'
       AND p.prosrc LIKE '%LEFT JOIN public.customers c ON c.id = NEW.customer_id%'
       AND p.prosrc LIKE '%v_source_number%'
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
     WHERE p.oid = 'public.record_commission_earned_state()'::regprocedure
       AND privilege.grantee <> p.proowner
  ) OR EXISTS (
    SELECT 1
      FROM public.commission_earned_state_ledger s
      JOIN public.commissions c ON c.id = s.commission_id
      LEFT JOIN public.orders o ON o.id = c.order_id
      LEFT JOIN public.jobs j ON j.id = c.job_id
      LEFT JOIN public.invoices i ON i.id = c.invoice_id
      LEFT JOIN public.customers cu ON cu.id = c.customer_id
     WHERE s.id = (
       SELECT newest.id
         FROM public.commission_earned_state_ledger newest
        WHERE newest.commission_id = s.commission_id
        ORDER BY newest.effective_at DESC, newest.id DESC
        LIMIT 1
     )
       AND (
         s.source_type IS DISTINCT FROM CASE
           WHEN c.order_id IS NOT NULL THEN 'order'
           WHEN c.job_id IS NOT NULL THEN 'job'
           WHEN c.invoice_id IS NOT NULL THEN 'invoice'
           ELSE 'commission'
         END
         OR s.source_number IS DISTINCT FROM CASE
           WHEN c.order_id IS NOT NULL THEN COALESCE(NULLIF(btrim(o.order_number), ''), NULLIF(btrim(c.order_number), ''), c.order_id::text)
           WHEN c.job_id IS NOT NULL THEN COALESCE(NULLIF(btrim(j.job_number), ''), c.job_id::text)
           WHEN c.invoice_id IS NOT NULL THEN COALESCE(NULLIF(btrim(i.invoice_number), ''), c.invoice_id::text)
           ELSE c.id::text
         END
         OR s.customer_name IS DISTINCT FROM COALESCE(NULLIF(btrim(cu.farm_name), ''), NULLIF(btrim(c.customer_name), ''), '[Unknown customer]')
       )
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_LABEL_REPAIR_POSTCOND: recorder trust boundary or latest label snapshot differs';
  END IF;
END
$postflight$;
