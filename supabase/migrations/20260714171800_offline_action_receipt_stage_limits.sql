-- Bound the permanent offline-receipt write path per actor.
--
-- Exact client_action_id replays remain available even at the limits. New
-- actions are capped at 250 per rolling 24 hours and 500 unresolved
-- needs_review receipts per actor. The browser must retain a locally queued
-- action when this guard rejects a new stage request.

CREATE INDEX IF NOT EXISTS idx_offline_action_receipts_actor_received
  ON public.offline_action_receipts (actor_id, received_at DESC);

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
  -- A stable action replay is a read-through of the permanent receipt, not a
  -- new write. Let ON CONFLICT and stage_offline_action's exact comparison
  -- handle it even when this actor has reached a limit.
  IF EXISTS (
    SELECT 1
    FROM public.offline_action_receipts r
    WHERE r.client_action_id = NEW.client_action_id
  ) THEN
    RETURN NEW;
  END IF;

  -- Serialize new staging for one actor so simultaneous requests cannot each
  -- observe a count below the cap and collectively cross it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('offline-action-receipts:' || NEW.actor_id::text, 0)
  );

  -- Recheck after the lock because another session may have committed the same
  -- client action while this session was waiting.
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
    RAISE EXCEPTION 'OFFLINE_STAGE_RATE_LIMIT: no more than 250 new offline actions may be staged per 24 hours';
  END IF;

  -- Once an actor already has 500 unresolved review items, stop every new
  -- receipt (including an initially valid/received one) until office cleanup.
  -- Existing action-ID replays still returned above before this check.
  SELECT count(*)
    INTO v_review_count
    FROM public.offline_action_receipts r
   WHERE r.actor_id = NEW.actor_id
     AND r.status = 'needs_review';

  IF v_review_count >= 500 THEN
    RAISE EXCEPTION 'OFFLINE_STAGE_RATE_LIMIT: unresolved offline review backlog reached 500 actions';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_offline_action_receipt_insert()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_offline_action_receipt_insert_guard
  ON public.offline_action_receipts;
CREATE TRIGGER trg_offline_action_receipt_insert_guard
BEFORE INSERT ON public.offline_action_receipts
FOR EACH ROW
EXECUTE FUNCTION public._guard_offline_action_receipt_insert();

DO $verify$
DECLARE
  v_acl aclitem[];
  v_public_exec integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.offline_action_receipts'::regclass
      AND t.tgname = 'trg_offline_action_receipt_insert_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post-check: offline receipt insert guard trigger is missing';
  END IF;

  IF has_function_privilege('anon', 'public._guard_offline_action_receipt_insert()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._guard_offline_action_receipt_insert()', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: offline receipt insert guard must be trigger-only';
  END IF;

  SELECT p.proacl INTO v_acl
  FROM pg_proc p
  WHERE p.oid = 'public._guard_offline_action_receipt_insert()'::regprocedure;
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'post-check: insert guard has default PUBLIC execution';
  END IF;
  SELECT count(*) INTO v_public_exec
  FROM aclexplode(v_acl) a
  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE';
  IF v_public_exec <> 0 THEN
    RAISE EXCEPTION 'post-check: PUBLIC can execute the insert guard';
  END IF;
END;
$verify$;
