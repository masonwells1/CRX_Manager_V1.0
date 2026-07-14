-- =============================================================================
-- STAGE 1B-1A: PERMANENT OFFLINE ACTION RECEIPTS
-- =============================================================================
-- Purpose:
--   Give complete_delivery / complete_job offline replays a permanent server
--   acknowledgement. The canonical business mutation and receipt success state
--   commit in the SAME PostgreSQL transaction, so a lost HTTP response can be
--   resolved by reading the receipt instead of repeating inventory work.
--
-- Scope:
--   * additive table only; no existing table/function body is rewritten
--   * exactly two operations: complete_delivery, complete_job
--   * writes are RPC-only; clients cannot directly mutate receipt rows
--   * no manual abandon/delete path, attachment replay, or notification replay
--
-- Live baseline verified read-only on 2026-07-14 before this draft:
--   complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz) -> jsonb
--     SECURITY DEFINER; search_path=public,pg_temp; md5(prosrc)=9fa0fdc953a0094dcb6e29a2850fe805
--   complete_job(uuid,jsonb,uuid,text) -> jsonb
--     SECURITY DEFINER; search_path=public,pg_temp; md5(prosrc)=3b1137089054fb16166cb4affc695ff9
--   idempotency_keys keeps UNIQUE(idempotency_key) and its rows expire after 24h.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.offline_action_receipts (
  client_action_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  operation text NOT NULL,
  entity_id uuid NOT NULL,
  schema_version integer NOT NULL,
  client_created_at timestamptz NOT NULL,
  entity_snapshot_at timestamptz,
  request_payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'received',
  result jsonb,
  failure_code text,
  failure_summary text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  succeeded_at timestamptz,
  needs_review_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT offline_action_receipts_operation_check
    CHECK (operation IN ('complete_delivery', 'complete_job')),
  CONSTRAINT offline_action_receipts_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT offline_action_receipts_status_check
    CHECK (status IN ('received', 'succeeded', 'needs_review')),
  CONSTRAINT offline_action_receipts_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 50),
  CONSTRAINT offline_action_receipts_idempotency_key_check
    CHECK (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 200),
  CONSTRAINT offline_action_receipts_payload_shape_check
    CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT offline_action_receipts_payload_size_check
    CHECK (pg_column_size(request_payload) <= 65536),
  CONSTRAINT offline_action_receipts_failure_code_check
    CHECK (
      failure_code IS NULL OR failure_code IN (
        'ACTOR_MISMATCH',
        'IDEMPOTENCY_KEY_REUSE',
        'LEGACY_OUTCOME_UNKNOWN',
        'NOT_AUTHORIZED',
        'PAYLOAD_INVALID',
        'PAYLOAD_TOO_LARGE',
        'RESULT_INVALID',
        'RETRY_LIMIT',
        'TARGET_NOT_FOUND',
        'TARGET_STATE_CONFLICT',
        'UNEXPECTED_SERVER_ERROR',
        'UNSUPPORTED_OPERATION',
        'UNSUPPORTED_SCHEMA_VERSION'
      )
    ),
  CONSTRAINT offline_action_receipts_state_shape_check
    CHECK (
      (
        status = 'received'
        AND result IS NULL
        AND failure_code IS NULL
        AND failure_summary IS NULL
        AND succeeded_at IS NULL
        AND needs_review_at IS NULL
      )
      OR
      (
        status = 'succeeded'
        AND result IS NOT NULL
        AND failure_code IS NULL
        AND failure_summary IS NULL
        AND succeeded_at IS NOT NULL
        AND needs_review_at IS NULL
      )
      OR
      (
        status = 'needs_review'
        AND result IS NULL
        AND failure_code IS NOT NULL
        AND failure_summary IS NOT NULL
        AND succeeded_at IS NULL
        AND needs_review_at IS NOT NULL
      )
    )
);

-- Preview/dev databases may already have the earlier queued table shape.
-- Keep the queued migration safely re-runnable without leaving schema drift.
ALTER TABLE public.offline_action_receipts
  ADD COLUMN IF NOT EXISTS entity_snapshot_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_offline_action_receipts_actor_status
  ON public.offline_action_receipts (actor_id, status);

CREATE INDEX IF NOT EXISTS idx_offline_action_receipts_needs_review
  ON public.offline_action_receipts (updated_at, client_action_id)
  WHERE status = 'needs_review';

DROP TRIGGER IF EXISTS trg_offline_action_receipts_updated_at
  ON public.offline_action_receipts;
CREATE TRIGGER trg_offline_action_receipts_updated_at
  BEFORE UPDATE ON public.offline_action_receipts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.offline_action_receipts ENABLE ROW LEVEL SECURITY;

DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'offline_action_receipts'
      AND policyname = 'offline_action_receipts_select_authorized'
  ) THEN
    CREATE POLICY offline_action_receipts_select_authorized
      ON public.offline_action_receipts
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active = true
            AND (
              offline_action_receipts.actor_id = p.id
              OR p.role IN ('admin', 'sales_rep')
            )
        )
      );
  END IF;
END;
$policy$;

-- The status RPC is the client read path so request_payload/idempotency_key can
-- never leak through PostgREST. RLS remains as defense-in-depth for any future
-- deliberately reviewed table/view grant.
REVOKE ALL ON TABLE public.offline_action_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.offline_action_receipts TO service_role;

COMMENT ON TABLE public.offline_action_receipts IS
  'Permanent acknowledgement for approved offline complete_delivery/complete_job actions. RPC-only writes; unresolved rows are never auto-deleted.';

-- =============================================================================
-- stage_offline_action
-- =============================================================================
-- Validates and canonicalizes one operation payload, then performs an atomic
-- INSERT ... ON CONFLICT DO NOTHING + exact immutable-field comparison.
-- A target/assignment that changed while the device was offline is retained as
-- needs_review (office-visible) rather than discarded.
-- =============================================================================

DROP FUNCTION IF EXISTS public.stage_offline_action(
  uuid, text, uuid, integer, timestamptz, jsonb, text
);

CREATE OR REPLACE FUNCTION public.stage_offline_action(
  p_client_action_id uuid,
  p_operation text,
  p_entity_id uuid,
  p_schema_version integer,
  p_client_created_at timestamptz,
  p_payload jsonb,
  p_idempotency_key text DEFAULT NULL,
  p_entity_snapshot_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_existing public.offline_action_receipts%ROWTYPE;
  v_canonical jsonb := '{}'::jsonb;
  v_quantities jsonb;
  v_canonical_quantities jsonb := '{}'::jsonb;
  v_field_acres jsonb := '[]'::jsonb;
  v_canonical_field_acres jsonb := '[]'::jsonb;
  v_seen_fields jsonb := '{}'::jsonb;
  v_key text;
  v_text text;
  v_value jsonb;
  v_uuid uuid;
  v_number numeric;
  v_timestamp timestamptz;
  v_assigned_driver uuid;
  v_job_applicator uuid;
  v_target_updated_at timestamptz;
  v_target_exists boolean := false;
  v_authorized boolean := false;
  v_initial_status text := 'received';
  v_failure_code text;
  v_failure_summary text;
  v_payload_requires_review boolean := false;
  v_payload_review_summary text;
  v_now timestamptz := now();
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

  IF p_client_action_id IS NULL OR p_entity_id IS NULL OR p_client_created_at IS NULL THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: action, entity, and client timestamp are required';
  END IF;
  IF p_client_created_at > v_now + interval '24 hours' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: client timestamp is too far in the future';
  END IF;
  IF p_schema_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'UNSUPPORTED_SCHEMA_VERSION';
  END IF;
  IF p_operation IS NULL
     OR p_operation NOT IN ('complete_delivery', 'complete_job') THEN
    RAISE EXCEPTION 'UNSUPPORTED_OPERATION';
  END IF;
  IF p_idempotency_key IS NULL
     OR btrim(p_idempotency_key) = ''
     OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: a bounded idempotency key is required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: payload must be a JSON object';
  END IF;
  IF pg_column_size(p_payload) > 65536 THEN
    RAISE EXCEPTION 'PAYLOAD_TOO_LARGE';
  END IF;

  IF p_operation = 'complete_delivery' THEN
    IF (p_payload - ARRAY['signed_by', 'quantities', 'issue_type', 'issue_notes', 'completed_at']) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: unsupported complete_delivery field';
    END IF;

    v_text := btrim(COALESCE(p_payload->>'signed_by', ''));
    IF v_text = '' OR length(v_text) > 200 THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: signed_by is required and limited to 200 characters';
    END IF;
    v_canonical := jsonb_build_object('signed_by', v_text);

    IF p_payload ? 'quantities' AND p_payload->'quantities' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'quantities') <> 'object' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: quantities must be an object';
      END IF;
      v_quantities := p_payload->'quantities';
      IF (SELECT count(*) FROM jsonb_object_keys(v_quantities)) > 500 THEN
        RAISE EXCEPTION 'PAYLOAD_TOO_LARGE: quantities exceeds 500 entries';
      END IF;

      FOR v_key, v_value IN SELECT key, value FROM jsonb_each(v_quantities)
      LOOP
        IF v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity key must be a UUID';
        END IF;
        IF jsonb_typeof(v_value) NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity must be numeric';
        END IF;
        v_text := v_value #>> '{}';
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity must be a finite decimal';
        END IF;
        v_number := v_text::numeric;
        IF v_number < 0 THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: quantity cannot be negative';
        END IF;
        v_uuid := v_key::uuid;
        v_canonical_quantities := v_canonical_quantities || jsonb_build_object(v_uuid::text, to_jsonb(v_number));
      END LOOP;
      v_canonical := v_canonical || jsonb_build_object('quantities', v_canonical_quantities);
    END IF;

    IF p_payload ? 'issue_type' AND p_payload->'issue_type' <> 'null'::jsonb THEN
      v_text := p_payload->>'issue_type';
      IF v_text NOT IN ('none', 'customer_not_home', 'gate_locked', 'road_blocked', 'wrong_address', 'refused', 'weather', 'other') THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: issue_type is not supported';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('issue_type', v_text);
    END IF;

    IF p_payload ? 'issue_notes' AND p_payload->'issue_notes' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'issue_notes') <> 'string' OR length(p_payload->>'issue_notes') > 2000 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: issue_notes must be text up to 2000 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('issue_notes', p_payload->>'issue_notes');
    END IF;

    IF p_payload ? 'completed_at' AND p_payload->'completed_at' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'completed_at') <> 'string' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: completed_at must be an ISO timestamp';
      END IF;
      BEGIN
        v_timestamp := (p_payload->>'completed_at')::timestamptz;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: completed_at must be an ISO timestamp';
      END;
      IF v_timestamp > v_now + interval '5 minutes' THEN
        v_payload_requires_review := true;
        v_payload_review_summary := 'The saved completion time is ahead of the server clock. Office review is required.';
      ELSIF v_timestamp < v_now - interval '14 days' THEN
        v_payload_requires_review := true;
        v_payload_review_summary := 'The saved completion time is more than 14 days old. Office review is required before posting into a prior period.';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('completed_at', to_jsonb(v_timestamp));
    END IF;

    SELECT d.assigned_driver, d.updated_at
      INTO v_assigned_driver, v_target_updated_at
      FROM public.deliveries d
     WHERE d.id = p_entity_id;
    v_target_exists := FOUND;
    v_authorized := v_target_exists AND (
      v_actor_role IN ('admin', 'sales_rep')
      OR (v_actor_role = 'driver' AND v_assigned_driver = v_actor)
    );

    IF v_target_exists AND v_quantities IS NOT NULL AND EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_quantities) q(item_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.delivery_items di
        WHERE di.id = q.item_id::uuid
          AND di.delivery_id = p_entity_id
      )
    ) THEN
      v_payload_requires_review := true;
      v_payload_review_summary := 'A saved delivery item no longer belongs to this delivery. Office review is required.';
    END IF;

  ELSE
    IF (p_payload - ARRAY[
      'actual_start_time', 'actual_end_time', 'wind_speed', 'wind_direction',
      'temperature', 'humidity', 'actual_gallons_applied', 'notes', 'field_acres'
    ]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'PAYLOAD_INVALID: unsupported complete_job field';
    END IF;

    FOREACH v_key IN ARRAY ARRAY['wind_speed', 'temperature', 'humidity', 'actual_gallons_applied']::text[]
    LOOP
      IF p_payload ? v_key AND p_payload->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(p_payload->v_key) NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be numeric', v_key;
        END IF;
        v_text := p_payload->>v_key;
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be a finite decimal', v_key;
        END IF;
        v_number := v_text::numeric;
        v_canonical := v_canonical || jsonb_build_object(v_key, to_jsonb(v_number));
      END IF;
    END LOOP;

    IF p_payload ? 'wind_direction' AND p_payload->'wind_direction' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'wind_direction') <> 'string' OR length(p_payload->>'wind_direction') > 64 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: wind_direction must be text up to 64 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('wind_direction', p_payload->>'wind_direction');
    END IF;

    IF p_payload ? 'notes' AND p_payload->'notes' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'notes') <> 'string' OR length(p_payload->>'notes') > 4000 THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: notes must be text up to 4000 characters';
      END IF;
      v_canonical := v_canonical || jsonb_build_object('notes', p_payload->>'notes');
    END IF;

    FOREACH v_key IN ARRAY ARRAY['actual_start_time', 'actual_end_time']::text[]
    LOOP
      IF p_payload ? v_key AND p_payload->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(p_payload->v_key) <> 'string' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be an ISO timestamp', v_key;
        END IF;
        BEGIN
          v_timestamp := (p_payload->>v_key)::timestamptz;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: % must be an ISO timestamp', v_key;
        END;
        v_canonical := v_canonical || jsonb_build_object(v_key, to_jsonb(v_timestamp));
      END IF;
    END LOOP;

    IF p_payload ? 'field_acres' AND p_payload->'field_acres' <> 'null'::jsonb THEN
      IF jsonb_typeof(p_payload->'field_acres') <> 'array' THEN
        RAISE EXCEPTION 'PAYLOAD_INVALID: field_acres must be an array';
      END IF;
      v_field_acres := p_payload->'field_acres';
      IF jsonb_array_length(v_field_acres) > 500 THEN
        RAISE EXCEPTION 'PAYLOAD_TOO_LARGE: field_acres exceeds 500 entries';
      END IF;

      FOR v_value IN SELECT value FROM jsonb_array_elements(v_field_acres)
      LOOP
        IF jsonb_typeof(v_value) <> 'object'
           OR (v_value - ARRAY['field_id', 'acres_applied']) <> '{}'::jsonb
           OR NOT (v_value ? 'field_id')
           OR NOT (v_value ? 'acres_applied') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: field_acres entry shape is invalid';
        END IF;
        v_text := v_value->>'field_id';
        IF v_text IS NULL OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: field_id must be a UUID';
        END IF;
        v_uuid := v_text::uuid;
        IF v_seen_fields ? v_uuid::text THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: duplicate field_id';
        END IF;
        v_seen_fields := v_seen_fields || jsonb_build_object(v_uuid::text, true);

        IF jsonb_typeof(v_value->'acres_applied') NOT IN ('number', 'string') THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied must be numeric';
        END IF;
        v_text := v_value->>'acres_applied';
        IF v_text IS NULL OR v_text !~ '^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied must be a finite decimal';
        END IF;
        v_number := v_text::numeric;
        IF v_number < 0 THEN
          RAISE EXCEPTION 'PAYLOAD_INVALID: acres_applied cannot be negative';
        END IF;
        v_canonical_field_acres := v_canonical_field_acres || jsonb_build_array(
          jsonb_build_object('field_id', v_uuid, 'acres_applied', v_number)
        );
      END LOOP;

      SELECT COALESCE(jsonb_agg(e.value ORDER BY e.value->>'field_id'), '[]'::jsonb)
        INTO v_canonical_field_acres
        FROM jsonb_array_elements(v_canonical_field_acres) e(value);
      v_canonical := v_canonical || jsonb_build_object('field_acres', v_canonical_field_acres);
    END IF;

    SELECT j.applicator_id, j.updated_at
      INTO v_job_applicator, v_target_updated_at
      FROM public.jobs j
     WHERE j.id = p_entity_id;
    v_target_exists := FOUND;

    v_authorized := v_target_exists AND (
      public.is_admin()
      OR public.is_sales_rep()
      OR (public.is_applicator() AND v_job_applicator IS NOT NULL AND v_job_applicator = v_actor)
      OR (
        public.is_applicator()
        AND public._is_dispatched_to_me(p_entity_id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_fields jf2
          WHERE jf2.job_id = p_entity_id
            AND NOT EXISTS (
              SELECT 1
              FROM public.job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (
                    d2.crew_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                      WHERE gcm.crew_id = d2.crew_id
                        AND gcm.profile_id = v_actor
                        AND gcm.is_active
                        AND gc.is_active
                    )
                  )
                )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_location_dispatches d
          WHERE d.job_id = p_entity_id
            AND d.dispatch_status = 'dispatched'
            AND NOT (
              (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
              OR (
                d.crew_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM public.ground_crew_members gcm
                  JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                  WHERE gcm.crew_id = d.crew_id
                    AND gcm.profile_id = v_actor
                    AND gcm.is_active
                    AND gc.is_active
                )
              )
            )
        )
      )
    );

    IF v_target_exists AND p_payload ? 'field_acres' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_canonical_field_acres) e(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.job_fields jf
        WHERE jf.job_id = p_entity_id
          AND jf.field_id = (e.value->>'field_id')::uuid
      )
    ) THEN
      v_payload_requires_review := true;
      v_payload_review_summary := 'A saved field no longer belongs to this job. Office review is required.';
    END IF;
  END IF;

  IF NOT v_target_exists THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'TARGET_NOT_FOUND';
    v_failure_summary := 'The referenced delivery or job no longer exists.';
  ELSIF NOT v_authorized THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'NOT_AUTHORIZED';
    v_failure_summary := 'The current user is no longer authorized to complete this delivery or job.';
  ELSIF p_entity_snapshot_at IS NULL THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'LEGACY_OUTCOME_UNKNOWN';
    v_failure_summary := 'This saved action does not include a target snapshot. Office review is required before it can run.';
  ELSIF p_entity_snapshot_at IS NOT NULL
        AND v_target_updated_at IS DISTINCT FROM p_entity_snapshot_at THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'TARGET_STATE_CONFLICT';
    v_failure_summary := 'The delivery or job changed after this action was saved offline. Office review is required.';
  ELSIF v_payload_requires_review THEN
    v_initial_status := 'needs_review';
    v_failure_code := 'PAYLOAD_INVALID';
    v_failure_summary := v_payload_review_summary;
  END IF;

  INSERT INTO public.offline_action_receipts (
    client_action_id, actor_id, operation, entity_id, schema_version,
    client_created_at, entity_snapshot_at, request_payload, idempotency_key,
    status, failure_code, failure_summary, needs_review_at
  ) VALUES (
    p_client_action_id, v_actor, p_operation, p_entity_id, p_schema_version,
    p_client_created_at, p_entity_snapshot_at, v_canonical, p_idempotency_key,
    v_initial_status, v_failure_code, v_failure_summary,
    CASE WHEN v_initial_status = 'needs_review' THEN v_now ELSE NULL END
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_existing
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.offline_action_receipts r
      WHERE r.idempotency_key = p_idempotency_key
    ) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
    RAISE EXCEPTION 'OFFLINE_STAGE_CONFLICT';
  END IF;

  IF v_existing.actor_id IS DISTINCT FROM v_actor
     OR v_existing.operation IS DISTINCT FROM p_operation
     OR v_existing.entity_id IS DISTINCT FROM p_entity_id
     OR v_existing.schema_version IS DISTINCT FROM p_schema_version
     OR v_existing.client_created_at IS DISTINCT FROM p_client_created_at
     OR v_existing.entity_snapshot_at IS DISTINCT FROM p_entity_snapshot_at
     OR v_existing.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR v_existing.request_payload IS DISTINCT FROM v_canonical THEN
    RAISE EXCEPTION 'OFFLINE_ACTION_ID_REUSE';
  END IF;

  RETURN jsonb_build_object(
    'client_action_id', v_existing.client_action_id,
    'operation', v_existing.operation,
    'entity_id', v_existing.entity_id,
    'status', v_existing.status,
    'result', v_existing.result,
    'failure_code', v_existing.failure_code,
    'failure_summary', v_existing.failure_summary,
    'attempt_count', v_existing.attempt_count,
    'client_created_at', v_existing.client_created_at,
    'received_at', v_existing.received_at,
    'updated_at', v_existing.updated_at
  );
END;
$function$;

-- =============================================================================
-- process_offline_action
-- =============================================================================
-- Locks one received receipt, invokes the explicit canonical function, validates
-- its result, and records success in the same outer transaction. Known business
-- failures roll back the canonical subtransaction and commit a sanitized review
-- state. Connection/transaction/system failures are re-raised so the receipt
-- remains received and safely retryable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.process_offline_action(
  p_client_action_id uuid,
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
  v_result jsonb;
  v_sqlstate text;
  v_message text;
  v_failure_code text;
  v_failure_summary text;
  v_target_updated_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = v_actor AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: active profile required';
  END IF;
  IF p_client_action_id IS NULL OR p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: action ID and idempotency key are required';
  END IF;

  SELECT *
    INTO v_receipt
    FROM public.offline_action_receipts r
   WHERE r.client_action_id = p_client_action_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_NOT_FOUND: offline receipt not found';
  END IF;
  IF v_receipt.actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF v_receipt.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
  END IF;

  IF v_receipt.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', v_receipt.status,
      'result', v_receipt.result,
      'attempt_count', v_receipt.attempt_count,
      'succeeded_at', v_receipt.succeeded_at,
      'updated_at', v_receipt.updated_at
    );
  END IF;
  IF v_receipt.status = 'needs_review' THEN
    RAISE EXCEPTION 'OFFLINE_ACTION_NEEDS_REVIEW';
  END IF;

  -- Re-check immediately before the canonical mutation. This closes the gap
  -- where staging committed as received, the target changed, and processing
  -- retried later after a weak-connection interruption.
  IF v_receipt.entity_snapshot_at IS NOT NULL THEN
    IF v_receipt.operation = 'complete_delivery' THEN
      SELECT d.updated_at INTO v_target_updated_at
      FROM public.deliveries d
      WHERE d.id = v_receipt.entity_id;
    ELSE
      SELECT j.updated_at INTO v_target_updated_at
      FROM public.jobs j
      WHERE j.id = v_receipt.entity_id;
    END IF;
  END IF;

  IF v_receipt.entity_snapshot_at IS NULL
     OR v_target_updated_at IS DISTINCT FROM v_receipt.entity_snapshot_at THEN
    v_failure_code := CASE
      WHEN v_receipt.entity_snapshot_at IS NULL THEN 'LEGACY_OUTCOME_UNKNOWN'
      ELSE 'TARGET_STATE_CONFLICT'
    END;
    v_failure_summary := CASE
      WHEN v_receipt.entity_snapshot_at IS NULL
        THEN 'This saved action does not include a target snapshot. Office review is required before it can run.'
      ELSE 'The delivery or job changed after this action reached the server. Office review is required.'
    END;
    UPDATE public.offline_action_receipts
       SET status = 'needs_review',
           failure_code = v_failure_code,
           failure_summary = v_failure_summary,
           needs_review_at = now()
     WHERE client_action_id = p_client_action_id;
    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', 'needs_review',
      'failure_code', v_failure_code,
      'failure_summary', v_failure_summary,
      'attempt_count', v_receipt.attempt_count
    );
  END IF;

  IF v_receipt.attempt_count >= 50 THEN
    UPDATE public.offline_action_receipts
       SET status = 'needs_review',
           failure_code = 'RETRY_LIMIT',
           failure_summary = 'The server retry limit was reached. Office review is required.',
           needs_review_at = now()
     WHERE client_action_id = p_client_action_id;
    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', 'needs_review',
      'failure_code', 'RETRY_LIMIT',
      'failure_summary', 'The server retry limit was reached. Office review is required.'
    );
  END IF;

  UPDATE public.offline_action_receipts
     SET attempt_count = attempt_count + 1,
         last_attempt_at = now()
   WHERE client_action_id = p_client_action_id;

  BEGIN
    IF v_receipt.operation = 'complete_delivery' THEN
      SELECT public.complete_delivery(
        p_delivery_id => v_receipt.entity_id,
        p_signed_by => v_receipt.request_payload->>'signed_by',
        p_performed_by => v_actor,
        p_quantities => v_receipt.request_payload->'quantities',
        p_issue_type => v_receipt.request_payload->>'issue_type',
        p_issue_notes => v_receipt.request_payload->>'issue_notes',
        p_idempotency_key => v_receipt.idempotency_key,
        p_completed_at => (v_receipt.request_payload->>'completed_at')::timestamptz
      ) INTO v_result;

      IF jsonb_typeof(v_result) <> 'object'
         OR v_result->>'delivery_id' IS DISTINCT FROM v_receipt.entity_id::text
         OR v_result->>'status' NOT IN ('completed', 'partial') THEN
        RAISE EXCEPTION 'OFFLINE_RESULT_INVALID';
      END IF;

    ELSIF v_receipt.operation = 'complete_job' THEN
      SELECT public.complete_job(
        p_job_id => v_receipt.entity_id,
        p_applied_info => v_receipt.request_payload,
        p_performed_by => v_actor,
        p_idempotency_key => v_receipt.idempotency_key
      ) INTO v_result;

      IF jsonb_typeof(v_result) <> 'object'
         OR v_result->'success' IS DISTINCT FROM 'true'::jsonb
         OR v_result->>'job_id' IS DISTINCT FROM v_receipt.entity_id::text
         OR COALESCE(btrim(v_result->>'record_number'), '') = '' THEN
        RAISE EXCEPTION 'OFFLINE_RESULT_INVALID';
      END IF;

    ELSE
      RAISE EXCEPTION 'UNSUPPORTED_OPERATION';
    END IF;

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_message = MESSAGE_TEXT;

    -- These classes are retryable infrastructure/transaction failures. Re-raise
    -- so this entire call, including attempt_count, rolls back to received.
    IF left(v_sqlstate, 2) IN ('08', '40', '53', '57', '58') THEN
      RAISE;
    END IF;

    -- The canonical functions currently use stable English tokens rather than
    -- structured SQLSTATEs for business failures. Keep these phrases aligned
    -- with their live definitions; the rolled-back smoke deliberately catches
    -- drift in the lifecycle-conflict phrase.
    IF v_message = 'OFFLINE_RESULT_INVALID' THEN
      v_failure_code := 'RESULT_INVALID';
      v_failure_summary := 'The business action returned an unexpected result. Office review is required.';
    ELSIF v_message IN (
      'Not authorized to complete this delivery',
      'Not authorized to complete this job'
    ) THEN
      v_failure_code := 'NOT_AUTHORIZED';
      v_failure_summary := 'The current user is not authorized to complete this delivery or job.';
    ELSIF v_message LIKE 'Delivery not found:%'
       OR v_message LIKE 'Job not found:%' THEN
      v_failure_code := 'TARGET_NOT_FOUND';
      v_failure_summary := 'The referenced delivery or job no longer exists.';
    ELSIF v_message LIKE 'Delivery must be in_progress to complete%'
       OR v_message LIKE 'Job must be in_progress before completion.%' THEN
      v_failure_code := 'TARGET_STATE_CONFLICT';
      v_failure_summary := 'The delivery or job changed after this offline action was saved. Office comparison is required.';
    ELSIF v_message ILIKE '%IDEMPOTENCY%CROSS%OP%'
       OR v_message ILIKE '%idempotency%reuse%' THEN
      v_failure_code := 'IDEMPOTENCY_KEY_REUSE';
      v_failure_summary := 'The idempotency key is already tied to different work. Office review is required.';
    ELSIF v_sqlstate = '23505' THEN
      -- A canonical UNIQUE failure is not necessarily an idempotency collision
      -- (for example, a record-number collision). Do not mislabel it.
      v_failure_code := 'UNEXPECTED_SERVER_ERROR';
      v_failure_summary := 'The business action hit an unexpected uniqueness conflict. Office review is required.';
    ELSIF left(v_sqlstate, 2) IN ('22', '23') THEN
      v_failure_code := 'PAYLOAD_INVALID';
      v_failure_summary := 'The saved action no longer satisfies the database contract. Office review is required.';
    ELSE
      v_failure_code := 'UNEXPECTED_SERVER_ERROR';
      v_failure_summary := 'The server could not safely complete this action. Office review is required.';
    END IF;

    UPDATE public.offline_action_receipts
       SET status = 'needs_review',
           result = NULL,
           failure_code = v_failure_code,
           failure_summary = v_failure_summary,
           needs_review_at = now()
     WHERE client_action_id = p_client_action_id;

    RETURN jsonb_build_object(
      'client_action_id', v_receipt.client_action_id,
      'operation', v_receipt.operation,
      'entity_id', v_receipt.entity_id,
      'status', 'needs_review',
      'failure_code', v_failure_code,
      'failure_summary', v_failure_summary,
      'attempt_count', v_receipt.attempt_count + 1
    );
  END;

  UPDATE public.offline_action_receipts
     SET status = 'succeeded',
         result = v_result,
         failure_code = NULL,
         failure_summary = NULL,
         succeeded_at = now(),
         needs_review_at = NULL
   WHERE client_action_id = p_client_action_id
   RETURNING * INTO v_receipt;

  RETURN jsonb_build_object(
    'client_action_id', v_receipt.client_action_id,
    'operation', v_receipt.operation,
    'entity_id', v_receipt.entity_id,
    'status', v_receipt.status,
    'result', v_receipt.result,
    'attempt_count', v_receipt.attempt_count,
    'succeeded_at', v_receipt.succeeded_at,
    'updated_at', v_receipt.updated_at
  );
END;
$function$;

-- =============================================================================
-- get_offline_action_status
-- =============================================================================
-- Narrow status read. The original active actor can read their own receipt;
-- active admin/sales_rep users can read a receipt for future office review.
-- Raw request payload and idempotency key are never returned.
-- =============================================================================

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
    'updated_at', v_receipt.updated_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.stage_offline_action(uuid, text, uuid, integer, timestamptz, jsonb, text, timestamptz)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_offline_action(uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_offline_action_status(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.stage_offline_action(uuid, text, uuid, integer, timestamptz, jsonb, text, timestamptz)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_offline_action(uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_offline_action_status(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.stage_offline_action(uuid, text, uuid, integer, timestamptz, jsonb, text, timestamptz) IS
  'Validates and permanently stages one approved offline completion under an immutable client UUID.';
COMMENT ON FUNCTION public.process_offline_action(uuid, text) IS
  'Processes one staged offline completion; canonical business mutation and success receipt commit atomically.';
COMMENT ON FUNCTION public.get_offline_action_status(uuid) IS
  'Returns sanitized receipt status to the active owner or active admin/sales office user.';

-- =============================================================================
-- POST-APPLY STRUCTURAL GATES
-- =============================================================================

DO $verify$
DECLARE
  v_count integer;
  v_rls boolean;
  v_delivery_source text;
  v_job_source text;
BEGIN
  SELECT c.relrowsecurity
    INTO v_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'offline_action_receipts';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'post-check: offline_action_receipts RLS must be enabled';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('stage_offline_action', 'process_offline_action', 'get_offline_action_status');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'post-check: expected exactly 3 offline receipt RPC overloads, found %', v_count;
  END IF;

  SELECT p.prosrc INTO v_delivery_source
  FROM pg_proc p
  WHERE p.oid = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)'::regprocedure;
  IF v_delivery_source IS NULL
     OR strpos(v_delivery_source, 'Not authorized to complete this delivery') = 0
     OR strpos(v_delivery_source, 'Delivery not found:') = 0
     OR strpos(v_delivery_source, 'Delivery must be in_progress to complete') = 0 THEN
    RAISE EXCEPTION 'post-check: complete_delivery business-error contract drifted';
  END IF;

  SELECT p.prosrc INTO v_job_source
  FROM pg_proc p
  WHERE p.oid = 'public.complete_job(uuid,jsonb,uuid,text)'::regprocedure;
  IF v_job_source IS NULL
     OR strpos(v_job_source, 'Not authorized to complete this job') = 0
     OR strpos(v_job_source, 'Job not found:') = 0
     OR strpos(v_job_source, 'Job must be in_progress before completion') = 0 THEN
    RAISE EXCEPTION 'post-check: complete_job business-error contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('stage_offline_action', 'process_offline_action', 'get_offline_action_status')
      AND (
        NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
      )
  ) THEN
    RAISE EXCEPTION 'post-check: offline receipt RPC SECURITY DEFINER/search_path posture is wrong';
  END IF;

  IF has_table_privilege('authenticated', 'public.offline_action_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.offline_action_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.offline_action_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.offline_action_receipts', 'DELETE') THEN
    RAISE EXCEPTION 'post-check: authenticated must not have direct receipt table privileges';
  END IF;

  IF has_function_privilege('anon', 'public.stage_offline_action(uuid,text,uuid,integer,timestamptz,jsonb,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.process_offline_action(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_offline_action_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: anon must not execute offline receipt RPCs';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.stage_offline_action(uuid,text,uuid,integer,timestamptz,jsonb,text,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.process_offline_action(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_offline_action_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: authenticated must execute all offline receipt RPCs';
  END IF;
END;
$verify$;
