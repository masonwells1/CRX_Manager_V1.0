-- Make PostgreSQL the sole authority for durable bulk-PO document identity.
-- The browser still supplies a bulk-import marker and its own per-user retry
-- key, but no browser-computed Unicode digest is trusted or compared. This
-- removes cross-runtime Unicode case-fold parity from the correctness path.

DO $guard$
DECLARE
  v_identity_source text;
BEGIN
  SELECT prosrc INTO v_identity_source
    FROM pg_proc
   WHERE oid = 'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  IF v_identity_source NOT LIKE '%normalize(%lower(%normalize(%v_requested_vendor%NFKC%'
     OR v_identity_source NOT LIKE '%BULK_PO_INTENT_IDENTITY_MISMATCH%' THEN
    RAISE EXCEPTION 'Unexpected pre-migration bulk-PO identity implementation';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._save_purchase_order_ascii_identity_impl(
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
  v_result jsonb;
  v_po_number text;
  v_bulk_import_requested boolean :=
    NULLIF(btrim(v_payload->>'bulk_import_intent_key'), '') IS NOT NULL
    OR v_payload->>'bulk_import_document' = 'true';
  v_bulk_intent_key text;
  v_requested_vendor text := NULLIF(btrim(v_payload->>'vendor'), '');
  v_vendor_reference text := NULLIF(btrim(v_payload->>'bulk_import_vendor_reference'), '');
  v_invoice_date text := NULLIF(btrim(v_payload->>'bulk_import_invoice_date'), '');
  v_identity_vendor text;
  v_identity_vendor_reference text;
  v_expected_intent_key text;
  v_canonical_items jsonb;
  v_content_fingerprint text;
  v_existing_po_id uuid;
  v_existing_intent_key text;
  v_existing_content_fingerprint text;
  v_cached jsonb;
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

  IF v_bulk_import_requested THEN
    IF v_requested_vendor IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REQUIRED';
    END IF;
    IF v_vendor_reference IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REFERENCE_REQUIRED';
    END IF;

    v_identity_vendor := normalize(
      lower(normalize(v_requested_vendor, NFKC)),
      NFKC
    );
    v_identity_vendor_reference := normalize(
      lower(normalize(v_vendor_reference, NFKC)),
      NFKC
    );

    IF p_po_id IS NOT NULL
       OR p_idempotency_key IS NULL
       OR length(v_vendor_reference) > 512
       OR strpos(v_identity_vendor, chr(31)) > 0
       OR strpos(v_identity_vendor_reference, chr(31)) > 0 THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'PO_ITEMS_REQUIRED';
    END IF;

    v_expected_intent_key := 'bulk-po-document:' || encode(
      extensions.digest(
        convert_to(
          v_identity_vendor || chr(31) || v_identity_vendor_reference,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    v_bulk_intent_key := v_expected_intent_key;

    SELECT COALESCE(
      jsonb_agg(item.value ORDER BY item.value::text),
      '[]'::jsonb
    )
      INTO v_canonical_items
      FROM jsonb_array_elements(p_items) AS item(value);

    v_content_fingerprint := encode(
      extensions.digest(
        convert_to(
          jsonb_build_object(
            'invoice_date', v_invoice_date,
            'items', v_canonical_items
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    v_payload := jsonb_set(
      jsonb_set(
        v_payload - 'bulk_import_intent_key' - 'bulk_import_document',
        '{vendor}',
        to_jsonb(v_requested_vendor),
        true
      ),
      '{bulk_import_vendor_reference}',
      to_jsonb(v_vendor_reference),
      true
    );
  END IF;

  -- A committed same-key replay is valid only for the exact server-derived
  -- document identity and reviewed content. Do not compare the PO's mutable
  -- current vendor: an edit after commit must not break a lost-response retry.
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(
      p_idempotency_key,
      'save_purchase_order'
    );
    IF v_cached IS NOT NULL THEN
      v_existing_po_id := NULLIF(v_cached->>'po_id', '')::uuid;
      IF v_existing_po_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_PURCHASE_ORDER_RESULT_INVALID';
      END IF;
      IF p_po_id IS NOT NULL AND p_po_id IS DISTINCT FROM v_existing_po_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;

      SELECT po.po_number
        INTO v_po_number
        FROM public.purchase_orders AS po
       WHERE po.id = v_existing_po_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Purchase order not found after save: %', v_existing_po_id;
      END IF;

      IF v_bulk_intent_key IS NOT NULL THEN
        SELECT claim.intent_key, claim.content_fingerprint
          INTO v_existing_intent_key, v_existing_content_fingerprint
          FROM public.purchase_order_import_intents AS claim
         WHERE claim.purchase_order_id = v_existing_po_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'BULK_PO_IMPORT_CLAIM_MISSING';
        END IF;
        IF v_existing_intent_key IS DISTINCT FROM v_bulk_intent_key THEN
          RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
        END IF;
        IF v_existing_content_fingerprint IS DISTINCT FROM v_content_fingerprint THEN
          RAISE EXCEPTION 'BULK_PO_DOCUMENT_CONTENT_CONFLICT';
        END IF;
      END IF;

      RETURN v_cached || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bulk_po:' || v_bulk_intent_key, 0)
    );
    SELECT
      claim.purchase_order_id,
      po.po_number,
      claim.content_fingerprint
      INTO
        v_existing_po_id,
        v_po_number,
        v_existing_content_fingerprint
      FROM public.purchase_order_import_intents AS claim
      JOIN public.purchase_orders AS po
        ON po.id = claim.purchase_order_id
     WHERE claim.intent_key = v_bulk_intent_key;
    IF FOUND THEN
      IF v_existing_content_fingerprint IS DISTINCT FROM v_content_fingerprint THEN
        RAISE EXCEPTION 'BULK_PO_DOCUMENT_CONTENT_CONFLICT';
      END IF;
      RETURN jsonb_build_object(
        'status', 'already_imported',
        'po_id', v_existing_po_id,
        'po_number', v_po_number
      );
    END IF;
  END IF;

  IF p_po_id IS NULL THEN
    v_po_number := public.next_po_number();
    v_payload := jsonb_set(
      v_payload,
      '{po_number}',
      to_jsonb(v_po_number),
      true
    );
  END IF;

  v_result := public._save_purchase_order_atomic_number_impl(
    p_po_id,
    v_payload,
    p_items,
    p_performed_by,
    p_idempotency_key
  );

  IF NULLIF(v_result->>'po_id', '') IS NOT NULL THEN
    v_existing_po_id := (v_result->>'po_id')::uuid;
    SELECT po_number
      INTO v_po_number
      FROM public.purchase_orders
     WHERE id = v_existing_po_id;
    IF v_po_number IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    UPDATE public.purchase_order_import_intents
       SET content_fingerprint = v_content_fingerprint
     WHERE purchase_order_id = v_existing_po_id
       AND intent_key = v_bulk_intent_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BULK_PO_IMPORT_CLAIM_MISSING';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._save_purchase_order_ascii_identity_impl(
  uuid, jsonb, jsonb, uuid, text
)
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._save_purchase_order_ascii_identity_impl(
  uuid, jsonb, jsonb, uuid, text
) IS 'Internal directly non-executable purchase-order writer. Historical function name retained for dependency stability; PostgreSQL alone derives durable Unicode bulk identity and content-bound replay.';

COMMENT ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
) IS 'Saves a purchase order; a bulk-import marker opts into PostgreSQL-derived NFKC/lower/NFKC document identity, deterministic claim/replay, and reviewed-content binding.';

DO $verify$
DECLARE
  v_identity_source text;
  v_identity_config text[];
  v_identity_security_definer boolean;
  v_outer_source text;
  v_overloads integer;
BEGIN
  SELECT prosrc, proconfig, prosecdef
    INTO v_identity_source, v_identity_config, v_identity_security_definer
    FROM pg_proc
   WHERE oid = 'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  SELECT prosrc INTO v_outer_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  SELECT count(*) INTO v_overloads
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'save_purchase_order';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one save_purchase_order overload, found %', v_overloads;
  END IF;
  IF NOT v_identity_security_definer
     OR v_identity_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'Internal purchase-order writer security is incorrect';
  END IF;
  IF v_identity_source NOT LIKE '%v_bulk_import_requested%'
     OR v_identity_source NOT LIKE '%bulk_import_document%'
     OR v_identity_source NOT LIKE '%v_bulk_intent_key := v_expected_intent_key%'
     OR v_identity_source LIKE '%BULK_PO_INTENT_IDENTITY_MISMATCH%'
     OR v_identity_source NOT LIKE '%normalize(%lower(%normalize(%v_requested_vendor%NFKC%'
     OR v_identity_source NOT LIKE '%normalize(%lower(%normalize(%v_vendor_reference%NFKC%'
     OR v_identity_source NOT LIKE '%BULK_PO_DOCUMENT_CONTENT_CONFLICT%'
     OR v_identity_source NOT LIKE '%public.next_po_number()%'
     OR v_identity_source NOT LIKE '%_save_purchase_order_atomic_number_impl%' THEN
    RAISE EXCEPTION 'Server-authoritative bulk-PO identity invariants are incomplete';
  END IF;
  IF v_outer_source NOT LIKE '%IF NOT (public.is_admin() OR public.is_sales_rep())%'
     OR v_outer_source NOT LIKE '%_save_purchase_order_ascii_identity_impl%' THEN
    RAISE EXCEPTION 'Public purchase-order role boundary or delegation changed';
  END IF;
  IF has_function_privilege(
       'anon',
       'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
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
     ) THEN
    RAISE EXCEPTION 'Purchase-order server-authority grants are incorrect';
  END IF;
END
$verify$;
