-- Migration: perf_consolidate_permissive_policies
-- Source: Supabase performance advisor multiple_permissive_policies (33 WARN → 23 unique
--         (table, role, action) overlap groups across 16 tables).
--
-- Goal: replace each overlap group with a single permissive policy whose predicate is
--       the OR of the original predicates. Each rewrite preserves the UNION of access.
--
-- Also wraps auth.uid() in (SELECT auth.uid()) so the 8 leftover auth_rls_initplan
-- findings from Migration 1 are resolved in the same pass.
--
-- Sensitive-table change: rate_limit_log gets an additional RESTRICTIVE policy as
-- defense-in-depth (per user decision). The existing permissive `false` deny-all
-- was a no-op (admin SELECT was granted by the OTHER permissive policy anyway).
-- After: admin SELECT still works; non-admins are blocked by both permissive grant
-- absence AND the new restrictive policy.

-- ============================================================
-- Group 1: application_services SELECT
-- Was: application_services_admin_all (FOR ALL, admin) + application_services_select (SELECT, true)
-- Fix: split admin_all into action-specific policies for INSERT/UPDATE/DELETE only.
--      Keep _select unchanged (qual=true). No SELECT overlap remains.
-- Access preserved: admin still has full access; authenticated still has SELECT.
-- ============================================================
DROP POLICY IF EXISTS "application_services_admin_all" ON public.application_services;
CREATE POLICY "application_services_admin_insert" ON public.application_services
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "application_services_admin_update" ON public.application_services
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "application_services_admin_delete" ON public.application_services
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

-- ============================================================
-- Group 2: commissions SELECT
-- Was: comm_select (admin OR (sales_rep AND match by full_name)) + comm_rep_select (sales_rep AND (recipient_user_id=auth.uid OR (recipient_user_id IS NULL AND match by full_name)))
-- Fix: merge into single SELECT policy. The "match by full_name" subsumes the
--      "recipient_user_id IS NULL AND match by full_name" path, so the merged
--      predicate is: admin OR (sales_rep AND (match-by-full-name OR recipient_user_id = auth.uid)).
-- ============================================================
DROP POLICY IF EXISTS "comm_rep_select" ON public.commissions;
DROP POLICY IF EXISTS "comm_select" ON public.commissions;
CREATE POLICY "comm_select" ON public.commissions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((
    is_admin()
    OR (is_sales_rep() AND (
      (recipient_user_id = (SELECT auth.uid()))
      OR (EXISTS (
        SELECT 1 FROM profiles p
        WHERE ((p.id = (SELECT auth.uid())) AND (commissions.recipient = p.full_name))
      ))
    ))
  ));

-- ============================================================
-- Group 3: customer_application_rates SELECT
-- Was: car_admin_all (FOR ALL, admin) + car_select (SELECT, true)
-- Fix: same shape as Group 1.
-- ============================================================
DROP POLICY IF EXISTS "car_admin_all" ON public.customer_application_rates;
CREATE POLICY "car_admin_insert" ON public.customer_application_rates
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "car_admin_update" ON public.customer_application_rates
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "car_admin_delete" ON public.customer_application_rates
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

-- ============================================================
-- deliveries: UPDATE (Group 4) + INSERT (Group 5)
-- Was: del_update (admin OR sales_rep) + del_driver_signature_only (driver own delivery, status in_progress/completed)
--      del_insert (public, admin OR (sales_rep AND created_by=auth.uid)) + del_rep_insert (authenticated, sales_rep)
-- Fix: merge each action into a single permissive policy preserving the union.
-- ============================================================
DROP POLICY IF EXISTS "del_driver_signature_only" ON public.deliveries;
DROP POLICY IF EXISTS "del_update" ON public.deliveries;
CREATE POLICY "del_update" ON public.deliveries
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((
    is_admin() OR is_sales_rep()
    OR ((assigned_driver = (SELECT auth.uid())) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text])))
  ))
  WITH CHECK ((
    is_admin() OR is_sales_rep()
    OR ((assigned_driver = (SELECT auth.uid())) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text])))
  ));

DROP POLICY IF EXISTS "del_insert" ON public.deliveries;
DROP POLICY IF EXISTS "del_rep_insert" ON public.deliveries;
CREATE POLICY "del_insert" ON public.deliveries
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()));

-- ============================================================
-- delivery_items: DELETE (Group 6) + INSERT (Group 7)
-- ============================================================
DROP POLICY IF EXISTS "del_items_delete" ON public.delivery_items;
DROP POLICY IF EXISTS "del_items_rep_delete" ON public.delivery_items;
CREATE POLICY "del_items_delete" ON public.delivery_items
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_admin() OR is_sales_rep()));

DROP POLICY IF EXISTS "del_items_insert" ON public.delivery_items;
DROP POLICY IF EXISTS "del_items_rep_insert" ON public.delivery_items;
CREATE POLICY "del_items_insert" ON public.delivery_items
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()));

-- ============================================================
-- delivery_photos: 3-way overlap on INSERT (Group 8) and SELECT (Group 9)
-- Was: del_photos_admin_all (FOR ALL, admin) +
--      del_photos_driver_insert/select (driver assigned to delivery) +
--      del_photos_rep_insert/select (sales_rep)
-- Fix: drop _admin_all, create action-specific policies merging admin + driver + rep
--      for INSERT/SELECT; admin-only for UPDATE/DELETE (no role-specific overlap on those).
-- ============================================================
DROP POLICY IF EXISTS "del_photos_admin_all" ON public.delivery_photos;
DROP POLICY IF EXISTS "del_photos_driver_insert" ON public.delivery_photos;
DROP POLICY IF EXISTS "del_photos_rep_insert" ON public.delivery_photos;
DROP POLICY IF EXISTS "del_photos_driver_select" ON public.delivery_photos;
DROP POLICY IF EXISTS "del_photos_rep_select" ON public.delivery_photos;

CREATE POLICY "del_photos_insert" ON public.delivery_photos
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((
    is_admin()
    OR is_sales_rep()
    OR (
      (EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'driver'::text))))
      AND (EXISTS (SELECT 1 FROM deliveries d WHERE ((d.id = delivery_photos.delivery_id) AND (d.assigned_driver = (SELECT auth.uid())))))
    )
  ));

CREATE POLICY "del_photos_select" ON public.delivery_photos
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((
    is_admin()
    OR is_sales_rep()
    OR (EXISTS (SELECT 1 FROM deliveries d WHERE ((d.id = delivery_photos.delivery_id) AND (d.assigned_driver = (SELECT auth.uid())))))
  ));

CREATE POLICY "del_photos_update" ON public.delivery_photos
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_admin()))
  WITH CHECK ((is_admin()));

CREATE POLICY "del_photos_delete" ON public.delivery_photos
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_admin()));

-- ============================================================
-- delivery_remainders: SELECT (Group 10) + INSERT (Group 11) + UPDATE (Group 12)
-- Was: del_rem_admin_all (FOR ALL, admin) +
--      del_rem_driver_select (driver) + del_rem_rep_select (sales_rep) +
--      del_rem_rep_insert (sales_rep) + del_rem_rep_update (sales_rep)
-- ============================================================
DROP POLICY IF EXISTS "del_rem_admin_all" ON public.delivery_remainders;
DROP POLICY IF EXISTS "del_rem_driver_select" ON public.delivery_remainders;
DROP POLICY IF EXISTS "del_rem_rep_select" ON public.delivery_remainders;
DROP POLICY IF EXISTS "del_rem_rep_insert" ON public.delivery_remainders;
DROP POLICY IF EXISTS "del_rem_rep_update" ON public.delivery_remainders;

CREATE POLICY "del_rem_select" ON public.delivery_remainders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((
    is_admin()
    OR is_sales_rep()
    OR (EXISTS (SELECT 1 FROM deliveries d WHERE ((d.id = delivery_remainders.original_delivery_id) AND (d.assigned_driver = (SELECT auth.uid())))))
  ));

CREATE POLICY "del_rem_insert" ON public.delivery_remainders
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()));

CREATE POLICY "del_rem_update" ON public.delivery_remainders
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_admin() OR is_sales_rep()))
  WITH CHECK ((is_admin() OR is_sales_rep()));

CREATE POLICY "del_rem_delete" ON public.delivery_remainders
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_admin()));

-- ============================================================
-- Group 13: document_processing_log SELECT
-- Was: 'Admins can view all processing logs' (admin) + 'Users can view own processing logs' (user_id=auth.uid)
-- Fix: merge into one SELECT policy.
-- ============================================================
DROP POLICY IF EXISTS "Admins can view all processing logs" ON public.document_processing_log;
DROP POLICY IF EXISTS "Users can view own processing logs" ON public.document_processing_log;
CREATE POLICY "document_processing_log_select" ON public.document_processing_log
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((
    (user_id = (SELECT auth.uid()))
    OR (EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text))))
  ));

-- ============================================================
-- Group 14: failed_notifications SELECT
-- Was: 'Admins can manage failed notifications' (FOR ALL, admin) + 'Admins can view failed notifications' (SELECT, admin)
-- Both check admin; the SELECT one is redundant since FOR ALL covers SELECT.
-- Fix: drop the redundant SELECT-only policy. Keep the FOR ALL.
-- ============================================================
DROP POLICY IF EXISTS "Admins can view failed notifications" ON public.failed_notifications;
-- Rewrite the surviving FOR ALL policy with wrapped auth.uid().
DROP POLICY IF EXISTS "Admins can manage failed notifications" ON public.failed_notifications;
CREATE POLICY "Admins can manage failed notifications" ON public.failed_notifications
  AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

-- ============================================================
-- Group 15: purchase_order_items SELECT
-- ============================================================
DROP POLICY IF EXISTS "po_items_select" ON public.purchase_order_items;
DROP POLICY IF EXISTS "po_items_rep_select" ON public.purchase_order_items;
CREATE POLICY "po_items_select" ON public.purchase_order_items
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR is_sales_rep()));

-- ============================================================
-- Group 16: purchase_orders SELECT
-- ============================================================
DROP POLICY IF EXISTS "po_select" ON public.purchase_orders;
DROP POLICY IF EXISTS "po_rep_select" ON public.purchase_orders;
CREATE POLICY "po_select" ON public.purchase_orders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR is_sales_rep()));

-- ============================================================
-- Group 17: quote_pdf_templates SELECT (Pattern B — admin_all FOR ALL + true SELECT)
-- ============================================================
DROP POLICY IF EXISTS "Admins can manage pdf templates" ON public.quote_pdf_templates;
CREATE POLICY "quote_pdf_templates_admin_insert" ON public.quote_pdf_templates
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "quote_pdf_templates_admin_update" ON public.quote_pdf_templates
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
CREATE POLICY "quote_pdf_templates_admin_delete" ON public.quote_pdf_templates
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

-- ============================================================
-- Group 18: quote_templates SELECT (Pattern B — admin+sales_all FOR ALL + true SELECT)
-- ============================================================
DROP POLICY IF EXISTS "Admin and sales can manage templates" ON public.quote_templates;
CREATE POLICY "quote_templates_admin_sales_insert" ON public.quote_templates
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))));
CREATE POLICY "quote_templates_admin_sales_update" ON public.quote_templates
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))))
  WITH CHECK ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))));
CREATE POLICY "quote_templates_admin_sales_delete" ON public.quote_templates
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((EXISTS (SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text]))))));

-- ============================================================
-- Group 19: rate_limit_log — sensitive table, gets RESTRICTIVE defense-in-depth
-- Was: 'Deny all direct access to rate_limit_log' (permissive false, no-op) +
--      'rate_limit_log_select_admin' (permissive admin SELECT)
-- The deny-all permissive false adds nothing — permissive policies OR together,
-- so the access was already "admin can SELECT, nobody can write directly."
-- Fix: drop the no-op deny-all. Keep the permissive admin SELECT (the actual grant).
--      Add a RESTRICTIVE FOR ALL admin policy so any future permissive policy
--      added by mistake would still be blocked for non-admins.
-- ============================================================
DROP POLICY IF EXISTS "Deny all direct access to rate_limit_log" ON public.rate_limit_log;
DROP POLICY IF EXISTS "rate_limit_log_select_admin" ON public.rate_limit_log;
CREATE POLICY "rate_limit_log_select_admin" ON public.rate_limit_log
  AS PERMISSIVE FOR SELECT TO public
  USING (is_admin());
CREATE POLICY "rate_limit_log_restrictive_admin_only" ON public.rate_limit_log
  AS RESTRICTIVE FOR ALL TO public
  USING (is_admin())
  WITH CHECK (is_admin());

-- ============================================================
-- receiving_photos: INSERT (Group 20) + SELECT (Group 21)
-- ============================================================
DROP POLICY IF EXISTS "recv_photos_admin_all" ON public.receiving_photos;
DROP POLICY IF EXISTS "recv_photos_rep_insert" ON public.receiving_photos;
DROP POLICY IF EXISTS "recv_photos_rep_select" ON public.receiving_photos;

CREATE POLICY "recv_photos_select" ON public.receiving_photos
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR is_sales_rep()));
CREATE POLICY "recv_photos_insert" ON public.receiving_photos
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()));
CREATE POLICY "recv_photos_update" ON public.receiving_photos
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_admin()))
  WITH CHECK ((is_admin()));
CREATE POLICY "recv_photos_delete" ON public.receiving_photos
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_admin()));

-- ============================================================
-- receiving_records: INSERT (Group 22) + SELECT (Group 23)
-- ============================================================
DROP POLICY IF EXISTS "recv_records_admin_all" ON public.receiving_records;
DROP POLICY IF EXISTS "recv_records_rep_insert" ON public.receiving_records;
DROP POLICY IF EXISTS "recv_records_rep_select" ON public.receiving_records;

CREATE POLICY "recv_records_select" ON public.receiving_records
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_admin() OR is_sales_rep()));
CREATE POLICY "recv_records_insert" ON public.receiving_records
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()));
CREATE POLICY "recv_records_update" ON public.receiving_records
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_admin()))
  WITH CHECK ((is_admin()));
CREATE POLICY "recv_records_delete" ON public.receiving_records
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_admin()));

-- ============================================================
-- Verification
-- ============================================================
DO $$
DECLARE
  v_count int;
BEGIN
  -- 1) Verify dropped policies are gone
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (tablename, policyname) IN (
      ('application_services', 'application_services_admin_all'),
      ('commissions', 'comm_rep_select'),
      ('customer_application_rates', 'car_admin_all'),
      ('deliveries', 'del_driver_signature_only'),
      ('deliveries', 'del_rep_insert'),
      ('delivery_items', 'del_items_rep_delete'),
      ('delivery_items', 'del_items_rep_insert'),
      ('delivery_photos', 'del_photos_admin_all'),
      ('delivery_photos', 'del_photos_driver_insert'),
      ('delivery_photos', 'del_photos_rep_insert'),
      ('delivery_photos', 'del_photos_driver_select'),
      ('delivery_photos', 'del_photos_rep_select'),
      ('delivery_remainders', 'del_rem_admin_all'),
      ('delivery_remainders', 'del_rem_driver_select'),
      ('delivery_remainders', 'del_rem_rep_select'),
      ('delivery_remainders', 'del_rem_rep_insert'),
      ('delivery_remainders', 'del_rem_rep_update'),
      ('document_processing_log', 'Admins can view all processing logs'),
      ('document_processing_log', 'Users can view own processing logs'),
      ('failed_notifications', 'Admins can view failed notifications'),
      ('purchase_order_items', 'po_items_rep_select'),
      ('purchase_orders', 'po_rep_select'),
      ('quote_pdf_templates', 'Admins can manage pdf templates'),
      ('quote_templates', 'Admin and sales can manage templates'),
      ('rate_limit_log', 'Deny all direct access to rate_limit_log'),
      ('receiving_photos', 'recv_photos_admin_all'),
      ('receiving_photos', 'recv_photos_rep_insert'),
      ('receiving_photos', 'recv_photos_rep_select'),
      ('receiving_records', 'recv_records_admin_all'),
      ('receiving_records', 'recv_records_rep_insert'),
      ('receiving_records', 'recv_records_rep_select')
    );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'perf_consolidate_permissive_policies: % old policies were not dropped', v_count;
  END IF;

  -- 2) Verify new consolidated policies exist
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (tablename, policyname) IN (
      ('application_services', 'application_services_admin_insert'),
      ('application_services', 'application_services_admin_update'),
      ('application_services', 'application_services_admin_delete'),
      ('commissions', 'comm_select'),
      ('customer_application_rates', 'car_admin_insert'),
      ('customer_application_rates', 'car_admin_update'),
      ('customer_application_rates', 'car_admin_delete'),
      ('deliveries', 'del_update'),
      ('deliveries', 'del_insert'),
      ('delivery_items', 'del_items_delete'),
      ('delivery_items', 'del_items_insert'),
      ('delivery_photos', 'del_photos_insert'),
      ('delivery_photos', 'del_photos_select'),
      ('delivery_photos', 'del_photos_update'),
      ('delivery_photos', 'del_photos_delete'),
      ('delivery_remainders', 'del_rem_select'),
      ('delivery_remainders', 'del_rem_insert'),
      ('delivery_remainders', 'del_rem_update'),
      ('delivery_remainders', 'del_rem_delete'),
      ('document_processing_log', 'document_processing_log_select'),
      ('failed_notifications', 'Admins can manage failed notifications'),
      ('purchase_order_items', 'po_items_select'),
      ('purchase_orders', 'po_select'),
      ('quote_pdf_templates', 'quote_pdf_templates_admin_insert'),
      ('quote_pdf_templates', 'quote_pdf_templates_admin_update'),
      ('quote_pdf_templates', 'quote_pdf_templates_admin_delete'),
      ('quote_templates', 'quote_templates_admin_sales_insert'),
      ('quote_templates', 'quote_templates_admin_sales_update'),
      ('quote_templates', 'quote_templates_admin_sales_delete'),
      ('rate_limit_log', 'rate_limit_log_select_admin'),
      ('rate_limit_log', 'rate_limit_log_restrictive_admin_only'),
      ('receiving_photos', 'recv_photos_select'),
      ('receiving_photos', 'recv_photos_insert'),
      ('receiving_photos', 'recv_photos_update'),
      ('receiving_photos', 'recv_photos_delete'),
      ('receiving_records', 'recv_records_select'),
      ('receiving_records', 'recv_records_insert'),
      ('receiving_records', 'recv_records_update'),
      ('receiving_records', 'recv_records_delete')
    );
  IF v_count <> 39 THEN
    RAISE EXCEPTION 'perf_consolidate_permissive_policies: expected 39 new policies, found %', v_count;
  END IF;

  -- 3) Verify the RESTRICTIVE policy exists on rate_limit_log
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rate_limit_log'
      AND policyname = 'rate_limit_log_restrictive_admin_only'
      AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'perf_consolidate_permissive_policies: rate_limit_log_restrictive_admin_only is not RESTRICTIVE';
  END IF;
END $$;
