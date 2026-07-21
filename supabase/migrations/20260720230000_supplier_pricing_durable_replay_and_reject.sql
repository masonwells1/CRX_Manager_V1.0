-- Supplier Pricing Phase 1b follow-ups (accepted from the 2026-07-20 release reviews).
--
-- 1) Durable idempotent replay after the shared idempotency_keys cache TTL expires.
--    stage_supplier_price_import, approve_supplier_price_import, stage_vendor_alias,
--    and correct_supplier_price_observation previously replayed only through
--    public.check_idempotency; once that cache entry expired, a retry re-ran the
--    body and surfaced a raw UNIQUE violation (supplier_price_imports.idempotency_key,
--    vendor_aliases.alias_normalized) or a wrong-state error instead of the stored
--    result. This adopts the Phase 1a durable-replay pattern used by
--    create_pricing_workbook_export (migration 20260718124517): after a cache miss,
--    look up the durable receipt row by its table-native idempotency key, verify the
--    original actor + request fingerprint, and rebuild the exact response.
--    New durable-receipt columns: vendor_aliases.{idempotency_key,request_fingerprint},
--    supplier_price_imports.{approve,reject}_{idempotency_key,request_fingerprint}.
--
-- 2) Terminal path for zero-approved imports (Codex PR #179 review P2): an import
--    whose rows are all invalid/duplicate/unchanged could never leave 'needs_review'
--    (approve_supplier_price_import requires at least one eligible selected row).
--    New admin RPC reject_supplier_price_import closes an import using the
--    rejected_by/rejected_at/rejection_reason columns and 'rejected' status that
--    have existed since 20260718225511.
--
-- 3) Verified Codex review candidates folded into the same re-emissions:
--    * price_unit is now validated against the link's supplier_uom during staging
--      (PRICE_UNIT_MISMATCH). Normalized ranking divides package cost by
--      inventory_units_per_supplier_unit, which is defined per supplier_uom, so an
--      observation quoted in a different unit would rank incorrectly.
--    * Effective-date predicates use the America/Chicago business date instead of
--      current_date (the live DB session runs UTC, which flips the date at ~6-7pm
--      Chicago). Applies to get_supplier_quote_sheet, get_supplier_market_evidence,
--      and the correction import's document_date.
--
-- Reader/mutator bodies are otherwise verbatim from 20260720203000 (readers,
-- admin-only gate) and 20260718225511 (mutators). No data is changed or deleted.
--
-- APPLY PREFLIGHT (required): immediately before apply_migration, run a fresh
-- read-only `list_migrations` and require the live high-water version to be
-- strictly below 20260720230000. Session evidence 2026-07-20: live high-water
-- was 20260720211454 (20260720211000_scope_delivery_signature_delete), which
-- satisfies the check. Post-apply, reconcile the MCP-assigned version against
-- this filename via ledger UPDATE per the settled B7 policy (never rename the
-- disk file).

-- ─── Durable-receipt columns ───────────────────────────────────────────────

ALTER TABLE public.vendor_aliases
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_aliases_idempotency_key
  ON public.vendor_aliases(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.supplier_price_imports
  ADD COLUMN IF NOT EXISTS approve_idempotency_key text,
  ADD COLUMN IF NOT EXISTS approve_request_fingerprint text,
  ADD COLUMN IF NOT EXISTS reject_idempotency_key text,
  ADD COLUMN IF NOT EXISTS reject_request_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_imports_approve_idem
  ON public.supplier_price_imports(approve_idempotency_key)
  WHERE approve_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_imports_reject_idem
  ON public.supplier_price_imports(reject_idempotency_key)
  WHERE reject_idempotency_key IS NOT NULL;

-- ─── stage_supplier_price_import: durable replay + price_unit validation ───

CREATE OR REPLACE FUNCTION public.stage_supplier_price_import(
  p_vendor_id uuid,
  p_document_date date,
  p_ingestion_method text,
  p_format_version text,
  p_source_document_path text,
  p_source_document_name text,
  p_source_document_mime text,
  p_rows jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_durable public.supplier_price_imports%ROWTYPE;
  v_import_id uuid;
  v_row jsonb;
  v_sequence integer;
  v_link public.product_supplier_links%ROWTYPE;
  v_cost_cents bigint;
  v_effective_from date;
  v_effective_to date;
  v_package_quantity numeric(20,8);
  v_price_kind text;
  v_price_unit text;
  v_status text;
  v_errors text[];
  v_link_id uuid;
  v_result jsonb;
  v_row_count integer;
  v_eligible_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_document_date IS NULL THEN RAISE EXCEPTION 'DOCUMENT_DATE_REQUIRED'; END IF;
  IF p_ingestion_method NOT IN ('quote_sheet', 'quick_quote') THEN
    RAISE EXCEPTION 'SUPPLIER_INGESTION_METHOD_INVALID';
  END IF;
  IF NULLIF(btrim(p_format_version), '') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_FORMAT_VERSION_REQUIRED';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_ROWS_REQUIRED';
  END IF;
  v_row_count := jsonb_array_length(p_rows);
  IF v_row_count < 1 OR v_row_count > 5000 THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_ROW_COUNT_INVALID';
  END IF;
  IF p_source_document_path IS NOT NULL AND (
    NULLIF(btrim(COALESCE(p_source_document_name, '')), '') IS NULL
    OR p_source_document_mime IS DISTINCT FROM 'application/pdf'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_SOURCE_DOCUMENT_INVALID';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_id', p_vendor_id,
    'document_date', p_document_date,
    'ingestion_method', p_ingestion_method,
    'format_version', p_format_version,
    'source_document_path', p_source_document_path,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'stage_supplier_price_import');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- The shared cache expires after 24 hours. The import row is the durable
  -- receipt, so only the exact original actor, payload fingerprint, and
  -- idempotency key may replay it. Runs before the ownership/existence checks
  -- so a replay does not re-litigate transient state (e.g. an already-consumed
  -- source PDF); the fingerprint pins the replay to the identical payload.
  SELECT * INTO v_durable
  FROM public.supplier_price_imports i
  WHERE i.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.created_by IS DISTINCT FROM v_actor
       OR v_durable.request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN public.get_supplier_price_import(v_durable.id);
  END IF;

  IF p_source_document_path IS NOT NULL AND (
    split_part(p_source_document_path, '/', 1) IS DISTINCT FROM v_actor::text
    OR NOT EXISTS (
      SELECT 1
      FROM storage.objects object
      WHERE object.bucket_id = 'supplier-price-evidence'
        AND object.name = p_source_document_path
    )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_SOURCE_DOCUMENT_NOT_OWNED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  INSERT INTO public.supplier_price_imports(
    vendor_id, document_date, ingestion_method, format_version, status,
    source_document_path, source_document_name, source_document_mime,
    request_fingerprint, idempotency_key, row_count, created_by
  ) VALUES (
    p_vendor_id, p_document_date, p_ingestion_method, p_format_version, 'draft',
    NULLIF(btrim(COALESCE(p_source_document_path, '')), ''),
    NULLIF(btrim(COALESCE(p_source_document_name, '')), ''),
    NULLIF(btrim(COALESCE(p_source_document_mime, '')), ''),
    v_request_fp, p_idempotency_key, v_row_count, v_actor
  ) RETURNING id INTO v_import_id;

  FOR v_row, v_sequence IN
    SELECT value, ordinality::integer
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    v_errors := ARRAY[]::text[];
    v_status := 'new';
    v_cost_cents := NULL;
    v_effective_from := NULL;
    v_effective_to := NULL;
    v_package_quantity := NULL;
    v_link_id := NULL;
    v_link := NULL;
    v_price_kind := lower(COALESCE(NULLIF(btrim(v_row->>'price_kind'), ''), 'quote'));
    v_price_unit := NULLIF(btrim(COALESCE(v_row->>'price_unit', '')), '');

    IF lower(COALESCE(v_row->>'has_formula', 'false')) = 'true' THEN
      v_errors := array_append(v_errors, 'FORMULA_NOT_ALLOWED');
    END IF;

    BEGIN
      v_link_id := NULLIF(btrim(COALESCE(v_row->>'product_supplier_link_id', '')), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_errors := array_append(v_errors, 'LINK_ID_INVALID');
    END;

    IF v_link_id IS NOT NULL THEN
      SELECT * INTO v_link
      FROM public.product_supplier_links
      WHERE id = v_link_id AND is_active;
      IF NOT FOUND OR v_link.vendor_id IS DISTINCT FROM p_vendor_id THEN
        v_errors := array_append(v_errors, 'LINK_VENDOR_MISMATCH');
        v_link_id := NULL;
        v_link := NULL;
      ELSIF NOT v_link.is_reusable THEN
        v_errors := array_append(v_errors, 'LINK_NOT_CONFIRMED_FOR_REUSE');
      ELSE
        IF v_price_unit IS NULL THEN
          v_price_unit := v_link.supplier_uom;
        ELSIF v_price_unit IS DISTINCT FROM v_link.supplier_uom THEN
          -- Normalized ranking divides the package cost by the link's
          -- inventory_units_per_supplier_unit, which is defined for the link's
          -- supplier_uom. A quote in any other unit cannot be ranked honestly.
          v_errors := array_append(v_errors, 'PRICE_UNIT_MISMATCH');
        END IF;
      END IF;
    ELSE
      v_errors := array_append(v_errors, 'LINK_REQUIRED');
    END IF;

    BEGIN
      v_cost_cents := public._parse_pricing_dollars(btrim(COALESCE(v_row->>'new_cost', '')));
      IF v_cost_cents <= 0 THEN
        v_errors := array_append(v_errors, 'COST_MUST_BE_POSITIVE');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := array_append(v_errors, 'COST_INVALID');
      v_cost_cents := NULL;
    END;

    IF v_price_kind NOT IN ('list', 'quote', 'contract', 'promo', 'manual') THEN
      v_errors := array_append(v_errors, 'PRICE_KIND_INVALID');
      v_price_kind := NULL;
    END IF;
    IF v_price_unit IS NULL THEN
      v_errors := array_append(v_errors, 'PRICE_UNIT_REQUIRED');
    END IF;

    BEGIN
      v_package_quantity := COALESCE(NULLIF(btrim(v_row->>'package_quantity'), '')::numeric, 1);
      IF v_package_quantity <= 0 THEN
        v_errors := array_append(v_errors, 'PACKAGE_QUANTITY_INVALID');
      END IF;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      v_errors := array_append(v_errors, 'PACKAGE_QUANTITY_INVALID');
      v_package_quantity := NULL;
    END;

    BEGIN
      v_effective_from := COALESCE(NULLIF(btrim(v_row->>'effective_date'), '')::date, p_document_date);
      v_effective_to := NULLIF(btrim(COALESCE(v_row->>'effective_to', '')), '')::date;
      IF v_effective_to IS NOT NULL AND v_effective_to < v_effective_from THEN
        v_errors := array_append(v_errors, 'EFFECTIVE_RANGE_INVALID');
      END IF;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      v_errors := array_append(v_errors, 'EFFECTIVE_DATE_INVALID');
      v_effective_from := NULL;
      v_effective_to := NULL;
    END;

    IF cardinality(v_errors) > 0 THEN
      v_status := 'invalid';
    ELSIF EXISTS (
      SELECT 1 FROM public.supplier_price_import_rows prior
      WHERE prior.import_id = v_import_id
        AND prior.product_supplier_link_id = v_link_id
        AND prior.cost_cents = v_cost_cents
        AND prior.effective_from = v_effective_from
        AND prior.price_kind = v_price_kind
    ) THEN
      v_status := 'duplicate';
    ELSIF EXISTS (
      SELECT 1 FROM public.supplier_price_observations o
      WHERE o.product_supplier_link_id = v_link_id
        AND o.cost_cents = v_cost_cents
        AND o.effective_from = v_effective_from
        AND o.price_kind = v_price_kind
        AND o.price_unit = v_price_unit
        AND o.package_quantity = v_package_quantity
    ) THEN
      v_status := 'unchanged';
    ELSIF v_link.comparison_status <> 'comparable' THEN
      v_status := 'cannot_compare';
    ELSIF EXISTS (
      SELECT 1
      FROM public.supplier_price_observations o
      WHERE o.product_supplier_link_id = v_link_id
    ) THEN
      v_status := 'changed';
    END IF;

    INSERT INTO public.supplier_price_import_rows(
      import_id, row_number, submitted_row,
      product_id, vendor_id, product_supplier_link_id,
      supplier_sku, supplier_product_name,
      cost_cents, price_unit, package_quantity,
      effective_from, effective_to, price_kind,
      row_status, validation_errors
    ) VALUES (
      v_import_id, v_sequence, v_row,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.product_id END,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE p_vendor_id END,
      v_link_id,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.supplier_sku END,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.supplier_product_name END,
      v_cost_cents, v_price_unit, v_package_quantity,
      v_effective_from, v_effective_to, v_price_kind,
      v_status, v_errors
    );
  END LOOP;

  SELECT count(*)::integer INTO v_eligible_count
  FROM public.supplier_price_import_rows
  WHERE import_id = v_import_id
    AND row_status IN ('new', 'changed', 'cannot_compare');

  UPDATE public.supplier_price_imports
  SET status = 'needs_review',
      eligible_row_count = v_eligible_count
  WHERE id = v_import_id;

  v_result := public.get_supplier_price_import(v_import_id);
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'stage_supplier_price_import',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

-- ─── approve_supplier_price_import: durable replay ─────────────────────────

CREATE OR REPLACE FUNCTION public.approve_supplier_price_import(
  p_import_id uuid,
  p_row_ids uuid[],
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_durable public.supplier_price_imports%ROWTYPE;
  v_import public.supplier_price_imports%ROWTYPE;
  v_row public.supplier_price_import_rows%ROWTYPE;
  v_observation_id uuid;
  v_approved_count integer := 0;
  v_eligible_count integer;
  v_nonterminal_count integer;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_row_ids IS NULL OR cardinality(p_row_ids) = 0 THEN
    RAISE EXCEPTION 'SUPPLIER_APPROVAL_ROWS_REQUIRED';
  END IF;
  IF cardinality(p_row_ids) <> (
    SELECT count(DISTINCT row_id)
    FROM unnest(p_row_ids) AS selected(row_id)
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_APPROVAL_DUPLICATE_ROW_IDS';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'import_id', p_import_id,
    'row_ids', to_jsonb(p_row_ids)
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'approve_supplier_price_import');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Durable replay: the approval stamp on the import row survives the cache.
  -- Without this, a post-TTL retry hit SUPPLIER_IMPORT_NOT_REVIEWABLE because
  -- the first run had already moved the import out of 'needs_review'.
  SELECT * INTO v_durable
  FROM public.supplier_price_imports i
  WHERE i.approve_idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.approved_by IS DISTINCT FROM v_actor
       OR v_durable.approve_request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN public.get_supplier_price_import(v_durable.id)
      || jsonb_build_object(
        'approved_count', v_durable.approved_observation_count,
        'sell_prices_changed', 0,
        'summary', format(
          'You are adding %s supplier observations. You are changing ZERO sell prices.',
          v_durable.approved_observation_count
        )
      );
  END IF;

  SELECT * INTO v_import
  FROM public.supplier_price_imports
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_FOUND'; END IF;
  IF v_import.status <> 'needs_review' THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_REVIEWABLE';
  END IF;

  SELECT count(*)::integer INTO v_eligible_count
  FROM public.supplier_price_import_rows
  WHERE import_id = p_import_id
    AND id = ANY(p_row_ids)
    AND row_status IN ('new', 'changed', 'cannot_compare');
  IF v_eligible_count <> cardinality(p_row_ids) THEN
    RAISE EXCEPTION 'SUPPLIER_APPROVAL_ROW_NOT_ELIGIBLE';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.supplier_price_import_rows
    WHERE import_id = p_import_id
      AND id = ANY(p_row_ids)
      AND row_status IN ('new', 'changed', 'cannot_compare')
    ORDER BY row_number
    FOR UPDATE
  LOOP
    INSERT INTO public.supplier_price_observations(
      product_id, vendor_id, product_supplier_link_id,
      import_id, import_row_id,
      price_kind, cost_cents, price_unit, package_quantity,
      effective_from, effective_to, observed_at, created_by
    ) VALUES (
      v_row.product_id, v_row.vendor_id, v_row.product_supplier_link_id,
      p_import_id, v_row.id,
      v_row.price_kind, v_row.cost_cents, v_row.price_unit, v_row.package_quantity,
      v_row.effective_from, v_row.effective_to, now(), v_actor
    ) RETURNING id INTO v_observation_id;

    UPDATE public.supplier_price_import_rows
    SET row_status = 'approved',
        reviewed_by = v_actor,
        reviewed_at = now(),
        observation_id = v_observation_id
    WHERE id = v_row.id;
    v_approved_count := v_approved_count + 1;
  END LOOP;

  UPDATE public.supplier_price_import_rows
  SET row_status = 'rejected',
      reviewed_by = v_actor,
      reviewed_at = now(),
      reviewer_note = COALESCE(reviewer_note, 'Not selected during import approval')
  WHERE import_id = p_import_id
    AND row_status IN ('new', 'changed', 'cannot_compare')
    AND NOT (id = ANY(p_row_ids));

  SELECT count(*)::integer INTO v_nonterminal_count
  FROM public.supplier_price_import_rows
  WHERE import_id = p_import_id
    AND row_status IN ('invalid', 'rejected');

  UPDATE public.supplier_price_imports
  SET status = CASE WHEN v_nonterminal_count = 0 THEN 'approved' ELSE 'partially_approved' END,
      approved_by = v_actor,
      approved_at = now(),
      approved_observation_count = v_approved_count,
      approve_idempotency_key = p_idempotency_key,
      approve_request_fingerprint = v_request_fp
  WHERE id = p_import_id;

  v_result := public.get_supplier_price_import(p_import_id)
    || jsonb_build_object(
      'approved_count', v_approved_count,
      'sell_prices_changed', 0,
      'summary', format(
        'You are adding %s supplier observations. You are changing ZERO sell prices.',
        v_approved_count
      )
    );
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'approve_supplier_price_import',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

-- ─── reject_supplier_price_import: terminal path for dead imports ──────────

-- An import whose rows all landed invalid/duplicate/unchanged has no eligible
-- row, so approve_supplier_price_import can never move it out of
-- 'needs_review'. This closes it. Nothing is deleted: rows keep their
-- statuses (still-open rows become 'rejected') and no observation or sell
-- price is touched.
CREATE OR REPLACE FUNCTION public.reject_supplier_price_import(
  p_import_id uuid,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_reason text;
  v_durable public.supplier_price_imports%ROWTYPE;
  v_import public.supplier_price_imports%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN RAISE EXCEPTION 'REJECTION_REASON_REQUIRED'; END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'import_id', p_import_id,
    'reason', v_reason
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'reject_supplier_price_import');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Durable replay after the shared cache expires (same pattern as approve).
  SELECT * INTO v_durable
  FROM public.supplier_price_imports i
  WHERE i.reject_idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.rejected_by IS DISTINCT FROM v_actor
       OR v_durable.reject_request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN public.get_supplier_price_import(v_durable.id)
      || jsonb_build_object(
        'summary', 'Import rejected. No supplier observations or sell prices were changed.'
      );
  END IF;

  SELECT * INTO v_import
  FROM public.supplier_price_imports
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_FOUND'; END IF;
  IF v_import.status <> 'needs_review' THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_REVIEWABLE';
  END IF;

  UPDATE public.supplier_price_import_rows
  SET row_status = 'rejected',
      reviewed_by = v_actor,
      reviewed_at = now(),
      reviewer_note = COALESCE(reviewer_note, 'Import rejected: ' || v_reason)
  WHERE import_id = p_import_id
    AND row_status IN ('new', 'changed', 'cannot_compare');

  UPDATE public.supplier_price_imports
  SET status = 'rejected',
      rejected_by = v_actor,
      rejected_at = now(),
      rejection_reason = v_reason,
      reject_idempotency_key = p_idempotency_key,
      reject_request_fingerprint = v_request_fp
  WHERE id = p_import_id;

  v_result := public.get_supplier_price_import(p_import_id)
    || jsonb_build_object(
      'summary', 'Import rejected. No supplier observations or sell prices were changed.'
    );
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'reject_supplier_price_import',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

-- ─── stage_vendor_alias: durable replay ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.stage_vendor_alias(
  p_alias_raw text,
  p_alias_display text,
  p_proposed_vendor_id uuid,
  p_source text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_durable public.vendor_aliases%ROWTYPE;
  v_alias_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_alias_raw), '') IS NULL OR NULLIF(btrim(p_alias_display), '') IS NULL THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_TEXT_REQUIRED';
  END IF;
  IF p_source NOT IN ('legacy_product', 'legacy_po', 'import', 'manual') THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_SOURCE_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_proposed_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'alias_raw', p_alias_raw,
    'alias_display', p_alias_display,
    'proposed_vendor_id', p_proposed_vendor_id,
    'source', p_source
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'stage_vendor_alias');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Durable replay after the shared cache expires. Without it, a post-TTL
  -- retry re-ran the INSERT and surfaced the raw uq_vendor_aliases_normalized
  -- UNIQUE violation instead of the stored result.
  SELECT * INTO v_durable
  FROM public.vendor_aliases a
  WHERE a.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.created_by IS DISTINCT FROM v_actor
       OR v_durable.request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN to_jsonb(v_durable) - 'idempotency_key' - 'request_fingerprint';
  END IF;

  BEGIN
    INSERT INTO public.vendor_aliases(
      proposed_vendor_id, alias_raw, alias_display, source,
      review_status, created_by, idempotency_key, request_fingerprint
    ) VALUES (
      p_proposed_vendor_id, btrim(p_alias_raw), btrim(p_alias_display), p_source,
      'pending', v_actor, p_idempotency_key, v_request_fp
    ) RETURNING id INTO v_alias_id;
  EXCEPTION WHEN unique_violation THEN
    -- A DIFFERENT request (different key) already staged an alias with the
    -- same normalized text. Surface it as a domain error, not a raw 23505.
    RAISE EXCEPTION 'VENDOR_ALIAS_ALREADY_EXISTS';
  END;

  SELECT to_jsonb(a) - 'idempotency_key' - 'request_fingerprint' INTO v_result
  FROM public.vendor_aliases a WHERE a.id = v_alias_id;
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'stage_vendor_alias',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

-- ─── correct_supplier_price_observation: durable replay + Chicago date ─────

CREATE OR REPLACE FUNCTION public.correct_supplier_price_observation(
  p_observation_id uuid,
  p_corrected_cost text,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_reason text;
  v_cost_cents bigint;
  v_durable public.supplier_price_imports%ROWTYPE;
  v_original public.supplier_price_observations%ROWTYPE;
  v_import_id uuid;
  v_row_id uuid;
  v_observation_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN RAISE EXCEPTION 'CORRECTION_REASON_REQUIRED'; END IF;

  -- Single dollars->cents boundary, reusing the same parser the staging path uses.
  BEGIN
    v_cost_cents := public._parse_pricing_dollars(btrim(COALESCE(p_corrected_cost, '')));
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'CORRECTION_COST_INVALID';
  END;
  IF v_cost_cents IS NULL OR v_cost_cents <= 0 THEN
    RAISE EXCEPTION 'CORRECTION_COST_MUST_BE_POSITIVE';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'observation_id', p_observation_id,
    'cost_cents', v_cost_cents,
    'reason', v_reason
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'correct_supplier_price_observation');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Durable replay after the shared cache expires. The correction's own
  -- single-row import (idempotency_key = 'correction:' || key) is the durable
  -- receipt; rebuild the original response from its approved observation.
  -- Without this, a post-TTL retry hit SUPPLIER_OBSERVATION_ALREADY_SUPERSEDED.
  SELECT * INTO v_durable
  FROM public.supplier_price_imports i
  WHERE i.idempotency_key = 'correction:' || p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.created_by IS DISTINCT FROM v_actor
       OR v_durable.request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;

    SELECT jsonb_build_object(
      'observation_id', o.id,
      'supersedes_observation_id', o.supersedes_observation_id,
      'product_id', o.product_id,
      'vendor_id', o.vendor_id,
      'product_supplier_link_id', o.product_supplier_link_id,
      'cost_cents', o.cost_cents,
      'price_unit', o.price_unit,
      'package_quantity', o.package_quantity,
      'price_kind', o.price_kind,
      'effective_from', o.effective_from,
      'effective_to', o.effective_to,
      'import_id', o.import_id,
      'import_row_id', o.import_row_id,
      'reason', r.reviewer_note,
      'sell_prices_changed', 0,
      'summary', format(
        'Correction recorded. The prior quote is superseded and no sell price changed. New supplier cost: $%s.',
        public._format_pricing_dollars(o.cost_cents)
      )
    ) INTO v_result
    FROM public.supplier_price_import_rows r
    JOIN public.supplier_price_observations o ON o.id = r.observation_id
    WHERE r.import_id = v_durable.id
      AND r.row_number = 1;
    IF v_result IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_CORRECTION_RECEIPT_MISSING';
    END IF;
    RETURN v_result;
  END IF;

  SELECT * INTO v_original
  FROM public.supplier_price_observations
  WHERE id = p_observation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_OBSERVATION_NOT_FOUND'; END IF;

  -- Only the current observation is correctable; a re-correction extends the chain.
  IF EXISTS (
    SELECT 1
    FROM public.supplier_price_observations correction
    WHERE correction.supersedes_observation_id = v_original.id
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_OBSERVATION_ALREADY_SUPERSEDED';
  END IF;

  IF v_cost_cents = v_original.cost_cents THEN
    RAISE EXCEPTION 'CORRECTION_MUST_CHANGE_COST';
  END IF;

  INSERT INTO public.supplier_price_imports(
    vendor_id, document_date, ingestion_method, format_version, status,
    request_fingerprint, idempotency_key, row_count, eligible_row_count,
    approved_observation_count, created_by, approved_by, approved_at
  ) VALUES (
    -- Business date: the DB session runs UTC; the session-local date function
    -- would stamp the correction with tomorrow's date after ~6-7pm Chicago.
    v_original.vendor_id, (now() AT TIME ZONE 'America/Chicago')::date, 'quick_quote',
    'crx-supplier-correction-phase1b-v1', 'approved',
    v_request_fp, 'correction:' || p_idempotency_key, 1, 1, 1,
    v_actor, v_actor, now()
  ) RETURNING id INTO v_import_id;

  -- Row first (not yet approved: the approved-shape CHECK needs observation_id, which
  -- only exists after the observation is inserted below).
  INSERT INTO public.supplier_price_import_rows(
    import_id, row_number, submitted_row,
    product_id, vendor_id, product_supplier_link_id,
    supplier_sku, supplier_product_name,
    cost_cents, price_unit, package_quantity,
    effective_from, effective_to, price_kind,
    row_status, validation_errors
  ) VALUES (
    v_import_id, 1,
    jsonb_build_object(
      'correction_of_observation_id', v_original.id,
      'reason', v_reason,
      'new_cost', public._format_pricing_dollars(v_cost_cents),
      'prior_cost', public._format_pricing_dollars(v_original.cost_cents)
    ),
    v_original.product_id, v_original.vendor_id, v_original.product_supplier_link_id,
    NULL, NULL,
    v_cost_cents, v_original.price_unit, v_original.package_quantity,
    v_original.effective_from, v_original.effective_to, v_original.price_kind,
    'changed', ARRAY[]::text[]
  ) RETURNING id INTO v_row_id;

  -- Superseding observation. The validate/no-cycle trigger confirms the product,
  -- vendor, and link all match the original before the row is written.
  INSERT INTO public.supplier_price_observations(
    product_id, vendor_id, product_supplier_link_id,
    import_id, import_row_id,
    price_kind, cost_cents, price_unit, package_quantity,
    effective_from, effective_to, observed_at,
    supersedes_observation_id, created_by
  ) VALUES (
    v_original.product_id, v_original.vendor_id, v_original.product_supplier_link_id,
    v_import_id, v_row_id,
    v_original.price_kind, v_cost_cents, v_original.price_unit, v_original.package_quantity,
    v_original.effective_from, v_original.effective_to, now(),
    v_original.id, v_actor
  ) RETURNING id INTO v_observation_id;

  UPDATE public.supplier_price_import_rows
  SET row_status = 'approved',
      reviewed_by = v_actor,
      reviewed_at = now(),
      reviewer_note = v_reason,
      observation_id = v_observation_id
  WHERE id = v_row_id;

  SELECT jsonb_build_object(
    'observation_id', o.id,
    'supersedes_observation_id', o.supersedes_observation_id,
    'product_id', o.product_id,
    'vendor_id', o.vendor_id,
    'product_supplier_link_id', o.product_supplier_link_id,
    'cost_cents', o.cost_cents,
    'price_unit', o.price_unit,
    'package_quantity', o.package_quantity,
    'price_kind', o.price_kind,
    'effective_from', o.effective_from,
    'effective_to', o.effective_to,
    'import_id', o.import_id,
    'import_row_id', o.import_row_id,
    'reason', v_reason,
    'sell_prices_changed', 0,
    'summary', format(
      'Correction recorded. The prior quote is superseded and no sell price changed. New supplier cost: $%s.',
      public._format_pricing_dollars(o.cost_cents)
    )
  ) INTO v_result
  FROM public.supplier_price_observations o
  WHERE o.id = v_observation_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'correct_supplier_price_observation',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

-- ─── Readers: America/Chicago business date (bodies otherwise verbatim ─────
-- ─── from 20260720203000, admin-only gate unchanged) ───────────────────────

CREATE OR REPLACE FUNCTION public.get_supplier_quote_sheet(p_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_vendor public.vendors%ROWTYPE;
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;

  SELECT * INTO v_vendor
  FROM public.vendors
  WHERE id = p_vendor_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'VENDOR_NOT_FOUND'; END IF;

  SELECT jsonb_build_object(
    'format_version', 'crx-supplier-quote-phase1b-v1',
    'vendor_id', v_vendor.id,
    'vendor_name', v_vendor.name,
    'generated_at', now(),
    'rows', COALESCE(jsonb_agg(jsonb_build_object(
      'product_supplier_link_id', l.id,
      'product_id', p.id,
      'vendor_id', l.vendor_id,
      'supplier_sku', l.supplier_sku,
      'product_name', p.product_name,
      'supplier_product_name', l.supplier_product_name,
      'supplier_uom', l.supplier_uom,
      'supplier_pack_description', l.supplier_pack_description,
      'inventory_unit', p.inventory_unit,
      'inventory_units_per_supplier_unit', l.inventory_units_per_supplier_unit,
      'comparison_status', l.comparison_status,
      'last_cost', CASE WHEN latest.cost_cents IS NULL THEN NULL ELSE public._format_pricing_dollars(latest.cost_cents) END,
      'last_effective_date', latest.effective_from,
      'new_cost', '',
      'effective_date', v_business_date,
      'price_kind', 'quote'
    ) ORDER BY p.product_name, l.supplier_sku), '[]'::jsonb)
  ) INTO v_result
  FROM public.product_supplier_links l
  JOIN public.products p ON p.id = l.product_id AND p.is_active
  LEFT JOIN LATERAL (
    SELECT o.cost_cents, o.effective_from
    FROM public.supplier_price_observations o
    WHERE o.product_supplier_link_id = l.id
      AND o.effective_from <= v_business_date
      AND (o.effective_to IS NULL OR o.effective_to >= v_business_date)
      AND NOT EXISTS (
        SELECT 1
        FROM public.supplier_price_observations correction
        WHERE correction.supersedes_observation_id = o.id
      )
    ORDER BY o.effective_from DESC, o.observed_at DESC, o.id DESC
    LIMIT 1
  ) latest ON true
  WHERE l.vendor_id = p_vendor_id
    AND l.is_active
    AND l.is_reusable;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_supplier_market_evidence(p_product_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (o.product_supplier_link_id)
      o.product_id,
      o.vendor_id,
      o.product_supplier_link_id,
      o.cost_cents,
      o.package_quantity,
      o.effective_from,
      o.observed_at,
      l.inventory_units_per_supplier_unit,
      l.comparison_status,
      v.name AS vendor_name,
      CASE
        WHEN l.comparison_status = 'comparable'
         AND l.inventory_units_per_supplier_unit > 0
        THEN round(o.cost_cents::numeric / o.package_quantity / l.inventory_units_per_supplier_unit)::bigint
        ELSE NULL
      END AS normalized_cost_cents
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l ON l.id = o.product_supplier_link_id AND l.is_active
    JOIN public.vendors v ON v.id = o.vendor_id AND v.deleted_at IS NULL
    WHERE (p_product_ids IS NULL OR o.product_id = ANY(p_product_ids))
      AND o.effective_from <= v_business_date
      AND (o.effective_to IS NULL OR o.effective_to >= v_business_date)
      AND NOT EXISTS (
        SELECT 1
        FROM public.supplier_price_observations correction
        WHERE correction.supersedes_observation_id = o.id
      )
    ORDER BY o.product_supplier_link_id, o.effective_from DESC, o.observed_at DESC, o.id DESC
  ), ranked AS (
    SELECT latest.*,
      dense_rank() OVER (
        PARTITION BY product_id
        ORDER BY normalized_cost_cents ASC NULLS LAST, effective_from DESC
      ) AS price_rank
    FROM latest
  ), product_summary AS (
    SELECT
      product_id,
      count(*)::integer AS supplier_quote_count,
      count(*) FILTER (WHERE normalized_cost_cents IS NOT NULL)::integer AS comparable_quote_count,
      min(normalized_cost_cents) AS replacement_cost_cents,
      max(effective_from) FILTER (WHERE normalized_cost_cents IS NOT NULL AND price_rank = 1) AS replacement_cost_as_of,
      min(vendor_name) FILTER (WHERE normalized_cost_cents IS NOT NULL AND price_rank = 1) AS best_supplier,
      jsonb_agg(jsonb_build_object(
        'vendor_id', vendor_id,
        'vendor_name', vendor_name,
        'product_supplier_link_id', product_supplier_link_id,
        'quoted_package_cost_cents', cost_cents,
        'normalized_cost_cents', normalized_cost_cents,
        'effective_from', effective_from,
        'comparison_status', CASE WHEN normalized_cost_cents IS NULL THEN 'cannot_compare' ELSE 'comparable' END,
        'is_best_comparable', normalized_cost_cents IS NOT NULL AND price_rank = 1
      ) ORDER BY normalized_cost_cents ASC NULLS LAST, vendor_name) AS suppliers
    FROM ranked
    GROUP BY product_id
  ), purchase_lines AS (
    SELECT
      poi.id,
      poi.product_id,
      poi.unit_cost_cents,
      poi.quantity_received,
      COALESCE(po.submitted_date, po.created_at::date) AS purchase_date
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE poi.quantity_received > 0
      AND poi.unit_cost_cents IS NOT NULL
      AND po.status <> 'cancelled'
      AND (p_product_ids IS NULL OR poi.product_id = ANY(p_product_ids))
  ), purchase_summary AS (
    SELECT
      product_id,
      (array_agg(unit_cost_cents ORDER BY purchase_date DESC, id DESC))[1] AS last_paid_cents,
      (array_agg(purchase_date ORDER BY purchase_date DESC, id DESC))[1] AS last_paid_as_of,
      round(
        sum(unit_cost_cents::numeric * quantity_received)
          FILTER (WHERE purchase_date >= v_business_date - 365)
        / NULLIF(
          sum(quantity_received) FILTER (WHERE purchase_date >= v_business_date - 365),
          0
        )
      )::bigint AS recent_po_weighted_average_cents
    FROM purchase_lines
    GROUP BY product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id,
    'supplier_quote_count', COALESCE(s.supplier_quote_count, 0),
    'comparable_quote_count', COALESCE(s.comparable_quote_count, 0),
    'replacement_cost_cents', s.replacement_cost_cents,
    'replacement_cost_as_of', s.replacement_cost_as_of,
    'best_supplier', s.best_supplier,
    'last_paid_cents', purchase.last_paid_cents,
    'last_paid_as_of', purchase.last_paid_as_of,
    'recent_po_weighted_average_cents', purchase.recent_po_weighted_average_cents,
    'recent_po_window', 'trailing_12_months',
    'comparison_status', CASE
      WHEN COALESCE(s.supplier_quote_count, 0) = 0 THEN 'no_evidence'
      WHEN COALESCE(s.comparable_quote_count, 0) = 0 THEN 'cannot_compare'
      ELSE 'comparable'
    END,
    'suppliers', COALESCE(s.suppliers, '[]'::jsonb)
  ) ORDER BY p.product_name, p.id), '[]'::jsonb)
  INTO v_result
  FROM public.products p
  LEFT JOIN product_summary s ON s.product_id = p.id
  LEFT JOIN purchase_summary purchase ON purchase.product_id = p.id
  WHERE p.is_active
    AND (p_product_ids IS NULL OR p.id = ANY(p_product_ids));

  RETURN v_result;
END;
$function$;

-- ─── ACLs ──────────────────────────────────────────────────────────────────

-- caller-analysis: reject_supplier_price_import :: new authenticated-admin RPC,
-- called only from src/pages/SupplierPricing.tsx (admin-only page).
REVOKE ALL ON FUNCTION public.reject_supplier_price_import(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_supplier_price_import(uuid, text, uuid, text)
  TO authenticated;

-- CREATE OR REPLACE preserves the existing grants on the re-emitted functions;
-- re-asserted here for explicitness (mirrors 20260720203000).
REVOKE ALL ON FUNCTION public.stage_supplier_price_import(
  uuid, date, text, text, text, text, text, jsonb, uuid, text
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_supplier_price_import(uuid, uuid[], uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stage_vendor_alias(text, text, uuid, text, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.correct_supplier_price_observation(uuid, text, text, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_quote_sheet(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_market_evidence(uuid[])
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.stage_supplier_price_import(
  uuid, date, text, text, text, text, text, jsonb, uuid, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_supplier_price_import(uuid, uuid[], uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.stage_vendor_alias(text, text, uuid, text, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_supplier_price_observation(uuid, text, text, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_quote_sheet(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_market_evidence(uuid[])
  TO authenticated;

-- ─── Verify ────────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_bad text;
BEGIN
  -- Every touched supplier-pricing function must keep its admin-only gate and
  -- must not reference current_date for business-date decisions.
  SELECT string_agg(p.proname, ', ')
  INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'stage_supplier_price_import',
      'approve_supplier_price_import',
      'reject_supplier_price_import',
      'stage_vendor_alias',
      'correct_supplier_price_observation',
      'get_supplier_quote_sheet',
      'get_supplier_market_evidence'
    )
    AND (p.prosrc NOT LIKE '%ADMIN_REQUIRED%' OR p.prosrc LIKE '%is_sales_rep%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: supplier-pricing functions missing admin gate: %', v_bad;
  END IF;

  SELECT string_agg(p.proname, ', ')
  INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_supplier_quote_sheet',
      'get_supplier_market_evidence',
      'correct_supplier_price_observation'
    )
    AND p.prosrc LIKE '%current_date%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: functions still use current_date: %', v_bad;
  END IF;

  IF to_regprocedure('public.reject_supplier_price_import(uuid,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: reject_supplier_price_import missing';
  END IF;
END;
$verify$;
