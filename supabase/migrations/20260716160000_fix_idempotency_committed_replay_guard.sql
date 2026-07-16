-- Restore committed replay for allocate_payment's atomic idempotency claim.
--
-- 20260714230000 added a BEFORE INSERT trigger to protect older mutators that
-- write idempotency_keys only after performing business work. The trigger
-- correctly rolls back a same-key loser for those legacy final-result inserts,
-- but it also rejected allocate_payment's deliberate claim-row INSERT before
-- ON CONFLICT could read and return the already-committed response. Every
-- ordinary retry therefore received IDEMPOTENCY_CONCURRENT_REPLAY_RETRY forever.
--
-- The atomic claim has an unambiguous versioned envelope with a NULL response.
-- Skip only that duplicate INSERT so allocate_payment's existing ROW_COUNT = 0
-- branch can validate the request and return the cached response. Keep raising
-- for legacy final-result duplicates so concurrent business work still rolls
-- back instead of committing twice.

CREATE OR REPLACE FUNCTION public._guard_idempotency_key_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_operation text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || NEW.idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = NEW.idempotency_key
     AND expires_at < now();

  SELECT operation
    INTO v_existing_operation
    FROM public.idempotency_keys
   WHERE idempotency_key = NEW.idempotency_key;

  IF FOUND THEN
    IF v_existing_operation IS DISTINCT FROM NEW.operation THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
        NEW.idempotency_key, v_existing_operation, NEW.operation;
    END IF;

    IF NEW.operation = 'allocate_payment'
       AND NEW.result->>'_contract' = 'allocate_payment_v1'
       AND NEW.result ? 'request'
       AND NEW.result->'response' = 'null'::jsonb THEN
      RETURN NULL;
    END IF;

    RAISE EXCEPTION
      'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY: operation % with key % completed concurrently; retry to read its saved result',
      NEW.operation, NEW.idempotency_key;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_idempotency_key_insert()
  FROM PUBLIC, anon, authenticated;
