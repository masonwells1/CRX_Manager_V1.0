-- Retry-safe CRM call logging (final-gauntlet follow-up, 2026-07-17).
-- LogInteractionModal previously wrote customer_interactions and the optional
-- team_notes follow-up as two direct table inserts: a committed response lost
-- to a network timeout, then retried, double-logs the call and duplicates the
-- follow-up todo. This RPC makes the whole log one idempotent unit while
-- preserving the interaction-first / follow-up-second partial-success
-- behavior: a failed follow-up insert reports back to the caller instead of
-- rolling back the call log.

CREATE OR REPLACE FUNCTION public.log_customer_interaction(
  p_customer_id uuid,
  p_interaction_type text,
  p_direction text,
  p_occurred_at timestamptz,
  p_summary text,
  p_contact_id uuid DEFAULT NULL,
  p_duration_seconds integer DEFAULT NULL,
  p_outcome text DEFAULT NULL,
  p_follow_up_title text DEFAULT NULL,
  p_follow_up_content text DEFAULT NULL,
  p_follow_up_assigned_to uuid DEFAULT NULL,
  p_follow_up_due_date date DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_interaction_id uuid;
  v_note_id uuid;
  v_follow_up_error text;
  v_existing jsonb;
  v_result jsonb;
  v_fingerprint text;
BEGIN
  -- Argument validation mirrors the customer_interactions CHECK constraints so
  -- callers get stable machine-readable tokens instead of raw constraint
  -- errors. All checks are deterministic on the arguments, so running them
  -- before the idempotency replay cannot reject a replay of a committed call.
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED';
  END IF;
  IF p_interaction_type IS NULL OR p_interaction_type NOT IN
     ('call', 'visit', 'meeting', 'text', 'email', 'voicemail') THEN
    RAISE EXCEPTION 'INTERACTION_TYPE_INVALID';
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('inbound', 'outbound') THEN
    RAISE EXCEPTION 'INTERACTION_DIRECTION_INVALID';
  END IF;
  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'INTERACTION_OCCURRED_AT_REQUIRED';
  END IF;
  IF p_summary IS NULL OR btrim(p_summary) = '' THEN
    RAISE EXCEPTION 'INTERACTION_SUMMARY_REQUIRED';
  END IF;
  IF p_duration_seconds IS NOT NULL AND p_duration_seconds < 0 THEN
    RAISE EXCEPTION 'INTERACTION_DURATION_INVALID';
  END IF;
  IF p_outcome IS NOT NULL AND p_outcome NOT IN
     ('connected', 'left_voicemail', 'no_answer', 'busy', 'follow_up_needed',
      'order_placed', 'resolved', 'other') THEN
    RAISE EXCEPTION 'INTERACTION_OUTCOME_INVALID';
  END IF;
  -- Follow-up fields are only meaningful with a title; fail closed rather than
  -- silently dropping an assignee or due date the caller thought was saved.
  IF p_follow_up_title IS NULL
     AND (p_follow_up_content IS NOT NULL
          OR p_follow_up_assigned_to IS NOT NULL
          OR p_follow_up_due_date IS NOT NULL) THEN
    RAISE EXCEPTION 'FOLLOW_UP_TITLE_REQUIRED';
  END IF;
  IF p_follow_up_title IS NOT NULL AND btrim(p_follow_up_title) = '' THEN
    RAISE EXCEPTION 'FOLLOW_UP_TITLE_REQUIRED';
  END IF;

  -- Authorization mirrors the customer_interactions rep INSERT policy: an
  -- active admin, or an active sales rep assigned to this customer. The row is
  -- always pinned to source = 'rep' and the caller's own identity below, so
  -- AI/web/system provenance is never writable through this path.
  IF NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.is_active
     )
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = p_customer_id
         AND c.assigned_sales_rep = auth.uid()
     ))) THEN
    RAISE EXCEPTION 'INTERACTION_ACCESS_DENIED';
  END IF;

  -- Same-customer contact check (the composite FK also enforces this; the
  -- explicit check returns a stable token instead of an FK error).
  IF p_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customer_contacts cc
    WHERE cc.id = p_contact_id AND cc.customer_id = p_customer_id
  ) THEN
    RAISE EXCEPTION 'INTERACTION_CONTACT_INVALID';
  END IF;

  -- Exact-request replay only (Codex 2026-07-17, same pattern as the bulk-PO
  -- replay fix): a replayed key must carry the same payload. If the rep edited
  -- the form between a lost-response commit and the retry, silently returning
  -- the old result would discard the edits — raise instead so the UI can tell
  -- the rep the earlier attempt already saved.
  v_fingerprint := md5(jsonb_build_object(
    'customer_id', p_customer_id,
    'contact_id', p_contact_id,
    'interaction_type', p_interaction_type,
    'direction', p_direction,
    'occurred_at', to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'duration_seconds', p_duration_seconds,
    'outcome', p_outcome,
    'summary', btrim(p_summary),
    'follow_up_title', CASE WHEN p_follow_up_title IS NULL THEN NULL ELSE btrim(p_follow_up_title) END,
    'follow_up_content', p_follow_up_content,
    'follow_up_assigned_to', p_follow_up_assigned_to,
    'follow_up_due_date', p_follow_up_due_date
  )::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'log_customer_interaction');
    IF v_existing IS NOT NULL THEN
      IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'INTERACTION_REPLAY_PAYLOAD_MISMATCH: this key already logged an interaction with different values';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  INSERT INTO public.customer_interactions (
    customer_id, contact_id, interaction_type, direction, source,
    occurred_at, duration_seconds, outcome, summary,
    owner_user_id, created_by
  ) VALUES (
    p_customer_id, p_contact_id, p_interaction_type, p_direction, 'rep',
    p_occurred_at, p_duration_seconds, p_outcome, btrim(p_summary),
    auth.uid(), auth.uid()
  )
  RETURNING id INTO v_interaction_id;

  IF p_follow_up_title IS NOT NULL THEN
    -- Partial-success seam: the interaction is the record of truth. A failed
    -- follow-up insert (bad assignee, constraint change, ...) reports back in
    -- the result instead of rolling back the committed call log — the same
    -- behavior the modal had when these were two separate writes.
    BEGIN
      INSERT INTO public.team_notes (
        title, content, note_type, priority, assigned_to, due_date,
        created_by, linked_entity_type, linked_entity_id
      ) VALUES (
        btrim(p_follow_up_title), p_follow_up_content, 'todo', 'medium',
        p_follow_up_assigned_to, p_follow_up_due_date,
        auth.uid(), 'customer', p_customer_id
      )
      RETURNING id INTO v_note_id;
    EXCEPTION WHEN OTHERS THEN
      v_note_id := NULL;
      v_follow_up_error := SQLERRM;
    END;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'interaction_id', v_interaction_id,
    'follow_up_requested', p_follow_up_title IS NOT NULL,
    'follow_up_note_id', v_note_id,
    'follow_up_error', v_follow_up_error,
    'request_fingerprint', v_fingerprint
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'log_customer_interaction', v_result);
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.log_customer_interaction(
  uuid, text, text, timestamptz, text, uuid, integer, text, text, text, uuid, date, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_customer_interaction(
  uuid, text, text, timestamptz, text, uuid, integer, text, text, text, uuid, date, text
) TO authenticated;

COMMENT ON FUNCTION public.log_customer_interaction(
  uuid, text, text, timestamptz, text, uuid, integer, text, text, text, uuid, date, text
) IS 'Idempotently logs a rep customer interaction with an optional team-note follow-up under admin-or-assigned-rep authorization; a failed follow-up returns partial success instead of rolling back the call log.';
