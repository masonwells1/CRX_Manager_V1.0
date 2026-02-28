-- Migration: failed_notifications table for notification reliability tracking
-- Sprint 2a: Promote notification failures to trackable events

-- ============================================================
-- A) Create failed_notifications table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.failed_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  error_message text NOT NULL,
  payload jsonb DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 1,
  max_attempts integer NOT NULL DEFAULT 3,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for retry queries (unresolved failures ordered by age)
CREATE INDEX IF NOT EXISTS idx_failed_notifications_unresolved
  ON public.failed_notifications (created_at)
  WHERE resolved_at IS NULL;

-- Index for lookups by entity
CREATE INDEX IF NOT EXISTS idx_failed_notifications_entity
  ON public.failed_notifications (entity_type, entity_id);

-- RLS: admins only
ALTER TABLE public.failed_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view failed notifications"
  ON public.failed_notifications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can manage failed notifications"
  ON public.failed_notifications FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- ============================================================
-- B) RPC to log a failed notification
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_failed_notification(
  p_notification_type text,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_error_message text DEFAULT 'Unknown error',
  p_payload jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.failed_notifications (
    notification_type, entity_type, entity_id, error_message, payload
  )
  VALUES (
    p_notification_type, p_entity_type, p_entity_id, p_error_message, p_payload
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ============================================================
-- C) RPC to retry failed notifications (called from Dashboard)
-- ============================================================
CREATE OR REPLACE FUNCTION public.retry_failed_notifications()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retried integer := 0;
  v_resolved integer := 0;
  v_exceeded integer := 0;
  v_row RECORD;
BEGIN
  -- Mark entries that exceeded max attempts
  UPDATE public.failed_notifications
  SET resolved_at = now(), updated_at = now()
  WHERE resolved_at IS NULL
    AND attempts >= max_attempts;
  GET DIAGNOSTICS v_exceeded = ROW_COUNT;

  -- Return summary (actual retry logic lives in the app layer
  -- since notifications use the Supabase client, not raw SQL)
  SELECT COUNT(*) INTO v_retried
  FROM public.failed_notifications
  WHERE resolved_at IS NULL;

  RETURN jsonb_build_object(
    'pending', v_retried,
    'exceeded_max_attempts', v_exceeded
  );
END;
$$;
