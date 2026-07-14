-- Require an active admin for commission payment reads and writes.
--
-- The 20260511050000 policy rewrite checked profiles.role directly and did
-- not include profiles.is_active. Use the canonical is_admin() helper so a
-- deactivated admin cannot retain access through these policies.

DROP POLICY IF EXISTS "commission_payment_items_insert_admin"
  ON public.commission_payment_items;
CREATE POLICY "commission_payment_items_insert_admin"
  ON public.commission_payment_items
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "commission_payment_items_select_admin"
  ON public.commission_payment_items;
CREATE POLICY "commission_payment_items_select_admin"
  ON public.commission_payment_items
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "commission_payments_insert_admin"
  ON public.commission_payments;
CREATE POLICY "commission_payments_insert_admin"
  ON public.commission_payments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "commission_payments_select_admin"
  ON public.commission_payments;
CREATE POLICY "commission_payments_select_admin"
  ON public.commission_payments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "commission_payments_update_admin"
  ON public.commission_payments;
CREATE POLICY "commission_payments_update_admin"
  ON public.commission_payments
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

DO $$
DECLARE
  v_valid_policy_count integer;
  v_admin_expr_pattern text := '^\s*\(*\s*(SELECT\s+)?(public\.)?is_admin\s*\(\s*\)(\s+AS\s+is_admin)?\s*\)*\s*$';
BEGIN
  SELECT count(*)
    INTO v_valid_policy_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (
       (tablename = 'commission_payment_items' AND policyname IN (
         'commission_payment_items_insert_admin',
         'commission_payment_items_select_admin'
       ))
       OR
       (tablename = 'commission_payments' AND policyname IN (
         'commission_payments_insert_admin',
         'commission_payments_select_admin',
         'commission_payments_update_admin'
       ))
     )
     AND permissive = 'PERMISSIVE'
     AND roles = ARRAY['authenticated'::name]
     AND CASE cmd
           WHEN 'SELECT' THEN coalesce(qual, '') ~* v_admin_expr_pattern
           WHEN 'DELETE' THEN coalesce(qual, '') ~* v_admin_expr_pattern
           WHEN 'INSERT' THEN coalesce(with_check, '') ~* v_admin_expr_pattern
           WHEN 'UPDATE' THEN coalesce(qual, '') ~* v_admin_expr_pattern
                              AND coalesce(with_check, '') ~* v_admin_expr_pattern
           WHEN 'ALL' THEN coalesce(qual, '') ~* v_admin_expr_pattern
                           AND coalesce(with_check, '') ~* v_admin_expr_pattern
           ELSE false
         END;

  IF v_valid_policy_count <> 5 THEN
    RAISE EXCEPTION
      'Expected 5 active-admin commission policies, found %',
      v_valid_policy_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('commission_payment_items', 'commission_payments')
       AND permissive = 'PERMISSIVE'
       AND roles && ARRAY['authenticated'::name, 'public'::name, 'anon'::name]
       AND NOT CASE cmd
                 WHEN 'SELECT' THEN coalesce(qual, '') ~* v_admin_expr_pattern
                 WHEN 'DELETE' THEN coalesce(qual, '') ~* v_admin_expr_pattern
                 WHEN 'INSERT' THEN coalesce(with_check, '') ~* v_admin_expr_pattern
                 WHEN 'UPDATE' THEN coalesce(qual, '') ~* v_admin_expr_pattern
                                    AND coalesce(with_check, '') ~* v_admin_expr_pattern
                 WHEN 'ALL' THEN coalesce(qual, '') ~* v_admin_expr_pattern
                                 AND coalesce(with_check, '') ~* v_admin_expr_pattern
                 ELSE false
               END
  ) THEN
    RAISE EXCEPTION
      'Every permissive commission payment policy available to external callers must use is_admin()';
  END IF;
END;
$$;
