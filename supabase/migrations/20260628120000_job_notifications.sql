-- 20260628120000_job_notifications.sql
-- Field-app parity #40 (2026-06-28): Pre-notification to customer (before application).
-- ---------------------------------------------------------------------------
-- ChemMan has a per-row "PRE = Send Pre-Notification" action that emails the
-- customer ahead of an application, and the job editor has a NOTIFICATIONS tab
-- listing every notification sent to the customer ("No notifications have been
-- sent yet" until the first one). This migration builds the persistence layer:
--
--   1. A new value on the existing `email_type` ENUM so the generic email_log
--      (and the gated send-email edge fn) can classify these sends.
--   2. A NEW per-job customer-facing log table `job_notifications` (#41 will
--      REUSE it for the post-application notice via notification_type='post').
--   3. A record RPC `record_job_pre_notifications` that resolves the job's
--      DISTINCT share customers (same precedence as get_job_billed_customers:
--      job_field_shares -> field_billing_defaults -> primary customer) and
--      records ONE job_notifications row per recipient with type='pre'. A
--      recipient with no email on file is recorded as status='failed' (surfaced,
--      never silently dropped) so the UI can show which contacts couldn't be
--      reached while the others still go out.
--
-- The ACTUAL outbound email is sent by the frontend through the gated send-email
-- edge function (email_type='pre_application_notice'); this RPC only records the
-- per-job log + returns the resolved recipients so the caller knows who to email.
--
-- ADDITIVE ONLY: new enum value + new table + new RPC. No existing object is
-- dropped or rewritten. The new table does NOT reference the email_type enum
-- (its own notification_type text CHECK), so the new enum value is never used in
-- the same statement that adds it.
-- Em-dashes below are real U+2014.

-- ── 1) Enum value ────────────────────────────────────────────────────────────
-- ALTER TYPE ... ADD VALUE must be its own committed statement and CANNOT be
-- used by another object in the SAME transaction. It runs FIRST here, and nothing
-- below references the enum value (job_notifications uses a text CHECK), so there
-- is no mid-transaction dependency. IF NOT EXISTS makes the migration idempotent.
ALTER TYPE public.email_type ADD VALUE IF NOT EXISTS 'pre_application_notice';

-- ── 2) Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- 'pre' (before application, this section) and 'post' (#41 reuses this table).
  notification_type text NOT NULL CHECK (notification_type IN ('pre', 'post')),
  -- The billed/share customer this notice was addressed to. SET NULL on a customer
  -- delete keeps the historical log row (it is a customer-facing audit record).
  customer_id       uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  recipient_email   text,
  -- Channel is email-only by design (#40 hard gate: no paid SMS channel). The
  -- CHECK keeps a future 'sms' value an explicit, reviewed migration, not a typo.
  channel           text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  subject           text,
  message           text,
  -- 'sent' = the outbound email actually went out (confirmed); 'failed' = recipient
  -- had no email on file, or the send has not (yet) succeeded.
  status            text NOT NULL DEFAULT 'failed' CHECK (status IN ('sent', 'failed')),
  -- NULL until the row is confirmed 'sent' — a failed/pending row has no send time,
  -- so the UI's "Sent" column stays blank for it (Codex #40 P2). confirm_job_
  -- notification_sent stamps this.
  sent_at           timestamptz,
  sent_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_notifications_job
  ON public.job_notifications(job_id);
CREATE INDEX IF NOT EXISTS idx_job_notifications_customer
  ON public.job_notifications(customer_id);

-- ── 3) RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.job_notifications ENABLE ROW LEVEL SECURITY;

-- SELECT: admin / sales_rep only. The row carries the customer's recipient_email,
-- which on a SPLIT-billed job includes CO-billed customers an applicator does not
-- otherwise get from the customer RLS / get_job_billed_customers path — so granting
-- the applicator a full-row read here would leak co-billed customer emails (Codex
-- #40 P2). The notification log is an admin/sales sending tool; applicators don't
-- need it. They cannot WRITE either (no write policy below — writes are RPC-only).
-- anon: no access at all.
DROP POLICY IF EXISTS "job_notifications_select" ON public.job_notifications;
CREATE POLICY "job_notifications_select" ON public.job_notifications
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
  );

-- WRITES ARE RPC-ONLY (no client INSERT/UPDATE/DELETE policy). Recording a
-- notification MUST go through record_job_pre_notifications(), which is SECURITY
-- DEFINER (bypasses RLS) and enforces the role gate, strict-actor, the job
-- lifecycle, the share-customer resolution, and idempotency. With RLS enabled and
-- NO permissive write policy, a direct PostgREST INSERT/UPDATE/DELETE by any role
-- is denied. (Mirrors job_location_dispatches: RPC-only writes, SELECT-only
-- client policy.)
GRANT SELECT ON public.job_notifications TO authenticated;

-- ── 4) Configurable template (criterion #5) ──────────────────────────────────
-- Owner-editable pre-notification wording lives in app_settings (admin-writable
-- via the existing settings RLS), so the message is NOT hard-coded. Stored as JSON
-- with a subject + body; the body supports {{customer}}, {{job_number}} and
-- {{job_date}} placeholders the frontend interpolates. Seed a sensible default
-- only if the owner has not already set one (ON CONFLICT DO NOTHING).
INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES (
  'pre_application_notice_template',
  '{"subject":"Upcoming application on your fields","body":"Hello {{customer}},\n\nThis is a courtesy notice that Crop RX Solutions has a field application scheduled for you (Job {{job_number}}) on {{job_date}}. Please keep people and livestock clear of the treated fields and observe any posted re-entry intervals.\n\nIf you have any questions, just reply to this email or give us a call.\n\nThank you,\nCrop RX Solutions"}',
  'Field-app #40: editable wording for the pre-application customer notification (subject + body; supports {{customer}}, {{job_number}}, {{job_date}}).'
)
ON CONFLICT (setting_key) DO NOTHING;

-- ── 5) Record RPC: record_job_pre_notifications ──────────────────────────────
-- Resolves the job's DISTINCT share customers (same precedence the compliance
-- resolver get_job_billed_customers uses) and records one job_notifications row
-- per recipient with notification_type='pre'. Returns the recorded rows so the
-- frontend knows which recipients have an email (status='sent', to be emailed via
-- the gated edge fn) and which do not (status='failed').
--
-- Single overload (verified: no existing record_job_pre_notifications). Drop a
-- would-be prior signature defensively before (re)creating.
DROP FUNCTION IF EXISTS public.record_job_pre_notifications(uuid, text, text, uuid, text);

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

  -- idempotency: return the cached result if this key already ran for THIS op.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_job_pre_notifications');
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

  -- LIFECYCLE GATE (Codex #40 P2): a PRE-application notice only makes sense for a
  -- job that has NOT happened yet — scheduled or in_progress. Refuse on completed /
  -- invoiced / cancelled jobs so a stale click can't email "upcoming application"
  -- after the work is done or the job is cancelled. (#41's post-notice will gate on
  -- completed instead.)
  IF v_job_status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'JOB_NOT_PRE_NOTIFIABLE: job % is % (pre-notice requires scheduled or in_progress)', p_job_id, v_job_status;
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
    -- HONEST STATUS (Codex #40 P2): a row is recorded as 'failed' and only flips to
    -- 'sent' once the outbound email actually succeeds (the frontend calls
    -- confirm_job_notification_sent after a successful send-email). So a recipient
    -- whose email never leaves (edge rejects the new type, rate limit, Resend error)
    -- correctly stays 'failed' in the log — we never show 'Sent' for an email that
    -- didn't go out. A recipient with NO email on file is also 'failed' (surfaced,
    -- not silently dropped) and has no row id to confirm later (has_email=false).
    v_per_email_key := CASE
      WHEN v_email IS NULL OR p_idempotency_key IS NULL THEN NULL
      -- Deterministic per-recipient email key derived from the RPC key (NOT a
      -- timestamp): a retry under the SAME action key reuses it, so the edge fn
      -- de-dupes and a recipient whose first email already went out is not emailed
      -- twice (Codex #40 P2).
      ELSE p_idempotency_key || ':' || v_recipient.customer_id::text
    END;

    -- sent_at stays NULL: this row is 'failed' until a successful send confirms it,
    -- so the UI's "Sent" column is blank for a failed/pending row (Codex #40 P2).
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
      -- has an email: it WILL be attempted by the frontend; counted as a pending send.
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

  -- A real job always resolves to at least its primary customer (fallback #4), so
  -- an empty set means a job with no customer at all — refuse rather than no-op.
  IF jsonb_array_length(v_recipients) = 0 THEN
    RAISE EXCEPTION 'NO_RECIPIENTS: job % has no resolvable customer to notify', p_job_id;
  END IF;

  -- Audit trail: a pre-notification was issued on this job (one summary row).
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
    -- recipients WITH an email (rows recorded 'failed' until the send confirms).
    'recipients_with_email', v_sent_count,
    -- recipients with NO email on file (recorded 'failed', never emailable).
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

COMMENT ON FUNCTION public.record_job_pre_notifications(uuid, text, text, uuid, text) IS
  'Field-app #40: records a per-recipient pre-application notification log on a job '
  '(notification_type=pre), resolving the job''s distinct share customers via the '
  'get_job_billed_customers precedence. Every row is recorded status=failed and only '
  'flips to sent via confirm_job_notification_sent after the outbound email succeeds. '
  'Lifecycle-gated to scheduled/in_progress. SECURITY DEFINER; admin/sales_rep only.';

-- ── 5b) Confirm RPC: confirm_job_notification_sent ───────────────────────────
-- Flips a recorded notification row from 'failed' to 'sent' AFTER the frontend's
-- outbound send-email call actually succeeds (Codex #40 P2 — never show 'Sent' for
-- an email that did not leave), and stores the EXACT per-recipient subject/message
-- that was emailed (so a split-billed co-billed customer's audit row matches the
-- {{customer}}-interpolated text they actually received — Codex #40 re-review P2).
-- Scoped to a single row id; admin/sales only (definer fn self-gates on role).
-- Idempotent: confirming an already-'sent' row is a no-op success.
DROP FUNCTION IF EXISTS public.confirm_job_notification_sent(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.confirm_job_notification_sent(uuid, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.confirm_job_notification_sent(
  p_notification_id uuid,
  p_subject         text DEFAULT NULL,
  p_message         text DEFAULT NULL,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_role     text;
  v_existing jsonb;
  v_status   text;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'confirm_job_notification_sent');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT status INTO v_status FROM job_notifications WHERE id = p_notification_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOTIFICATION_NOT_FOUND: % does not exist', p_notification_id;
  END IF;

  -- Only a row that actually HAS a recipient email is confirmable (a no-email row
  -- stays 'failed'); confirming an already-'sent' row is an idempotent no-op. When
  -- the caller passes the per-recipient rendered subject/message, store THAT exact
  -- text (so the audit row matches the email), else keep what was recorded.
  IF v_status <> 'sent' THEN
    UPDATE job_notifications
       SET status  = 'sent',
           sent_at = now(),
           subject = COALESCE(p_subject, subject),
           message = COALESCE(p_message, message)
     WHERE id = p_notification_id
       AND recipient_email IS NOT NULL;
  END IF;

  v_result := jsonb_build_object('success', true, 'notification_id', p_notification_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'confirm_job_notification_sent', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_job_notification_sent(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_job_notification_sent(uuid, text, text, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.confirm_job_notification_sent(uuid, text, text, uuid, text) IS
  'Field-app #40: flips a job_notifications row from failed to sent after the '
  'outbound email succeeds, storing the exact per-recipient subject/message sent. '
  'SECURITY DEFINER; admin/sales_rep only; idempotent.';

-- ── 6) Verification ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- enum value present
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'email_type' AND e.enumlabel = 'pre_application_notice'
  ) THEN
    RAISE EXCEPTION 'email_type enum is missing pre_application_notice';
  END IF;

  -- table + RLS enabled
  IF to_regclass('public.job_notifications') IS NULL THEN
    RAISE EXCEPTION 'job_notifications table missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_class
   WHERE oid = 'public.job_notifications'::regclass AND relrowsecurity = true;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'RLS not enabled on job_notifications';
  END IF;

  -- exactly one overload of each RPC
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'record_job_pre_notifications';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'record_job_pre_notifications overload count is % (expected 1)', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'confirm_job_notification_sent';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'confirm_job_notification_sent overload count is % (expected 1)', v_count;
  END IF;

  -- exactly one SELECT policy, and NO write policy (writes are RPC-only)
  SELECT count(*) INTO v_count FROM pg_policy
   WHERE polrelid = 'public.job_notifications'::regclass;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'job_notifications should have exactly one (SELECT) policy, found %', v_count;
  END IF;

  -- the template setting was seeded
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key = 'pre_application_notice_template') THEN
    RAISE EXCEPTION 'pre_application_notice_template setting missing';
  END IF;
END $$;
