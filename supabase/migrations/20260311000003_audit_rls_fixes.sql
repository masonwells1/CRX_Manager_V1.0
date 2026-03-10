-- ============================================================================
-- Migration: 20260311000003_audit_rls_fixes.sql
-- Date: 2026-03-11
-- Description: Fix overly permissive RLS policies and add missing policies
--
-- Bug 1: financial_audit_log INSERT was WITH CHECK (true) — any user could
--         insert fake audit records. Restrict to admin or own records.
-- Bug 2: team_note_comments missing UPDATE/DELETE policies — frontend edits
--         and soft-deletes comments but RLS blocked it.
-- Bug 3: ar_reminder_tracking missing INSERT policy — ARaging.tsx inserts
--         tracking records but no INSERT policy existed.
-- Bug 4: ocr_processing_queue had leftover permissive policies from original
--         blend ticket migration ("System can insert/update queue items").
-- Bug 5: team_note_tags INSERT/DELETE were WITH CHECK (true) / USING (true)
--         — any user could tag/untag any note. Restrict to note owner or admin.
-- Bug 6: 12 tables missing admin-only DELETE policies.
-- ============================================================================

-- ============================================================================
-- Bug 1: Fix financial_audit_log INSERT — too permissive
-- Was: WITH CHECK (true)
-- Now: Admin or the current user (for RPC-inserted records)
-- ============================================================================

DROP POLICY IF EXISTS "financial_audit_insert" ON financial_audit_log;
CREATE POLICY "financial_audit_insert" ON financial_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR actor_user_id = auth.uid()
  );

-- ============================================================================
-- Bug 2: Add UPDATE/DELETE policies for team_note_comments
-- Only the comment author or admin can edit/soft-delete comments.
-- Note: column is created_by (not user_id).
-- ============================================================================

DROP POLICY IF EXISTS "team_note_comments_update" ON team_note_comments;
CREATE POLICY "team_note_comments_update" ON team_note_comments
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR is_admin())
  WITH CHECK (created_by = auth.uid() OR is_admin());

DROP POLICY IF EXISTS "team_note_comments_delete" ON team_note_comments;
CREATE POLICY "team_note_comments_delete" ON team_note_comments
  FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR is_admin());

-- ============================================================================
-- Bug 3: Add INSERT policy for ar_reminder_tracking
-- Only admins can insert reminder tracking records.
-- ============================================================================

DROP POLICY IF EXISTS "ar_reminder_tracking_insert" ON ar_reminder_tracking;
CREATE POLICY "ar_reminder_tracking_insert" ON ar_reminder_tracking
  FOR INSERT TO authenticated
  WITH CHECK (is_admin());

-- ============================================================================
-- Bug 4: Fix ocr_processing_queue — drop leftover permissive policies
-- The original blend ticket migration created permissive policies named
-- "System can insert queue items" and "System can update queue items"
-- with WITH CHECK (true) / USING (true). Sprint1 added tighter policies
-- but never dropped the old-named ones, so both sets coexist.
-- Since PostgreSQL RLS is permissive-OR, the old open policies negate
-- the tighter ones. Drop the old names to leave only the sprint1 policies.
-- ============================================================================

DROP POLICY IF EXISTS "System can insert queue items" ON ocr_processing_queue;
DROP POLICY IF EXISTS "System can update queue items" ON ocr_processing_queue;

-- Also drop and recreate the sprint1 policies to ensure they use is_admin()
-- consistently (sprint1 already does, but this ensures idempotency).
DROP POLICY IF EXISTS "ocr_queue_insert" ON ocr_processing_queue;
CREATE POLICY "ocr_queue_insert" ON ocr_processing_queue
  FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_id AND bt.uploaded_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "ocr_queue_update" ON ocr_processing_queue;
CREATE POLICY "ocr_queue_update" ON ocr_processing_queue
  FOR UPDATE TO authenticated
  USING (is_admin());

-- ============================================================================
-- Bug 5: Fix team_note_tags — too permissive
-- Was: WITH CHECK (true) / USING (true) for INSERT and DELETE.
-- Now: Only note owner or admin can tag/untag notes.
-- ============================================================================

DROP POLICY IF EXISTS "Authenticated users can add tags to notes" ON team_note_tags;
CREATE POLICY "team_note_tags_insert" ON team_note_tags
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_notes tn
      WHERE tn.id = note_id
        AND (tn.created_by = auth.uid() OR is_admin())
    )
  );

DROP POLICY IF EXISTS "Authenticated users can remove tags from notes" ON team_note_tags;
CREATE POLICY "team_note_tags_delete" ON team_note_tags
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_notes tn
      WHERE tn.id = note_id
        AND (tn.created_by = auth.uid() OR is_admin())
    )
  );

-- ============================================================================
-- Bug 6: Add admin-only DELETE policies to tables missing them
--
-- Excluded (intentionally no DELETE):
--   profiles (managed by auth), app_settings (singleton),
--   unit_conversions (reference data), financial_audit_log (append-only),
--   activity_feed (append-only), inventory_transactions (ledger)
-- ============================================================================

-- accounting_periods
DROP POLICY IF EXISTS "accounting_periods_admin_delete" ON accounting_periods;
CREATE POLICY "accounting_periods_admin_delete" ON accounting_periods
  FOR DELETE TO authenticated
  USING (is_admin());

-- allocation_sets
DROP POLICY IF EXISTS "allocation_sets_admin_delete" ON allocation_sets;
CREATE POLICY "allocation_sets_admin_delete" ON allocation_sets
  FOR DELETE TO authenticated
  USING (is_admin());

-- blend_tickets
DROP POLICY IF EXISTS "blend_tickets_admin_delete" ON blend_tickets;
CREATE POLICY "blend_tickets_admin_delete" ON blend_tickets
  FOR DELETE TO authenticated
  USING (is_admin());

-- commission_payments
DROP POLICY IF EXISTS "commission_payments_admin_delete" ON commission_payments;
CREATE POLICY "commission_payments_admin_delete" ON commission_payments
  FOR DELETE TO authenticated
  USING (is_admin());

-- commissions
DROP POLICY IF EXISTS "commissions_admin_delete" ON commissions;
CREATE POLICY "commissions_admin_delete" ON commissions
  FOR DELETE TO authenticated
  USING (is_admin());

-- notifications
DROP POLICY IF EXISTS "notifications_admin_delete" ON notifications;
CREATE POLICY "notifications_admin_delete" ON notifications
  FOR DELETE TO authenticated
  USING (is_admin());

-- ocr_processing_queue
DROP POLICY IF EXISTS "ocr_processing_queue_admin_delete" ON ocr_processing_queue;
CREATE POLICY "ocr_processing_queue_admin_delete" ON ocr_processing_queue
  FOR DELETE TO authenticated
  USING (is_admin());

-- vendor_bills
DROP POLICY IF EXISTS "vendor_bills_admin_delete" ON vendor_bills;
CREATE POLICY "vendor_bills_admin_delete" ON vendor_bills
  FOR DELETE TO authenticated
  USING (is_admin());

-- vendors
DROP POLICY IF EXISTS "vendors_admin_delete" ON vendors;
CREATE POLICY "vendors_admin_delete" ON vendors
  FOR DELETE TO authenticated
  USING (is_admin());

-- prepay_credits
DROP POLICY IF EXISTS "prepay_credits_admin_delete" ON prepay_credits;
CREATE POLICY "prepay_credits_admin_delete" ON prepay_credits
  FOR DELETE TO authenticated
  USING (is_admin());

-- vendor_payments
DROP POLICY IF EXISTS "vendor_payments_admin_delete" ON vendor_payments;
CREATE POLICY "vendor_payments_admin_delete" ON vendor_payments
  FOR DELETE TO authenticated
  USING (is_admin());

-- commission_payment_items
DROP POLICY IF EXISTS "commission_payment_items_admin_delete" ON commission_payment_items;
CREATE POLICY "commission_payment_items_admin_delete" ON commission_payment_items
  FOR DELETE TO authenticated
  USING (is_admin());
