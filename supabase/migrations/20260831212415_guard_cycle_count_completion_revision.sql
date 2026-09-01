-- STATUS: PARKED - NOT APPLIED
-- Close the Cycle Count stale-completion race without changing the business
-- operation's identity. Item writers lock their item before the parent; the
-- completer locks every item before the parent. That ordering means a write
-- already in PostgreSQL cannot be leapfrogged by completion. An optional,
-- caller-supplied revision then rejects a completion whose authoritative
-- snapshot has changed in another tab/client.

BEGIN;

SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';

DO $precond$
BEGIN
  IF to_regprocedure('public.complete_cycle_count(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.update_cycle_count_item(uuid,numeric,text,uuid,text)') IS NULL
     OR to_regprocedure('public._complete_cycle_count_impl(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_cycle_count') <> 1
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_cycle_count_item') <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected one current cycle-count completion and item-update RPC';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.cycle_counts'::regclass
      AND attname = 'item_revision'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'PRECOND: cycle_counts.item_revision already exists; reconcile drift before applying';
  END IF;

END;
$precond$;

-- Serialize the replay-receipt cutover with every legacy writer. The old item
-- RPC stored no actor/fingerprint, while the old completion receipt did not
-- carry the parent/actor fields that the new wrapper validates.
LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
DO $cycle_count_intent_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.idempotency_keys
    WHERE (expires_at IS NULL OR expires_at >= transaction_timestamp())
      AND (
        (
          operation = 'update_cycle_count_item'
          AND (request_actor_id IS NULL OR request_fingerprint IS NULL)
        )
        OR (
          operation = 'complete_cycle_count'
          AND (
            result->>'_cycle_count_id' IS NULL
            OR result->>'_actor_id' IS NULL
            OR NOT (result ? '_expected_item_revision')
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'CYCLE_COUNT_INTENT_CUTOVER_BLOCKED: unexpired legacy item/completion receipt exists';
  END IF;
END;
$cycle_count_intent_cutover$;

ALTER TABLE public.cycle_counts
  ADD COLUMN item_revision bigint NOT NULL DEFAULT 0
  CONSTRAINT cycle_counts_item_revision_nonnegative_chk CHECK (item_revision >= 0);

CREATE OR REPLACE FUNCTION public.bump_cycle_count_item_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cycle_count_id uuid;
BEGIN
  v_cycle_count_id := COALESCE(NEW.cycle_count_id, OLD.cycle_count_id);
  UPDATE public.cycle_counts
     SET item_revision = item_revision + 1
   WHERE id = v_cycle_count_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.bump_cycle_count_item_revision()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_bump_cycle_count_item_revision
AFTER INSERT OR UPDATE OR DELETE ON public.cycle_count_items
FOR EACH ROW EXECUTE FUNCTION public.bump_cycle_count_item_revision();

-- Item-first locking makes the completion/item-write ordering deterministic:
-- a completion waits for an item write that is already inside PostgreSQL,
-- rather than acquiring the parent row ahead of it.
CREATE OR REPLACE FUNCTION public.update_cycle_count_item(
  p_item_id         uuid,
  p_counted_qty     numeric DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor         uuid := auth.uid();
  v_replay        jsonb;
  v_fingerprint   text;
  v_item          public.cycle_count_items%ROWTYPE;
  v_count         public.cycle_counts%ROWTYPE;
  v_variance      numeric;
  v_variance_pct  numeric;
  v_item_revision bigint;
  v_result        jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_cycle_count_item requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'item_id', p_item_id,
    'counted_qty', p_counted_qty,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'update_cycle_count_item', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_item
    FROM public.cycle_count_items
   WHERE id = p_item_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_ITEM_NOT_FOUND'; END IF;

  SELECT * INTO v_count
    FROM public.cycle_counts
   WHERE id = v_item.cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_count.status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NOT_IN_PROGRESS';
  END IF;

  IF p_counted_qty IS NOT NULL THEN
    v_variance := p_counted_qty - v_item.expected_qty;
    IF v_item.expected_qty <> 0 THEN
      v_variance_pct := round((v_variance / v_item.expected_qty) * 100, 2);
    END IF;
  END IF;

  UPDATE public.cycle_count_items
     SET counted_qty = p_counted_qty,
         variance = v_variance,
         variance_pct = v_variance_pct,
         is_counted = (p_counted_qty IS NOT NULL),
         counted_by = CASE WHEN p_counted_qty IS NOT NULL THEN v_actor ELSE NULL END,
         counted_at = CASE WHEN p_counted_qty IS NOT NULL THEN now() ELSE NULL END,
         notes = COALESCE(p_notes, notes)
   WHERE id = p_item_id;

  SELECT item_revision INTO v_item_revision
    FROM public.cycle_counts
   WHERE id = v_item.cycle_count_id;

  v_result := jsonb_build_object(
    'item_id', p_item_id,
    'counted_qty', p_counted_qty,
    'variance', v_variance,
    'variance_pct', v_variance_pct,
    'is_counted', (p_counted_qty IS NOT NULL),
    'item_revision', v_item_revision
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'update_cycle_count_item', v_result);
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'update_cycle_count_item';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

-- PostgreSQL treats a newly appended defaulted parameter as a different
-- identity. Rename the old public wrapper first so there is never a public
-- overload; callers that omit the named optional argument still resolve this
-- one four-argument function through its DEFAULT.
ALTER FUNCTION public.complete_cycle_count(uuid, uuid, text)
  RENAME TO _complete_cycle_count_pre_revision_20260831;
REVOKE ALL ON FUNCTION public._complete_cycle_count_pre_revision_20260831(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_cycle_count(
  p_cycle_count_id uuid,
  p_completed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_expected_item_revision bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_current_item_revision bigint;
  v_cache_rows integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_completed_by IS NOT NULL AND p_completed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_cycle_count requires p_idempotency_key';
  END IF;
  IF p_expected_item_revision IS NOT NULL AND p_expected_item_revision < 0 THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;

  v_existing := public.check_idempotency(p_idempotency_key, 'complete_cycle_count');
  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_cycle_count_id' IS DISTINCT FROM p_cycle_count_id::text
       OR v_existing->>'_actor_id' IS DISTINCT FROM v_actor::text
       OR (v_existing->>'_expected_item_revision') IS DISTINCT FROM p_expected_item_revision::text THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    RETURN;
  END IF;

  -- Lock item rows first, in a stable order. Item writers take one of these
  -- before the parent row, so an already-started save commits or fails before
  -- this completion observes the revision and finalizes inventory.
  PERFORM 1
    FROM public.cycle_count_items
   WHERE cycle_count_id = p_cycle_count_id
   ORDER BY id
   FOR UPDATE;

  SELECT item_revision INTO v_current_item_revision
    FROM public.cycle_counts
   WHERE id = p_cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF p_expected_item_revision IS NOT NULL
     AND v_current_item_revision IS DISTINCT FROM p_expected_item_revision THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;

  -- Preserve the pre-existing inventory serialization contract after the new
  -- item and parent locks. The private implementation reads current on-hand
  -- values before writing inventory and its ledger, so these rows must remain
  -- locked in stable order across that entire operation.
  PERFORM 1
    FROM public.inventory i
    JOIN public.cycle_count_items cci ON cci.inventory_id = i.id
   WHERE cci.cycle_count_id = p_cycle_count_id
   ORDER BY i.id
   FOR UPDATE OF i;

  PERFORM public._complete_cycle_count_impl(p_cycle_count_id, v_actor, p_idempotency_key);

  UPDATE public.idempotency_keys
     SET result = jsonb_build_object(
       '_cycle_count_id', p_cycle_count_id,
       '_actor_id', v_actor,
       '_expected_item_revision', p_expected_item_revision,
       '_completed_item_revision', v_current_item_revision
     )
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'complete_cycle_count';
  GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
  IF v_cache_rows <> 1 THEN RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED'; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_cycle_count(uuid, uuid, text, bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_cycle_count(uuid, uuid, text, bigint)
  TO authenticated, service_role;

DO $postcond$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'complete_cycle_count') <> 1
     OR to_regprocedure('public.complete_cycle_count(uuid,uuid,text,bigint)') IS NULL
     OR to_regprocedure('public.complete_cycle_count(uuid,uuid,text)') IS NOT NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_cycle_count_item') <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: cycle-count RPC overload drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.cycle_counts'::regclass
      AND attname = 'item_revision'
      AND atttypid = 'bigint'::regtype
      AND attnotnull
      AND NOT attisdropped
  ) THEN RAISE EXCEPTION 'POSTCOND: item revision column has the wrong shape'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.cycle_count_items'::regclass
      AND tgname = 'trg_bump_cycle_count_item_revision'
      AND NOT tgisinternal
      AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'POSTCOND: item revision trigger is missing or disabled'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.complete_cycle_count(uuid,uuid,text,bigint)'::regprocedure
      AND (NOT prosecdef
        OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(proconfig, ARRAY[]::text[])) c(value)
                       WHERE replace(c.value, ' ', '') = 'search_path=public,pg_temp')
        OR prosrc NOT LIKE '%CYCLE_COUNT_STALE_REVISION%'
        OR prosrc NOT LIKE '%ORDER BY id%'
        OR prosrc NOT LIKE '%FOR UPDATE OF i%')
  ) THEN RAISE EXCEPTION 'POSTCOND: completion revision or lock contract drifted'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure
      AND (prosrc NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%'
        OR prosrc NOT LIKE '%check_idempotency_intent%'
        OR prosrc NOT LIKE '%request_fingerprint%'
        OR prosrc NOT LIKE '%request_actor_id%')
  ) THEN RAISE EXCEPTION 'POSTCOND: item-update replay binding drifted'; END IF;
  IF has_function_privilege('anon', 'public.complete_cycle_count(uuid,uuid,text,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.complete_cycle_count(uuid,uuid,text,bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._complete_cycle_count_pre_revision_20260831(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: cycle-count execute grants drifted';
  END IF;
END;
$postcond$;

COMMIT;
