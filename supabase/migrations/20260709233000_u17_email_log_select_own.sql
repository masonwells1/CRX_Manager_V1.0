-- U17-DB: Allow authenticated email senders to read their own email_log rows.
-- QuoteBuilder's send-history indicator must work for sales reps while retaining existing admin access.
-- Additive only: the existing email_log_admin_select policy is intentionally untouched.

CREATE POLICY email_log_select_own ON public.email_log FOR SELECT TO authenticated USING (created_by = (SELECT auth.uid()));

DO $$
DECLARE
  v_select_policy_count bigint;
  v_rls_enabled boolean;
BEGIN
  SELECT count(*)
  INTO v_select_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'email_log'
    AND cmd = 'SELECT'
    AND policyname IN ('email_log_admin_select', 'email_log_select_own');

  IF v_select_policy_count <> 2 THEN
    RAISE EXCEPTION
      'email_log SELECT policy post-check failed: expected both email_log_admin_select and email_log_select_own, found %',
      v_select_policy_count;
  END IF;

  SELECT c.relrowsecurity
  INTO v_rls_enabled
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'email_log';

  IF NOT COALESCE(v_rls_enabled, false) THEN
    RAISE EXCEPTION 'email_log RLS post-check failed: row-level security is not enabled';
  END IF;
END
$$;
