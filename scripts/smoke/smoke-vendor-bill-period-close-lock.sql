-- Candidate rollback-only shape gate. The migration itself is applied only in a
-- disposable database by the owning concurrency proof; this smoke remains safe
-- to run against a migrated target because it writes no fixture or business row.
DO $smoke$
DECLARE
  v_constraint boolean;
  v_helper text;
  v_check_open text;
  v_close text;
  v_create text;
  v_update text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.accounting_periods'::regclass
      AND conname = 'accounting_periods_whole_calendar_month_check'
  ) INTO v_constraint;
  IF NOT v_constraint THEN RAISE EXCEPTION 'missing whole-month constraint'; END IF;
  SELECT pg_get_functiondef('_lock_accounting_months(date[],boolean)'::regprocedure) INTO v_helper;
  SELECT pg_get_functiondef('check_period_open(date)'::regprocedure) INTO v_check_open;
  SELECT pg_get_functiondef('close_accounting_period(date,uuid,text)'::regprocedure) INTO v_close;
  SELECT pg_get_functiondef('create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'::regprocedure) INTO v_create;
  SELECT pg_get_functiondef('update_vendor_bill(uuid,bigint,bigint,date,date,text,text)'::regprocedure) INTO v_update;
  IF v_helper NOT LIKE '%73492010%' OR v_helper NOT LIKE '%ORDER BY 1%' THEN RAISE EXCEPTION 'helper lock contract missing'; END IF;
  IF v_check_open NOT LIKE '%_lock_accounting_months(ARRAY[p_date], false)%' THEN RAISE EXCEPTION 'check_period_open shared lock missing'; END IF;
  IF v_close NOT LIKE '%_lock_accounting_months(ARRAY[v_period_start], true)%' THEN RAISE EXCEPTION 'close exclusive lock missing'; END IF;
  IF v_create NOT LIKE '%check_period_open(p_bill_date)%' THEN RAISE EXCEPTION 'create period check missing'; END IF;
  IF v_update NOT LIKE '%_lock_accounting_months(ARRAY[v_bill.bill_date, p_bill_date], false)%' THEN RAISE EXCEPTION 'update sorted prelock missing'; END IF;
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
