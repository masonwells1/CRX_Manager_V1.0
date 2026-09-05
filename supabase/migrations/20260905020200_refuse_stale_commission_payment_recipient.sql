-- NOT APPLIED — DO NOT APPLY without Mason's explicit in-chat approval.
-- ============================================================================
-- Refuse a commission payment batch whose recipient became stale before post.
--
-- An unposted batch snapshots one recipient on its header. The earned-state
-- recorder permits a commission reassignment until settlement history exists.
-- The original settlement recorder then searched backward for the newest
-- event matching the OLD batch recipient, so A -> B after batch creation could
-- still post a settlement for A. This forward migration locks every referenced
-- commission, reads its latest earned-state event without recipient filtering,
-- and refuses the post unless every latest recipient matches the batch header.
-- Voids and already-correct posts retain their existing behavior.
-- ============================================================================

SET LOCAL lock_timeout = '10s';
LOCK TABLE public.commission_payments,
           public.commission_payment_items,
           public.commissions,
           public.commission_earned_state_ledger,
           public.commission_settlement_events
  IN SHARE ROW EXCLUSIVE MODE;

-- July moved authenticated writes behind SECURITY DEFINER RPCs by removing
-- permissive write policies. Remove the older table-level write grants too so
-- the catalog itself expresses that boundary instead of relying on RLS alone.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.commission_payments, public.commission_payment_items
  FROM PUBLIC, anon, authenticated;

DO $preflight$
BEGIN
  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'record_commission_settlement_event') <> 1
     OR (SELECT count(*)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'record_commission_earned_state') <> 1
     OR (SELECT count(*)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN (
                  'prevent_commission_history_ledger_mutation',
                  'prevent_commission_history_ledger_truncate'
                )) <> 2
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.record_commission_settlement_event()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND p.prosecdef
          AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND p.prorettype = 'trigger'::regtype
          AND p.provolatile = 'v'
          AND p.proparallel = 'u'
          AND NOT p.proisstrict
          AND NOT p.proleakproof
          AND NOT p.proretset
          AND p.procost = 100
          AND md5(p.prosrc) IN (
            'feb0f260fd2ad9e2945f761e93e9a3dc',
            '9054ce6c57f3e985e2b044385e07a6cd'
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
        WHERE p.oid = 'public.record_commission_settlement_event()'::regprocedure
          AND privilege.grantee <> p.proowner
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.record_commission_earned_state()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND p.prosecdef
          AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND p.prorettype = 'trigger'::regtype
          AND p.provolatile = 'v'
          AND p.proparallel = 'u'
          AND NOT p.proisstrict
          AND NOT p.proleakproof
          AND NOT p.proretset
          AND p.procost = 100
          AND md5(p.prosrc) = '5623b0d31181d357b303a36e563a77aa'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
        WHERE p.oid = 'public.record_commission_earned_state()'::regprocedure
          AND privilege.grantee <> p.proowner
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
        WHERE p.oid = 'public.prevent_commission_history_ledger_mutation()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND NOT p.prosecdef
          AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND p.prorettype = 'trigger'::regtype
          AND p.provolatile = 'v'
          AND p.proparallel = 'u'
          AND NOT p.proisstrict
          AND NOT p.proleakproof
          AND NOT p.proretset
          AND md5(p.prosrc) = 'f31a41a2b139f101074f95d2e361308f'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.prevent_commission_history_ledger_truncate()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND NOT p.prosecdef
          AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND p.prorettype = 'trigger'::regtype
          AND p.provolatile = 'v'
          AND p.proparallel = 'u'
          AND NOT p.proisstrict
          AND NOT p.proleakproof
          AND NOT p.proretset
          AND md5(p.prosrc) = 'add7928abcb610caedb7cfbea52b8602'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
        WHERE p.oid IN (
                'public.prevent_commission_history_ledger_mutation()'::regprocedure,
                'public.prevent_commission_history_ledger_truncate()'::regprocedure
              )
          AND privilege.grantee <> p.proowner
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
         FROM pg_class c
        WHERE c.oid IN (
                'public.commission_payments'::regclass,
                'public.commission_payment_items'::regclass
              )
          AND (
            c.relowner <> 'postgres'::regrole
            OR NOT c.relrowsecurity
            OR c.relforcerowsecurity
          )
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           ('public.commission_payments'::regclass, 'commission_payments_select_admin'),
           ('public.commission_payment_items'::regclass, 'commission_payment_items_select_admin')
         ) expected(table_oid, policy_name)
         LEFT JOIN pg_policy p
           ON p.polrelid = expected.table_oid
          AND p.polname = expected.policy_name
        WHERE p.oid IS NULL
           OR NOT p.polpermissive
           OR p.polcmd <> 'r'
           OR p.polroles <> ARRAY['authenticated'::regrole::oid]
           OR coalesce(pg_get_expr(p.polqual, p.polrelid), '') !~*
              '^\s*\(*\s*(SELECT\s+)?(public\.)?is_admin\s*\(\s*\)(\s+AS\s+is_admin)?\s*\)*\s*$'
           OR p.polwithcheck IS NOT NULL
     )
     OR (SELECT count(*)
           FROM pg_policy p
          WHERE p.polrelid IN (
                  'public.commission_payments'::regclass,
                  'public.commission_payment_items'::regclass
                )) <> 2
     OR EXISTS (
       SELECT 1
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) privilege
        WHERE c.oid IN (
                'public.commission_payments'::regclass,
                'public.commission_payment_items'::regclass
              )
          AND privilege.grantee IN (
                0,
                'anon'::regrole::oid,
                'authenticated'::regrole::oid
              )
          AND privilege.privilege_type IN (
                'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
              )
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           (
             'public.commission_payments'::regclass,
             'commission_payments_total_amount_whole_cents_chk',
             'CHECK (((total_amount IS NULL) OR ((total_amount = round(total_amount, 2)) AND (total_amount > ''-Infinity''::numeric) AND (total_amount < ''Infinity''::numeric))))'
           ),
           (
             'public.commission_payment_items'::regclass,
             'commission_payment_items_amount_whole_cents_chk',
             'CHECK (((amount IS NULL) OR ((amount = round(amount, 2)) AND (amount > ''-Infinity''::numeric) AND (amount < ''Infinity''::numeric))))'
           )
         ) expected(table_oid, constraint_name, constraint_definition)
         LEFT JOIN pg_constraint c
           ON c.conrelid = expected.table_oid
          AND c.conname = expected.constraint_name
          AND c.contype = 'c'
        WHERE c.oid IS NULL
           OR NOT c.convalidated
           OR pg_get_constraintdef(c.oid) <> expected.constraint_definition
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
     OR (SELECT count(*)
           FROM pg_policy p
          WHERE p.polrelid IN (
                  'public.commission_earned_state_ledger'::regclass,
                  'public.commission_settlement_events'::regclass
                )) <> 2
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
    RAISE EXCEPTION 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT: reviewed settlement recorder or earned ledger foundation differs';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.record_commission_settlement_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_expected_count bigint;
  v_written_count bigint;
  v_event_at timestamptz;
BEGIN
  IF OLD.status <> 'posted' AND NEW.status = 'posted' THEN
    IF auth.uid() IS NULL OR NEW.posted_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_POSTED_ACTOR_MISMATCH';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.commission_payment_items i
      WHERE i.commission_payment_id = NEW.id
        AND (
          i.amount IS NULL
          OR i.amount <> round(i.amount, 2)
          OR i.amount <= '-Infinity'::numeric
          OR i.amount >= 'Infinity'::numeric
          OR i.amount < 0
        )
    ) THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_INVALID_ITEM_AMOUNT';
    END IF;
    SELECT count(*) INTO v_expected_count
      FROM public.commission_payment_items i
     WHERE i.commission_payment_id = NEW.id;
    IF v_expected_count = 0 THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_ITEMS_REQUIRED';
    END IF;

    -- Serialize posting against recipient changes. Commission updates take the
    -- same row locks before their earned-state trigger runs, so either the
    -- reassignment lands first and this post sees/refuses it, or this post lands
    -- first and the existing post-settlement reassignment guard refuses it.
    PERFORM c.id
      FROM public.commission_payment_items i
      JOIN public.commissions c ON c.id = i.commission_id
     WHERE i.commission_payment_id = NEW.id
     ORDER BY c.id
     FOR UPDATE OF c;

    -- Capture the event boundary only after the lock is held. If posting had
    -- to wait for a concurrent reassignment, its newly appended earned event
    -- must be visible to the checks below.
    v_event_at := clock_timestamp();
    NEW.posted_at := v_event_at;

    -- Read the latest state OVERALL. Filtering by the payment header recipient
    -- here would deliberately find an older pre-reassignment event and recreate
    -- the bug this migration closes.
    IF EXISTS (
      SELECT 1
        FROM public.commission_payment_items i
        LEFT JOIN LATERAL (
          SELECT s.commission_id, s.recipient_id
            FROM public.commission_earned_state_ledger s
           WHERE s.commission_id = i.commission_id
             AND s.effective_at <= v_event_at
           ORDER BY s.effective_at DESC, s.id DESC
           LIMIT 1
        ) e ON true
       WHERE i.commission_payment_id = NEW.id
         AND (e.commission_id IS NULL OR e.recipient_id IS DISTINCT FROM NEW.recipient_id)
    ) THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_RECIPIENT_CHANGED: a commission recipient changed after this payment batch was created; void and recreate the batch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.commission_payment_items i
      CROSS JOIN LATERAL (
        SELECT s.order_date
        FROM public.commission_earned_state_ledger s
        WHERE s.commission_id = i.commission_id
          AND s.effective_at <= v_event_at
        ORDER BY s.effective_at DESC, s.id DESC
        LIMIT 1
      ) e
      WHERE i.commission_payment_id = NEW.id
        AND NEW.payment_date < e.order_date
    ) THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_PAYMENT_DATE_BEFORE_ORDER: payment_date cannot precede snapshotted commission order_date';
    END IF;
    INSERT INTO public.commission_settlement_events (
      commission_payment_id, commission_payment_item_id, commission_id, event_kind,
      effective_at, payment_number, payment_date, recipient_id, recipient_group_key,
      recipient_name, source_type, source_number, customer_name,
      commission_order_date, amount_cents
    )
    SELECT
      NEW.id, i.id, i.commission_id, 'posted', NEW.posted_at,
      NEW.payment_number, NEW.payment_date,
      NEW.recipient_id, e.recipient_group_key, e.recipient_name,
      e.source_type, e.source_number, e.customer_name, e.order_date,
      (round(i.amount, 2) * 100)::bigint
    FROM public.commission_payment_items i
    CROSS JOIN LATERAL (
      SELECT s.*
      FROM public.commission_earned_state_ledger s
      WHERE s.commission_id = i.commission_id
        AND s.effective_at <= v_event_at
      ORDER BY s.effective_at DESC, s.id DESC
      LIMIT 1
    ) e
    WHERE i.commission_payment_id = NEW.id;
    GET DIAGNOSTICS v_written_count = ROW_COUNT;
    IF v_written_count <> v_expected_count THEN
      RAISE EXCEPTION
        'COMMISSION_SETTLEMENT_HISTORY_MISMATCH: expected % item events, wrote %',
        v_expected_count, v_written_count;
    END IF;
  ELSIF OLD.status = 'posted' AND NEW.status = 'voided' THEN
    IF auth.uid() IS NULL OR NEW.voided_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_VOIDED_ACTOR_MISMATCH';
    END IF;
    v_event_at := clock_timestamp();
    NEW.voided_at := v_event_at;
    INSERT INTO public.commission_settlement_events (
      commission_payment_id, commission_payment_item_id, commission_id, event_kind,
      effective_at, payment_number, payment_date, recipient_id, recipient_group_key,
      recipient_name, source_type, source_number, customer_name,
      commission_order_date, amount_cents
    )
    SELECT
      p.commission_payment_id, p.commission_payment_item_id, p.commission_id, 'voided',
      v_event_at, p.payment_number, p.payment_date, p.recipient_id,
      p.recipient_group_key, p.recipient_name, p.source_type, p.source_number,
      p.customer_name, p.commission_order_date, -p.amount_cents
    FROM public.commission_settlement_events p
    WHERE p.commission_payment_id = NEW.id
      AND p.event_kind = 'posted';
    GET DIAGNOSTICS v_written_count = ROW_COUNT;
    SELECT count(*) INTO v_expected_count
      FROM public.commission_settlement_events p
     WHERE p.commission_payment_id = NEW.id
       AND p.event_kind = 'posted';
    IF v_written_count <> v_expected_count OR v_expected_count = 0 THEN
      RAISE EXCEPTION
        'COMMISSION_SETTLEMENT_VOID_HISTORY_MISMATCH: expected % reversal events, wrote %',
        v_expected_count, v_written_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_commission_settlement_event()
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT count(*)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'record_commission_settlement_event') <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = 'public.record_commission_settlement_event()'::regprocedure
          AND p.proowner = 'postgres'::regrole
          AND p.prosecdef
          AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
          AND p.prorettype = 'trigger'::regtype
          AND p.provolatile = 'v'
          AND p.proparallel = 'u'
          AND NOT p.proisstrict
          AND NOT p.proleakproof
          AND NOT p.proretset
          AND p.procost = 100
          AND md5(p.prosrc) = '9054ce6c57f3e985e2b044385e07a6cd'
          AND p.prosrc LIKE '%FOR UPDATE OF c%'
          AND p.prosrc LIKE '%COMMISSION_SETTLEMENT_RECIPIENT_CHANGED%'
          AND p.prosrc NOT LIKE '%s.recipient_id IS NOT DISTINCT FROM NEW.recipient_id%'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) privilege
        WHERE p.oid = 'public.record_commission_settlement_event()'::regprocedure
          AND privilege.grantee <> p.proowner
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
     ) THEN
    RAISE EXCEPTION 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_POSTCOND: settlement recorder contract differs';
  END IF;
END
$postflight$;
