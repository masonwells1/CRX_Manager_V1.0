-- Canonicalize bulk-import identity boundary whitespace at the public RPC
-- boundary before the deterministic inner implementation hashes or stores it.
-- JavaScript String.prototype.trim() and this explicit PostgreSQL character
-- set therefore produce the same vendor/reference identity for retries.

DO $guard$
BEGIN
  IF to_regprocedure('public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Expected save_purchase_order(uuid,jsonb,jsonb,uuid,text)';
  END IF;
  IF to_regprocedure(
       'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Expected _save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_payload jsonb := COALESCE(p_po_payload, '{}'::jsonb);
  v_bulk_intent_key text := NULLIF(btrim(v_payload->>'bulk_import_intent_key'), '');
  v_vendor text := v_payload->>'vendor';
  v_vendor_reference text := v_payload->>'bulk_import_vendor_reference';
  -- ECMAScript WhiteSpace and LineTerminator code points used by trim(). Keep
  -- this list explicit so collation and regex locale cannot alter identity.
  v_identity_boundary_chars text :=
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
      || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
      || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
      || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
      || chr(12288) || chr(65279);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    v_vendor := btrim(v_vendor, v_identity_boundary_chars);
    v_vendor_reference := btrim(v_vendor_reference, v_identity_boundary_chars);

    IF NULLIF(v_vendor, '') IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REQUIRED';
    END IF;
    IF NULLIF(v_vendor_reference, '') IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REFERENCE_REQUIRED';
    END IF;

    v_payload := jsonb_set(
      jsonb_set(v_payload, '{vendor}', to_jsonb(v_vendor), true),
      '{bulk_import_vendor_reference}',
      to_jsonb(v_vendor_reference),
      true
    );
  END IF;

  RETURN public._save_purchase_order_ascii_identity_impl(
    p_po_id,
    v_payload,
    p_items,
    p_performed_by,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
)
TO authenticated, service_role;

COMMENT ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
) IS 'Saves a purchase order; bulk-import vendor identity is ECMAScript-trimmed before deterministic ASCII-folded hashing, replay, and storage.';

DO $verify$
DECLARE
  v_save_source text;
  v_save_config text[];
  v_save_security_definer boolean;
  v_overloads integer;
  v_codepoint integer;
BEGIN
  SELECT prosrc, proconfig, prosecdef
    INTO v_save_source, v_save_config, v_save_security_definer
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  SELECT count(*)
    INTO v_overloads
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'save_purchase_order';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one save_purchase_order overload, found %', v_overloads;
  END IF;
  IF NOT v_save_security_definer
     OR v_save_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'save_purchase_order security or search_path is incorrect';
  END IF;

  FOREACH v_codepoint IN ARRAY ARRAY[
    9, 10, 11, 12, 13, 32, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279
  ]
  LOOP
    IF v_save_source NOT LIKE '%chr(' || v_codepoint::text || ')%' THEN
      RAISE EXCEPTION 'save_purchase_order is missing identity trim code point %', v_codepoint;
    END IF;
  END LOOP;

  IF v_save_source NOT LIKE '%v_vendor := btrim(v_vendor, v_identity_boundary_chars)%'
     OR v_save_source NOT LIKE '%v_vendor_reference := btrim(v_vendor_reference, v_identity_boundary_chars)%'
     OR v_save_source NOT LIKE '%jsonb_set(v_payload, ''{vendor}''%'
     OR v_save_source NOT LIKE '%''{bulk_import_vendor_reference}''%'
     OR v_save_source NOT LIKE '%_save_purchase_order_ascii_identity_impl%'
     OR strpos(v_save_source, 'IF NOT (public.is_admin() OR public.is_sales_rep())')
        > strpos(v_save_source, 'v_vendor := btrim(v_vendor, v_identity_boundary_chars)')
     OR strpos(v_save_source, 'v_payload := jsonb_set(')
        > strpos(v_save_source, 'RETURN public._save_purchase_order_ascii_identity_impl') THEN
    RAISE EXCEPTION 'Bulk PO identity canonicalization or authorization ordering is incorrect';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Purchase-order identity wrapper grants are incorrect';
  END IF;
END
$verify$;
