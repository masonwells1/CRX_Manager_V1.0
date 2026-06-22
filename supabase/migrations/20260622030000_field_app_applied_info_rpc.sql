-- 20260622030000_field_app_applied_info_rpc.sql
--
-- OVERNIGHT BUG HUNT cycle 1, finding #2 (HIGH, both adversarial-verifier + Codex confirmed).
-- dedupeKey: field_app:save_field_app_invoice:applied-info-rls-salesrep
--
-- WHAT WAS WRONG
-- src/pages/FieldApplicationInvoice.tsx (an admin+sales_rep page) persists "Applied Info"
-- (wind_direction / temperature_text / applicator_name) with a RAW frontend
--   supabase.from('invoices').update({...}).in('id', ids).select('id')
-- The live RLS policy invoices_update is USING is_admin() ONLY (no sales_rep clause). For a
-- sales_rep that UPDATE matches zero visible rows and returns {error:null, data:[]};
-- checkMutationResult() then throws "no rows were affected", the outer catch shows
-- "Save failed" even though save_field_app_invoice ALREADY created the invoice, and because
-- saveIdem.resetKey() ran and navigate() is skipped, re-saving mints a DUPLICATE invoice.
-- (Admins are unaffected — their UPDATE passes is_admin() RLS.)
--
-- THE FIX
-- A tiny SECURITY DEFINER RPC the page calls INSTEAD of the raw .update(). Running as definer
-- it bypasses the admin-only RLS while re-gating on (is_admin() OR is_sales_rep()) — the same
-- gate save_field_app_invoice already uses — and binding the actor to auth.uid(). It restricts
-- the write to field_application invoices that are still editable (draft/unposted), so it can
-- never touch posted/voided rows or a non-field invoice (segregation-safe). A frontend-only
-- fix is impossible because the RLS policy blocks the sales_rep role at the DB layer.
--
-- This is a NEW function (no overload risk; no existing object changed). The companion
-- frontend change (swap the raw .update for supabase.rpc('update_field_app_applied_info', …))
-- is documented in the overnight REPORT.md and must ship WITH this migration.
--
-- ROLLBACK: DROP FUNCTION public.update_field_app_applied_info(uuid[],text,text,text,uuid,text);

CREATE OR REPLACE FUNCTION public.update_field_app_applied_info(
  p_invoice_ids       uuid[],
  p_wind_direction    text DEFAULT NULL,
  p_temperature_text  text DEFAULT NULL,
  p_applicator_name   text DEFAULT NULL,
  p_performed_by      uuid DEFAULT NULL,
  p_idempotency_key   text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_expected int;
  v_updated  int;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save applied info';
  END IF;

  v_expected := COALESCE(array_length(p_invoice_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'At least one invoice id is required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'update_field_app_applied_info';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Only editable field-application invoices — never a posted/voided row or a non-field invoice.
  UPDATE invoices SET
    wind_direction   = p_wind_direction,
    temperature_text = p_temperature_text,
    applicator_name  = p_applicator_name,
    updated_at       = now()
  WHERE id = ANY(p_invoice_ids)
    AND invoice_type = 'field_application'
    AND status IN ('draft', 'unposted');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'Applied info update affected % of % invoice(s) — some are not editable field-application invoices', v_updated, v_expected;
  END IF;

  v_result := jsonb_build_object('updated', v_updated);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'update_field_app_applied_info', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_field_app_applied_info(uuid[],text,text,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_applied_info(uuid[],text,text,text,uuid,text) TO authenticated;
