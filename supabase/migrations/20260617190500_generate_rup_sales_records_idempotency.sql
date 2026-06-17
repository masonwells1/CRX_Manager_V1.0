-- idempotency-body-check: exempt
-- Fix (gauntlet LOW-1): generate_rup_sales_records declared p_idempotency_key but NEVER used it —
-- contract drift. The signature advertised idempotency support (post_invoice, its sole caller, may pass
-- a key) while the body ignored it entirely. The function already de-dups RUP rows naturally via the
-- per-(invoice_id, product_id) NOT EXISTS guard, so this was low-severity, but the param being inert
-- violated the canonical "every mutating RPC must accept AND USE p_idempotency_key" rule.
--
-- Fix: wire the canonical operation-scoped check_idempotency()/save_idempotency() helpers WITHOUT
-- touching the signature (param kept; post_invoice's call site is unchanged) and WITHOUT touching the
-- natural per-row de-dup guard (kept verbatim — it remains the real correctness backstop). On a retried
-- call with the same key, the cached rich result is replayed and the integer count returned verbatim.
-- The function RETURNS integer; the helpers traffic in jsonb, so the count is wrapped as
-- jsonb_build_object('count', v_count) on save and unwrapped as (v_existing->>'count')::integer on replay
-- — the public RETURNS integer shape is unchanged.
--
-- GRANTS ARE UNCHANGED. Live grants EXECUTE to service_role and postgres ONLY (NOT authenticated, NOT
-- anon, NOT PUBLIC) — verified against live before writing. This is a SECURITY DEFINER RPC whose sole
-- caller is the gated post_invoice. The REVOKE/GRANT block at the bottom RESTATES that exact posture
-- verbatim so this CREATE OR REPLACE cannot accidentally widen execute access.
--
-- Body reproduced live-verbatim EXCEPT the marked DELTA-IDEM blocks (2 new DECLARE vars, the early
-- replay check, and the build-result/save/return at the end). SET search_path, SECURITY DEFINER, the
-- (uuid, text) signature, and the RETURNS integer shape are all preserved.
-- Source: codex-gauntlet (LEDGER: rup:generate_rup_sales_records:idempotency-param-inert).
-- Rollback: re-apply generate_rup_sales_records with the DELTA-IDEM blocks removed (param stays, unused).

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
  -- DELTA-IDEM BEGIN (gauntlet LOW-1: canonical idempotency — cache/replay the count via the helpers)
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-IDEM END
BEGIN
  -- DELTA-IDEM BEGIN (gauntlet LOW-1: canonical operation-scoped replay — return the cached count verbatim)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_rup_sales_records');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'count')::integer;
    END IF;
  END IF;
  -- DELTA-IDEM END

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

  -- DELTA-IDEM BEGIN (gauntlet LOW-1: cache the real count via the canonical helper, then return it)
  v_result := jsonb_build_object('count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
  -- DELTA-IDEM END
END;
$function$;

-- Restate the EXACT live grant posture so CREATE OR REPLACE cannot widen execute access.
-- Live posture (verified): EXECUTE granted to service_role + postgres ONLY. NOT authenticated/anon/PUBLIC.
REVOKE ALL ON FUNCTION public.generate_rup_sales_records(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_rup_sales_records(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.generate_rup_sales_records(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_rup_sales_records(uuid, text) TO postgres;
