-- Close two review findings without modifying the already-applied commission
-- history migration:
--   1. fail closed if its append-only ledger catalog contract has drifted; and
--   2. return balance and payment detail from one PostgreSQL statement snapshot.

DO $commission_history_catalog_contract$
DECLARE
  v_column_drift bigint;
  v_primary_key_drift bigint;
  v_foreign_key_drift bigint;
BEGIN
  WITH expected(
    table_name, ordinal_position, column_name, data_type, is_nullable,
    column_default, is_generated, is_identity, identity_generation
  ) AS (
    VALUES
      ('commission_history_cutover', 1, 'singleton', 'boolean', 'NO', 'true', 'NEVER', 'NO', NULL::text),
      ('commission_history_cutover', 2, 'cutover_at', 'timestamp with time zone', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_history_cutover', 3, 'first_supported_date', 'date', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_history_cutover', 4, 'opening_commission_count', 'bigint', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_history_cutover', 5, 'opening_commission_digest', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_history_cutover', 6, 'created_at', 'timestamp with time zone', 'NO', 'transaction_timestamp()', 'NEVER', 'NO', NULL),

      ('commission_earned_state_ledger', 1, 'id', 'bigint', 'NO', NULL, 'NEVER', 'YES', 'ALWAYS'),
      ('commission_earned_state_ledger', 2, 'commission_id', 'uuid', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 3, 'event_kind', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 4, 'effective_at', 'timestamp with time zone', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 5, 'recorded_at', 'timestamp with time zone', 'NO', 'transaction_timestamp()', 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 6, 'recorded_by', 'uuid', 'YES', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 7, 'recipient_id', 'uuid', 'YES', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 8, 'recipient_group_key', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 9, 'recipient_name', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 10, 'source_type', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 11, 'source_number', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 12, 'customer_name', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 13, 'order_date', 'date', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 14, 'amount_cents', 'bigint', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 15, 'is_earned', 'boolean', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_earned_state_ledger', 16, 'created_at', 'timestamp with time zone', 'NO', 'transaction_timestamp()', 'NEVER', 'NO', NULL),

      ('commission_settlement_events', 1, 'id', 'bigint', 'NO', NULL, 'NEVER', 'YES', 'ALWAYS'),
      ('commission_settlement_events', 2, 'commission_payment_id', 'uuid', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 3, 'commission_payment_item_id', 'uuid', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 4, 'commission_id', 'uuid', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 5, 'event_kind', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 6, 'effective_at', 'timestamp with time zone', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 7, 'payment_number', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 8, 'payment_date', 'date', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 9, 'recipient_id', 'uuid', 'YES', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 10, 'recipient_group_key', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 11, 'recipient_name', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 12, 'source_type', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 13, 'source_number', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 14, 'customer_name', 'text', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 15, 'commission_order_date', 'date', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 16, 'amount_cents', 'bigint', 'NO', NULL, 'NEVER', 'NO', NULL),
      ('commission_settlement_events', 17, 'created_at', 'timestamp with time zone', 'NO', 'transaction_timestamp()', 'NEVER', 'NO', NULL)
  ), actual AS (
    SELECT
      c.table_name::text,
      c.ordinal_position::integer,
      c.column_name::text,
      c.data_type::text,
      c.is_nullable::text,
      c.column_default::text,
      c.is_generated::text,
      c.is_identity::text,
      c.identity_generation::text
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name IN (
        'commission_history_cutover',
        'commission_earned_state_ledger',
        'commission_settlement_events'
      )
  )
  SELECT count(*)
    INTO v_column_drift
    FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) drift;

  IF v_column_drift <> 0 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_SCHEMA_DRIFT: % expected/actual column contract row(s) differ',
      v_column_drift;
  END IF;

  WITH expected(
    constraint_name, table_name, key_columns,
    is_deferrable, is_deferred, is_validated
  ) AS (
    VALUES
      ('commission_history_cutover_pkey', 'commission_history_cutover', 'singleton', false, false, true),
      ('commission_earned_state_ledger_pkey', 'commission_earned_state_ledger', 'id', false, false, true),
      ('commission_settlement_events_pkey', 'commission_settlement_events', 'id', false, false, true)
  ), actual AS (
    SELECT
      con.conname::text,
      rel.relname::text,
      array_to_string(ARRAY(
        SELECT att.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid
         AND att.attnum = key.attnum
        ORDER BY key.ord
      ), ',')::text,
      con.condeferrable,
      con.condeferred,
      con.convalidated
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.contype = 'p'
      AND nsp.nspname = 'public'
      AND rel.relname IN (
        'commission_history_cutover',
        'commission_earned_state_ledger',
        'commission_settlement_events'
      )
  )
  SELECT count(*)
    INTO v_primary_key_drift
    FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) drift;

  IF v_primary_key_drift <> 0 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_SCHEMA_DRIFT: % expected/actual primary-key contract row(s) differ',
      v_primary_key_drift;
  END IF;

  IF pg_get_serial_sequence('public.commission_earned_state_ledger', 'id')
       IS DISTINCT FROM 'public.commission_earned_state_ledger_id_seq'
     OR pg_get_serial_sequence('public.commission_settlement_events', 'id')
       IS DISTINCT FROM 'public.commission_settlement_events_id_seq' THEN
    RAISE EXCEPTION 'COMMISSION_HISTORY_SCHEMA_DRIFT: identity sequence contract differs';
  END IF;

  WITH expected(
    constraint_name, table_name, key_columns,
    referenced_schema_name, referenced_table_name, referenced_columns,
    update_action, delete_action, match_type,
    is_deferrable, is_deferred, is_validated
  ) AS (
    VALUES
      ('commission_earned_state_ledger_commission_id_fkey', 'commission_earned_state_ledger', 'commission_id', 'public', 'commissions', 'id', 'a', 'r', 's', false, false, true),
      ('commission_settlement_events_commission_payment_id_fkey', 'commission_settlement_events', 'commission_payment_id', 'public', 'commission_payments', 'id', 'a', 'r', 's', false, false, true),
      ('commission_settlement_events_commission_payment_item_id_fkey', 'commission_settlement_events', 'commission_payment_item_id', 'public', 'commission_payment_items', 'id', 'a', 'r', 's', false, false, true),
      ('commission_settlement_events_commission_id_fkey', 'commission_settlement_events', 'commission_id', 'public', 'commissions', 'id', 'a', 'r', 's', false, false, true)
  ), actual AS (
    SELECT
      con.conname::text,
      rel.relname::text,
      array_to_string(ARRAY(
        SELECT att.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid
         AND att.attnum = key.attnum
        ORDER BY key.ord
      ), ',')::text,
      foreign_nsp.nspname::text,
      foreign_rel.relname::text,
      array_to_string(ARRAY(
        SELECT att.attname
        FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
        JOIN pg_attribute att
          ON att.attrelid = con.confrelid
         AND att.attnum = key.attnum
        ORDER BY key.ord
      ), ',')::text,
      con.confupdtype::text,
      con.confdeltype::text,
      con.confmatchtype::text,
      con.condeferrable,
      con.condeferred,
      con.convalidated
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    JOIN pg_class foreign_rel ON foreign_rel.oid = con.confrelid
    JOIN pg_namespace foreign_nsp ON foreign_nsp.oid = foreign_rel.relnamespace
    WHERE con.contype = 'f'
      AND nsp.nspname = 'public'
      AND rel.relname IN (
        'commission_earned_state_ledger',
        'commission_settlement_events'
      )
  )
  SELECT count(*)
    INTO v_foreign_key_drift
    FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) drift;

  IF v_foreign_key_drift <> 0 THEN
    RAISE EXCEPTION
      'COMMISSION_HISTORY_SCHEMA_DRIFT: % expected/actual foreign-key contract row(s) differ',
      v_foreign_key_drift;
  END IF;
END
$commission_history_catalog_contract$;

CREATE OR REPLACE FUNCTION public.get_commission_history_report(p_as_of_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'as_of_date', p_as_of_date,
    'balance_rows', COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(balance_row)
          ORDER BY balance_row.outstanding_balance DESC, balance_row.recipient_name)
        FROM public.get_commission_balance_report(p_as_of_date) AS balance_row
      ),
      '[]'::jsonb
    ),
    'payment_detail_rows', COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(detail_row)
          ORDER BY detail_row.payment_date, detail_row.payment_number,
                   detail_row.commission_order_date, detail_row.commission_id)
        FROM public.get_commission_payment_detail_report(p_as_of_date) AS detail_row
      ),
      '[]'::jsonb
    )
  );
$function$;

ALTER FUNCTION public.get_commission_history_report(date) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_commission_history_report(date)
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_commission_history_report(date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_commission_history_report(date) IS
  'Admin-only commission balance and payment-detail arrays evaluated together in one stable SQL statement snapshot for the requested supported Chicago business date.';
