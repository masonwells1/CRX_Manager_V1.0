-- 20260701210000_notification_lifecycle_gate_before_idempotency.sql
-- Codex bug-hunt B1 (2026-07-01). record_job_pre_notifications /
-- record_job_post_notifications returned the CACHED idempotency result BEFORE they
-- re-read the job's status, and the job editor deliberately REUSES the same
-- idempotency key when retrying after a partial email failure (JobDetail.tsx). So a
-- retry AFTER the job's status changed (e.g. the job was completed/invoiced/cancelled
-- between the first click and the retry) replayed the cached recipient set and let the
-- frontend re-send a now-stale notice ("upcoming application" for a job that already
-- happened, or "application complete" for a job that was cancelled) — the lifecycle
-- gate never ran on the replay path.
--
-- Fix: move the job-load + LIFECYCLE GATE ABOVE the idempotency check in BOTH RPCs.
-- A valid retry (job still in a notifiable status) still returns the cached result;
-- a stale retry (status no longer notifiable) is refused with the existing
-- JOB_NOT_PRE_NOTIFIABLE / JOB_NOT_POST_NOTIFIABLE error before any recipients replay.
--
-- Everything else is re-emitted VERBATIM from 20260628120000 / 20260628130000 (same
-- signature, single overload, same share-customer resolution, grants, comments) — the
-- ONLY change is the order of the two blocks. Money/security-adjacent lifecycle change.

-- ── record_job_pre_notifications (gate before idempotency) ───────────────────
CREATE OR REPLACE FUNCTION public.record_job_pre_notifications(
  p_job_id          uuid,
  p_subject         text,
  p_message         text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor               uuid;
  v_role                text;
  v_existing            jsonb;
  v_primary_customer_id uuid;
  v_job_status          text;
  v_recipient           record;
  v_email               text;
  v_per_email_key       text;
  v_row_id              uuid;
  v_recipients          jsonb := '[]'::jsonb;
  v_sent_count          int := 0;   -- recipients WITH an email (a send will be attempted)
  v_failed_count        int := 0;   -- recipients with NO email on file
  v_result              jsonb;
BEGIN
  -- actor / strict-actor / role gate (admin or sales_rep send notifications).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  IF p_subject IS NULL OR btrim(p_subject) = '' THEN
    RAISE EXCEPTION 'INVALID_SUBJECT: a non-empty subject is required';
  END IF;
  IF p_message IS NULL OR btrim(p_message) = '' THEN
    RAISE EXCEPTION 'INVALID_MESSAGE: a non-empty message is required';
  END IF;

  -- Load the job's primary customer + status (also validates the job exists).
  SELECT j.customer_id, j.status INTO v_primary_customer_id, v_job_status
  FROM jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;

  -- LIFECYCLE GATE (Codex #40 P2 + bug-hunt B1): a PRE-application notice only makes
  -- sense for a job that has NOT happened yet — scheduled or in_progress. This gate
  -- now runs BEFORE the idempotency replay (B1), so a retry after the job's status
  -- changed cannot re-drive a stale "upcoming application" notice.
  IF v_job_status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'JOB_NOT_PRE_NOTIFIABLE: job % is % (pre-notice requires scheduled or in_progress)', p_job_id, v_job_status;
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op —
  -- ONLY reached once the lifecycle gate above has (re-)passed for the CURRENT status.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_job_pre_notifications');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Resolve the DISTINCT share customers with the SAME precedence the compliance
  -- resolver uses, so a pre-notice targets exactly the parties a split-billed job
  -- bills: explicit job_field_shares, else field_billing_defaults, else the job's
  -- primary customer. Record one row per resolved customer.
  FOR v_recipient IN
    WITH job_field_ids AS (
      SELECT DISTINCT jf.field_id
      FROM job_fields jf
      WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
    ),
    fields_with_share AS (
      SELECT DISTINCT jfs.field_id
      FROM job_field_shares jfs
      JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
      WHERE jfs.job_id = p_job_id
    ),
    resolved AS (
      -- 1. Saved per-field shares (explicit split) — only fields on the job.
      SELECT jfs.customer_id
      FROM job_field_shares jfs
      JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
      WHERE jfs.job_id = p_job_id AND jfs.customer_id IS NOT NULL

      UNION ALL

      -- 2. field_billing_defaults for fields WITHOUT a saved share.
      SELECT fbd.customer_id
      FROM job_field_ids jfi
      JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
      WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
        AND fbd.customer_id IS NOT NULL

      UNION ALL

      -- 3. The job's PRIMARY customer for fields with neither.
      SELECT v_primary_customer_id
      FROM job_field_ids jfi
      WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
        AND NOT EXISTS (
          SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
        )
        AND v_primary_customer_id IS NOT NULL

      UNION ALL

      -- 4. SAFETY FALLBACK: a job with NO fields still has a primary customer.
      SELECT v_primary_customer_id
      WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)
        AND v_primary_customer_id IS NOT NULL
    )
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      (c.id = v_primary_customer_id) AS is_primary
    FROM (SELECT DISTINCT r.customer_id FROM resolved r) d
    JOIN customers c ON c.id = d.customer_id
    ORDER BY (c.id = v_primary_customer_id) DESC, c.farm_name NULLS LAST
  LOOP
    v_email := nullif(btrim(coalesce(v_recipient.email, '')), '');
    v_per_email_key := CASE
      WHEN v_email IS NULL OR p_idempotency_key IS NULL THEN NULL
      ELSE p_idempotency_key || ':' || v_recipient.customer_id::text
    END;

    INSERT INTO job_notifications
      (job_id, notification_type, customer_id, recipient_email, channel,
       subject, message, status, sent_at, sent_by, idempotency_key)
    VALUES
      (p_job_id, 'pre', v_recipient.customer_id, v_email, 'email',
       p_subject, p_message, 'failed', NULL, v_actor, v_per_email_key)
    RETURNING id INTO v_row_id;

    IF v_email IS NULL THEN
      v_failed_count := v_failed_count + 1;
    ELSE
      v_sent_count := v_sent_count + 1;
    END IF;

    v_recipients := v_recipients || jsonb_build_object(
      'notification_id', v_row_id,
      'customer_id', v_recipient.customer_id,
      'farm_name',   v_recipient.farm_name,
      'email',       v_email,
      'has_email',   (v_email IS NOT NULL),
      'email_idempotency_key', v_per_email_key,
      'is_primary',  v_recipient.is_primary
    );
  END LOOP;

  IF jsonb_array_length(v_recipients) = 0 THEN
    RAISE EXCEPTION 'NO_RECIPIENTS: job % has no resolvable customer to notify', p_job_id;
  END IF;

  INSERT INTO activity_feed
    (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES (
    'job_pre_notification_sent',
    'Pre-application notice recorded for ' || v_sent_count || ' recipient(s) with email'
      || CASE WHEN v_failed_count > 0
              THEN ' (' || v_failed_count || ' with no email on file)'
              ELSE '' END,
    v_actor, 'job', p_job_id, v_primary_customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'recipients_with_email', v_sent_count,
    'recipients_without_email', v_failed_count,
    'recipients', v_recipients
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'record_job_pre_notifications', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_job_pre_notifications(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_pre_notifications(uuid, text, text, uuid, text) TO authenticated, service_role;

-- ── record_job_post_notifications (gate before idempotency) ──────────────────
CREATE OR REPLACE FUNCTION public.record_job_post_notifications(
  p_job_id          uuid,
  p_subject         text,
  p_message         text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor               uuid;
  v_role                text;
  v_existing            jsonb;
  v_primary_customer_id uuid;
  v_job_status          text;
  v_recipient           record;
  v_email               text;
  v_per_email_key       text;
  v_row_id              uuid;
  v_recipients          jsonb := '[]'::jsonb;
  v_sent_count          int := 0;
  v_failed_count        int := 0;
  v_result              jsonb;
BEGIN
  -- actor / strict-actor / role gate (admin or sales_rep send notifications).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  IF p_subject IS NULL OR btrim(p_subject) = '' THEN
    RAISE EXCEPTION 'INVALID_SUBJECT: a non-empty subject is required';
  END IF;
  IF p_message IS NULL OR btrim(p_message) = '' THEN
    RAISE EXCEPTION 'INVALID_MESSAGE: a non-empty message is required';
  END IF;

  -- Load the job's primary customer + status (also validates the job exists).
  SELECT j.customer_id, j.status INTO v_primary_customer_id, v_job_status
  FROM jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;

  -- LIFECYCLE GATE (bug-hunt B1): a POST-application notice only makes sense for a
  -- job whose work HAS happened — completed or invoiced. This gate now runs BEFORE the
  -- idempotency replay, so a retry after the job's status changed cannot re-drive a
  -- stale "application complete" notice on a job that is no longer completed/invoiced.
  IF v_job_status NOT IN ('completed', 'invoiced') THEN
    RAISE EXCEPTION 'JOB_NOT_POST_NOTIFIABLE: job % is % (post-notice requires completed or invoiced)', p_job_id, v_job_status;
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op —
  -- ONLY reached once the lifecycle gate above has (re-)passed for the CURRENT status.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_job_post_notifications');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Resolve the DISTINCT share customers with the SAME precedence the compliance
  -- resolver uses (get_job_billed_customers). IDENTICAL to record_job_pre_notifications.
  FOR v_recipient IN
    WITH job_field_ids AS (
      SELECT DISTINCT jf.field_id
      FROM job_fields jf
      WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
    ),
    fields_with_share AS (
      SELECT DISTINCT jfs.field_id
      FROM job_field_shares jfs
      JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
      WHERE jfs.job_id = p_job_id
    ),
    resolved AS (
      SELECT jfs.customer_id
      FROM job_field_shares jfs
      JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
      WHERE jfs.job_id = p_job_id AND jfs.customer_id IS NOT NULL

      UNION ALL

      SELECT fbd.customer_id
      FROM job_field_ids jfi
      JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
      WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
        AND fbd.customer_id IS NOT NULL

      UNION ALL

      SELECT v_primary_customer_id
      FROM job_field_ids jfi
      WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
        AND NOT EXISTS (
          SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
        )
        AND v_primary_customer_id IS NOT NULL

      UNION ALL

      SELECT v_primary_customer_id
      WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)
        AND v_primary_customer_id IS NOT NULL
    )
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      (c.id = v_primary_customer_id) AS is_primary
    FROM (SELECT DISTINCT r.customer_id FROM resolved r) d
    JOIN customers c ON c.id = d.customer_id
    ORDER BY (c.id = v_primary_customer_id) DESC, c.farm_name NULLS LAST
  LOOP
    v_email := nullif(btrim(coalesce(v_recipient.email, '')), '');
    v_per_email_key := CASE
      WHEN v_email IS NULL OR p_idempotency_key IS NULL THEN NULL
      ELSE p_idempotency_key || ':' || v_recipient.customer_id::text
    END;

    INSERT INTO job_notifications
      (job_id, notification_type, customer_id, recipient_email, channel,
       subject, message, status, sent_at, sent_by, idempotency_key)
    VALUES
      (p_job_id, 'post', v_recipient.customer_id, v_email, 'email',
       p_subject, p_message, 'failed', NULL, v_actor, v_per_email_key)
    RETURNING id INTO v_row_id;

    IF v_email IS NULL THEN
      v_failed_count := v_failed_count + 1;
    ELSE
      v_sent_count := v_sent_count + 1;
    END IF;

    v_recipients := v_recipients || jsonb_build_object(
      'notification_id', v_row_id,
      'customer_id', v_recipient.customer_id,
      'farm_name',   v_recipient.farm_name,
      'email',       v_email,
      'has_email',   (v_email IS NOT NULL),
      'email_idempotency_key', v_per_email_key,
      'is_primary',  v_recipient.is_primary
    );
  END LOOP;

  IF jsonb_array_length(v_recipients) = 0 THEN
    RAISE EXCEPTION 'NO_RECIPIENTS: job % has no resolvable customer to notify', p_job_id;
  END IF;

  INSERT INTO activity_feed
    (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES (
    'job_post_notification_sent',
    'Post-application notice recorded for ' || v_sent_count || ' recipient(s) with email'
      || CASE WHEN v_failed_count > 0
              THEN ' (' || v_failed_count || ' with no email on file)'
              ELSE '' END,
    v_actor, 'job', p_job_id, v_primary_customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'recipients_with_email', v_sent_count,
    'recipients_without_email', v_failed_count,
    'recipients', v_recipients
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'record_job_post_notifications', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_job_post_notifications(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_post_notifications(uuid, text, text, uuid, text) TO authenticated, service_role;

-- ── Verification: single overload of each, still SECDEF + search_path set ─────
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'record_job_pre_notifications';
  IF v_count <> 1 THEN RAISE EXCEPTION 'record_job_pre_notifications overload count is % (expected 1)', v_count; END IF;
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'record_job_post_notifications';
  IF v_count <> 1 THEN RAISE EXCEPTION 'record_job_post_notifications overload count is % (expected 1)', v_count; END IF;
END $$;
