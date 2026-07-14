-- =============================================================================
-- OFFLINE ACTION OFFICE REVIEW + RESOLUTION
-- =============================================================================
-- idempotency-body-check: exempt -- resolve_offline_action uses the canonical
-- check_idempotency/save_idempotency helper pair instead of inline table access.
-- Adds an audited, non-destructive office resolution path for permanent offline
-- action receipts. Office users never impersonate the original actor and never
-- rerun the canonical inventory/application mutation. They may only record that
-- a needs_review item was independently verified as already handled, or that it
-- must not run. The receipt, original safe failure, and actor identity remain.
--
-- Also gives the browser distinct staging-cap error tokens and changes the
-- backlog cap to count only unresolved review items.
-- =============================================================================

ALTER TABLE public.offline_action_receipts
  ADD COLUMN IF NOT EXISTS review_resolution text,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES public.profiles(id);

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.offline_action_receipts'::regclass
      AND conname = 'offline_action_receipts_review_resolution_check'
  ) THEN
    ALTER TABLE public.offline_action_receipts
      ADD CONSTRAINT offline_action_receipts_review_resolution_check
      CHECK (
        review_resolution IS NULL
        OR review_resolution IN ('already_completed', 'abandoned')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.offline_action_receipts'::regclass
      AND conname = 'offline_action_receipts_review_resolution_shape_check'
  ) THEN
    ALTER TABLE public.offline_action_receipts
      ADD CONSTRAINT offline_action_receipts_review_resolution_shape_check
      CHECK (
        (
          review_resolution IS NULL
          AND review_note IS NULL
          AND resolved_at IS NULL
          AND resolved_by IS NULL
        )
        OR
        (
          status = 'needs_review'
          AND review_resolution IS NOT NULL
          AND review_note IS NOT NULL
          AND length(btrim(review_note)) BETWEEN 10 AND 1000
          AND resolved_at IS NOT NULL
          AND resolved_by IS NOT NULL
        )
      );
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS idx_offline_action_receipts_unresolved_review
  ON public.offline_action_receipts (needs_review_at, client_action_id)
  WHERE status = 'needs_review' AND resolved_at IS NULL;

COMMENT ON COLUMN public.offline_action_receipts.review_resolution IS
  'Audited office outcome: already_completed or abandoned. Never means the receipt processor succeeded.';
COMMENT ON COLUMN public.offline_action_receipts.review_note IS
  'Required office explanation for a manual resolution; retained with the permanent receipt.';
COMMENT ON COLUMN public.offline_action_receipts.resolved_at IS
  'Time an office user resolved a needs_review item without rerunning its business mutation.';
COMMENT ON COLUMN public.offline_action_receipts.resolved_by IS
  'Active admin or sales_rep who recorded the non-destructive office resolution.';

-- Replace the Stage 1B guard with structured browser-facing tokens. Exact
-- client_action_id replays still bypass both caps.
CREATE OR REPLACE FUNCTION public._guard_offline_action_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_recent_count integer;
  v_review_count integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.offline_action_receipts r
    WHERE r.client_action_id = NEW.client_action_id
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('offline-action-receipts:' || NEW.actor_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.offline_action_receipts r
    WHERE r.client_action_id = NEW.client_action_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO v_recent_count
    FROM public.offline_action_receipts r
   WHERE r.actor_id = NEW.actor_id
     AND r.received_at >= now() - interval '24 hours';

  IF v_recent_count >= 250 THEN
    RAISE EXCEPTION 'OFFLINE_STAGE_DAILY_CAP: no more than 250 new offline actions may be staged per 24 hours';
  END IF;

  SELECT count(*)
    INTO v_review_count
    FROM public.offline_action_receipts r
   WHERE r.actor_id = NEW.actor_id
     AND r.status = 'needs_review'
     AND r.resolved_at IS NULL;

  IF v_review_count >= 500 THEN
    RAISE EXCEPTION 'OFFLINE_STAGE_REVIEW_BACKLOG: unresolved offline review backlog reached 500 actions';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_offline_action_receipt_insert()
  FROM PUBLIC, anon, authenticated;

-- Office-only sanitized queue. Raw request_payload and idempotency_key are
-- deliberately absent.
CREATE OR REPLACE FUNCTION public.get_offline_action_review_queue(
  p_include_resolved boolean DEFAULT false,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_limit integer;
  v_offset integer;
  v_items jsonb;
  v_total integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_actor
      AND p.is_active = true
      AND p.role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active office role required';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT count(*)::integer
    INTO v_total
    FROM public.offline_action_receipts r
   WHERE r.status = 'needs_review'
     AND (COALESCE(p_include_resolved, false) OR r.resolved_at IS NULL);

  SELECT COALESCE(jsonb_agg(q.item ORDER BY q.needs_review_at DESC, q.client_action_id), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT
        r.needs_review_at,
        r.client_action_id,
        jsonb_build_object(
          'client_action_id', r.client_action_id,
          'actor_id', r.actor_id,
          'actor_name', COALESCE(NULLIF(btrim(actor.full_name), ''), actor.email),
          'operation', r.operation,
          'entity_id', r.entity_id,
          'failure_code', r.failure_code,
          'failure_summary', r.failure_summary,
          'attempt_count', r.attempt_count,
          'client_created_at', r.client_created_at,
          'received_at', r.received_at,
          'needs_review_at', r.needs_review_at,
          'updated_at', r.updated_at,
          'review_resolution', r.review_resolution,
          'review_note', r.review_note,
          'resolved_at', r.resolved_at,
          'resolved_by', r.resolved_by,
          'resolver_name', CASE
            WHEN resolver.id IS NULL THEN NULL
            ELSE COALESCE(NULLIF(btrim(resolver.full_name), ''), resolver.email)
          END
        ) AS item
      FROM public.offline_action_receipts r
      JOIN public.profiles actor ON actor.id = r.actor_id
      LEFT JOIN public.profiles resolver ON resolver.id = r.resolved_by
      WHERE r.status = 'needs_review'
        AND (COALESCE(p_include_resolved, false) OR r.resolved_at IS NULL)
      ORDER BY r.needs_review_at DESC, r.client_action_id
      LIMIT v_limit
      OFFSET v_offset
    ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset
  );
END;
$function$;

-- Audited manual resolution. This function changes receipt review metadata
-- only. It never invokes complete_delivery or complete_job and never deletes.
CREATE OR REPLACE FUNCTION public.resolve_offline_action(
  p_client_action_id uuid,
  p_resolution text,
  p_note text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_receipt public.offline_action_receipts%ROWTYPE;
  v_existing jsonb;
  v_result jsonb;
  v_note text := btrim(COALESCE(p_note, ''));
  v_entity_type text;
  v_resolution_label text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_actor
      AND p.is_active = true
      AND p.role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active office role required';
  END IF;
  IF p_client_action_id IS NULL THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: client action ID is required';
  END IF;
  IF p_resolution IS NULL OR p_resolution NOT IN ('already_completed', 'abandoned') THEN
    RAISE EXCEPTION 'OFFLINE_RESOLUTION_INVALID';
  END IF;
  IF length(v_note) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: resolution note must be 10 to 1000 characters';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: a bounded idempotency key is required';
  END IF;

  -- The shared idempotency helper saves at the end of the transaction. Serialize
  -- this operation+key before the cache check so two different receipts cannot
  -- both mutate under the same previously unseen key.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('resolve_offline_action:' || p_idempotency_key, 0)
  );

  v_existing := public.check_idempotency(p_idempotency_key, 'resolve_offline_action');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'client_action_id' IS DISTINCT FROM p_client_action_id::text
       OR v_existing->>'review_resolution' IS DISTINCT FROM p_resolution
       OR v_existing->>'review_note' IS DISTINCT FROM v_note THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT *
    INTO v_receipt
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_NOT_FOUND: offline receipt not found';
  END IF;
  IF v_receipt.status <> 'needs_review' THEN
    RAISE EXCEPTION 'OFFLINE_ACTION_NOT_REVIEWABLE';
  END IF;
  IF v_receipt.resolved_at IS NOT NULL THEN
    IF v_receipt.resolved_by IS DISTINCT FROM v_actor
       OR v_receipt.review_resolution IS DISTINCT FROM p_resolution
       OR v_receipt.review_note IS DISTINCT FROM v_note THEN
      RAISE EXCEPTION 'OFFLINE_ACTION_ALREADY_RESOLVED';
    END IF;
  ELSE
    UPDATE public.offline_action_receipts
       SET review_resolution = p_resolution,
           review_note = v_note,
           resolved_at = now(),
           resolved_by = v_actor
     WHERE client_action_id = p_client_action_id
     RETURNING * INTO v_receipt;

    v_entity_type := CASE v_receipt.operation
      WHEN 'complete_delivery' THEN 'delivery'
      WHEN 'complete_job' THEN 'job'
      ELSE 'offline_action_receipt'
    END;
    v_resolution_label := CASE p_resolution
      WHEN 'already_completed' THEN 'already handled outside the offline queue'
      ELSE 'intentionally abandoned and must not run'
    END;

    INSERT INTO public.activity_feed (
      event_type,
      description,
      performed_by,
      related_entity_type,
      related_entity_id
    ) VALUES (
      'offline_action_resolved',
      format(
        'Offline %s receipt %s was resolved as %s.',
        v_receipt.operation,
        left(v_receipt.client_action_id::text, 8),
        v_resolution_label
      ),
      v_actor,
      v_entity_type,
      v_receipt.entity_id
    );
  END IF;

  v_result := jsonb_build_object(
    'client_action_id', v_receipt.client_action_id,
    'operation', v_receipt.operation,
    'entity_id', v_receipt.entity_id,
    'status', v_receipt.status,
    'review_resolution', v_receipt.review_resolution,
    'review_note', v_receipt.review_note,
    'resolved_at', v_receipt.resolved_at,
    'resolved_by', v_receipt.resolved_by,
    'updated_at', v_receipt.updated_at
  );

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'resolve_offline_action',
    v_result
  );

  RETURN v_result;
END;
$function$;

-- Extend the owner/office status response with safe resolution metadata. The
-- raw request and idempotency key remain private.
CREATE OR REPLACE FUNCTION public.get_offline_action_status(
  p_client_action_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_receipt public.offline_action_receipts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT p.role
    INTO v_actor_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active profile required';
  END IF;

  SELECT *
    INTO v_receipt
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_NOT_FOUND: offline receipt not found';
  END IF;

  IF v_receipt.actor_id IS DISTINCT FROM v_actor
     AND v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  RETURN jsonb_build_object(
    'client_action_id', v_receipt.client_action_id,
    'actor_id', v_receipt.actor_id,
    'operation', v_receipt.operation,
    'entity_id', v_receipt.entity_id,
    'schema_version', v_receipt.schema_version,
    'client_created_at', v_receipt.client_created_at,
    'status', v_receipt.status,
    'result', v_receipt.result,
    'failure_code', v_receipt.failure_code,
    'failure_summary', v_receipt.failure_summary,
    'attempt_count', v_receipt.attempt_count,
    'last_attempt_at', v_receipt.last_attempt_at,
    'received_at', v_receipt.received_at,
    'succeeded_at', v_receipt.succeeded_at,
    'needs_review_at', v_receipt.needs_review_at,
    'review_resolution', v_receipt.review_resolution,
    'review_note', v_receipt.review_note,
    'resolved_at', v_receipt.resolved_at,
    'resolved_by', v_receipt.resolved_by,
    'updated_at', v_receipt.updated_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_offline_action_review_queue(boolean, integer, integer)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_offline_action(uuid, text, text, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_offline_action_status(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_offline_action_review_queue(boolean, integer, integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_offline_action(uuid, text, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_offline_action_status(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_offline_action_review_queue(boolean, integer, integer) IS
  'Returns safe needs_review receipt metadata to active admin/sales office users; never exposes payloads or idempotency keys.';
COMMENT ON FUNCTION public.resolve_offline_action(uuid, text, text, text) IS
  'Records an audited non-destructive office resolution without rerunning or deleting the offline business action.';

DO $verify$
DECLARE
  v_count integer;
  v_source text;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'offline_action_receipts'
    AND column_name IN ('review_resolution', 'review_note', 'resolved_at', 'resolved_by');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'post-check: offline review resolution columns are incomplete';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('get_offline_action_review_queue', 'resolve_offline_action')
    AND p.prosecdef
    AND p.proconfig @> ARRAY['search_path=public, pg_temp'];
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'post-check: office review RPC security attributes are incomplete';
  END IF;

  SELECT p.prosrc INTO v_source
  FROM pg_proc p
  WHERE p.oid = 'public.resolve_offline_action(uuid,text,text,text)'::regprocedure;
  IF position('pg_advisory_xact_lock' IN v_source) = 0
     OR position('resolve_offline_action:' IN v_source) = 0 THEN
    RAISE EXCEPTION 'post-check: office resolution is missing its per-idempotency-key transaction lock';
  END IF;

  SELECT p.prosrc INTO v_source
  FROM pg_proc p
  WHERE p.oid = 'public._guard_offline_action_receipt_insert()'::regprocedure;
  IF position('resolved_at IS NULL' IN v_source) = 0
     OR position('OFFLINE_STAGE_DAILY_CAP' IN v_source) = 0
     OR position('OFFLINE_STAGE_REVIEW_BACKLOG' IN v_source) = 0 THEN
    RAISE EXCEPTION 'post-check: offline staging guard is missing resolution-aware structured limits';
  END IF;

  SELECT p.prosrc INTO v_source
  FROM pg_proc p
  WHERE p.oid = 'public.stage_offline_action(uuid,text,uuid,integer,timestamptz,jsonb,text,timestamptz)'::regprocedure;
  IF position('v_payload_requires_review' IN v_source) = 0
     OR position('A saved delivery item no longer belongs to this delivery' IN v_source) = 0
     OR position('A saved field no longer belongs to this job' IN v_source) = 0
     OR position('p_entity_snapshot_at' IN v_source) = 0
     OR position('TARGET_STATE_CONFLICT' IN v_source) = 0 THEN
    RAISE EXCEPTION 'post-check: actionable offline payload/target drift is not retained for office review';
  END IF;

  SELECT p.prosrc INTO v_source
  FROM pg_proc p
  WHERE p.oid = 'public.process_offline_action(uuid,text)'::regprocedure;
  IF position('v_receipt.entity_snapshot_at IS NULL' IN v_source) = 0
     OR position('changed after this action reached the server' IN v_source) = 0 THEN
    RAISE EXCEPTION 'post-check: process-time target drift guard is missing';
  END IF;

  IF has_function_privilege('anon', 'public.get_offline_action_review_queue(boolean,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_offline_action(uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: anon must not execute offline office-review RPCs';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.get_offline_action_review_queue(boolean,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.resolve_offline_action(uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: authenticated grants are missing from offline office-review RPCs';
  END IF;
END;
$verify$;
