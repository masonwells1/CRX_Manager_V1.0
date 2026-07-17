-- A deferred constraint trigger fires after the SECURITY DEFINER
-- save_purchase_order() wrapper has returned. Its own function therefore needs
-- SECURITY DEFINER to inspect the RPC-owned, deny-all-RLS intent table when the
-- caller is authenticated.

CREATE OR REPLACE FUNCTION public._require_bulk_po_content_fingerprint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.purchase_order_import_intents
     WHERE id = NEW.id
       AND content_fingerprint IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'BULK_PO_CONTENT_FINGERPRINT_REQUIRED';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._require_bulk_po_content_fingerprint()
  FROM PUBLIC, anon, authenticated, service_role;

DO $verify$
DECLARE
  v_is_security_definer boolean;
  v_config text[];
  v_trigger_is_deferred boolean;
BEGIN
  SELECT p.prosecdef, p.proconfig
    INTO v_is_security_definer, v_config
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_require_bulk_po_content_fingerprint'
     AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_is_security_definer IS DISTINCT FROM true
     OR NOT ('search_path=public, pg_temp' = ANY (COALESCE(v_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'Bulk PO fingerprint trigger function security boundary is invalid';
  END IF;

  SELECT t.tgdeferrable AND t.tginitdeferred
    INTO v_trigger_is_deferred
    FROM pg_trigger AS t
   WHERE t.tgrelid = 'public.purchase_order_import_intents'::regclass
     AND t.tgname = 'require_bulk_po_content_fingerprint'
     AND NOT t.tgisinternal;

  IF v_trigger_is_deferred IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Bulk PO fingerprint constraint trigger is missing or not initially deferred';
  END IF;

  IF has_function_privilege('anon', 'public._require_bulk_po_content_fingerprint()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._require_bulk_po_content_fingerprint()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._require_bulk_po_content_fingerprint()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Bulk PO fingerprint trigger function is directly executable';
  END IF;
END;
$verify$;
