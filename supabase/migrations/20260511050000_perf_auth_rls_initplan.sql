-- Migration: perf_auth_rls_initplan
-- Source: Supabase performance advisor auth_rls_initplan (63 WARN)
-- Goal: wrap unwrapped auth.uid() in `(SELECT auth.uid())` so it's evaluated
-- once per query instead of once per row. Same goes for auth.jwt() if present.
-- Hard requirement: each policy is dropped and recreated with the SAME action,
-- roles, permissive flag, qual, and with_check — only the auth.<fn>() calls are
-- wrapped. Access is provably preserved (verified by post-block).
--
-- Excluded: policies that also appear in multiple_permissive_policies overlap
-- groups — those are handled in 20260511060000_perf_consolidate_permissive_policies.sql
-- (which both consolidates them AND wraps the auth.uid() calls).


-- ============================================================
-- Table: public.accounting_periods
-- ============================================================

-- accounting_periods_insert_admin  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "accounting_periods_insert_admin" ON public.accounting_periods;
CREATE POLICY "accounting_periods_insert_admin" ON public.accounting_periods
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- accounting_periods_select_admin  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "accounting_periods_select_admin" ON public.accounting_periods;
CREATE POLICY "accounting_periods_select_admin" ON public.accounting_periods
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- accounting_periods_update_admin  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "accounting_periods_update_admin" ON public.accounting_periods;
CREATE POLICY "accounting_periods_update_admin" ON public.accounting_periods
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));


-- ============================================================
-- Table: public.application_record_fields
-- ============================================================

-- arf_delete  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "arf_delete" ON public.application_record_fields;
CREATE POLICY "arf_delete" ON public.application_record_fields
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (SELECT auth.uid())) AND (p.role = 'admin'::text)))));

-- arf_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "arf_insert" ON public.application_record_fields;
CREATE POLICY "arf_insert" ON public.application_record_fields
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (SELECT auth.uid())) AND (p.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))));

-- arf_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "arf_select" ON public.application_record_fields;
CREATE POLICY "arf_select" ON public.application_record_fields
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((SELECT auth.uid()) IS NOT NULL));

-- arf_update  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "arf_update" ON public.application_record_fields;
CREATE POLICY "arf_update" ON public.application_record_fields
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (SELECT auth.uid())) AND (p.role = 'admin'::text)))));


-- ============================================================
-- Table: public.ar_reminder_tracking
-- ============================================================

-- ar_reminder_admin_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "ar_reminder_admin_select" ON public.ar_reminder_tracking;
CREATE POLICY "ar_reminder_admin_select" ON public.ar_reminder_tracking
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));


-- ============================================================
-- Table: public.blend_ticket_images
-- ============================================================

-- Users can delete images for their tickets or admin can delete a  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can delete images for their tickets or admin can delete a" ON public.blend_ticket_images;
CREATE POLICY "Users can delete images for their tickets or admin can delete a" ON public.blend_ticket_images
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM blend_tickets
  WHERE ((blend_tickets.id = blend_ticket_images.blend_ticket_id) AND ((blend_tickets.uploaded_by = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))))))));

-- Users can insert images for their tickets  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "Users can insert images for their tickets" ON public.blend_ticket_images;
CREATE POLICY "Users can insert images for their tickets" ON public.blend_ticket_images
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM blend_tickets
  WHERE ((blend_tickets.id = blend_ticket_images.blend_ticket_id) AND (blend_tickets.uploaded_by = (SELECT auth.uid()))))));


-- ============================================================
-- Table: public.blend_ticket_products
-- ============================================================

-- Users can delete products for their tickets or admin can delete  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can delete products for their tickets or admin can delete" ON public.blend_ticket_products;
CREATE POLICY "Users can delete products for their tickets or admin can delete" ON public.blend_ticket_products
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM blend_tickets
  WHERE ((blend_tickets.id = blend_ticket_products.blend_ticket_id) AND ((blend_tickets.uploaded_by = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))))))));

-- Users can insert products for their tickets  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "Users can insert products for their tickets" ON public.blend_ticket_products;
CREATE POLICY "Users can insert products for their tickets" ON public.blend_ticket_products
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM blend_tickets
  WHERE ((blend_tickets.id = blend_ticket_products.blend_ticket_id) AND (blend_tickets.uploaded_by = (SELECT auth.uid()))))));

-- Users can update products for their tickets or admin can update  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can update products for their tickets or admin can update" ON public.blend_ticket_products;
CREATE POLICY "Users can update products for their tickets or admin can update" ON public.blend_ticket_products
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM blend_tickets
  WHERE ((blend_tickets.id = blend_ticket_products.blend_ticket_id) AND ((blend_tickets.uploaded_by = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))))))));


-- ============================================================
-- Table: public.blend_tickets
-- ============================================================

-- Authenticated users can insert blend tickets  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "Authenticated users can insert blend tickets" ON public.blend_tickets;
CREATE POLICY "Authenticated users can insert blend tickets" ON public.blend_tickets
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((uploaded_by = (SELECT auth.uid())));

-- Users can update their own tickets or admin can update any  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can update their own tickets or admin can update any" ON public.blend_tickets;
CREATE POLICY "Users can update their own tickets or admin can update any" ON public.blend_tickets
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (((uploaded_by = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])))))));


-- ============================================================
-- Table: public.commission_payment_items
-- ============================================================

-- commission_payment_items_insert_admin  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "commission_payment_items_insert_admin" ON public.commission_payment_items;
CREATE POLICY "commission_payment_items_insert_admin" ON public.commission_payment_items
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- commission_payment_items_select_admin  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "commission_payment_items_select_admin" ON public.commission_payment_items;
CREATE POLICY "commission_payment_items_select_admin" ON public.commission_payment_items
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));


-- ============================================================
-- Table: public.commission_payments
-- ============================================================

-- commission_payments_insert_admin  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "commission_payments_insert_admin" ON public.commission_payments;
CREATE POLICY "commission_payments_insert_admin" ON public.commission_payments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- commission_payments_select_admin  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "commission_payments_select_admin" ON public.commission_payments;
CREATE POLICY "commission_payments_select_admin" ON public.commission_payments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- commission_payments_update_admin  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "commission_payments_update_admin" ON public.commission_payments;
CREATE POLICY "commission_payments_update_admin" ON public.commission_payments
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));


-- ============================================================
-- Table: public.email_log
-- ============================================================

-- email_log_admin_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "email_log_admin_insert" ON public.email_log;
CREATE POLICY "email_log_admin_insert" ON public.email_log
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

-- email_log_admin_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "email_log_admin_select" ON public.email_log;
CREATE POLICY "email_log_admin_select" ON public.email_log
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));


-- ============================================================
-- Table: public.field_app_location_shares
-- ============================================================

-- field_app_location_shares_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "field_app_location_shares_select" ON public.field_app_location_shares;
CREATE POLICY "field_app_location_shares_select" ON public.field_app_location_shares
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((SELECT auth.uid()) IS NOT NULL));


-- ============================================================
-- Table: public.field_app_locations
-- ============================================================

-- field_app_locations_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "field_app_locations_select" ON public.field_app_locations;
CREATE POLICY "field_app_locations_select" ON public.field_app_locations
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((SELECT auth.uid()) IS NOT NULL));


-- ============================================================
-- Table: public.finance_charges
-- ============================================================

-- finance_charges_insert_admin  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "finance_charges_insert_admin" ON public.finance_charges;
CREATE POLICY "finance_charges_insert_admin" ON public.finance_charges
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- finance_charges_select_admin  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "finance_charges_select_admin" ON public.finance_charges;
CREATE POLICY "finance_charges_select_admin" ON public.finance_charges
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));


-- ============================================================
-- Table: public.financial_audit_log
-- ============================================================

-- financial_audit_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "financial_audit_insert" ON public.financial_audit_log;
CREATE POLICY "financial_audit_insert" ON public.financial_audit_log
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((is_admin() OR (actor_user_id = (SELECT auth.uid()))));


-- ============================================================
-- Table: public.inventory_holds
-- ============================================================

-- inventory_holds_delete  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "inventory_holds_delete" ON public.inventory_holds;
CREATE POLICY "inventory_holds_delete" ON public.inventory_holds
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((((SELECT auth.uid()) = created_by) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text))))));

-- inventory_holds_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "inventory_holds_insert" ON public.inventory_holds;
CREATE POLICY "inventory_holds_insert" ON public.inventory_holds
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((SELECT auth.uid()) = created_by));

-- inventory_holds_update  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "inventory_holds_update" ON public.inventory_holds;
CREATE POLICY "inventory_holds_update" ON public.inventory_holds
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((((SELECT auth.uid()) = created_by) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text))))));


-- ============================================================
-- Table: public.invoice_shares
-- ============================================================

-- invoice_shares_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "invoice_shares_select" ON public.invoice_shares;
CREATE POLICY "invoice_shares_select" ON public.invoice_shares
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_shares.invoice_id) AND (i.deleted_at IS NULL) AND (is_admin() OR (i.created_by = (SELECT auth.uid())) OR (i.salesman_id = (SELECT auth.uid())))))));


-- ============================================================
-- Table: public.note_activity_log
-- ============================================================

-- Authenticated users can create activity entries  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "Authenticated users can create activity entries" ON public.note_activity_log;
CREATE POLICY "Authenticated users can create activity entries" ON public.note_activity_log
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((SELECT auth.uid()) = user_id));


-- ============================================================
-- Table: public.note_tags
-- ============================================================

-- Authenticated users can create note tags  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "Authenticated users can create note tags" ON public.note_tags;
CREATE POLICY "Authenticated users can create note tags" ON public.note_tags
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((SELECT auth.uid()) = created_by));

-- Users can delete tags they created  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can delete tags they created" ON public.note_tags;
CREATE POLICY "Users can delete tags they created" ON public.note_tags
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((SELECT auth.uid()) = created_by));

-- Users can update tags they created  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can update tags they created" ON public.note_tags;
CREATE POLICY "Users can update tags they created" ON public.note_tags
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (((SELECT auth.uid()) = created_by))
  WITH CHECK (((SELECT auth.uid()) = created_by));


-- ============================================================
-- Table: public.notifications
-- ============================================================

-- notif_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "notif_insert" ON public.notifications;
CREATE POLICY "notif_insert" ON public.notifications
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((is_admin() OR (user_id = (SELECT auth.uid()))));


-- ============================================================
-- Table: public.order_shares
-- ============================================================

-- order_shares_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "order_shares_select" ON public.order_shares;
CREATE POLICY "order_shares_select" ON public.order_shares
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = order_shares.order_id) AND (o.deleted_at IS NULL) AND (is_admin() OR (o.salesman_id = (SELECT auth.uid())))))));


-- ============================================================
-- Table: public.rate_limits
-- ============================================================

-- Users can view own rate limits  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "Users can view own rate limits" ON public.rate_limits;
CREATE POLICY "Users can view own rate limits" ON public.rate_limits
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((SELECT auth.uid()) = user_id));


-- ============================================================
-- Table: public.rup_sales_records
-- ============================================================

-- rup_sales_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "rup_sales_insert" ON public.rup_sales_records;
CREATE POLICY "rup_sales_insert" ON public.rup_sales_records
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- rup_sales_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "rup_sales_select" ON public.rup_sales_records;
CREATE POLICY "rup_sales_select" ON public.rup_sales_records
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = ANY (ARRAY['admin'::text, 'sales_rep'::text])));


-- ============================================================
-- Table: public.team_note_attachments
-- ============================================================

-- Authenticated users can insert own attachments  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "Authenticated users can insert own attachments" ON public.team_note_attachments;
CREATE POLICY "Authenticated users can insert own attachments" ON public.team_note_attachments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((uploaded_by = (SELECT auth.uid())));

-- Users can delete own attachments or admin can delete any  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "Users can delete own attachments or admin can delete any" ON public.team_note_attachments;
CREATE POLICY "Users can delete own attachments or admin can delete any" ON public.team_note_attachments
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((uploaded_by = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text))))));


-- ============================================================
-- Table: public.team_note_comments
-- ============================================================

-- team_note_comments_delete  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "team_note_comments_delete" ON public.team_note_comments;
CREATE POLICY "team_note_comments_delete" ON public.team_note_comments
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((created_by = (SELECT auth.uid())) OR is_admin()));

-- team_note_comments_update  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "team_note_comments_update" ON public.team_note_comments;
CREATE POLICY "team_note_comments_update" ON public.team_note_comments
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (((created_by = (SELECT auth.uid())) OR is_admin()))
  WITH CHECK (((created_by = (SELECT auth.uid())) OR is_admin()));


-- ============================================================
-- Table: public.team_note_tags
-- ============================================================

-- team_note_tags_delete  (DELETE/PERMISSIVE)
DROP POLICY IF EXISTS "team_note_tags_delete" ON public.team_note_tags;
CREATE POLICY "team_note_tags_delete" ON public.team_note_tags
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM team_notes tn
  WHERE ((tn.id = team_note_tags.note_id) AND ((tn.created_by = (SELECT auth.uid())) OR is_admin())))));

-- team_note_tags_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "team_note_tags_insert" ON public.team_note_tags;
CREATE POLICY "team_note_tags_insert" ON public.team_note_tags
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1
   FROM team_notes tn
  WHERE ((tn.id = team_note_tags.note_id) AND ((tn.created_by = (SELECT auth.uid())) OR is_admin())))));


-- ============================================================
-- Table: public.vendor_bills
-- ============================================================

-- vendor_bills_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "vendor_bills_insert" ON public.vendor_bills;
CREATE POLICY "vendor_bills_insert" ON public.vendor_bills
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- vendor_bills_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "vendor_bills_select" ON public.vendor_bills;
CREATE POLICY "vendor_bills_select" ON public.vendor_bills
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (((deleted_at IS NULL) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text)));

-- vendor_bills_update  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "vendor_bills_update" ON public.vendor_bills;
CREATE POLICY "vendor_bills_update" ON public.vendor_bills
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));


-- ============================================================
-- Table: public.vendor_payments
-- ============================================================

-- vendor_payments_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "vendor_payments_insert" ON public.vendor_payments;
CREATE POLICY "vendor_payments_insert" ON public.vendor_payments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- vendor_payments_select  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "vendor_payments_select" ON public.vendor_payments;
CREATE POLICY "vendor_payments_select" ON public.vendor_payments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));


-- ============================================================
-- Table: public.vendors
-- ============================================================

-- vendors_insert  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "vendors_insert" ON public.vendors;
CREATE POLICY "vendors_insert" ON public.vendors
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = ANY (ARRAY['admin'::text, 'sales_rep'::text])));

-- vendors_update  (UPDATE/PERMISSIVE)
DROP POLICY IF EXISTS "vendors_update" ON public.vendors;
CREATE POLICY "vendors_update" ON public.vendors
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = ANY (ARRAY['admin'::text, 'sales_rep'::text])));


-- ============================================================
-- Table: public.write_offs
-- ============================================================

-- write_offs_insert_admin  (INSERT/PERMISSIVE)
DROP POLICY IF EXISTS "write_offs_insert_admin" ON public.write_offs;
CREATE POLICY "write_offs_insert_admin" ON public.write_offs
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- write_offs_select_admin  (SELECT/PERMISSIVE)
DROP POLICY IF EXISTS "write_offs_select_admin" ON public.write_offs;
CREATE POLICY "write_offs_select_admin" ON public.write_offs
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = (SELECT auth.uid()))) = 'admin'::text));

-- ============================================================
-- Verification: assert no flagged Cat1 policies still have unwrapped auth.uid()
-- ============================================================
DO $$
DECLARE
  v_count int;
  v_target int := 55;
  v_table text;
  v_name text;
BEGIN
  -- Count rewritten policies that still contain a raw `auth.uid()` not preceded by `SELECT `.
  -- Using LIKE patterns since Postgres regex doesn't support lookbehind portably.
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (tablename, policyname) IN (

      ('accounting_periods', 'accounting_periods_insert_admin'),
      ('accounting_periods', 'accounting_periods_select_admin'),
      ('accounting_periods', 'accounting_periods_update_admin'),
      ('application_record_fields', 'arf_delete'),
      ('application_record_fields', 'arf_insert'),
      ('application_record_fields', 'arf_select'),
      ('application_record_fields', 'arf_update'),
      ('ar_reminder_tracking', 'ar_reminder_admin_select'),
      ('blend_ticket_images', 'Users can delete images for their tickets or admin can delete a'),
      ('blend_ticket_images', 'Users can insert images for their tickets'),
      ('blend_ticket_products', 'Users can delete products for their tickets or admin can delete'),
      ('blend_ticket_products', 'Users can insert products for their tickets'),
      ('blend_ticket_products', 'Users can update products for their tickets or admin can update'),
      ('blend_tickets', 'Authenticated users can insert blend tickets'),
      ('blend_tickets', 'Users can update their own tickets or admin can update any'),
      ('commission_payment_items', 'commission_payment_items_insert_admin'),
      ('commission_payment_items', 'commission_payment_items_select_admin'),
      ('commission_payments', 'commission_payments_insert_admin'),
      ('commission_payments', 'commission_payments_select_admin'),
      ('commission_payments', 'commission_payments_update_admin'),
      ('email_log', 'email_log_admin_insert'),
      ('email_log', 'email_log_admin_select'),
      ('field_app_location_shares', 'field_app_location_shares_select'),
      ('field_app_locations', 'field_app_locations_select'),
      ('finance_charges', 'finance_charges_insert_admin'),
      ('finance_charges', 'finance_charges_select_admin'),
      ('financial_audit_log', 'financial_audit_insert'),
      ('inventory_holds', 'inventory_holds_delete'),
      ('inventory_holds', 'inventory_holds_insert'),
      ('inventory_holds', 'inventory_holds_update'),
      ('invoice_shares', 'invoice_shares_select'),
      ('note_activity_log', 'Authenticated users can create activity entries'),
      ('note_tags', 'Authenticated users can create note tags'),
      ('note_tags', 'Users can delete tags they created'),
      ('note_tags', 'Users can update tags they created'),
      ('notifications', 'notif_insert'),
      ('order_shares', 'order_shares_select'),
      ('rate_limits', 'Users can view own rate limits'),
      ('rup_sales_records', 'rup_sales_insert'),
      ('rup_sales_records', 'rup_sales_select'),
      ('team_note_attachments', 'Authenticated users can insert own attachments'),
      ('team_note_attachments', 'Users can delete own attachments or admin can delete any'),
      ('team_note_comments', 'team_note_comments_delete'),
      ('team_note_comments', 'team_note_comments_update'),
      ('team_note_tags', 'team_note_tags_delete'),
      ('team_note_tags', 'team_note_tags_insert'),
      ('vendor_bills', 'vendor_bills_insert'),
      ('vendor_bills', 'vendor_bills_select'),
      ('vendor_bills', 'vendor_bills_update'),
      ('vendor_payments', 'vendor_payments_insert'),
      ('vendor_payments', 'vendor_payments_select'),
      ('vendors', 'vendors_insert'),
      ('vendors', 'vendors_update'),
      ('write_offs', 'write_offs_insert_admin'),
      ('write_offs', 'write_offs_select_admin')

    )
    AND (
      (qual LIKE '%auth.uid()%' AND qual NOT LIKE '%(SELECT auth.uid())%' AND qual NOT LIKE '%( SELECT auth.uid()%')
      OR (with_check LIKE '%auth.uid()%' AND with_check NOT LIKE '%(SELECT auth.uid())%' AND with_check NOT LIKE '%( SELECT auth.uid()%')
    );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'perf_auth_rls_initplan migration failed: % policies still have unwrapped auth.uid()', v_count;
  END IF;
  -- Sanity-check that the expected number of policies exist post-migration
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (tablename, policyname) IN (
      ('accounting_periods', 'accounting_periods_insert_admin'),
      ('accounting_periods', 'accounting_periods_select_admin'),
      ('accounting_periods', 'accounting_periods_update_admin'),
      ('application_record_fields', 'arf_delete'),
      ('application_record_fields', 'arf_insert'),
      ('application_record_fields', 'arf_select'),
      ('application_record_fields', 'arf_update'),
      ('ar_reminder_tracking', 'ar_reminder_admin_select'),
      ('blend_ticket_images', 'Users can delete images for their tickets or admin can delete a'),
      ('blend_ticket_images', 'Users can insert images for their tickets'),
      ('blend_ticket_products', 'Users can delete products for their tickets or admin can delete'),
      ('blend_ticket_products', 'Users can insert products for their tickets'),
      ('blend_ticket_products', 'Users can update products for their tickets or admin can update'),
      ('blend_tickets', 'Authenticated users can insert blend tickets'),
      ('blend_tickets', 'Users can update their own tickets or admin can update any'),
      ('commission_payment_items', 'commission_payment_items_insert_admin'),
      ('commission_payment_items', 'commission_payment_items_select_admin'),
      ('commission_payments', 'commission_payments_insert_admin'),
      ('commission_payments', 'commission_payments_select_admin'),
      ('commission_payments', 'commission_payments_update_admin'),
      ('email_log', 'email_log_admin_insert'),
      ('email_log', 'email_log_admin_select'),
      ('field_app_location_shares', 'field_app_location_shares_select'),
      ('field_app_locations', 'field_app_locations_select'),
      ('finance_charges', 'finance_charges_insert_admin'),
      ('finance_charges', 'finance_charges_select_admin'),
      ('financial_audit_log', 'financial_audit_insert'),
      ('inventory_holds', 'inventory_holds_delete'),
      ('inventory_holds', 'inventory_holds_insert'),
      ('inventory_holds', 'inventory_holds_update'),
      ('invoice_shares', 'invoice_shares_select'),
      ('note_activity_log', 'Authenticated users can create activity entries'),
      ('note_tags', 'Authenticated users can create note tags'),
      ('note_tags', 'Users can delete tags they created'),
      ('note_tags', 'Users can update tags they created'),
      ('notifications', 'notif_insert'),
      ('order_shares', 'order_shares_select'),
      ('rate_limits', 'Users can view own rate limits'),
      ('rup_sales_records', 'rup_sales_insert'),
      ('rup_sales_records', 'rup_sales_select'),
      ('team_note_attachments', 'Authenticated users can insert own attachments'),
      ('team_note_attachments', 'Users can delete own attachments or admin can delete any'),
      ('team_note_comments', 'team_note_comments_delete'),
      ('team_note_comments', 'team_note_comments_update'),
      ('team_note_tags', 'team_note_tags_delete'),
      ('team_note_tags', 'team_note_tags_insert'),
      ('vendor_bills', 'vendor_bills_insert'),
      ('vendor_bills', 'vendor_bills_select'),
      ('vendor_bills', 'vendor_bills_update'),
      ('vendor_payments', 'vendor_payments_insert'),
      ('vendor_payments', 'vendor_payments_select'),
      ('vendors', 'vendors_insert'),
      ('vendors', 'vendors_update'),
      ('write_offs', 'write_offs_insert_admin'),
      ('write_offs', 'write_offs_select_admin')
    );
  IF v_count <> v_target THEN
    RAISE EXCEPTION 'perf_auth_rls_initplan: expected % policies, found %', v_target, v_count;
  END IF;
END $$;
