-- Migration: role-gate generate_rup_sales_records (N2-4, security quick-win)
-- Date: 2026-07-06  ·  Branch: fix/business-workflow-2026-07
--
-- WHAT / WHY
--   The Night-1 sweep found public.generate_rup_sales_records(uuid,text) is SECURITY
--   DEFINER with search_path set and idempotency, BUT has NO role gate. It only reads
--   auth.uid() inside the INSERT (created_by). Because `authenticated` holds EXECUTE,
--   ANY signed-in user (an applicator or driver) could call it directly and write
--   restricted-use-pesticide sales-register rows. This migration adds the same house
--   gate its real caller uses, so only admin / sales_rep can invoke it.
--
-- GROUNDED LIVE (project rhyzpcqhnizqbxphqdkr, 2026-07-06):
--   * Live body captured verbatim below (also .claude/session-state/live-defs/
--     n24-generate_rup_sales_records.sql). Single overload (uuid,text).
--   * Current EXECUTE grants: authenticated, postgres, service_role (anon NOT granted).
--   * ONLY DB caller: post_invoice — which itself gates
--       role IN ('admin','sales_rep')  ('Not authorized to post invoices').
--     post_invoice is SECURITY DEFINER, so its internal call runs as owner (postgres,
--     which keeps EXECUTE) with auth.uid() = the admin/sales poster — the new gate
--     passes for every legitimate post. No behavior change for the real caller.
--   * No direct frontend .rpc('generate_rup_sales_records') caller — the name appears
--     only in generated types (src/types/supabase.ts) and tests. The two UI surfaces in
--     this domain (InvoiceDetail at /invoices/:id which posts invoices, and the
--     Compliance page /compliance) are both allowedRoles={['admin','sales_rep']} in
--     App.tsx — the gate keeps every legitimate UI path working.
--   * Gate pattern copied from the actual caller post_invoice (admin+sales); this is the
--     correct scope for an RUP-generation write (get_ar_aging is admin-only, but that is
--     a narrower AR-report; RUP generation is coupled to invoice posting = admin+sales).

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  v_invoice record;
  v_item record;
  v_license record;
  v_compliance_status text;
  v_compliance_notes text;
  v_season integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  -- N2-4 role gate (matches the sole caller post_invoice): block applicators/drivers.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to generate RUP sales records';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_rup_sales_records');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'count')::integer;
    END IF;
  END IF;

  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.created_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id;

  IF v_invoice IS NULL THEN RETURN 0; END IF;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_invoice.created_at) >= 10
    THEN EXTRACT(YEAR FROM v_invoice.created_at)::integer + 1
    ELSE EXTRACT(YEAR FROM v_invoice.created_at)::integer
  END;

  FOR v_item IN
    SELECT ii.id, ii.product_id, p.product_name, ii.quantity, ii.unit_size,
           ii.unit_price_cents, ii.extended_cents,
           p.epa_registration, p.signal_word
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND p.is_rup = true
  LOOP
    SELECT al.license_number, al.license_type, al.expiry_date
    INTO v_license
    FROM applicator_licenses al
    WHERE al.customer_id = v_invoice.customer_id
      AND al.is_active = true
    ORDER BY al.expiry_date DESC NULLS LAST
    LIMIT 1;

    IF v_license IS NULL OR v_license.license_number IS NULL THEN
      v_compliance_status := 'non_compliant';
      v_compliance_notes := 'No applicator license on file for this customer';
    ELSIF v_license.expiry_date IS NOT NULL AND v_license.expiry_date < CURRENT_DATE THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;
    ELSE
      v_compliance_status := 'compliant';
      v_compliance_notes := NULL;
    END IF;

    -- PARKED-006: dedup ignores voided rows so a legitimate re-post can record
    -- a fresh active sale even when a prior voided row exists.
    IF NOT EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id
        AND product_id = v_item.product_id
        AND voided_at IS NULL
    ) THEN
      INSERT INTO rup_sales_records (
        invoice_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by
      ) VALUES (
        p_invoice_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        CURRENT_DATE, v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit_size,
        v_item.unit_price_cents, v_item.extended_cents,
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid()
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  v_result := jsonb_build_object('count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
END;
$function$;

-- Lock down EXECUTE (defense-in-depth on top of the in-body gate).
-- Caller analysis (2026-07-06): no direct frontend .rpc() caller; only DB caller is
-- post_invoice, which runs SECDEF-as-owner (postgres retains EXECUTE) so it is
-- unaffected. UI surfaces (InvoiceDetail, Compliance) are admin/sales_rep only.
REVOKE EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) TO service_role;

-- Verification -------------------------------------------------------------------------
DO $$
BEGIN
  -- exactly one overload
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'generate_rup_sales_records'
        AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: generate_rup_sales_records overload count <> 1';
  END IF;

  -- anon has no EXECUTE
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'generate_rup_sales_records'
      AND grantee = 'anon' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: anon still has EXECUTE on generate_rup_sales_records';
  END IF;

  -- gate present in the body (prosrc check — NOT the banned catalog-def function)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'generate_rup_sales_records' AND pronamespace = 'public'::regnamespace
      AND prosrc LIKE '%Not authorized to generate RUP sales records%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: role gate not present in generate_rup_sales_records body';
  END IF;
END $$;

COMMIT;
