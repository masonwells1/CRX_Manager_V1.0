-- Team Board delegation fixes (from docs/audits/team-board-todo-audit-2026-08-08.md, PR #351)
--
-- Problem 1: tnotes_update RLS only allows the note's CREATOR or an admin to
-- update a team note, but the UI shows the completion checkbox to everyone —
-- an employee assigned a task by someone else cannot check it off (the update
-- matches 0 rows). Live evidence: 21 delegated notes, zero ever completed by
-- a non-creator.
--   Fix: complete_team_note RPC. Completion/reopen goes through a SECURITY
--   DEFINER path with its own authorization (creator OR assignee OR admin).
--   The row-level tnotes_update policy is deliberately left unchanged —
--   full edits (title, content, reassignment, delete) stay creator-or-admin.
--
-- Problem 2: assigning a team note notifies no one (deliveries notify via
-- 'delivery_update'/'delivery_assigned' and jobs via 'job_assigned'; team
-- notes only notify on comment @mentions).
--   Fix: notify_team_note_assignment trigger — inserts a NEW notification
--   type 'task_assigned' on INSERT-with-assignee or reassignment. Also covers
--   notes created by log_customer_interaction's follow-up path.
--   notifications.notification_type has no CHECK constraint (verified live),
--   so the new type value needs no constraint change.

-- ── 1. complete_team_note RPC ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_team_note(
  p_note_id uuid,
  p_completed boolean,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_note public.team_notes%ROWTYPE;
  v_row_completed boolean;
  v_row_completed_by uuid;
  v_fingerprint text;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_note_id IS NULL THEN
    RAISE EXCEPTION 'NOTE_ID_REQUIRED';
  END IF;
  IF p_completed IS NULL THEN
    RAISE EXCEPTION 'COMPLETED_FLAG_REQUIRED';
  END IF;
  IF NOT (SELECT public.is_active_profile()) THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE';
  END IF;

  -- Authorization BEFORE the idempotency replay (house ordering —
  -- log_customer_interaction/log_customer_fact precedent): a caller who is
  -- not creator/assignee/admin must get the authorization error, never a
  -- cached result.
  SELECT * INTO v_note
  FROM public.team_notes
  WHERE id = p_note_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOTE_NOT_FOUND';
  END IF;

  IF v_note.created_by <> v_uid
     AND (v_note.assigned_to IS NULL OR v_note.assigned_to <> v_uid)
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_TO_COMPLETE: only the creator, the assignee, or an admin can complete or reopen this note';
  END IF;

  -- Fingerprint is deterministic on the arguments PLUS the actor, so a
  -- different user replaying a stolen/stale key gets a mismatch, never the
  -- original caller's cached result (2026-08-03 intent-binding direction).
  v_fingerprint := md5(jsonb_build_object(
    'note_id', p_note_id,
    'completed', p_completed,
    'actor', v_uid
  )::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'complete_team_note');
    IF v_existing IS NOT NULL THEN
      IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'COMPLETE_REPLAY_PAYLOAD_MISMATCH: this key already completed a different note/state';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  IF v_note.is_completed IS DISTINCT FROM p_completed THEN
    UPDATE public.team_notes
    SET is_completed = p_completed,
        completed_by = CASE WHEN p_completed THEN v_uid ELSE NULL END,
        completed_at = CASE WHEN p_completed THEN now() ELSE NULL END,
        updated_at = now()
    WHERE id = p_note_id;
    -- log_note_activity trigger records 'completed'/'reopened' with auth.uid().
  END IF;

  -- Report the ROW's actual state, not the caller's intent: on the no-op
  -- path (already in the requested state) completed_by must stay the
  -- original completer, not become the current caller.
  SELECT is_completed, completed_by INTO v_row_completed, v_row_completed_by
  FROM public.team_notes WHERE id = p_note_id;

  v_result := jsonb_build_object(
    'success', true,
    'note_id', p_note_id,
    'is_completed', v_row_completed,
    'completed_by', v_row_completed_by,
    'request_fingerprint', v_fingerprint
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'complete_team_note', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_team_note(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_team_note(uuid, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.complete_team_note(uuid, boolean, text) IS
  'Complete or reopen a team note. Authorization: note creator, current assignee, or admin (active profile required), checked BEFORE the idempotency replay. Idempotent by state; p_idempotency_key enforced via check_idempotency/save_idempotency with an actor-bound request fingerprint.';

-- ── 2. Assignment notification trigger ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_team_note_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
BEGIN
  IF NEW.assigned_to IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to THEN
    RETURN NEW;
  END IF;
  -- No notification for self-assignment. With no JWT (service paths) the
  -- acting user is the note's creator, so compare against that too.
  IF NEW.assigned_to = COALESCE(v_actor, NEW.created_by) THEN
    RETURN NEW;
  END IF;
  -- Deactivated profiles can't log in to read notifications — skip them.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = NEW.assigned_to AND is_active = true
  ) THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_actor_name
  FROM public.profiles
  WHERE id = COALESCE(v_actor, NEW.created_by);

  INSERT INTO public.notifications (
    user_id, notification_type, title, message, related_entity_type, related_entity_id
  ) VALUES (
    NEW.assigned_to,
    'task_assigned',
    'Task assigned to you',
    COALESCE(v_actor_name, 'A teammate') || ' assigned you: "' || left(NEW.title, 120) || '"'
      || CASE WHEN NEW.due_date IS NOT NULL
              THEN ' (due ' || to_char(NEW.due_date, 'Mon FMDD') || ')'
              ELSE '' END,
    'team_note',
    NEW.id
  );

  RETURN NEW;
END;
$$;

-- Trigger function: not callable as an RPC; lock grants down anyway.
REVOKE ALL ON FUNCTION public.notify_team_note_assignment() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notify_team_note_assignment() IS
  'AFTER INSERT OR UPDATE OF assigned_to trigger on team_notes: inserts a task_assigned notification for the new ACTIVE assignee on real assignment changes only (self-assignment and unchanged-assignee updates are silent). SECURITY DEFINER so the notifications insert does not depend on the acting user''s notif_insert policy; actor identity comes from auth.uid() and is not forgeable.';

DROP TRIGGER IF EXISTS notify_on_team_note_assignment ON public.team_notes;
CREATE TRIGGER notify_on_team_note_assignment
  AFTER INSERT OR UPDATE OF assigned_to ON public.team_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_team_note_assignment();

-- Postflight: exactly one overload each, SECURITY DEFINER, pinned search_path,
-- and the intended ACLs — the standard house assertions, so a partial apply
-- (or the project's anon default-privilege grant) cannot pass silently.
DO $$
DECLARE
  v_count int;
  v_secdef boolean;
  v_config text[];
BEGIN
  -- complete_team_note
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'complete_team_note';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly 1 complete_team_note overload, found %', v_count;
  END IF;
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'complete_team_note';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: complete_team_note is not SECURITY DEFINER';
  END IF;
  IF NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: complete_team_note search_path is not pinned to public, pg_temp';
  END IF;
  IF has_function_privilege('anon', 'public.complete_team_note(uuid, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: anon can execute complete_team_note';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.complete_team_note(uuid, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: authenticated cannot execute complete_team_note';
  END IF;

  -- notify_team_note_assignment (trigger fn: no client role may EXECUTE)
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'notify_team_note_assignment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly 1 notify_team_note_assignment overload, found %', v_count;
  END IF;
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'notify_team_note_assignment';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notify_team_note_assignment is not SECURITY DEFINER';
  END IF;
  IF NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notify_team_note_assignment search_path is not pinned to public, pg_temp';
  END IF;
  IF has_function_privilege('anon', 'public.notify_team_note_assignment()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_team_note_assignment()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a client role can execute notify_team_note_assignment';
  END IF;

  -- Trigger is attached
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'notify_on_team_note_assignment'
      AND tgrelid = 'public.team_notes'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notify_on_team_note_assignment trigger is not attached to team_notes';
  END IF;
END;
$$;
