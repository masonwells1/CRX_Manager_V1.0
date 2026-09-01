-- STATUS: PARKED - NOT APPLIED
-- Gauntlet exact-head follow-up: close the two remaining write races.
--
-- 1. reverse_receiving_record now takes the linked PO-item row lock, then the
--    purchase-order row lock, then the accounting-month shared lock before its
--    existing period/bill checks. This matches the established supplier-cost
--    item -> PO order; bill creation uses vendor -> PO, while period close uses
--    the matching exclusive month lock. Either writer commits first and the
--    loser revalidates authoritative state without a lock-order inversion.
-- 2. cycle-count item mutations now lock and revalidate the parent count in a
--    BEFORE trigger. A late insert therefore either advances the revision
--    before completion reads it or waits for completion and fails because the
--    parent is no longer in_progress.

SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';

DO $precond$
BEGIN
  IF to_regprocedure('public.reverse_receiving_record(uuid,text,uuid,text)') IS NULL
     OR to_regprocedure('public._section9_reverse_receiving_record_serialized(uuid,text,uuid,text)') IS NULL
     OR to_regprocedure('public._lock_accounting_months(date[],boolean)') IS NULL
     OR to_regprocedure('public.bump_cycle_count_item_revision()') IS NULL
     OR to_regprocedure('public.complete_cycle_count(uuid,uuid,text,bigint)') IS NULL
     OR (SELECT count(*) FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname = 'reverse_receiving_record') <> 1
     OR (SELECT count(*) FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname = 'complete_cycle_count') <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected gauntlet receiving and cycle-count candidates are absent or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.cycle_count_items'::regclass
      AND tgname = 'trg_bump_cycle_count_item_revision'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'PRECOND: cycle-count revision trigger is absent or disabled';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.reverse_receiving_record(
  p_record_id uuid,
  p_reason text DEFAULT 'Manually reversed',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_reason text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_purchase_order_id uuid;
  v_po_item_id uuid;
  v_receiving_date date;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REQUIRED: reverse_receiving_record requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'record_id', p_record_id,
        'reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'reverse_receiving_record', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT rr.purchase_order_id,
         rr.po_item_id,
         (rr.received_at AT TIME ZONE 'America/Chicago')::date
    INTO v_purchase_order_id, v_po_item_id, v_receiving_date
    FROM public.receiving_records rr
   WHERE rr.id = p_record_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receiving record not found: %', p_record_id; END IF;

  -- Canonical supplier-cost/receiving lock order: PO item, then PO. The
  -- delegated reversal later updates both rows, so acquiring them here in the
  -- shared order serializes with supplier-cost application without deadlocks.
  PERFORM 1
    FROM public.purchase_order_items poi
   WHERE poi.id = v_po_item_id
     AND poi.purchase_order_id = v_purchase_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_ORDER_ITEM_NOT_FOUND: %', v_po_item_id;
  END IF;

  PERFORM 1
    FROM public.purchase_orders po
   WHERE po.id = v_purchase_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_ORDER_NOT_FOUND: %', v_purchase_order_id;
  END IF;

  PERFORM public._lock_accounting_months(ARRAY[v_receiving_date], false);
  PERFORM public.check_period_open(v_receiving_date);

  v_result := public._section9_reverse_receiving_record_serialized(
    p_record_id, v_reason, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'reverse_receiving_record';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bump_cycle_count_item_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cycle_count_id uuid;
  v_status text;
BEGIN
  v_cycle_count_id := COALESCE(NEW.cycle_count_id, OLD.cycle_count_id);

  -- BEFORE timing is load-bearing for INSERT: it makes the not-yet-visible
  -- item and completion contend on the same parent row before either can
  -- commit an authoritative decision.
  SELECT cc.status
    INTO v_status
    FROM public.cycle_counts cc
   WHERE cc.id = v_cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NOT_IN_PROGRESS';
  END IF;

  UPDATE public.cycle_counts
     SET item_revision = item_revision + 1
   WHERE id = v_cycle_count_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_cycle_count_item_revision()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER trg_bump_cycle_count_item_revision ON public.cycle_count_items;
CREATE TRIGGER trg_bump_cycle_count_item_revision
BEFORE INSERT OR UPDATE OR DELETE ON public.cycle_count_items
FOR EACH ROW EXECUTE FUNCTION public.bump_cycle_count_item_revision();

DO $postcond$
DECLARE
  v_reverse_source text;
  v_trigger_source text;
  v_trigger_definition text;
BEGIN
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'reverse_receiving_record') <> 1
     OR (SELECT count(*) FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname = 'complete_cycle_count') <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: public RPC overload drift';
  END IF;

  SELECT prosrc INTO v_reverse_source
  FROM pg_proc
  WHERE oid = 'public.reverse_receiving_record(uuid,text,uuid,text)'::regprocedure;
  IF v_reverse_source NOT LIKE '%FROM public.purchase_order_items poi%'
     OR v_reverse_source NOT LIKE '%FROM public.purchase_orders po%'
     OR v_reverse_source NOT LIKE '%FOR UPDATE%'
     OR v_reverse_source NOT LIKE '%_lock_accounting_months(ARRAY[v_receiving_date], false)%'
     OR v_reverse_source NOT LIKE '%check_period_open(v_receiving_date)%'
     OR strpos(v_reverse_source, 'FROM public.purchase_order_items poi')
        > strpos(v_reverse_source, 'FROM public.purchase_orders po')
     OR strpos(v_reverse_source, 'FROM public.purchase_orders po')
        > strpos(v_reverse_source, '_lock_accounting_months(ARRAY[v_receiving_date], false)')
     OR strpos(v_reverse_source, '_lock_accounting_months(ARRAY[v_receiving_date], false)')
        > strpos(v_reverse_source, 'check_period_open(v_receiving_date)')
     OR strpos(v_reverse_source, 'check_period_open(v_receiving_date)')
        > strpos(v_reverse_source, '_section9_reverse_receiving_record_serialized') THEN
    RAISE EXCEPTION 'POSTCOND: receiving reversal serialization contract drifted';
  END IF;

  SELECT p.prosrc INTO v_trigger_source
  FROM pg_proc p
  WHERE p.oid = 'public.bump_cycle_count_item_revision()'::regprocedure;
  SELECT pg_get_triggerdef(t.oid) INTO v_trigger_definition
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.cycle_count_items'::regclass
    AND t.tgname = 'trg_bump_cycle_count_item_revision'
    AND NOT t.tgisinternal
    AND t.tgenabled = 'O';

  IF v_trigger_definition IS NULL
     OR v_trigger_definition NOT LIKE '% BEFORE INSERT OR DELETE OR UPDATE ON public.cycle_count_items %'
     OR v_trigger_source NOT LIKE '%FROM public.cycle_counts cc%'
     OR v_trigger_source NOT LIKE '%FOR UPDATE%'
     OR v_trigger_source NOT LIKE '%CYCLE_COUNT_NOT_IN_PROGRESS%'
     OR strpos(v_trigger_source, 'FOR UPDATE')
        > strpos(v_trigger_source, 'SET item_revision = item_revision + 1') THEN
    RAISE EXCEPTION 'POSTCOND: cycle-count item serialization contract drifted';
  END IF;

  IF has_function_privilege(
       'anon', 'public.reverse_receiving_record(uuid,text,uuid,text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.reverse_receiving_record(uuid,text,uuid,text)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.bump_cycle_count_item_revision()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'POSTCOND: write-boundary execute grants drifted';
  END IF;
END;
$postcond$;
