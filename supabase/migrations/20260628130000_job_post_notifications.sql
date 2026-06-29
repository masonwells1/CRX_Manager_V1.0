-- 20260628130000_job_post_notifications.sql
-- Field-app parity #41 (2026-06-28): Post-notification to customer (AFTER application).
-- ---------------------------------------------------------------------------
-- Close mirror of #40 (20260628120000_job_notifications.sql). ChemMan's field-
-- application INVOICE editor carries a 'SEND POST-NOTIFICATION' bottom action and the
-- Notifications tab carries the customer notification history OVER from the job — an
-- after-application notice to the customer, logged. This migration adds ONLY the
-- post-application pieces; it REUSES #40's infrastructure heavily:
--
--   REUSED VERBATIM (built in #40, NOT rebuilt here):
--     * table public.job_notifications — already has notification_type CHECK
--       ('pre','post'); this section records the 'post' rows. SELECT-only RLS
--       (admin/sales); writes are RPC-only.
--     * confirm_job_notification_sent(uuid,text,text,uuid,text) — notification_type
--       agnostic; flips a recorded row failed->sent after the outbound email
--       succeeds. Used by BOTH pre and post sends unchanged.
--
--   NEW here:
--     1. A new value on the existing `email_type` ENUM so the generic email_log
--        (and the gated send-email edge fn) can classify the post send.
--     2. A record RPC `record_job_post_notifications` that mirrors
--        record_job_pre_notifications EXACTLY (SECDEF + search_path, idempotency,
--        strict-actor, role-gate admin/sales, same distinct share-customer
--        resolution, no-email recipient -> 'failed' not dropped) BUT lifecycle-gated
--        to a job that HAS been applied — status IN ('completed','invoiced') —
--        instead of scheduled/in_progress (a post notice is sent AFTER application,
--        and a job that has been transferred to an invoice is 'invoiced').
--     3. An owner-editable post-notification template app_setting (criterion #4).
--
-- ADDITIVE ONLY: new enum value + new RPC + a seed row. No existing object is
-- dropped or rewritten; job_notifications + confirm_job_notification_sent are reused.
-- Em-dashes below are real U+2014.

-- ── 1) Enum value ────────────────────────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE must be its own committed statement and CANNOT be used
-- by another object in the SAME transaction. It runs FIRST here, and nothing below
-- references the enum value as a literal (job_notifications uses a text CHECK, and
-- the RPC writes notification_type='post' text, NOT the enum), so there is no
-- mid-transaction dependency. IF NOT EXISTS makes the migration idempotent. The
-- value's ONLY consumer is the send-email edge fn's allow-list + the email_log
-- classification — both downstream of this migration, never in the same statement.
ALTER TYPE public.email_type ADD VALUE IF NOT EXISTS 'post_application_notice';

-- ── 2) Configurable template (criterion #4) ──────────────────────────────────
-- Owner-editable post-notification wording lives in app_settings (admin-writable via
-- the existing settings RLS), so the message is NOT hard-coded. Stored as JSON with a
-- subject + body; the body supports {{customer}}, {{job_number}} and {{job_date}}
-- placeholders the frontend interpolates. Seed a sensible default only if the owner
-- has not already set one (ON CONFLICT DO NOTHING).
INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES (
  'post_application_notice_template',
  '{"subject":"Your field application is complete","body":"Hello {{customer}},\n\nThis is to confirm that Crop RX Solutions has completed the field application for you (Job {{job_number}}) on {{job_date}}. Please observe any posted re-entry (REI) and pre-harvest (PHI) intervals for the products applied.\n\nIf you have any questions about this application, just reply to this email or give us a call.\n\nThank you,\nCrop RX Solutions"}',
  'Field-app #41: editable wording for the post-application customer notification (subject + body; supports {{customer}}, {{job_number}}, {{job_date}}).'
)
ON CONFLICT (setting_key) DO NOTHING;

-- ── 3) Record RPC: record_job_post_notifications ─────────────────────────────
-- Exact mirror of record_job_pre_notifications, EXCEPT:
--   * lifecycle gate is status IN ('completed','invoiced') — a post notice is sent
--     AFTER the work is done; a job that has been transferred to an invoice is
--     'invoiced' (UPDATE jobs SET status='invoiced' in transfer_job_to_invoice), so
--     the gate accepts BOTH the post-application/pre-billing 'completed' state AND
--     the billed 'invoiced' state. This is what lets criterion #5 work: a tester can
--     trigger the post-notice from the field-application INVOICE (whose source job is
--     'invoiced'). #40's pre-notice gates the opposite end (scheduled/in_progress).
--   * notification_type recorded is 'post'.
--   * the idempotency operation + activity event + comment say "post".
-- Everything else (share-customer resolution precedence, strict-actor, role gate,
-- per-recipient deterministic email key, 'failed'-until-confirmed status, no-email
-- recipient recorded as 'failed' not dropped) is identical to #40.
--
-- Single overload (verified: no existing record_job_post_notifications). Drop a
-- would-be prior signature defensively before (re)creating.
DROP FUNCTION IF EXISTS public.record_job_post_notifications(uuid, text, text, uuid, text);

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

  -- idempotency: return the cached result if this key already ran for THIS op
  -- (scoped to record_job_post_notifications — never another op's cached row).
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_job_post_notifications');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
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

  -- LIFECYCLE GATE: a POST-application notice only makes sense for a job whose work
  -- HAS happened — completed (applied, not yet billed) or invoiced (applied + billed;
  -- a job transferred to an invoice is set to 'invoiced'). Refuse on
  -- scheduled / in_progress / cancelled so a stale click can't email "application
  -- complete" before the work is done or on a cancelled job. (#40's pre-notice gates
  -- the opposite end — scheduled/in_progress.)
  IF v_job_status NOT IN ('completed', 'invoiced') THEN
    RAISE EXCEPTION 'JOB_NOT_POST_NOTIFIABLE: job % is % (post-notice requires completed or invoiced)', p_job_id, v_job_status;
  END IF;

  -- Resolve the DISTINCT share customers with the SAME precedence the compliance
  -- resolver uses (get_job_billed_customers): explicit job_field_shares, else
  -- field_billing_defaults, else the job's primary customer. Record one row per
  -- resolved customer. IDENTICAL to record_job_pre_notifications.
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
    -- HONEST STATUS: a row is recorded 'failed' and only flips to 'sent' once the
    -- outbound email actually succeeds (the frontend calls confirm_job_notification_sent
    -- after a successful send-email). A recipient whose email never leaves correctly
    -- stays 'failed'; a recipient with NO email on file is also 'failed' (surfaced, not
    -- silently dropped) and has no row id to confirm later (has_email=false).
    v_per_email_key := CASE
      WHEN v_email IS NULL OR p_idempotency_key IS NULL THEN NULL
      -- Deterministic per-recipient email key derived from the RPC key (NOT a
      -- timestamp): a retry under the SAME action key reuses it, so the edge fn
      -- de-dupes and a recipient whose first email already went out is not emailed twice.
      ELSE p_idempotency_key || ':' || v_recipient.customer_id::text
    END;

    -- sent_at stays NULL: 'failed' until a successful send confirms it.
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

  -- A real job always resolves to at least its primary customer (fallback #4), so an
  -- empty set means a job with no customer at all — refuse rather than no-op.
  IF jsonb_array_length(v_recipients) = 0 THEN
    RAISE EXCEPTION 'NO_RECIPIENTS: job % has no resolvable customer to notify', p_job_id;
  END IF;

  -- Audit trail: a post-notification was issued on this job (one summary row).
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

COMMENT ON FUNCTION public.record_job_post_notifications(uuid, text, text, uuid, text) IS
  'Field-app #41: records a per-recipient post-application notification log on a job '
  '(notification_type=post), resolving the job''s distinct share customers via the '
  'get_job_billed_customers precedence. Every row is recorded status=failed and only '
  'flips to sent via confirm_job_notification_sent after the outbound email succeeds. '
  'Lifecycle-gated to completed/invoiced. SECURITY DEFINER; admin/sales_rep only.';

-- ── 4) Verification ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- enum value present
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'email_type' AND e.enumlabel = 'post_application_notice'
  ) THEN
    RAISE EXCEPTION 'email_type enum is missing post_application_notice';
  END IF;

  -- exactly one overload of the new RPC
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'record_job_post_notifications';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'record_job_post_notifications overload count is % (expected 1)', v_count;
  END IF;

  -- the confirm RPC #41 REUSES still exists as a single overload (reused verbatim).
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'confirm_job_notification_sent';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'confirm_job_notification_sent overload count is % (expected 1)', v_count;
  END IF;

  -- the post template setting was seeded
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key = 'post_application_notice_template') THEN
    RAISE EXCEPTION 'post_application_notice_template setting missing';
  END IF;
END $$;
