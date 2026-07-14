-- Fixtures for the disposable office-resolution proof. This file must never
-- run against production or the reusable local template database.

DO $guard$
BEGIN
  IF current_database() !~ '^crx_offline_resolution_proof_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'PROOF_SAFETY: refusing non-disposable database %', current_database();
  END IF;
END;
$guard$;

CREATE TABLE public.offline_resolution_proof_control (
  label text PRIMARY KEY,
  client_action_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  idempotency_key text NOT NULL
);

REVOKE ALL ON TABLE public.offline_resolution_proof_control
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public._offline_resolution_proof_delay()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.resolved_at IS NULL
     AND NEW.resolved_at IS NOT NULL
     AND current_setting('crx.review_delay', true) = 'on' THEN
    PERFORM pg_sleep(4);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._offline_resolution_proof_delay()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_offline_resolution_proof_delay
BEFORE UPDATE ON public.offline_action_receipts
FOR EACH ROW
EXECUTE FUNCTION public._offline_resolution_proof_delay();

DO $seed$
DECLARE
  v_actor uuid := '00000000-0000-0000-0000-0000000000a1'::uuid;
  v_action uuid;
  v_entity uuid;
  v_key text;
  v_label text;
BEGIN
  FOREACH v_label IN ARRAY ARRAY['primary', 'race', 'owner_status', 'same_key_a', 'same_key_b'] LOOP
    v_action := gen_random_uuid();
    v_entity := gen_random_uuid();
    v_key := '[PROOF] resolution-' || v_label || '-' || substr(md5(random()::text), 1, 8);

    INSERT INTO public.offline_action_receipts (
      client_action_id,
      actor_id,
      operation,
      entity_id,
      schema_version,
      client_created_at,
      request_payload,
      idempotency_key,
      status,
      failure_code,
      failure_summary,
      attempt_count,
      last_attempt_at,
      needs_review_at,
      received_at
    ) VALUES (
      v_action,
      v_actor,
      CASE WHEN v_label = 'owner_status' THEN 'complete_delivery' ELSE 'complete_job' END,
      v_entity,
      1,
      now() - interval '3 hours',
      jsonb_build_object('private_proof_value', 'RAW_PAYLOAD_MUST_NOT_ESCAPE'),
      v_key,
      'needs_review',
      'TARGET_STATE_CONFLICT',
      'The target changed while the device was offline.',
      1,
      now() - interval '2 hours',
      now() - interval '2 hours',
      now() - interval '3 hours'
    );

    INSERT INTO public.offline_resolution_proof_control
    VALUES (v_label, v_action, v_actor, v_entity, v_key);
  END LOOP;
END;
$seed$;
