-- ============================================================================
-- Phase 3 #9c + #9d — Tighten SELECT RLS on blend_ticket_fields + field_crop_history
-- ============================================================================
-- Audit findings (Phase 0 verification, 2026-05-11):
--   #9c: blend_ticket_fields_select USING (true) — wide open for reads.
--        WRITE side properly gated to uploader/admin/sales_rep.
--   #9d: "Authenticated users can read crop history" USING (true) on
--        field_crop_history — wide open for reads. WRITE side properly gated
--        to admin/sales_rep.
--
-- Scope (#9c): match the SELECT policy to the existing INSERT/UPDATE EXISTS
--   pattern — admins, sales reps, and the original uploader of the parent
--   blend_ticket can read its fields. Drivers don't need this data.
--
-- Scope (#9d): tighten to admin/sales_rep/applicator. Applicators are
--   included because the field-application workflow needs crop-history
--   context to make rate decisions. Drivers don't need crop history.
--
-- Both predicates use (SELECT auth.uid()) per the PR #61 initplan pattern.
-- ============================================================================

-- ─── #9c: blend_ticket_fields_select ─────────────────────────────────────

DROP POLICY IF EXISTS blend_ticket_fields_select ON public.blend_ticket_fields;

CREATE POLICY blend_ticket_fields_select ON public.blend_ticket_fields
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM blend_tickets bt
      WHERE bt.id = blend_ticket_fields.blend_ticket_id
        AND (
          bt.uploaded_by = (SELECT auth.uid())
          OR is_admin()
          OR is_sales_rep()
        )
    )
  );

COMMENT ON POLICY blend_ticket_fields_select ON public.blend_ticket_fields IS
  'Phase 3 #9c — SELECT now matches INSERT/UPDATE: uploader, admin, or sales_rep. Was USING (true).';

-- ─── #9d: field_crop_history SELECT ──────────────────────────────────────

DROP POLICY IF EXISTS "Authenticated users can read crop history" ON public.field_crop_history;

CREATE POLICY field_crop_history_select ON public.field_crop_history
  FOR SELECT
  USING (
    is_admin() OR is_sales_rep() OR is_applicator()
  );

COMMENT ON POLICY field_crop_history_select ON public.field_crop_history IS
  'Phase 3 #9d — SELECT tightened to admin/sales_rep/applicator. Was "Authenticated users can read crop history" USING (true). Applicators need crop history for rate decisions; drivers do not.';

-- ─── Verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_btf_qual text;
  v_fch_qual text;
  v_fch_old_policy_exists boolean;
BEGIN
  -- blend_ticket_fields_select now has the EXISTS predicate, not just `true`
  SELECT qual::text INTO v_btf_qual
  FROM pg_policies
  WHERE tablename = 'blend_ticket_fields' AND policyname = 'blend_ticket_fields_select';
  IF v_btf_qual IS NULL OR v_btf_qual = 'true' THEN
    RAISE EXCEPTION 'phase-3-9c verification: blend_ticket_fields_select still permissive (qual=%)', v_btf_qual;
  END IF;
  IF v_btf_qual NOT LIKE '%blend_tickets%' THEN
    RAISE EXCEPTION 'phase-3-9c verification: blend_ticket_fields_select predicate missing parent join — got: %', v_btf_qual;
  END IF;

  -- Old "Authenticated users can read crop history" policy is gone
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'field_crop_history'
      AND policyname = 'Authenticated users can read crop history'
  ) INTO v_fch_old_policy_exists;
  IF v_fch_old_policy_exists THEN
    RAISE EXCEPTION 'phase-3-9d verification: old permissive policy still present';
  END IF;

  -- New field_crop_history_select policy exists and gates by role
  SELECT qual::text INTO v_fch_qual
  FROM pg_policies
  WHERE tablename = 'field_crop_history' AND policyname = 'field_crop_history_select';
  IF v_fch_qual IS NULL OR v_fch_qual = 'true' THEN
    RAISE EXCEPTION 'phase-3-9d verification: field_crop_history_select missing or still permissive (qual=%)', v_fch_qual;
  END IF;

  RAISE NOTICE 'phase-3-9c + 9d verification passed: blend_ticket_fields + field_crop_history SELECT tightened.';
END;
$$;
