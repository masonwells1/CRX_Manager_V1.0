-- Fix latent 42703 in generate_rup_sales_records (found during B5 license-gates review)
-- idempotency-body-check: exempt  (verbatim live body — idempotency is the per-row
-- NOT EXISTS guard; rpcContracts.test.ts already classifies this fn as 'natural')
--
-- The live function filters `al.deleted_at IS NULL`, but applicator_licenses has NO
-- deleted_at column (live-verified 2026-06-10: `SELECT ... WHERE al.deleted_at IS NULL`
-- → ERROR 42703). The branch never fired in prod ONLY because zero products have
-- is_rup = true yet — the moment an RUP product is invoiced, post_invoice (which calls
-- this unguarded) would crash on every posting. Time bomb on the money path.
--
-- ONLY change vs the live body (live definition md5 e5eab6536de508a532d84fc46cb9723a):
--   `AND al.deleted_at IS NULL`  →  `AND al.is_active = true`
-- (is_active is the table's real lifecycle flag; matches the B5 trigger + UI semantics.)
-- Everything else is reproduced verbatim from the live definition, transcribed by hand.

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
BEGIN
  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.created_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id;

  IF v_invoice IS NULL THEN
    RETURN 0;
  END IF;

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

    IF NOT EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id AND product_id = v_item.product_id
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

  RETURN v_count;
END;
$function$;

-- Verification: single overload, the previously-broken license-lookup statement now
-- plans/executes, and the phantom predicate is gone from the deployed body.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'generate_rup_sales_records';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'generate_rup_sales_records overload count is % (expected 1)', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'generate_rup_sales_records'
       AND prosrc LIKE '%deleted_at%'
  ) THEN
    RAISE EXCEPTION 'generate_rup_sales_records still references deleted_at';
  END IF;

  PERFORM 1 FROM applicator_licenses al
   WHERE al.customer_id = '00000000-0000-0000-0000-000000000000'::uuid
     AND al.is_active = true
   ORDER BY al.expiry_date DESC NULLS LAST
   LIMIT 1;
END $$;
