-- idempotency-body-check: exempt
-- ============================================================================
-- Restore stable, ledger-backed commission history and reconciliation detail.
--
-- Historical boundary: pre-cutover earned-state versions were never recorded and
-- cannot be reconstructed honestly. The migration captures one immutable opening
-- observation at its real database transaction time; exact date-only reporting
-- begins on the first complete Chicago day after that cutover. Two older-model
-- cancelled rows have no recoverable cancellation timestamp or amount and enter
-- the opening observation as excluded legacy states.
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
  v_legacy_identity_digest text;
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
       )
       OR EXISTS (
         SELECT 1 FROM public.commissions
          WHERE deleted_at IS NOT NULL
             OR order_date IS NULL
             OR commission_amount IS NULL
             OR commission_amount <> round(commission_amount, 2)
             OR commission_amount <= '-Infinity'::numeric
             OR commission_amount >= 'Infinity'::numeric
       ) THEN
      RAISE EXCEPTION
        'COMMISSION_HISTORY_CHEAP_WINDOW_CLOSED: payout activity, soft deletion, or undated commission exists; reconstruct history before applying';
    END IF;

    SELECT count(*), md5(string_agg(id::text, ',' ORDER BY id))
      INTO v_cancelled_count, v_legacy_identity_digest
      FROM public.commissions
     WHERE status = 'cancelled';

    IF v_cancelled_count <> 2
       OR v_legacy_identity_digest IS DISTINCT FROM 'd2111549f1dc613edf9a31e4d152b096'
       OR EXISTS (
         SELECT 1
           FROM public.commissions
          WHERE status = 'cancelled'
            AND (
              order_date IS DISTINCT FROM DATE '2026-03-16'
              OR commission_amount IS DISTINCT FROM 0::numeric
            )
       ) THEN
      RAISE EXCEPTION
        'COMMISSION_HISTORY_CANCELLATION_DRIFT: expected exact reviewed two-row legacy cancellation identity set, found % rows',
        v_cancelled_count;
    END IF;
  END IF;

  -- First apply replaces two existing functions. Refuse any direct ACL drift
  -- before CREATE OR REPLACE / REVOKE can normalize and conceal it.
  IF v_history_columns = 0 AND EXISTS (
    SELECT 1
      FROM (
        SELECT p.oid AS function_oid,
               privilege.grantee,
               privilege.privilege_type,
               privilege.is_grantable,
               true AS actual_present
          FROM pg_proc p
          CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
          ) privilege
         WHERE p.oid = ANY (ARRAY[
           'public.get_commission_balance_report(date)'::regprocedure::oid,
           'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'::regprocedure::oid
         ])
           AND privilege.grantee <> p.proowner
      ) actual
      FULL JOIN (VALUES
        ('public.get_commission_balance_report(date)'::regprocedure::oid, 'authenticated'::regrole::oid, 'EXECUTE'::text, false, true),
        ('public.get_commission_balance_report(date)'::regprocedure::oid, 'service_role'::regrole::oid, 'EXECUTE'::text, false, true)
      ) expected(function_oid, grantee, privilege_type, is_grantable, expected_present)
      USING (function_oid, grantee, privilege_type, is_grantable)
     WHERE actual.actual_present IS NULL
        OR expected.expected_present IS NULL
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_FRESH_ACL_DRIFT: existing report or void implementation ACL differs';
  END IF;

  -- Zero NULL-history cancellations are accepted only while the complete
  -- commission subsystem is still a clean rebuild. Any populated lineage must
  -- retain the exact two reviewed live identities; every later cancellation
  -- carries ledger fields.
  IF v_history_columns = 4 THEN
    SELECT count(*), md5(string_agg(id::text, ',' ORDER BY id))
      INTO v_cancelled_count, v_legacy_identity_digest
      FROM public.commissions
     WHERE status = 'cancelled'
       AND cancelled_at IS NULL
       AND cancelled_amount_cents IS NULL;

    IF (
         NOT EXISTS (SELECT 1 FROM public.commissions)
         AND NOT EXISTS (SELECT 1 FROM public.commission_payments)
         AND NOT EXISTS (SELECT 1 FROM public.commission_payment_items)
         AND v_cancelled_count = 0
       ) THEN
      NULL;
    ELSIF v_cancelled_count <> 2
       OR v_legacy_identity_digest IS DISTINCT FROM 'd2111549f1dc613edf9a31e4d152b096'
       OR EXISTS (
         SELECT 1
           FROM public.commissions
          WHERE status = 'cancelled'
            AND cancelled_at IS NULL
            AND cancelled_amount_cents IS NULL
            AND (
              order_date IS DISTINCT FROM DATE '2026-03-16'
              OR commission_amount IS DISTINCT FROM 0::numeric
            )
       ) THEN
      RAISE EXCEPTION
        'COMMISSION_HISTORY_REPLAY_DRIFT: NULL-history cancellations differ from the exact reviewed identity set (% rows)',
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
        AND proname IN (
          'get_commission_payment_detail_report', 'stamp_commission_cancellation_history',
          'record_commission_earned_state', 'record_commission_settlement_event',
          'prevent_commission_history_ledger_mutation', 'prevent_commission_history_ledger_truncate'
        )
    ) OR to_regclass('public.commission_earned_state_ledger') IS NOT NULL
      OR to_regclass('public.commission_settlement_events') IS NOT NULL
      OR to_regclass('public.commission_history_cutover') IS NOT NULL
      OR EXISTS (
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
    IF v_void_body_md5 <> '985fb1a42ab3b4d911c68898c14ce637'
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc
          WHERE oid = 'public.get_commission_payment_detail_report(date)'::regprocedure
            AND proowner = 'postgres'::regrole
            AND prosecdef
            AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
            AND md5(prosrc) = '304e4e87fb9d7b9426ea57ca59aad9a2'
            AND prosrc LIKE '%commission_settlement_events%'
       ) OR NOT EXISTS (
         SELECT 1 FROM pg_proc
          WHERE oid = 'public.stamp_commission_cancellation_history()'::regprocedure
            AND proowner = 'postgres'::regrole
            AND NOT prosecdef
            AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
            AND md5(prosrc) = '44fc20fd4b84be893460cab96fe0eb7d'
            AND prosrc LIKE '%cancelled commissions cannot be reopened%'
       ) OR NOT EXISTS (
         SELECT 1 FROM pg_proc
          WHERE oid = 'public.get_commission_balance_report(date)'::regprocedure
            AND proowner = 'postgres'::regrole
            AND prosecdef
            AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
            AND md5(prosrc) = '97fa0f552420f6918bf02a55d95b6a54'
            AND prosrc LIKE '%commission_earned_state_ledger%'
            AND prosrc LIKE '%commission_settlement_events%'
       ) OR to_regclass('public.commission_earned_state_ledger') IS NULL
         OR to_regclass('public.commission_settlement_events') IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.commission_earned_state_ledger
         ) AND EXISTS (SELECT 1 FROM public.commissions)
         OR EXISTS (
           SELECT 1 FROM pg_class c
           WHERE c.oid IN ('public.commission_earned_state_ledger'::regclass, 'public.commission_settlement_events'::regclass)
             AND (c.relowner <> 'postgres'::regrole OR NOT c.relrowsecurity)
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
       OR has_function_privilege('anon', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
       OR has_function_privilege('anon', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
       OR has_function_privilege('service_role', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM (
             SELECT p.oid AS function_oid,
                    privilege.grantee,
                    privilege.privilege_type,
                    privilege.is_grantable,
                    true AS actual_present
               FROM pg_proc p
               CROSS JOIN LATERAL aclexplode(
                 COALESCE(p.proacl, acldefault('f', p.proowner))
               ) privilege
              WHERE p.oid = ANY (ARRAY[
                'public.get_commission_balance_report(date)'::regprocedure::oid,
                'public.get_commission_payment_detail_report(date)'::regprocedure::oid,
                'public.stamp_commission_cancellation_history()'::regprocedure::oid,
                'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'::regprocedure::oid
              ])
                AND privilege.grantee <> p.proowner
           ) actual
           FULL JOIN (VALUES
             ('public.get_commission_balance_report(date)'::regprocedure::oid, 'authenticated'::regrole::oid, 'EXECUTE'::text, false, true),
             ('public.get_commission_balance_report(date)'::regprocedure::oid, 'service_role'::regrole::oid, 'EXECUTE'::text, false, true),
             ('public.get_commission_payment_detail_report(date)'::regprocedure::oid, 'authenticated'::regrole::oid, 'EXECUTE'::text, false, true),
             ('public.get_commission_payment_detail_report(date)'::regprocedure::oid, 'service_role'::regrole::oid, 'EXECUTE'::text, false, true)
           ) expected(function_oid, grantee, privilege_type, is_grantable, expected_present)
           USING (function_oid, grantee, privilege_type, is_grantable)
          WHERE actual.actual_present IS NULL
             OR expected.expected_present IS NULL
       ) THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: FK, trigger, or grant boundary differs';
    END IF;
  END IF;
END
$precondition$;

-- Reapplication is permitted only over the exact private ledger boundary. Run
-- this before any CREATE OR REPLACE / REVOKE statement could normalize drift.
DO $ledger_replay_guard$
DECLARE
  v_earned regclass := to_regclass('public.commission_earned_state_ledger');
  v_settlement regclass := to_regclass('public.commission_settlement_events');
  v_cutover regclass := to_regclass('public.commission_history_cutover');
BEGIN
  IF (v_earned IS NULL) <> (v_settlement IS NULL)
     OR (v_earned IS NULL) <> (v_cutover IS NULL) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: partial ledger or cutover table set';
  END IF;
  IF v_earned IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid IN (v_earned, v_settlement, v_cutover)
       AND (c.relowner <> 'postgres'::regrole OR NOT c.relrowsecurity OR c.relforcerowsecurity)
  ) OR EXISTS (
    SELECT 1
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
     WHERE c.oid IN (v_earned, v_settlement, v_cutover)
       AND a.grantee <> c.relowner
  ) OR EXISTS (
    SELECT 1
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) a
     WHERE c.oid IN (
       'public.commission_earned_state_ledger_id_seq'::regclass,
       'public.commission_settlement_events_id_seq'::regclass
     )
       AND a.grantee <> c.relowner
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: ledger RLS, owner, or ACL boundary differs';
  END IF;

  IF (SELECT count(*) FROM public.commission_history_cutover) <> 1
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commission_history_cutover') <> 6
     OR EXISTS (
       SELECT 1 FROM (VALUES
         ('singleton', 'boolean'), ('cutover_at', 'timestamp with time zone'),
         ('first_supported_date', 'date'), ('opening_commission_count', 'bigint'),
         ('opening_commission_digest', 'text'), ('created_at', 'timestamp with time zone')
       ) expected(column_name, data_type)
       LEFT JOIN information_schema.columns c
         ON c.table_schema = 'public' AND c.table_name = 'commission_history_cutover'
        AND c.column_name = expected.column_name AND c.data_type = expected.data_type
       WHERE c.column_name IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.commission_history_cutover
       WHERE singleton
         AND first_supported_date = ((cutover_at AT TIME ZONE 'America/Chicago')::date + 1)
         AND opening_commission_count >= 0
         AND opening_commission_digest ~ '^[0-9a-f]{32}$'
         AND created_at = cutover_at
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('commission_history_cutover_singleton_chk'),
         ('commission_history_cutover_first_complete_day_chk'),
         ('commission_history_cutover_opening_count_non_negative_chk'),
         ('commission_history_cutover_opening_digest_chk'),
         ('commission_history_cutover_created_at_chk')
       ) expected(constraint_name)
       LEFT JOIN pg_constraint c
         ON c.conrelid = v_cutover
        AND c.conname = expected.constraint_name
        AND c.contype = 'c'
        AND c.convalidated
       WHERE c.oid IS NULL
     ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: immutable cutover metadata differs';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    WHERE x.indrelid = v_earned
      AND i.relname = 'commission_earned_state_ledger_one_opening_idx'
      AND x.indisunique AND x.indisvalid AND x.indisready
      AND x.indnkeyatts = 1 AND x.indnatts = 1
      AND pg_get_indexdef(i.oid) LIKE '%(commission_id)%'
      AND pg_get_expr(x.indpred, x.indrelid) LIKE '%event_kind%baseline%legacy_excluded%'
  ) OR EXISTS (
    SELECT 1 FROM public.commission_earned_state_ledger
    WHERE event_kind IN ('baseline', 'legacy_excluded')
    GROUP BY commission_id HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM public.commission_earned_state_ledger s
    CROSS JOIN public.commission_history_cutover m
    WHERE s.event_kind IN ('baseline', 'legacy_excluded')
      AND (s.effective_at IS DISTINCT FROM m.cutover_at OR s.recorded_by IS NOT NULL)
  ) OR (SELECT count(*) FROM public.commission_earned_state_ledger WHERE event_kind IN ('baseline', 'legacy_excluded'))
       <> (SELECT opening_commission_count FROM public.commission_history_cutover)
    OR (SELECT COALESCE(md5(string_agg(commission_id::text, ',' ORDER BY commission_id)), md5(''))
          FROM public.commission_earned_state_ledger
         WHERE event_kind IN ('baseline', 'legacy_excluded'))
       <> (SELECT opening_commission_digest FROM public.commission_history_cutover)
    OR EXISTS (
      SELECT 1 FROM public.commissions c
      WHERE NOT EXISTS (
        SELECT 1 FROM public.commission_earned_state_ledger s WHERE s.commission_id = c.id
      )
    ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: opening observation or ledger coverage differs';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = ANY (ARRAY[
       'public.record_commission_earned_state()'::regprocedure::oid,
       'public.record_commission_settlement_event()'::regprocedure::oid
     ])
       AND (p.proowner <> 'postgres'::regrole OR NOT p.prosecdef
         OR NOT p.proconfig @> ARRAY['search_path=public, pg_temp']::text[])
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = ANY (ARRAY[
       'public.prevent_commission_history_ledger_mutation()'::regprocedure::oid,
       'public.prevent_commission_history_ledger_truncate()'::regprocedure::oid
     ])
       AND (p.proowner <> 'postgres'::regrole OR p.prosecdef
         OR NOT p.proconfig @> ARRAY['search_path=public, pg_temp']::text[])
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = ANY (ARRAY[
       'public.record_commission_earned_state()'::regprocedure::oid,
       'public.record_commission_settlement_event()'::regprocedure::oid,
       'public.prevent_commission_history_ledger_mutation()'::regprocedure::oid,
       'public.prevent_commission_history_ledger_truncate()'::regprocedure::oid
     ])
       AND a.grantee <> p.proowner
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.record_commission_earned_state()'::regprocedure
       AND md5(prosrc) = 'dc0577e8e694773e75a1c8099819ba6c'
       AND prosrc LIKE '%clock_timestamp()%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.record_commission_settlement_event()'::regprocedure
       AND md5(prosrc) = '2d4d8f2df557f125415e208a7e198ded'
       AND prosrc LIKE '%NEW.posted_at := v_event_at%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.prevent_commission_history_ledger_mutation()'::regprocedure
       AND md5(prosrc) = 'f31a41a2b139f101074f95d2e361308f'
       AND prosrc LIKE '%IMMUTABLE%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.prevent_commission_history_ledger_truncate()'::regprocedure
       AND md5(prosrc) = 'add7928abcb610caedb7cfbea52b8602'
       AND prosrc LIKE '%cannot be truncated%'
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: private ledger function trust or ACL differs';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        (v_earned, 'trg_commission_earned_state_ledger_immutable', 27::smallint, 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
        (v_earned, 'trg_commission_earned_state_ledger_no_truncate', 34::smallint, 'public.prevent_commission_history_ledger_truncate()'::regprocedure),
        (v_settlement, 'trg_commission_settlement_events_immutable', 27::smallint, 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
        (v_settlement, 'trg_commission_settlement_events_no_truncate', 34::smallint, 'public.prevent_commission_history_ledger_truncate()'::regprocedure),
        (v_cutover, 'trg_commission_history_cutover_immutable', 27::smallint, 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
        (v_cutover, 'trg_commission_history_cutover_no_truncate', 34::smallint, 'public.prevent_commission_history_ledger_truncate()'::regprocedure),
        ('public.commissions'::regclass, 'trg_commissions_record_earned_state', 21::smallint, 'public.record_commission_earned_state()'::regprocedure),
        ('public.commission_payments'::regclass, 'trg_commission_payments_record_settlement_event', 19::smallint, 'public.record_commission_settlement_event()'::regprocedure)
      ) expected(table_oid, trigger_name, trigger_type, function_oid)
      LEFT JOIN pg_trigger t
        ON t.tgrelid = expected.table_oid
       AND t.tgname = expected.trigger_name
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
       AND t.tgtype = expected.trigger_type
       AND t.tgfoid = expected.function_oid
       AND t.tgqual IS NULL
       AND t.tgnargs = 0
       AND octet_length(t.tgargs) = 0
     WHERE t.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: ledger trigger catalog differs';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.commission_payments'::regclass
      AND t.tgname = 'trg_commission_payments_record_settlement_event'
      AND t.tgattr::text = (SELECT attnum::text FROM pg_attribute WHERE attrelid = 'public.commission_payments'::regclass AND attname = 'status' AND NOT attisdropped)
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: settlement trigger must pin UPDATE OF status';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.commissions'::regclass
      AND t.tgname = 'trg_commissions_record_earned_state'
      AND t.tgattr::text = ''
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.commissions'::regclass
      AND t.tgname = 'trg_commissions_stamp_cancellation_history'
      AND t.tgattr::text = ''
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: broad commission history trigger catalog differs';
  END IF;

  IF (SELECT count(*) FROM pg_policy WHERE polrelid IN (v_earned, v_settlement, v_cutover)) <> 3
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           (v_earned, 'commission_earned_state_ledger_admin_select'),
           (v_settlement, 'commission_settlement_events_admin_select'),
           (v_cutover, 'commission_history_cutover_admin_select')
         ) expected(table_oid, policy_name)
         LEFT JOIN pg_policy p
           ON p.polrelid = expected.table_oid
          AND p.polname = expected.policy_name
          AND p.polcmd = 'r'
          AND p.polroles = ARRAY['authenticated'::regrole::oid]
          AND pg_get_expr(p.polqual, p.polrelid) = 'is_admin()'
          AND p.polwithcheck IS NULL
        WHERE p.oid IS NULL
     ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_REPLAY_DRIFT: ledger policy catalog differs';
  END IF;
END
$ledger_replay_guard$;

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
  -- Check the caller's proposed values before any convenience backfill can
  -- hide a label rewrite attempt.
  IF TG_OP = 'UPDATE' AND OLD.order_number IS NOT NULL AND NEW.order_number IS DISTINCT FROM OLD.order_number THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_ORDER_LABEL_IMMUTABLE: order_number cannot change after it is frozen';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.customer_name IS NOT NULL AND NEW.customer_name IS DISTINCT FROM OLD.customer_name THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_CUSTOMER_LABEL_IMMUTABLE: customer_name cannot change after it is frozen';
  END IF;
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
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'cancelled' THEN
      IF NEW.commission_amount IS NULL
         OR NEW.commission_amount <> round(NEW.commission_amount, 2)
         OR NEW.commission_amount <= '-Infinity'::numeric
         OR NEW.commission_amount >= 'Infinity'::numeric THEN
        RAISE EXCEPTION 'COMMISSION_HISTORY_CANCELLATION_AMOUNT_INVALID: cancelled commission % requires a finite whole-cent amount', NEW.id;
      END IF;
      NEW.cancelled_at := clock_timestamp();
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
    IF OLD.commission_amount IS NULL
       OR OLD.commission_amount <> round(OLD.commission_amount, 2)
       OR OLD.commission_amount <= '-Infinity'::numeric
       OR OLD.commission_amount >= 'Infinity'::numeric THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_CANCELLATION_AMOUNT_INVALID: commission % requires a finite whole-cent pre-cancellation amount', NEW.id;
    END IF;
    NEW.cancelled_at := clock_timestamp();
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

-- One immutable cutover record defines the first complete reportable Chicago
-- day.  Opening rows are observations at this real database transaction time,
-- never invented back at an order date that predates the ledger.
CREATE TABLE IF NOT EXISTS public.commission_history_cutover (
  singleton boolean PRIMARY KEY DEFAULT true,
  cutover_at timestamptz NOT NULL,
  first_supported_date date NOT NULL,
  opening_commission_count bigint NOT NULL,
  opening_commission_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT commission_history_cutover_singleton_chk CHECK (singleton),
  CONSTRAINT commission_history_cutover_first_complete_day_chk
    CHECK (first_supported_date = ((cutover_at AT TIME ZONE 'America/Chicago')::date + 1)),
  CONSTRAINT commission_history_cutover_opening_count_non_negative_chk
    CHECK (opening_commission_count >= 0),
  CONSTRAINT commission_history_cutover_opening_digest_chk
    CHECK (opening_commission_digest ~ '^[0-9a-f]{32}$'),
  CONSTRAINT commission_history_cutover_created_at_chk CHECK (created_at = cutover_at)
);

ALTER TABLE public.commission_history_cutover OWNER TO postgres;
ALTER TABLE public.commission_history_cutover ENABLE ROW LEVEL SECURITY;
DO $cutover_policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.commission_history_cutover'::regclass AND polname = 'commission_history_cutover_admin_select') THEN
    CREATE POLICY commission_history_cutover_admin_select ON public.commission_history_cutover FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
END
$cutover_policy$;
REVOKE ALL ON TABLE public.commission_history_cutover FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DO $cutover_seed$
DECLARE
  v_cutover_at timestamptz := transaction_timestamp();
  v_count bigint;
  v_digest text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.commission_history_cutover) THEN
    IF to_regclass('public.commission_earned_state_ledger') IS NOT NULL THEN
      RAISE EXCEPTION 'COMMISSION_HISTORY_CUTOVER_DRIFT: an event ledger exists without immutable cutover metadata';
    END IF;
    SELECT count(*), COALESCE(md5(string_agg(id::text, ',' ORDER BY id)), md5(''))
      INTO v_count, v_digest
      FROM public.commissions;
    INSERT INTO public.commission_history_cutover (
      singleton, cutover_at, first_supported_date,
      opening_commission_count, opening_commission_digest
    ) VALUES (
      true, v_cutover_at,
      ((v_cutover_at AT TIME ZONE 'America/Chicago')::date + 1),
      v_count, v_digest
    );
  ELSIF (SELECT count(*) FROM public.commission_history_cutover) <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_CUTOVER_DRIFT: expected exactly one cutover row';
  END IF;
END
$cutover_seed$;

-- These are append-only reporting ledgers, not mutable caches. Opening rows are
-- observations of the pre-payout population at the immutable cutover timestamp;
-- they are never backdated to an order date. Every later state transition is
-- effective at its actual wall-clock mutation time. Exact date-only reporting
-- starts with the first complete Chicago day after cutover.
-- `updated_at` is intentionally absent: both ledgers reject every UPDATE, so
-- an automatically-mutated timestamp would contradict their audit contract.
CREATE TABLE IF NOT EXISTS public.commission_earned_state_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id uuid NOT NULL REFERENCES public.commissions(id) ON DELETE RESTRICT,
  event_kind text NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  recorded_by uuid,
  recipient_id uuid,
  recipient_group_key text NOT NULL,
  recipient_name text NOT NULL,
  source_type text NOT NULL,
  source_number text NOT NULL,
  customer_name text NOT NULL,
  order_date date NOT NULL,
  amount_cents bigint NOT NULL,
  is_earned boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT commission_earned_state_ledger_event_kind_chk
    CHECK (event_kind IN ('baseline', 'legacy_excluded', 'inserted', 'revised', 'cancelled', 'soft_deleted', 'restored')),
  CONSTRAINT commission_earned_state_ledger_source_type_chk
    CHECK (source_type IN ('order', 'job', 'invoice', 'commission')),
  CONSTRAINT commission_earned_state_ledger_amount_cents_non_negative_chk
    CHECK (amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS commission_earned_state_ledger_as_of_idx
  ON public.commission_earned_state_ledger (commission_id, effective_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS commission_earned_state_ledger_recipient_as_of_idx
  ON public.commission_earned_state_ledger (recipient_group_key, effective_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS commission_earned_state_ledger_one_opening_idx
  ON public.commission_earned_state_ledger (commission_id)
  WHERE event_kind IN ('baseline', 'legacy_excluded');

ALTER TABLE public.commission_earned_state_ledger ENABLE ROW LEVEL SECURITY;
DO $earned_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.commission_earned_state_ledger'::regclass
      AND polname = 'commission_earned_state_ledger_admin_select'
  ) THEN
    CREATE POLICY commission_earned_state_ledger_admin_select
      ON public.commission_earned_state_ledger
      FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END
$earned_policy$;

CREATE TABLE IF NOT EXISTS public.commission_settlement_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_payment_id uuid NOT NULL REFERENCES public.commission_payments(id) ON DELETE RESTRICT,
  commission_payment_item_id uuid NOT NULL REFERENCES public.commission_payment_items(id) ON DELETE RESTRICT,
  commission_id uuid NOT NULL REFERENCES public.commissions(id) ON DELETE RESTRICT,
  event_kind text NOT NULL,
  effective_at timestamptz NOT NULL,
  payment_number text NOT NULL,
  payment_date date NOT NULL,
  recipient_id uuid,
  recipient_group_key text NOT NULL,
  recipient_name text NOT NULL,
  source_type text NOT NULL,
  source_number text NOT NULL,
  customer_name text NOT NULL,
  commission_order_date date NOT NULL,
  amount_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT commission_settlement_events_event_kind_chk
    CHECK (event_kind IN ('posted', 'voided')),
  CONSTRAINT commission_settlement_events_event_amount_direction_chk
    CHECK ((event_kind = 'posted' AND amount_cents > 0)
        OR (event_kind = 'voided' AND amount_cents < 0)),
  CONSTRAINT commission_settlement_events_item_event_kind_key
    UNIQUE (commission_payment_item_id, event_kind)
);

ALTER TABLE public.commission_earned_state_ledger OWNER TO postgres;
ALTER TABLE public.commission_settlement_events OWNER TO postgres;
ALTER SEQUENCE public.commission_earned_state_ledger_id_seq OWNER TO postgres;
ALTER SEQUENCE public.commission_settlement_events_id_seq OWNER TO postgres;

CREATE INDEX IF NOT EXISTS commission_settlement_events_as_of_idx
  ON public.commission_settlement_events (effective_at, recipient_group_key, commission_id);
CREATE INDEX IF NOT EXISTS commission_settlement_events_item_idx
  ON public.commission_settlement_events (commission_payment_item_id, effective_at);

ALTER TABLE public.commission_settlement_events ENABLE ROW LEVEL SECURITY;
DO $settlement_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.commission_settlement_events'::regclass
      AND polname = 'commission_settlement_events_admin_select'
  ) THEN
    CREATE POLICY commission_settlement_events_admin_select
      ON public.commission_settlement_events
      FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END
$settlement_policy$;

-- The report functions own all application access.  Do not hand users direct
-- table or sequence privileges merely because the tables carry a SELECT policy.
-- The postgres owner deliberately bypasses RLS so SECURITY DEFINER report and
-- recorder functions can work; a database superuser is outside application
-- immutability controls and remains an operational trust boundary.
REVOKE ALL ON TABLE public.commission_earned_state_ledger FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON TABLE public.commission_settlement_events FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.commission_earned_state_ledger_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON SEQUENCE public.commission_settlement_events_id_seq FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE OR REPLACE FUNCTION public.prevent_commission_history_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'COMMISSION_HISTORY_LEDGER_IMMUTABLE: % events are append-only', TG_TABLE_NAME;
END;
$function$;
REVOKE ALL ON FUNCTION public.prevent_commission_history_ledger_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_commission_history_ledger_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'COMMISSION_HISTORY_LEDGER_IMMUTABLE: % cannot be truncated', TG_TABLE_NAME;
END;
$function$;
REVOKE ALL ON FUNCTION public.prevent_commission_history_ledger_truncate()
  FROM PUBLIC, anon, authenticated, service_role;

DO $ledger_triggers$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_earned_state_ledger'::regclass AND tgname = 'trg_commission_earned_state_ledger_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_earned_state_ledger_immutable BEFORE UPDATE OR DELETE ON public.commission_earned_state_ledger FOR EACH ROW EXECUTE FUNCTION public.prevent_commission_history_ledger_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_history_cutover'::regclass AND tgname = 'trg_commission_history_cutover_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_history_cutover_immutable BEFORE UPDATE OR DELETE ON public.commission_history_cutover FOR EACH ROW EXECUTE FUNCTION public.prevent_commission_history_ledger_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_history_cutover'::regclass AND tgname = 'trg_commission_history_cutover_no_truncate' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_history_cutover_no_truncate BEFORE TRUNCATE ON public.commission_history_cutover FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_commission_history_ledger_truncate();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_earned_state_ledger'::regclass AND tgname = 'trg_commission_earned_state_ledger_no_truncate' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_earned_state_ledger_no_truncate BEFORE TRUNCATE ON public.commission_earned_state_ledger FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_commission_history_ledger_truncate();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_settlement_events'::regclass AND tgname = 'trg_commission_settlement_events_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_settlement_events_immutable BEFORE UPDATE OR DELETE ON public.commission_settlement_events FOR EACH ROW EXECUTE FUNCTION public.prevent_commission_history_ledger_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_settlement_events'::regclass AND tgname = 'trg_commission_settlement_events_no_truncate' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_settlement_events_no_truncate BEFORE TRUNCATE ON public.commission_settlement_events FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_commission_history_ledger_truncate();
  END IF;
END
$ledger_triggers$;

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
    COALESCE(NULLIF(btrim(NEW.order_number), ''), NEW.order_id::text, NEW.job_id::text, NEW.invoice_id::text, NEW.id::text),
    COALESCE(NULLIF(btrim(NEW.customer_name), ''), '[Unknown customer]'),
    NEW.order_date,
    (round(NEW.commission_amount, 2) * 100)::bigint,
    NEW.status <> 'cancelled' AND NEW.deleted_at IS NULL
  );
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_commission_earned_state()
  FROM PUBLIC, anon, authenticated, service_role;

DO $earned_recorder_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commissions'::regclass AND tgname = 'trg_commissions_record_earned_state' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commissions_record_earned_state AFTER INSERT OR UPDATE ON public.commissions FOR EACH ROW EXECUTE FUNCTION public.record_commission_earned_state();
  END IF;
END
$earned_recorder_trigger$;

-- The table locks at the top of this transaction close the baseline/trigger
-- race: no commission can change after its opening event is selected but before
-- the recorder trigger exists.
INSERT INTO public.commission_earned_state_ledger (
  commission_id, event_kind, effective_at, recorded_by,
  recipient_id, recipient_group_key, recipient_name,
  source_type, source_number, customer_name, order_date, amount_cents, is_earned
)
SELECT
  c.id,
  CASE WHEN c.status = 'cancelled' THEN 'legacy_excluded' ELSE 'baseline' END,
  m.cutover_at,
  NULL::uuid,
  c.recipient_user_id,
  COALESCE('user:' || c.recipient_user_id::text,
           NULLIF('name:' || lower(btrim(c.recipient)), 'name:'),
           'commission:' || c.id::text),
  COALESCE(NULLIF(btrim(c.recipient), ''), '[Unknown recipient]'),
  CASE WHEN c.order_id IS NOT NULL THEN 'order'
       WHEN c.job_id IS NOT NULL THEN 'job'
       WHEN c.invoice_id IS NOT NULL THEN 'invoice'
       ELSE 'commission' END,
  COALESCE(NULLIF(btrim(c.order_number), ''), c.order_id::text, c.job_id::text, c.invoice_id::text, c.id::text),
  COALESCE(NULLIF(btrim(c.customer_name), ''), '[Unknown customer]'),
  c.order_date,
  (round(c.commission_amount, 2) * 100)::bigint,
  c.status <> 'cancelled' AND c.deleted_at IS NULL
FROM public.commissions c
CROSS JOIN public.commission_history_cutover m
WHERE m.cutover_at = transaction_timestamp()
  AND NOT EXISTS (SELECT 1 FROM public.commission_earned_state_ledger);

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
    v_event_at := clock_timestamp();
    NEW.posted_at := v_event_at;
    IF EXISTS (
      SELECT 1 FROM public.commission_payment_items i
      WHERE i.commission_payment_id = NEW.id
        AND (i.amount IS NULL OR round(i.amount, 2) <= 0)
    ) THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_INVALID_ITEM_AMOUNT';
    END IF;
    SELECT count(*) INTO v_expected_count
      FROM public.commission_payment_items i
     WHERE i.commission_payment_id = NEW.id;
    IF v_expected_count = 0 THEN
      RAISE EXCEPTION 'COMMISSION_SETTLEMENT_ITEMS_REQUIRED';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.commission_payment_items i
      CROSS JOIN LATERAL (
        SELECT s.order_date
        FROM public.commission_earned_state_ledger s
        WHERE s.commission_id = i.commission_id
          AND s.recipient_id IS NOT DISTINCT FROM NEW.recipient_id
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
        AND s.recipient_id IS NOT DISTINCT FROM NEW.recipient_id
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

DO $settlement_recorder_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.commission_payments'::regclass AND tgname = 'trg_commission_payments_record_settlement_event' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_commission_payments_record_settlement_event BEFORE UPDATE OF status ON public.commission_payments FOR EACH ROW EXECUTE FUNCTION public.record_commission_settlement_event();
  END IF;
END
$settlement_recorder_trigger$;

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
  v_history_start_date date;
BEGIN
  PERFORM public.require_admin();
  SELECT first_supported_date INTO v_history_start_date
  FROM public.commission_history_cutover WHERE singleton;
  IF v_history_start_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_CUTOVER_UNAVAILABLE';
  END IF;

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
  WITH cutoff AS (
    SELECT ((p_as_of_date + 1)::timestamp AT TIME ZONE 'America/Chicago') AS at
  ), latest_state AS (
    SELECT DISTINCT ON (s.commission_id) s.*
    FROM public.commission_earned_state_ledger s
    CROSS JOIN cutoff c
    WHERE s.effective_at < c.at
    ORDER BY s.commission_id, s.effective_at DESC, s.id DESC
  ), settlement_by_commission_recipient AS (
    SELECT
      se.commission_id,
      se.recipient_group_key,
      MIN(se.recipient_id::text)::uuid AS recipient_id,
      MIN(se.recipient_name) AS recipient_name,
      SUM(se.amount_cents) AS paid_cents
    FROM public.commission_settlement_events se
    CROSS JOIN cutoff c
    WHERE se.effective_at < c.at
      AND se.payment_date <= p_as_of_date
    GROUP BY se.commission_id, se.recipient_group_key
  ), earned_by_recipient AS (
    SELECT
      s.recipient_group_key,
      MIN(s.recipient_id::text)::uuid AS recipient_id,
      MIN(s.recipient_name) AS recipient_name,
      SUM(s.amount_cents) AS earned_cents,
      COUNT(*) FILTER (WHERE COALESCE(p.paid_cents, 0) < s.amount_cents) AS pending_count,
      COUNT(*) FILTER (WHERE COALESCE(p.paid_cents, 0) >= s.amount_cents) AS paid_count
    FROM latest_state s
    LEFT JOIN settlement_by_commission_recipient p
      ON p.commission_id = s.commission_id
     AND p.recipient_group_key = s.recipient_group_key
    WHERE s.is_earned
      AND s.order_date <= p_as_of_date
    GROUP BY s.recipient_group_key
  ), paid_by_recipient AS (
    SELECT
      p.recipient_group_key,
      MIN(p.recipient_id::text)::uuid AS recipient_id,
      MIN(p.recipient_name) AS recipient_name,
      SUM(p.paid_cents) AS paid_cents,
      COUNT(*) FILTER (
        WHERE p.paid_cents > 0
          AND NOT EXISTS (
            SELECT 1 FROM latest_state s
            WHERE s.commission_id = p.commission_id
              AND s.recipient_group_key = p.recipient_group_key
              AND s.is_earned
              AND s.order_date <= p_as_of_date
          )
      ) AS paid_only_count
    FROM settlement_by_commission_recipient p
    GROUP BY p.recipient_group_key
  )
  SELECT
    COALESCE(e.recipient_id, p.recipient_id),
    COALESCE(e.recipient_name, p.recipient_name),
    COALESCE(e.earned_cents, 0)::numeric / 100::numeric,
    COALESCE(p.paid_cents, 0)::numeric / 100::numeric,
    (COALESCE(e.earned_cents, 0) - COALESCE(p.paid_cents, 0))::numeric / 100::numeric,
    COALESCE(e.pending_count, 0),
    COALESCE(e.paid_count, 0) + COALESCE(p.paid_only_count, 0)
  FROM earned_by_recipient e
  FULL OUTER JOIN paid_by_recipient p
    ON p.recipient_group_key = e.recipient_group_key
  WHERE e.recipient_group_key IS NOT NULL OR p.paid_cents <> 0
  ORDER BY (COALESCE(e.earned_cents, 0) - COALESCE(p.paid_cents, 0)) DESC,
           COALESCE(e.recipient_name, p.recipient_name);
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
  v_history_start_date date;
BEGIN
  PERFORM public.require_admin();
  SELECT first_supported_date INTO v_history_start_date
  FROM public.commission_history_cutover WHERE singleton;
  IF v_history_start_date IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_CUTOVER_UNAVAILABLE';
  END IF;

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
  WITH cutoff AS (
    SELECT ((p_as_of_date + 1)::timestamp AT TIME ZONE 'America/Chicago') AS at
  ), settled_item AS (
    SELECT
      se.commission_payment_id,
      se.commission_payment_item_id,
      se.payment_number,
      se.payment_date,
      se.recipient_id,
      se.recipient_name,
      se.commission_id,
      se.source_type,
      se.source_number,
      se.customer_name,
      se.commission_order_date,
      SUM(se.amount_cents) AS settled_cents
    FROM public.commission_settlement_events se
    CROSS JOIN cutoff c
    WHERE se.effective_at < c.at
      AND se.payment_date <= p_as_of_date
    GROUP BY se.commission_payment_id, se.commission_payment_item_id,
             se.payment_number, se.payment_date, se.recipient_id,
             se.recipient_name, se.commission_id, se.source_type,
             se.source_number, se.customer_name, se.commission_order_date
    HAVING SUM(se.amount_cents) <> 0
  )
  SELECT
    si.commission_payment_id,
    si.payment_number,
    si.payment_date,
    si.recipient_id,
    si.recipient_name,
    si.commission_id,
    si.source_type,
    si.source_number,
    si.customer_name,
    si.commission_order_date,
    si.settled_cents::numeric / 100::numeric
  FROM settled_item si
  ORDER BY si.payment_date, si.payment_number, si.commission_order_date, si.commission_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_commission_payment_detail_report(date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_commission_payment_detail_report(date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_commission_balance_report(date) IS
  'Admin-only exact commission earned, paid, and outstanding balances from the immutable cutover''s first complete Chicago day through Chicago-today; earlier dates fail closed because pre-cutover earned-state history is unavailable.';

COMMENT ON FUNCTION public.get_commission_payment_detail_report(date) IS
  'Admin-only payment and settled-commission reconciliation detail from the immutable cutover''s first complete Chicago day through Chicago-today.';

DO $postcondition$
DECLARE
  v_bad_columns bigint;
  v_legacy_cancelled_count bigint;
  v_legacy_identity_digest text;
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

  SELECT count(*), md5(string_agg(id::text, ',' ORDER BY id))
    INTO v_legacy_cancelled_count, v_legacy_identity_digest
    FROM public.commissions
   WHERE status = 'cancelled'
     AND cancelled_at IS NULL
     AND cancelled_amount_cents IS NULL;

  IF (
       NOT EXISTS (SELECT 1 FROM public.commissions)
       AND NOT EXISTS (SELECT 1 FROM public.commission_payments)
       AND NOT EXISTS (SELECT 1 FROM public.commission_payment_items)
       AND v_legacy_cancelled_count = 0
     ) THEN
    NULL;
  ELSIF v_legacy_cancelled_count <> 2
     OR v_legacy_identity_digest IS DISTINCT FROM 'd2111549f1dc613edf9a31e4d152b096'
     OR EXISTS (
       SELECT 1
         FROM public.commissions
        WHERE status = 'cancelled'
          AND cancelled_at IS NULL
          AND cancelled_amount_cents IS NULL
          AND (
            order_date IS DISTINCT FROM DATE '2026-03-16'
            OR commission_amount IS DISTINCT FROM 0::numeric
          )
     ) THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_POSTCOND: NULL-history cancellations differ from the exact reviewed identity set (% rows)',
      v_legacy_cancelled_count;
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
         AND proname IN (
           'stamp_commission_cancellation_history', 'record_commission_earned_state',
           'record_commission_settlement_event', 'prevent_commission_history_ledger_mutation',
           'prevent_commission_history_ledger_truncate'
         )) <> 5 THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: function overload drift';
  END IF;

  IF has_function_privilege('anon', 'public.get_commission_balance_report(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_commission_balance_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_commission_balance_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_commission_payment_detail_report(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.stamp_commission_cancellation_history()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM (
           SELECT p.oid AS function_oid,
                  privilege.grantee,
                  privilege.privilege_type,
                  privilege.is_grantable,
                  true AS actual_present
             FROM pg_proc p
             CROSS JOIN LATERAL aclexplode(
               COALESCE(p.proacl, acldefault('f', p.proowner))
             ) privilege
            WHERE p.oid = ANY (ARRAY[
              'public.get_commission_balance_report(date)'::regprocedure::oid,
              'public.get_commission_payment_detail_report(date)'::regprocedure::oid,
              'public.stamp_commission_cancellation_history()'::regprocedure::oid,
              'public.record_commission_earned_state()'::regprocedure::oid,
              'public.record_commission_settlement_event()'::regprocedure::oid,
              'public.prevent_commission_history_ledger_mutation()'::regprocedure::oid,
              'public.prevent_commission_history_ledger_truncate()'::regprocedure::oid,
              'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'::regprocedure::oid
            ])
              AND privilege.grantee <> p.proowner
         ) actual
         FULL JOIN (VALUES
           ('public.get_commission_balance_report(date)'::regprocedure::oid, 'authenticated'::regrole::oid, 'EXECUTE'::text, false, true),
           ('public.get_commission_balance_report(date)'::regprocedure::oid, 'service_role'::regrole::oid, 'EXECUTE'::text, false, true),
           ('public.get_commission_payment_detail_report(date)'::regprocedure::oid, 'authenticated'::regrole::oid, 'EXECUTE'::text, false, true),
           ('public.get_commission_payment_detail_report(date)'::regprocedure::oid, 'service_role'::regrole::oid, 'EXECUTE'::text, false, true)
         ) expected(function_oid, grantee, privilege_type, is_grantable, expected_present)
         USING (function_oid, grantee, privilege_type, is_grantable)
        WHERE actual.actual_present IS NULL
           OR expected.expected_present IS NULL
     ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: function grant boundary drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.get_commission_balance_report(date)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = '97fa0f552420f6918bf02a55d95b6a54'
       AND prosrc LIKE '%PERFORM public.require_admin()%'
       AND prosrc LIKE '%commission_earned_state_ledger%'
       AND prosrc LIKE '%commission_settlement_events%'
       AND prosrc LIKE '%commission_history_cutover%'
       AND prosrc LIKE '%FULL OUTER JOIN%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.get_commission_payment_detail_report(date)'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = '304e4e87fb9d7b9426ea57ca59aad9a2'
       AND prosrc LIKE '%PERFORM public.require_admin()%'
       AND prosrc LIKE '%commission_settlement_events%'
       AND prosrc LIKE '%commission_history_cutover%'
       AND prosrc LIKE '%HAVING SUM(se.amount_cents) <> 0%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.stamp_commission_cancellation_history()'::regprocedure
       AND proowner = 'postgres'::regrole
       AND NOT prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = '44fc20fd4b84be893460cab96fe0eb7d'
       AND prosrc LIKE '%ROUND(OLD.commission_amount, 2) * 100%'
       AND prosrc LIKE '%NEW.order_number%'
       AND prosrc LIKE '%NEW.customer_name%'
       AND prosrc LIKE '%cancelled commissions cannot be reopened%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.record_commission_earned_state()'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = 'dc0577e8e694773e75a1c8099819ba6c'
       AND prosrc LIKE '%commission_earned_state_ledger%'
       AND prosrc LIKE '%clock_timestamp()%'
       AND prosrc LIKE '%RECIPIENT_GROUP_IMMUTABLE_AFTER_SETTLEMENT%'
       AND prosrc LIKE '%ORDER_DATE_REQUIRED%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.record_commission_settlement_event()'::regprocedure
       AND proowner = 'postgres'::regrole
       AND prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = '2d4d8f2df557f125415e208a7e198ded'
       AND prosrc LIKE '%commission_settlement_events%'
       AND prosrc LIKE '%OLD.status <> ''posted''%'
       AND prosrc LIKE '%OLD.status = ''posted''%'
       AND prosrc LIKE '%NEW.posted_at := v_event_at%'
       AND prosrc LIKE '%NEW.voided_at := v_event_at%'
       AND prosrc LIKE '%PAYMENT_DATE_BEFORE_ORDER%'
       AND prosrc LIKE '%POSTED_ACTOR_MISMATCH%'
       AND prosrc LIKE '%VOIDED_ACTOR_MISMATCH%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.prevent_commission_history_ledger_mutation()'::regprocedure
       AND proowner = 'postgres'::regrole
       AND NOT prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = 'f31a41a2b139f101074f95d2e361308f'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.prevent_commission_history_ledger_truncate()'::regprocedure
       AND proowner = 'postgres'::regrole
       AND NOT prosecdef
       AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
       AND md5(prosrc) = 'add7928abcb610caedb7cfbea52b8602'
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
      ('public.commission_earned_state_ledger'::regclass, 'commission_earned_state_ledger_admin_select'),
      ('public.commission_settlement_events'::regclass, 'commission_settlement_events_admin_select')
    ) expected(table_oid, policy_name)
    LEFT JOIN pg_policy p ON p.polrelid = expected.table_oid AND p.polname = expected.policy_name
    LEFT JOIN pg_class c ON c.oid = expected.table_oid
    WHERE p.oid IS NULL OR c.relowner <> 'postgres'::regrole OR NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: ledger policy, ownership, or RLS drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = 'public.commission_earned_state_ledger'::regclass), acldefault('r', 'postgres'::regrole))) a
    WHERE a.grantee <> 'postgres'::regrole
  ) OR EXISTS (
    SELECT 1
    FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = 'public.commission_settlement_events'::regclass), acldefault('r', 'postgres'::regrole))) a
    WHERE a.grantee <> 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: ledger table ACL drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
    WHERE c.oid IN ('public.commission_earned_state_ledger_id_seq'::regclass, 'public.commission_settlement_events_id_seq'::regclass)
      AND a.grantee <> c.relowner
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: ledger sequence ACL drift';
  END IF;

  IF (SELECT count(*) FROM public.commission_earned_state_ledger WHERE event_kind IN ('baseline','legacy_excluded'))
       <> (SELECT opening_commission_count FROM public.commission_history_cutover)
     OR (SELECT COALESCE(md5(string_agg(commission_id::text, ',' ORDER BY commission_id)), md5(''))
           FROM public.commission_earned_state_ledger
          WHERE event_kind IN ('baseline','legacy_excluded'))
       <> (SELECT opening_commission_digest FROM public.commission_history_cutover)
     OR EXISTS (
      SELECT 1 FROM public.commission_earned_state_ledger
      WHERE event_kind IN ('baseline','legacy_excluded')
      GROUP BY commission_id HAVING count(*) <> 1
    ) OR EXISTS (
      SELECT 1
      FROM public.commission_earned_state_ledger s
      CROSS JOIN public.commission_history_cutover m
      WHERE s.event_kind IN ('baseline', 'legacy_excluded')
        AND (s.effective_at IS DISTINCT FROM m.cutover_at OR s.recorded_by IS NOT NULL)
    ) OR EXISTS (
      SELECT 1 FROM public.commissions c
      WHERE NOT EXISTS (
        SELECT 1 FROM public.commission_earned_state_ledger s WHERE s.commission_id = c.id
      )
    ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_POSTCOND: opening baseline drift';
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

-- Keep replay fail-closed on the history objects themselves, rather than merely
-- proving that the older cancellation columns survived.
DO $ledger_postcondition$
BEGIN
  IF (SELECT count(*) FROM public.commission_history_cutover) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.commission_history_cutover
       WHERE singleton
         AND first_supported_date = ((cutover_at AT TIME ZONE 'America/Chicago')::date + 1)
         AND opening_commission_count >= 0
         AND opening_commission_digest ~ '^[0-9a-f]{32}$'
         AND created_at = cutover_at
     ) OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('commission_history_cutover_singleton_chk'),
         ('commission_history_cutover_first_complete_day_chk'),
         ('commission_history_cutover_opening_count_non_negative_chk'),
         ('commission_history_cutover_opening_digest_chk'),
         ('commission_history_cutover_created_at_chk')
       ) expected(constraint_name)
       LEFT JOIN pg_constraint c
         ON c.conrelid = 'public.commission_history_cutover'::regclass
        AND c.conname = expected.constraint_name
        AND c.contype = 'c'
        AND c.convalidated
       WHERE c.oid IS NULL
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_policy p
       WHERE p.polrelid = 'public.commission_history_cutover'::regclass
         AND p.polname = 'commission_history_cutover_admin_select'
         AND p.polcmd = 'r'
         AND p.polroles = ARRAY['authenticated'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = 'is_admin()'
     ) OR EXISTS (
       SELECT 1 FROM pg_class c
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
       WHERE c.oid = 'public.commission_history_cutover'::regclass
         AND (c.relowner <> 'postgres'::regrole OR NOT c.relrowsecurity OR c.relforcerowsecurity OR a.grantee <> c.relowner)
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = 'public.commission_history_cutover'::regclass
         AND t.tgname = 'trg_commission_history_cutover_immutable'
         AND t.tgtype = 27 AND t.tgenabled = 'O' AND NOT t.tgisinternal
         AND t.tgfoid = 'public.prevent_commission_history_ledger_mutation()'::regprocedure
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = 'public.commission_history_cutover'::regclass
         AND t.tgname = 'trg_commission_history_cutover_no_truncate'
         AND t.tgtype = 34 AND t.tgenabled = 'O' AND NOT t.tgisinternal
         AND t.tgfoid = 'public.prevent_commission_history_ledger_truncate()'::regprocedure
     ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_LEDGER_POSTCOND: immutable cutover metadata contract drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('commission_earned_state_ledger', 'id', 'bigint'),
      ('commission_earned_state_ledger', 'commission_id', 'uuid'),
      ('commission_earned_state_ledger', 'event_kind', 'text'),
      ('commission_earned_state_ledger', 'effective_at', 'timestamp with time zone'),
      ('commission_earned_state_ledger', 'recorded_at', 'timestamp with time zone'),
      ('commission_earned_state_ledger', 'recorded_by', 'uuid'),
      ('commission_earned_state_ledger', 'recipient_id', 'uuid'),
      ('commission_earned_state_ledger', 'recipient_group_key', 'text'),
      ('commission_earned_state_ledger', 'recipient_name', 'text'),
      ('commission_earned_state_ledger', 'source_type', 'text'),
      ('commission_earned_state_ledger', 'source_number', 'text'),
      ('commission_earned_state_ledger', 'customer_name', 'text'),
      ('commission_earned_state_ledger', 'order_date', 'date'),
      ('commission_earned_state_ledger', 'amount_cents', 'bigint'),
      ('commission_earned_state_ledger', 'is_earned', 'boolean'),
      ('commission_earned_state_ledger', 'created_at', 'timestamp with time zone'),
      ('commission_settlement_events', 'id', 'bigint'),
      ('commission_settlement_events', 'commission_payment_id', 'uuid'),
      ('commission_settlement_events', 'commission_payment_item_id', 'uuid'),
      ('commission_settlement_events', 'commission_id', 'uuid'),
      ('commission_settlement_events', 'event_kind', 'text'),
      ('commission_settlement_events', 'effective_at', 'timestamp with time zone'),
      ('commission_settlement_events', 'payment_number', 'text'),
      ('commission_settlement_events', 'payment_date', 'date'),
      ('commission_settlement_events', 'recipient_id', 'uuid'),
      ('commission_settlement_events', 'recipient_group_key', 'text'),
      ('commission_settlement_events', 'recipient_name', 'text'),
      ('commission_settlement_events', 'source_type', 'text'),
      ('commission_settlement_events', 'source_number', 'text'),
      ('commission_settlement_events', 'customer_name', 'text'),
      ('commission_settlement_events', 'commission_order_date', 'date'),
      ('commission_settlement_events', 'amount_cents', 'bigint'),
      ('commission_settlement_events', 'created_at', 'timestamp with time zone')
    ) expected(table_name, column_name, data_type)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = expected.table_name
     AND c.column_name = expected.column_name
     AND c.data_type = expected.data_type
    WHERE c.column_name IS NULL
  ) OR (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'commission_earned_state_ledger') <> 16
    OR (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'commission_settlement_events') <> 17
    OR NOT EXISTS (
      SELECT 1
      FROM pg_class i
      JOIN pg_index x ON x.indexrelid = i.oid
      WHERE x.indrelid = 'public.commission_earned_state_ledger'::regclass
        AND i.relname = 'commission_earned_state_ledger_one_opening_idx'
        AND x.indisunique AND x.indisvalid AND x.indisready
        AND x.indnkeyatts = 1 AND x.indnatts = 1
        AND pg_get_indexdef(i.oid) LIKE '%(commission_id)%'
        AND pg_get_expr(x.indpred, x.indrelid) LIKE '%event_kind%baseline%legacy_excluded%'
    ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commission_earned_state_ledger'::regclass
      AND conname = 'commission_earned_state_ledger_amount_cents_non_negative_chk'
      AND contype = 'c' AND convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commission_settlement_events'::regclass
      AND conname = 'commission_settlement_events_item_event_kind_key'
      AND contype = 'u'
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid IN ('public.commission_earned_state_ledger'::regclass, 'public.commission_settlement_events'::regclass)
      AND contype = 'f' AND confdeltype <> 'r'
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.commission_earned_state_ledger'::regclass, 'commission_earned_state_ledger_admin_select'),
      ('public.commission_settlement_events'::regclass, 'commission_settlement_events_admin_select')
    ) expected(table_oid, policy_name)
    LEFT JOIN pg_policy p ON p.polrelid = expected.table_oid AND p.polname = expected.policy_name
    WHERE p.oid IS NULL OR p.polcmd <> 'r'
      OR p.polroles <> ARRAY['authenticated'::regrole::oid]
      OR pg_get_expr(p.polqual, p.polrelid) <> 'is_admin()'
      OR p.polwithcheck IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.commission_earned_state_ledger'::regclass, 'trg_commission_earned_state_ledger_immutable', 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
      ('public.commission_earned_state_ledger'::regclass, 'trg_commission_earned_state_ledger_no_truncate', 'public.prevent_commission_history_ledger_truncate()'::regprocedure),
      ('public.commission_settlement_events'::regclass, 'trg_commission_settlement_events_immutable', 'public.prevent_commission_history_ledger_mutation()'::regprocedure),
      ('public.commission_settlement_events'::regclass, 'trg_commission_settlement_events_no_truncate', 'public.prevent_commission_history_ledger_truncate()'::regprocedure),
      ('public.commissions'::regclass, 'trg_commissions_record_earned_state', 'public.record_commission_earned_state()'::regprocedure),
      ('public.commission_payments'::regclass, 'trg_commission_payments_record_settlement_event', 'public.record_commission_settlement_event()'::regprocedure)
    ) expected(table_oid, trigger_name, function_oid)
    LEFT JOIN pg_trigger t
      ON t.tgrelid = expected.table_oid
     AND t.tgname = expected.trigger_name
     AND t.tgfoid = expected.function_oid
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
    WHERE t.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_LEDGER_POSTCOND: ledger shape, immutable trigger, policy, or FK contract drift';
  END IF;
END
$ledger_postcondition$;
