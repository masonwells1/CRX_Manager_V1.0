-- Quote commission splits are money-routing instructions. Keep the shared
-- commission validator authoritative for every quote write, including direct
-- table writes, and reconcile the one exact active row found by the standing
-- financial invariant sweep before attaching the trigger.

LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_quote record;
  v_error text;
  v_invalid_count integer := 0;
  v_validator_hash text;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_validator_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.validate_commission_split_json(jsonb)');

  IF v_validator_hash IS DISTINCT FROM 'e9c13053f1146525612c4cee82de5092' THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_VALIDATOR_DRIFT: %', v_validator_hash;
  END IF;

  IF to_regprocedure('public.guard_quote_commission_split_valid()') IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.quotes'::regclass
          AND t.tgname = 'trg_validate_quote_commission_split'
          AND NOT t.tgisinternal
     ) THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_GUARD_ALREADY_EXISTS';
  END IF;

  FOR v_quote IN
    SELECT q.id, q.quote_number, q.status, q.created_by, q.commission_split
      FROM public.quotes q
     WHERE q.deleted_at IS NULL
     ORDER BY q.id
  LOOP
    BEGIN
      PERFORM public.validate_commission_split_json(v_quote.commission_split);
    EXCEPTION WHEN OTHERS THEN
      v_error := SQLERRM;
      v_invalid_count := v_invalid_count + 1;
      IF v_quote.id IS DISTINCT FROM 'bcdca194-568a-454b-80da-de726820b27b'::uuid
         OR v_quote.quote_number IS DISTINCT FROM 'Q-2026-2059'
         OR v_quote.status IS DISTINCT FROM 'accepted'
         OR v_quote.created_by IS DISTINCT FROM '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
         OR v_quote.commission_split IS DISTINCT FROM
              '{"splits":[{"recipient":"","percentage":100}]}'::jsonb
         OR v_error NOT LIKE 'COMMISSION_SPLIT_INVALID: recipient is required%' THEN
        RAISE EXCEPTION 'QUOTE_COMMISSION_RECONCILIATION_REQUIRED: quote=% number=% error=%',
          v_quote.id, v_quote.quote_number, v_error;
      END IF;
    END;
  END LOOP;

  IF v_invalid_count <> 1 THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_RECONCILIATION_COUNT: expected=1 actual=%',
      v_invalid_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.orders o
     WHERE o.quote_id = 'bcdca194-568a-454b-80da-de726820b27b'::uuid
  ) THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_REPAIR_HAS_ORDER';
  END IF;
END;
$preflight$;

WITH repaired AS (
  UPDATE public.quotes q
     SET commission_split = '{"splits":[]}'::jsonb,
         updated_at = clock_timestamp()
   WHERE q.id = 'bcdca194-568a-454b-80da-de726820b27b'::uuid
     AND q.quote_number = 'Q-2026-2059'
     AND q.status = 'accepted'
     AND q.deleted_at IS NULL
     AND q.created_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
     AND q.commission_split =
           '{"splits":[{"recipient":"","percentage":100}]}'::jsonb
     AND NOT EXISTS (
       SELECT 1 FROM public.orders o WHERE o.quote_id = q.id
     )
  RETURNING q.id
)
INSERT INTO public.financial_audit_log (
  operation_type,
  entity_type,
  entity_id,
  actor_user_id,
  actor_role,
  old_values,
  new_values,
  total_impact_cents,
  description
)
SELECT
  'split_modified',
  'quote',
  r.id,
  '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid,
  'admin',
  '{"commission_split":{"splits":[{"recipient":"","percentage":100}]}}'::jsonb,
  '{"commission_split":{"splits":[]},"repair_contract":"quote_commission_split_v1"}'::jsonb,
  0,
  'Reconciled invalid blank-recipient quote commission split before validator cutover'
FROM repaired r;

DO $repair_count$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.financial_audit_log a
     WHERE a.entity_type = 'quote'
       AND a.entity_id = 'bcdca194-568a-454b-80da-de726820b27b'::uuid
       AND a.operation_type = 'split_modified'
       AND a.new_values->>'repair_contract' = 'quote_commission_split_v1'
  ) THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_REPAIR_DID_NOT_APPLY';
  END IF;
END;
$repair_count$;

CREATE FUNCTION public.guard_quote_commission_split_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.validate_commission_split_json(NEW.commission_split);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_quote_commission_split_valid()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_validate_quote_commission_split
BEFORE INSERT OR UPDATE OF commission_split ON public.quotes
FOR EACH ROW
EXECUTE FUNCTION public.guard_quote_commission_split_valid();

DO $postflight$
DECLARE
  v_quote record;
BEGIN
  FOR v_quote IN
    SELECT q.id, q.quote_number, q.commission_split
      FROM public.quotes q
     WHERE q.deleted_at IS NULL
     ORDER BY q.id
  LOOP
    BEGIN
      PERFORM public.validate_commission_split_json(v_quote.commission_split);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'QUOTE_COMMISSION_POSTFLIGHT_INVALID: quote=% number=% error=%',
        v_quote.id, v_quote.quote_number, SQLERRM;
    END;
  END LOOP;

  IF (SELECT q.commission_split
        FROM public.quotes q
       WHERE q.id = 'bcdca194-568a-454b-80da-de726820b27b'::uuid)
       IS DISTINCT FROM '{"splits":[]}'::jsonb THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_REPAIR_POSTFLIGHT_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.quotes'::regclass
       AND t.tgname = 'trg_validate_quote_commission_split'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_TRIGGER_POSTFLIGHT_FAILED';
  END IF;

  IF has_function_privilege('anon', 'public.guard_quote_commission_split_valid()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_quote_commission_split_valid()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_quote_commission_split_valid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_TRIGGER_FUNCTION_GRANT_DRIFT';
  END IF;
END;
$postflight$;
