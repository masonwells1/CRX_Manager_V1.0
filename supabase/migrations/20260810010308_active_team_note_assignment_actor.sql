-- Team Board assignment notification active-actor hardening.
--
-- Follow-up to live migration 20260809130108. The original trigger correctly
-- validates the assignee, but an inactive profile with a still-valid JWT can
-- satisfy the legacy creator-only INSERT policy and make the SECURITY DEFINER
-- trigger notify an active teammate. This migration closes that path twice:
--   1. tnotes_insert requires the caller's profile to be active.
--   2. the privileged trigger independently rejects an inactive effective
--      actor before it can insert a notification.
--
-- The existing tnotes_update creator-or-admin policy is deliberately unchanged.

DO $$
DECLARE
  v_count integer;
  v_secdef boolean;
  v_owner text;
  v_config text[];
  v_body text;
  v_policy_check text;
  v_tgenabled "char";
  v_tgfoid oid;
  v_tgtype smallint;
  v_tgattr text;
  v_assigned_attnum smallint;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'notify_team_note_assignment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly 1 notify_team_note_assignment overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig, p.prosrc
    INTO v_secdef, v_owner, v_config, v_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'notify_team_note_assignment';
  IF v_secdef IS DISTINCT FROM true
     OR v_owner <> 'postgres'
     OR ('search_path=public, pg_temp' = ANY (v_config)) IS NOT TRUE
     OR md5(v_body) <> 'ce356683fb140f2e0d3d8faee077cc1a' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: notify_team_note_assignment live base drift (owner=%, secdef=%, config=%, body_md5=%)',
      v_owner, v_secdef, v_config, md5(v_body);
  END IF;
  IF has_function_privilege('anon', 'public.notify_team_note_assignment()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_team_note_assignment()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: application client EXECUTE drift on notify_team_note_assignment';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'team_notes'
    AND policyname = 'tnotes_insert'
    AND cmd = 'INSERT';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly 1 INSERT policy public.team_notes.tnotes_insert, found %', v_count;
  END IF;

  SELECT with_check INTO v_policy_check
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'team_notes'
    AND policyname = 'tnotes_insert'
    AND cmd = 'INSERT';
  IF regexp_replace(v_policy_check, '\s+', '', 'g') <> '(created_by=(SELECTauth.uid()ASuid))' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: tnotes_insert live base drift: %', v_policy_check;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_trigger
  WHERE tgname = 'notify_on_team_note_assignment'
    AND tgrelid = 'public.team_notes'::regclass
    AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly 1 notify_on_team_note_assignment trigger, found %', v_count;
  END IF;

  SELECT attnum INTO v_assigned_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.team_notes'::regclass
    AND attname = 'assigned_to'
    AND NOT attisdropped;
  SELECT tgenabled, tgfoid, tgtype, tgattr::text
    INTO v_tgenabled, v_tgfoid, v_tgtype, v_tgattr
  FROM pg_trigger
  WHERE tgname = 'notify_on_team_note_assignment'
    AND tgrelid = 'public.team_notes'::regclass
    AND NOT tgisinternal;
  IF v_tgenabled <> 'O'
     OR v_tgfoid <> 'public.notify_team_note_assignment()'::regprocedure
     OR v_tgtype <> 21
     OR v_assigned_attnum IS NULL
     OR v_tgattr <> v_assigned_attnum::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: assignment trigger live base drift (enabled=%, fn=%, type=%, attrs=%, assigned_attnum=%)',
      v_tgenabled, v_tgfoid::regprocedure, v_tgtype, v_tgattr, v_assigned_attnum;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_team_note_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), NEW.created_by);
  v_actor_name text;
BEGIN
  IF NEW.assigned_to IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.assigned_to IS NOT DISTINCT FROM NEW.assigned_to THEN
    RETURN NEW;
  END IF;

  -- Defense in depth: the trigger runs as its owner and bypasses RLS, so it
  -- must independently require the effective actor to be active before the
  -- privileged notifications INSERT. Service paths without a JWT retain the
  -- existing created_by fallback, but that creator must also be active.
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = v_actor
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE: active profile required to assign a team note'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.assigned_to = v_actor THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = NEW.assigned_to
      AND is_active = true
  ) THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_actor_name
  FROM public.profiles
  WHERE id = v_actor;

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

REVOKE ALL ON FUNCTION public.notify_team_note_assignment() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notify_team_note_assignment() IS
  'AFTER INSERT OR UPDATE OF assigned_to trigger on team_notes: requires an active effective actor, then inserts a task_assigned notification for the new active assignee on real assignment changes only. Self-assignment and unchanged-assignee updates are silent. SECURITY DEFINER because notif_insert does not admit ordinary task assigners.';

ALTER POLICY tnotes_insert ON public.team_notes
  WITH CHECK (
    created_by = auth.uid()
    AND public.is_active_profile()
  );

DO $$
DECLARE
  v_count integer;
  v_secdef boolean;
  v_owner text;
  v_config text[];
  v_definition text;
  v_policy_check text;
  v_tgenabled "char";
  v_tgfoid oid;
  v_tgtype smallint;
  v_tgattr text;
  v_assigned_attnum smallint;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'notify_team_note_assignment';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly 1 notify_team_note_assignment overload, found %', v_count;
  END IF;

  SELECT p.prosecdef,
         pg_get_userbyid(p.proowner),
         p.proconfig,
         p.prosrc
    INTO v_secdef, v_owner, v_config, v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'notify_team_note_assignment';

  IF v_secdef IS DISTINCT FROM true OR v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notify_team_note_assignment owner/security drift (owner=%, secdef=%)', v_owner, v_secdef;
  END IF;
  IF ('search_path=public, pg_temp' = ANY (v_config)) IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notify_team_note_assignment search_path is not pinned to public, pg_temp';
  END IF;
  IF position('PROFILE_INACTIVE' IN v_definition) = 0
     OR position('COALESCE(auth.uid(), NEW.created_by)' IN v_definition) = 0
     OR position('is_active = true' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notify_team_note_assignment active-actor guard is missing';
  END IF;
  IF has_function_privilege('anon', 'public.notify_team_note_assignment()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_team_note_assignment()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: an application client role can execute notify_team_note_assignment';
  END IF;

  SELECT with_check INTO v_policy_check
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'team_notes'
    AND policyname = 'tnotes_insert'
    AND cmd = 'INSERT';
  IF v_policy_check IS NULL
     OR position('created_by' IN v_policy_check) = 0
     OR position('auth.uid()' IN v_policy_check) = 0
     OR position('is_active_profile()' IN v_policy_check) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: tnotes_insert is not creator-and-active-profile gated: %', v_policy_check;
  END IF;

  SELECT attnum INTO v_assigned_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.team_notes'::regclass
    AND attname = 'assigned_to'
    AND NOT attisdropped;

  SELECT count(*) INTO v_count
  FROM pg_trigger
  WHERE tgname = 'notify_on_team_note_assignment'
    AND tgrelid = 'public.team_notes'::regclass
    AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected exactly 1 assignment trigger, found %', v_count;
  END IF;

  SELECT tgenabled, tgfoid, tgtype, tgattr::text
    INTO v_tgenabled, v_tgfoid, v_tgtype, v_tgattr
  FROM pg_trigger
  WHERE tgname = 'notify_on_team_note_assignment'
    AND tgrelid = 'public.team_notes'::regclass
    AND NOT tgisinternal;
  IF v_tgenabled <> 'O'
     OR v_tgfoid <> 'public.notify_team_note_assignment()'::regprocedure
     OR v_tgtype <> 21
     OR v_assigned_attnum IS NULL
     OR v_tgattr <> v_assigned_attnum::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: assignment trigger drift (count=%, enabled=%, fn=%, type=%, attrs=%, assigned_attnum=%)',
      v_count, v_tgenabled, v_tgfoid::regprocedure, v_tgtype, v_tgattr, v_assigned_attnum;
  END IF;
END;
$$;
