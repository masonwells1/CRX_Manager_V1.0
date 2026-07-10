-- Finding #105: count committed unposted spray-job invoices in credit exposure.
-- Sole function-body change: add 'unposted' to the invoice status filter.

CREATE OR REPLACE FUNCTION public.check_customer_credit_limit(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit_limit_cents bigint;
  v_farm_name text;
  v_outstanding_ar_cents bigint;
BEGIN
  -- Get customer info
  SELECT credit_limit_cents, farm_name
  INTO v_credit_limit_cents, v_farm_name
  FROM customers
  WHERE id = p_customer_id;

  IF v_credit_limit_cents IS NULL OR v_credit_limit_cents <= 0 THEN
    RETURN jsonb_build_object(
      'exceeded', false,
      'credit_limit', 0,
      'outstanding_ar', 0,
      'farm_name', COALESCE(v_farm_name, '')
    );
  END IF;

  SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0)
  INTO v_outstanding_ar_cents
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue', 'unposted')
    AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'exceeded', v_outstanding_ar_cents > v_credit_limit_cents,
    'credit_limit', v_credit_limit_cents / 100.0,
    'outstanding_ar', v_outstanding_ar_cents / 100.0,
    'available_credit', GREATEST(v_credit_limit_cents - v_outstanding_ar_cents, 0) / 100.0,
    'farm_name', COALESCE(v_farm_name, '')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_customer_credit_limit(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.check_customer_credit_limit(uuid) TO authenticated;
