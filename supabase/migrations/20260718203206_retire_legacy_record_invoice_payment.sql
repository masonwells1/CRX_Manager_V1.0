-- The legacy payments-table writer has no compatible reversal. Live proof found
-- zero active legacy rows, so retire future writes and keep allocate_payment as
-- the sole supported, reversible cash-entry path.
-- idempotency-body-check: exempt -- this compatibility stub never mutates.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id uuid, p_amount_cents bigint, p_payment_method text,
  p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'LEGACY_PAYMENT_PATH_DISABLED: record_invoice_payment used an obsolete ledger with no compatible reversal. Use allocate_payment so cash can be safely unapplied through void_payment.';
END;
$function$;
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text) TO service_role;
