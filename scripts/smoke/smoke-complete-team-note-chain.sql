-- ============================================================================
-- SMOKE CHAIN: complete_team_note + notify_team_note_assignment
-- (migrations 20260809130108 + 20260809154649)
-- ----------------------------------------------------------------------------
-- Proves the Team Board delegation loop end to end, rolled back by design:
--   assignment notification on INSERT -> auth probes (P1/P2) -> outsider
--   rejection -> ASSIGNEE completes a note they did not create (the core fix)
--   -> exact idempotent replay (no double activity log) -> replay payload
--   mismatch rejection -> creator reopen -> reassignment notification ->
--   self-assignment silence -> deleted-note rejection -> grant probes.
--
-- P4 (forged actor) is dropped: complete_team_note has no actor parameter —
-- completed_by is always auth.uid() inside the function.
-- There is no separate role gate (creator/assignee/admin is the whole rule),
-- so the P3 slot probes an active profile that is none of the three.
--
-- Fixture inserts run with admin claims already set: team_notes triggers
-- write note_activity_log.user_id (NOT NULL) from auth.uid(), so a no-claims
-- owner insert would abort on the audit trigger, not the path under test.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin     uuid;
  v_assignee  uuid;   -- active NON-admin who did NOT create the note
  v_assignee_role text;
  v_outsider  uuid;   -- active profile: not creator, not assignee, not admin
  v_inactive  uuid := gen_random_uuid(); -- rollback-only synthetic auth/profile fixture
  v_suffix    text := substr(md5(random()::text), 1, 8);
  v_note      uuid;
  v_note2     uuid;
  v_msg       text;
  v_res       jsonb;
  v_res2      jsonb;
  v_key1      text;
  v_key2      text;
  v_key3      text;
  v_n         int;
  v_completed boolean;
  v_completed_by uuid;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Real active business actors. The inactive probes use a dedicated
  --    rollback-only auth/profile fixture created below; no real teammate's
  --    auth state is changed.
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;

  SELECT id, role INTO v_assignee, v_assignee_role FROM profiles
  WHERE is_active = true AND role IN ('driver', 'applicator', 'sales_rep')
  ORDER BY CASE role WHEN 'driver' THEN 0 WHEN 'applicator' THEN 1 ELSE 2 END,
           created_at
  LIMIT 1;
  IF v_assignee IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active non-admin profile for the assignee probe';
  END IF;

  SELECT id INTO v_outsider FROM profiles
  WHERE is_active = true AND role IN ('driver', 'applicator', 'sales_rep')
    AND id <> v_assignee
  ORDER BY created_at LIMIT 1;
  IF v_outsider IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no second active non-admin profile for the outsider probe';
  END IF;

  v_key1 := 'smk-ctn-' || v_suffix || '-1';
  v_key2 := 'smk-ctn-' || v_suffix || '-2';
  v_key3 := 'smk-ctn-' || v_suffix || '-3';

  -- --------------------------------------------------------------------
  -- 1. Fixture as admin claims (audit trigger needs auth.uid()); the
  --    INSERT itself must fire notify_team_note_assignment for v_assignee.
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    v_inactive,
    'smoke-team-note-inactive-' || v_suffix || '@example.invalid',
    jsonb_build_object('full_name', '[SMOKE] Inactive ' || v_suffix, 'role', 'sales_rep'),
    now(),
    now()
  );
  UPDATE profiles SET is_active = false WHERE id = v_inactive;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected exactly 1 synthetic inactive profile, updated %', v_n;
  END IF;

  INSERT INTO team_notes (title, note_type, priority, created_by, assigned_to, due_date)
  VALUES ('[SMOKE] delegation ' || v_suffix, 'todo', 'medium', v_admin, v_assignee, CURRENT_DATE + 1)
  RETURNING id INTO v_note;

  SELECT count(*) INTO v_n FROM notifications
  WHERE related_entity_type = 'team_note' AND related_entity_id = v_note
    AND notification_type = 'task_assigned' AND user_id = v_assignee;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 task_assigned notification for assignee after INSERT, got %', v_n;
  END IF;

  -- The ordinary PostgREST role must first be denied by tnotes_insert RLS.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_inactive, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO team_notes (title, note_type, priority, created_by, assigned_to)
    VALUES ('[SMOKE] inactive RLS assignment ' || v_suffix, 'todo', 'medium', v_inactive, v_assignee);
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: inactive actor passed tnotes_insert RLS';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLSTATE <> '42501' OR SQLERRM NOT ILIKE '%row-level security%' THEN
      RESET ROLE;
      RAISE EXCEPTION 'SMOKE_FAIL: inactive actor expected RLS 42501, got %: %', SQLSTATE, SQLERRM;
    END IF;
  END;
  RESET ROLE;

  -- Defense in depth: the owner-run trigger must independently reject the
  -- same inactive actor even when a trusted SQL path bypasses RLS.
  BEGIN
    INSERT INTO team_notes (title, note_type, priority, created_by, assigned_to)
    VALUES ('[SMOKE] inactive assignment ' || v_suffix, 'todo', 'medium', v_inactive, v_assignee);
    RAISE EXCEPTION 'SMOKE_FAIL: inactive actor assignment was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PROFILE_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: inactive actor expected PROFILE_INACTIVE, got: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- P1: no-auth -> AUTH_REQUIRED
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM complete_team_note(v_note, true, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: P1 no-auth call was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P1 expected AUTH_REQUIRED, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P2: anon-key claims (no sub) -> AUTH_REQUIRED, nothing written
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM complete_team_note(v_note, true, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: P2 anon call was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P2 expected AUTH_REQUIRED, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P3 slot: authenticated OUTSIDER (not creator/assignee/admin) -> denied
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM complete_team_note(v_note, true, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: outsider completion was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'NOT_AUTHORIZED_TO_COMPLETE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: outsider expected NOT_AUTHORIZED_TO_COMPLETE, got: %', SQLERRM;
    END IF;
  END;

  SELECT is_completed INTO v_completed FROM team_notes WHERE id = v_note;
  IF v_completed THEN
    RAISE EXCEPTION 'SMOKE_FAIL: probes must not complete the note';
  END IF;

  -- --------------------------------------------------------------------
  -- P5a positive (THE FIX): the non-admin ASSIGNEE completes the note
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_assignee, 'role', 'authenticated')::text, true);
  v_res := complete_team_note(v_note, true, v_key1);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: assignee (%) completion returned %', v_assignee_role, v_res;
  END IF;

  SELECT is_completed, completed_by INTO v_completed, v_completed_by
  FROM team_notes WHERE id = v_note;
  IF v_completed IS DISTINCT FROM true OR v_completed_by IS DISTINCT FROM v_assignee THEN
    RAISE EXCEPTION 'SMOKE_FAIL: after assignee completion is_completed=%, completed_by=%', v_completed, v_completed_by;
  END IF;

  SELECT count(*) INTO v_n FROM note_activity_log
  WHERE note_id = v_note AND action_type = 'completed';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 completed activity row, got %', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- P5b: exact idempotent replay — same key + args returns the saved
  --      result and does NOT double-log activity
  -- --------------------------------------------------------------------
  v_res2 := complete_team_note(v_note, true, v_key1);
  IF v_res2->>'request_fingerprint' IS DISTINCT FROM v_res->>'request_fingerprint' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay returned a different fingerprint';
  END IF;
  SELECT count(*) INTO v_n FROM note_activity_log
  WHERE note_id = v_note AND action_type = 'completed';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay double-logged completion (% rows)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- P5b2: no-op by a DIFFERENT authorized actor (creator) — the response
  --       must report the ORIGINAL completer, not the caller
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_res2 := complete_team_note(v_note, true, v_key3);
  IF (v_res2->>'completed_by')::uuid IS DISTINCT FROM v_assignee THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-op response reported completed_by=% (expected original completer %)',
      v_res2->>'completed_by', v_assignee;
  END IF;
  SELECT completed_by INTO v_completed_by FROM team_notes WHERE id = v_note;
  IF v_completed_by IS DISTINCT FROM v_assignee THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-op call changed the stored completer to %', v_completed_by;
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_assignee, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- P5c: same key, DIFFERENT payload -> replay mismatch rejection
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM complete_team_note(v_note, false, v_key1);
    RAISE EXCEPTION 'SMOKE_FAIL: payload-mismatch replay was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'COMPLETE_REPLAY_PAYLOAD_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected COMPLETE_REPLAY_PAYLOAD_MISMATCH, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P5d: DIFFERENT actor replaying the assignee's key with the SAME
  --      payload -> mismatch (fingerprint is actor-bound)
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM complete_team_note(v_note, true, v_key1);
    RAISE EXCEPTION 'SMOKE_FAIL: cross-actor replay of another user''s key was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'COMPLETE_REPLAY_PAYLOAD_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: cross-actor replay expected COMPLETE_REPLAY_PAYLOAD_MISMATCH, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P5e: creator (admin) reopens with a fresh key
  -- --------------------------------------------------------------------
  v_res := complete_team_note(v_note, false, v_key2);
  SELECT is_completed, completed_by INTO v_completed, v_completed_by
  FROM team_notes WHERE id = v_note;
  IF v_completed IS DISTINCT FROM false OR v_completed_by IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: after reopen is_completed=%, completed_by=%', v_completed, v_completed_by;
  END IF;

  -- --------------------------------------------------------------------
  -- 2. Reassignment fires a notification for the NEW assignee only
  -- --------------------------------------------------------------------
  UPDATE team_notes SET assigned_to = v_outsider WHERE id = v_note;
  SELECT count(*) INTO v_n FROM notifications
  WHERE related_entity_type = 'team_note' AND related_entity_id = v_note
    AND notification_type = 'task_assigned' AND user_id = v_outsider;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 task_assigned notification for new assignee after reassign, got %', v_n;
  END IF;

  -- Self-assignment stays silent (actor == new assignee)
  UPDATE team_notes SET assigned_to = v_admin WHERE id = v_note;
  SELECT count(*) INTO v_n FROM notifications
  WHERE related_entity_type = 'team_note' AND related_entity_id = v_note
    AND notification_type = 'task_assigned' AND user_id = v_admin;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: self-assignment must not notify, got % rows', v_n;
  END IF;

  -- No-op UPDATE that includes assigned_to unchanged must not re-notify
  UPDATE team_notes SET assigned_to = v_admin, priority = 'high' WHERE id = v_note;
  SELECT count(*) INTO v_n FROM notifications
  WHERE related_entity_type = 'team_note' AND related_entity_id = v_note
    AND notification_type = 'task_assigned';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unchanged-assignee update re-notified (total % rows, expected 2)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 2b. Long titles are truncated to 120 chars in the notification message
  -- --------------------------------------------------------------------
  INSERT INTO team_notes (title, note_type, priority, created_by, assigned_to)
  VALUES (repeat('X', 150), 'todo', 'medium', v_admin, v_assignee)
  RETURNING id INTO v_note2;
  SELECT message INTO v_msg FROM notifications
  WHERE related_entity_type = 'team_note' AND related_entity_id = v_note2
    AND notification_type = 'task_assigned' AND user_id = v_assignee;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: long-title note produced no notification';
  END IF;
  IF v_msg LIKE '%' || repeat('X', 121) || '%' OR v_msg NOT LIKE '%' || repeat('X', 120) || '%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: notification message not truncated to 120 title chars';
  END IF;

  -- --------------------------------------------------------------------
  -- 2c. Inactive synthetic assignee is not notified
  -- --------------------------------------------------------------------
  UPDATE team_notes SET assigned_to = v_inactive WHERE id = v_note;
  SELECT count(*) INTO v_n FROM notifications
  WHERE related_entity_type = 'team_note' AND related_entity_id = v_note
    AND notification_type = 'task_assigned' AND user_id = v_inactive;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inactive synthetic assignee was notified (% rows)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 3. Soft-deleted note -> NOTE_NOT_FOUND
  -- --------------------------------------------------------------------
  UPDATE team_notes SET deleted_at = now(), deleted_by = v_admin WHERE id = v_note;
  BEGIN
    PERFORM complete_team_note(v_note, true, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: completion of a deleted note was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'NOTE_NOT_FOUND%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected NOTE_NOT_FOUND on deleted note, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- 3b. Deactivated caller -> PROFILE_INACTIVE (checked before note lookup)
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_inactive, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM complete_team_note(v_note, true, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: deactivated caller was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PROFILE_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected PROFILE_INACTIVE, got: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 4. Grant probes: anon must not EXECUTE the RPC; the trigger function
  --    must not be client-executable at all
  -- --------------------------------------------------------------------
  IF has_function_privilege('anon', 'public.complete_team_note(uuid,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon holds EXECUTE on complete_team_note';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.complete_team_note(uuid,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost EXECUTE on complete_team_note';
  END IF;
  IF has_function_privilege('anon', 'public.notify_team_note_assignment()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_team_note_assignment()', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: client role holds EXECUTE on notify_team_note_assignment';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
