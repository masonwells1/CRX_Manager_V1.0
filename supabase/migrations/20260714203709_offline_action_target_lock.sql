-- idempotency-body-check: exempt -- offline_action_receipts is the durable idempotency ledger
-- =============================================================================
-- OFFLINE ACTION TARGET LOCK
-- =============================================================================
-- Close the final snapshot-to-mutation race in process_offline_action.
-- The receipt row is already locked. This revision also locks the target
-- delivery/job row while comparing updated_at and retains that lock through the
-- canonical completion call, so a concurrent office edit cannot cross between
-- the comparison and mutation.
-- =============================================================================

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*)
    INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'process_offline_action'
     AND pg_get_function_identity_arguments(p.oid) = 'p_client_action_id uuid, p_idempotency_key text';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pre-check: expected exactly one process_offline_action(uuid,text), found %', v_count;
  END IF;
END;
$verify$;

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
      WHERE d.id = v_receipt.entity_id
      FOR UPDATE;
    ELSE
      SELECT j.updated_at INTO v_target_updated_at
      FROM public.jobs j
      WHERE j.id = v_receipt.entity_id
      FOR UPDATE;
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


REVOKE ALL ON FUNCTION public.process_offline_action(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_offline_action(uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.process_offline_action(uuid, text) IS
  'Locks the durable receipt and target row, executes one canonical offline completion, and records its permanent outcome.';

DO $verify$
DECLARE
  v_source text;
  v_count integer;
BEGIN
  SELECT count(*), max(p.prosrc)
    INTO v_count, v_source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'process_offline_action'
     AND pg_get_function_identity_arguments(p.oid) = 'p_client_action_id uuid, p_idempotency_key text';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'post-check: expected exactly one process_offline_action(uuid,text), found %', v_count;
  END IF;
  IF (
    SELECT count(*)
    FROM regexp_matches(v_source, 'FOR UPDATE', 'g')
  ) < 3 THEN
    RAISE EXCEPTION 'post-check: receipt plus delivery/job target row locks are required';
  END IF;
  IF has_function_privilege('anon', 'public.process_offline_action(uuid,text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.process_offline_action(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: process_offline_action must not be executable by anon/PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.process_offline_action(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: authenticated execution grant is missing';
  END IF;
END;
$verify$;
