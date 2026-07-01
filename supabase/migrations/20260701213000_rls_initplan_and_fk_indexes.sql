-- 20260701213000_rls_initplan_and_fk_indexes.sql
-- Codex bug-hunt F5 (2026-07-01), performance polish (low risk, additive/idempotent).
-- The performance advisor flagged, on NEW tables only:
--   (a) auth_rls_initplan x9 — policies call auth.uid() bare, so Postgres re-evaluates
--       it PER ROW. Wrapping as (select auth.uid()) makes it a one-time init-plan scalar.
--       Same predicate + same role targeting; behaviour is identical, just faster.
--   (b) unindexed_foreign_keys x9 — new-table FK columns with no covering index.
-- No schema/column change; policy predicates are re-created verbatim except the
-- (select auth.uid()) wrap. DROP+CREATE of each policy is atomic inside this migration's
-- transaction (no window with the policy absent).

-- ── (a) product_label_drafts — wrap auth.uid() (4 policies; role targeting unchanged) ──
DROP POLICY IF EXISTS "admin_select_product_label_drafts" ON public.product_label_drafts;
CREATE POLICY "admin_select_product_label_drafts" ON public.product_label_drafts
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin' AND profiles.is_active = true));

DROP POLICY IF EXISTS "admin_insert_product_label_drafts" ON public.product_label_drafts;
CREATE POLICY "admin_insert_product_label_drafts" ON public.product_label_drafts
  FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin' AND profiles.is_active = true));

DROP POLICY IF EXISTS "admin_update_product_label_drafts" ON public.product_label_drafts;
CREATE POLICY "admin_update_product_label_drafts" ON public.product_label_drafts
  FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin' AND profiles.is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin' AND profiles.is_active = true));

DROP POLICY IF EXISTS "admin_delete_product_label_drafts" ON public.product_label_drafts;
CREATE POLICY "admin_delete_product_label_drafts" ON public.product_label_drafts
  FOR DELETE
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin' AND profiles.is_active = true));

-- ── (a) user_list_settings — wrap auth.uid() (4 policies; TO authenticated preserved) ──
DROP POLICY IF EXISTS "user_list_settings_select" ON public.user_list_settings;
CREATE POLICY "user_list_settings_select" ON public.user_list_settings
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "user_list_settings_insert" ON public.user_list_settings;
CREATE POLICY "user_list_settings_insert" ON public.user_list_settings
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "user_list_settings_update" ON public.user_list_settings;
CREATE POLICY "user_list_settings_update" ON public.user_list_settings
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "user_list_settings_delete" ON public.user_list_settings;
CREATE POLICY "user_list_settings_delete" ON public.user_list_settings
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- ── (a) watchdog_flag_dismissals — wrap auth.uid() in the flagged INSERT policy ──
-- (Only the INSERT policy's `dismissed_by = auth.uid()` was flagged; the SELECT policy
--  uses is_admin()/is_sales_rep() and is left unchanged.)
DROP POLICY IF EXISTS "watchdog_dismissals_insert" ON public.watchdog_flag_dismissals;
CREATE POLICY "watchdog_dismissals_insert" ON public.watchdog_flag_dismissals
  FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()) AND (dismissed_by = (select auth.uid())));

-- ── (b) covering indexes for the flagged new-table foreign keys ──
CREATE INDEX IF NOT EXISTS idx_job_applied_records_created_by       ON public.job_applied_records(created_by);
CREATE INDEX IF NOT EXISTS idx_job_attachments_uploaded_by          ON public.job_attachments(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_job_batches_created_by               ON public.job_batches(created_by);
CREATE INDEX IF NOT EXISTS idx_job_location_dispatches_crew_id      ON public.job_location_dispatches(crew_id);
CREATE INDEX IF NOT EXISTS idx_job_location_dispatches_dispatched_by ON public.job_location_dispatches(dispatched_by);
CREATE INDEX IF NOT EXISTS idx_job_notifications_sent_by            ON public.job_notifications(sent_by);
CREATE INDEX IF NOT EXISTS idx_job_tags_created_by                 ON public.job_tags(created_by);
CREATE INDEX IF NOT EXISTS idx_product_label_drafts_created_by     ON public.product_label_drafts(created_by);
CREATE INDEX IF NOT EXISTS idx_product_label_drafts_reviewed_by    ON public.product_label_drafts(reviewed_by);

-- ── Verification ──
DO $$
DECLARE v_count int;
BEGIN
  -- product_label_drafts keeps its 4 policies, user_list_settings its 4.
  SELECT count(*) INTO v_count FROM pg_policy WHERE polrelid = 'public.product_label_drafts'::regclass;
  IF v_count <> 4 THEN RAISE EXCEPTION 'product_label_drafts policy count is % (expected 4)', v_count; END IF;
  SELECT count(*) INTO v_count FROM pg_policy WHERE polrelid = 'public.user_list_settings'::regclass;
  IF v_count <> 4 THEN RAISE EXCEPTION 'user_list_settings policy count is % (expected 4)', v_count; END IF;
  -- watchdog_flag_dismissals keeps both (select + insert).
  SELECT count(*) INTO v_count FROM pg_policy WHERE polrelid = 'public.watchdog_flag_dismissals'::regclass;
  IF v_count <> 2 THEN RAISE EXCEPTION 'watchdog_flag_dismissals policy count is % (expected 2)', v_count; END IF;
END $$;
