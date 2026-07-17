-- Make browser and PostgreSQL vendor-invoice identity folding byte-identical.
-- JavaScript and locale-aware PostgreSQL lower() can disagree for non-ASCII
-- text. Both sides now fold only ASCII A-Z and preserve every other UTF-8 byte.
-- This keeps ordinary case-insensitive vendor/reference matching while making
-- the server's SHA-256 recomputation deterministic for international text.

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
  v_result jsonb;
  v_po_number text;
  v_bulk_intent_key text := NULLIF(btrim(v_payload->>'bulk_import_intent_key'), '');
  v_requested_vendor text := NULLIF(btrim(v_payload->>'vendor'), '');
  v_vendor_reference text := NULLIF(btrim(v_payload->>'bulk_import_vendor_reference'), '');
  v_invoice_date text := NULLIF(btrim(v_payload->>'bulk_import_invoice_date'), '');
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

  IF v_bulk_intent_key IS NOT NULL THEN
    IF v_requested_vendor IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REQUIRED';
    END IF;
    IF v_vendor_reference IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REFERENCE_REQUIRED';
    END IF;
    IF p_po_id IS NOT NULL
       OR p_idempotency_key IS NULL
       OR length(v_bulk_intent_key) > 512
       OR length(v_vendor_reference) > 512
       OR strpos(translate(
            v_requested_vendor,
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            'abcdefghijklmnopqrstuvwxyz'
          ), chr(31)) > 0
       OR strpos(translate(
            v_vendor_reference,
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            'abcdefghijklmnopqrstuvwxyz'
          ), chr(31)) > 0 THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'PO_ITEMS_REQUIRED';
    END IF;

    v_expected_intent_key := 'bulk-po-document:' || encode(
      extensions.digest(
        convert_to(
          translate(
            v_requested_vendor,
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            'abcdefghijklmnopqrstuvwxyz'
          ) || chr(31) || translate(
            v_vendor_reference,
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            'abcdefghijklmnopqrstuvwxyz'
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    IF v_bulk_intent_key IS DISTINCT FROM v_expected_intent_key THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_IDENTITY_MISMATCH';
    END IF;

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
        v_payload,
        '{vendor}',
        to_jsonb(v_requested_vendor),
        true
      ),
      '{bulk_import_vendor_reference}',
      to_jsonb(v_vendor_reference),
      true
    );
  END IF;

  -- A committed same-key replay is valid only for the exact claimed document
  -- and reviewed content. Do not compare the PO's mutable current vendor: an
  -- edit after commit must not make a legitimate lost-response replay fail.
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
) IS 'Saves a purchase order; bulk imports verify deterministic ASCII-folded vendor-invoice identity, bind cached replay to the exact claim/content fingerprint, and allocate PO numbers atomically.';

DO $verify$
DECLARE
  v_save_source text;
  v_save_config text[];
  v_trigger_def text;
  v_overloads integer;
BEGIN
  SELECT prosrc, proconfig
    INTO v_save_source, v_save_config
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  IF v_save_source NOT LIKE '%BULK_PO_INTENT_IDENTITY_MISMATCH%'
     OR v_save_source NOT LIKE '%BULK_PO_DOCUMENT_CONTENT_CONFLICT%'
     OR v_save_source NOT LIKE '%v_existing_intent_key IS DISTINCT FROM v_bulk_intent_key%'
     OR v_save_source NOT LIKE '%SET content_fingerprint = v_content_fingerprint%'
     OR v_save_source NOT LIKE '%translate(%v_requested_vendor%ABCDEFGHIJKLMNOPQRSTUVWXYZ%abcdefghijklmnopqrstuvwxyz%'
     OR v_save_source NOT LIKE '%translate(%v_vendor_reference%ABCDEFGHIJKLMNOPQRSTUVWXYZ%abcdefghijklmnopqrstuvwxyz%'
     OR v_save_source LIKE '%lower(v_requested_vendor)%'
     OR v_save_source LIKE '%lower(v_vendor_reference)%'
     OR v_save_source NOT LIKE '%extensions.digest(%'
     OR strpos(v_save_source, 'v_existing_intent_key IS DISTINCT FROM v_bulk_intent_key')
        > strpos(v_save_source, 'RETURN v_cached || jsonb_build_object')
     OR strpos(v_save_source, 'WHERE claim.intent_key = v_bulk_intent_key')
        > strpos(v_save_source, 'public.next_po_number()') THEN
    RAISE EXCEPTION 'Purchase-order identity, replay, fingerprint, or number ordering is incorrect';
  END IF;
  IF NOT ('search_path=public, pg_temp' = ANY(COALESCE(v_save_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'Purchase-order save search_path is incorrect';
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
     ) THEN
    RAISE EXCEPTION 'Purchase-order save grants are incorrect';
  END IF;

  SELECT pg_get_triggerdef(oid)
    INTO v_trigger_def
    FROM pg_trigger
   WHERE tgrelid = 'public.purchase_order_import_intents'::regclass
     AND tgname = 'require_bulk_po_content_fingerprint'
     AND NOT tgisinternal;
  IF v_trigger_def IS NULL
     OR v_trigger_def NOT LIKE '%DEFERRABLE INITIALLY DEFERRED%' THEN
    RAISE EXCEPTION 'Bulk PO content fingerprint constraint trigger is missing or not deferred';
  END IF;

  SELECT count(*)
    INTO v_overloads
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'save_purchase_order';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'Expected one save_purchase_order overload, found %', v_overloads;
  END IF;
END;
$verify$;
