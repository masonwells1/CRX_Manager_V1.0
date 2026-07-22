-- Supplier Pricing workbook v2: govern the fixed Product-information field set
-- through the existing preview/apply transaction. No supplier evidence is
-- auto-applied and no Product pricing is changed by this migration.

ALTER TABLE public.products
  ADD COLUMN quoting_notes text;

GRANT INSERT (quoting_notes) ON public.products TO authenticated;
GRANT UPDATE (quoting_notes) ON public.products TO authenticated;

ALTER TABLE public.pricing_workbook_exports
  ADD COLUMN format_version text NOT NULL
    DEFAULT 'crx-product-pricing-phase1a-v1'
    CHECK (btrim(format_version) <> '');

-- A v1 workbook does not carry Product-info snapshots. It cannot be safely
-- upgraded in place, so every still-active v1 export is retired atomically.
UPDATE public.pricing_workbook_exports
SET status = 'expired'
WHERE status = 'active'
  AND format_version = 'crx-product-pricing-phase1a-v1';

ALTER TABLE public.pricing_workbook_exports
  ALTER COLUMN format_version
  SET DEFAULT 'crx-product-pricing-phase2-v2';

ALTER TABLE public.pricing_workbook_export_rows
  ADD COLUMN suggested_rate_snapshot text,
  ADD COLUMN rate_per_acre_snapshot numeric,
  ADD COLUMN rate_unit_snapshot text,
  ADD COLUMN use_timing_snapshot text,
  ADD COLUMN internal_notes_snapshot text,
  ADD COLUMN quoting_notes_snapshot text;

CREATE TABLE public.product_info_change_set_rows (
  change_set_id uuid NOT NULL
    REFERENCES public.pricing_change_sets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL
    REFERENCES public.products(id) ON DELETE RESTRICT,
  expected_version bigint NOT NULL CHECK (expected_version >= 1),
  before_values jsonb NOT NULL CHECK (jsonb_typeof(before_values) = 'object'),
  after_values jsonb NOT NULL CHECK (jsonb_typeof(after_values) = 'object'),
  changes jsonb NOT NULL CHECK (
    jsonb_typeof(changes) = 'object' AND changes <> '{}'::jsonb
  ),
  output_fingerprint text NOT NULL,
  PRIMARY KEY (change_set_id, product_id)
);

CREATE INDEX idx_product_info_change_set_rows_product
  ON public.product_info_change_set_rows(product_id);

ALTER TABLE public.product_info_change_set_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_info_change_set_rows_rpc_only
  ON public.product_info_change_set_rows
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);
REVOKE ALL ON TABLE public.product_info_change_set_rows
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_pricing_workbook_export(
  p_product_ids uuid[] DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
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
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_export_id uuid;
  v_manifest_fp text;
  v_row_count integer;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'format_version', 'crx-product-pricing-phase2-v2',
    'product_ids', COALESCE(to_jsonb(p_product_ids), 'null'::jsonb)
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'create_pricing_workbook_export'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  SELECT * INTO v_export
  FROM public.pricing_workbook_exports e
  WHERE e.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_export.created_by IS DISTINCT FROM v_actor
       OR v_export.request_fingerprint IS DISTINCT FROM v_request_fp
       OR v_export.format_version IS DISTINCT FROM
          'crx-product-pricing-phase2-v2' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;

    SELECT jsonb_build_object(
      'export_id', e.id,
      'format_version', e.format_version,
      'manifest_fingerprint', e.manifest_fingerprint,
      'expires_at', e.expires_at,
      'rows', (
        SELECT jsonb_agg(jsonb_build_object(
          'product_id', r.product_id,
          'sku', COALESCE(r.sku_snapshot, ''),
          'product_name', r.product_name_snapshot,
          'category', COALESCE(r.category_snapshot, ''),
          'container_size', COALESCE(r.container_size_snapshot, ''),
          'unit_size', COALESCE(r.unit_size_snapshot, ''),
          'inventory_unit', COALESCE(r.inventory_unit_snapshot, ''),
          'identity_fingerprint', r.identity_fingerprint,
          'row_token', r.row_token,
          'row_version', r.row_version,
          'current_cost', COALESCE(public._format_pricing_dollars(r.current_cost_cents), ''),
          'current_tier1_margin_percent', COALESCE(public._format_pricing_margin_percent(r.current_tier1_margin), ''),
          'current_tier1_price', COALESCE(public._format_pricing_dollars(r.current_tier1_price_cents), ''),
          'current_tier2_margin_percent', COALESCE(public._format_pricing_margin_percent(r.current_tier2_margin), ''),
          'current_tier2_price', COALESCE(public._format_pricing_dollars(r.current_tier2_price_cents), ''),
          'current_tier3_margin_percent', COALESCE(public._format_pricing_margin_percent(r.current_tier3_margin), ''),
          'current_tier3_price', COALESCE(public._format_pricing_dollars(r.current_tier3_price_cents), ''),
          'suggested_rate', COALESCE(r.suggested_rate_snapshot, ''),
          'rate_per_acre', COALESCE(r.rate_per_acre_snapshot::text, ''),
          'rate_unit', COALESCE(r.rate_unit_snapshot, ''),
          'use_timing', COALESCE(r.use_timing_snapshot, ''),
          'internal_notes', COALESCE(r.internal_notes_snapshot, ''),
          'quoting_notes', COALESCE(r.quoting_notes_snapshot, '')
        ) ORDER BY r.product_id)
        FROM public.pricing_workbook_export_rows r
        WHERE r.export_id = e.id
      )
    ) INTO v_result
    FROM public.pricing_workbook_exports e
    WHERE e.id = v_export.id;
    RETURN v_result;
  END IF;

  IF p_product_ids IS NOT NULL AND (
    cardinality(p_product_ids) = 0
    OR cardinality(p_product_ids) <>
       (SELECT count(DISTINCT x) FROM unnest(p_product_ids) x)
  ) THEN
    RAISE EXCEPTION 'EXPORT_PRODUCT_IDS_INVALID';
  END IF;

  INSERT INTO public.pricing_workbook_exports(
    created_by, request_fingerprint, manifest_fingerprint,
    idempotency_key, row_count, format_version
  ) VALUES (
    v_actor, v_request_fp, 'pending', p_idempotency_key, 1,
    'crx-product-pricing-phase2-v2'
  ) RETURNING id INTO v_export_id;

  INSERT INTO public.pricing_workbook_export_rows(
    export_id, product_id, sku_snapshot, product_name_snapshot,
    category_snapshot, container_size_snapshot, unit_size_snapshot,
    inventory_unit_snapshot, identity_fingerprint, row_token, row_version,
    current_cost_cents,
    current_tier1_margin, current_tier1_price_cents,
    current_tier2_margin, current_tier2_price_cents,
    current_tier3_margin, current_tier3_price_cents,
    suggested_rate_snapshot, rate_per_acre_snapshot, rate_unit_snapshot,
    use_timing_snapshot, internal_notes_snapshot, quoting_notes_snapshot
  )
  WITH export_products AS (
    SELECT
      p.id, p.sku, p.product_name, p.category,
      p.container_size::text AS container_size_text,
      p.unit_size, p.inventory_unit, p.pricing_version,
      p.suggested_rate, p.rate_per_acre, p.rate_unit,
      p.use_timing, p.internal_notes, p.quoting_notes,
      md5(jsonb_build_object(
        'product_id', p.id,
        'sku', COALESCE(p.sku, ''),
        'product_name', p.product_name,
        'category', COALESCE(p.category, ''),
        'container_size', COALESCE(p.container_size::text, ''),
        'unit_size', COALESCE(p.unit_size, ''),
        'inventory_unit', COALESCE(p.inventory_unit, '')
      )::text) AS identity_fp,
      CASE WHEN p.current_cost IS NULL THEN NULL
        ELSE round(p.current_cost * 100)::bigint END AS cost_cents,
      p.tier1_margin,
      CASE WHEN p.tier1_price IS NULL THEN NULL
        ELSE round(p.tier1_price * 100)::bigint END AS tier1_price_cents,
      p.tier2_margin,
      CASE WHEN p.tier2_price IS NULL THEN NULL
        ELSE round(p.tier2_price * 100)::bigint END AS tier2_price_cents,
      p.tier3_margin,
      CASE WHEN p.tier3_price IS NULL THEN NULL
        ELSE round(p.tier3_price * 100)::bigint END AS tier3_price_cents
    FROM public.products p
    WHERE p.is_active = true
      AND (p_product_ids IS NULL OR p.id = ANY(p_product_ids))
  ), tokenized AS (
    SELECT ep.*,
      md5(jsonb_build_object(
        'export_id', v_export_id,
        'format_version', 'crx-product-pricing-phase2-v2',
        'product_id', ep.id,
        'identity_fingerprint', ep.identity_fp,
        'row_version', ep.pricing_version,
        'current_cost_cents', ep.cost_cents,
        'current_tier1_margin', ep.tier1_margin,
        'current_tier1_price_cents', ep.tier1_price_cents,
        'current_tier2_margin', ep.tier2_margin,
        'current_tier2_price_cents', ep.tier2_price_cents,
        'current_tier3_margin', ep.tier3_margin,
        'current_tier3_price_cents', ep.tier3_price_cents,
        'suggested_rate', ep.suggested_rate,
        'rate_per_acre', ep.rate_per_acre,
        'rate_unit', ep.rate_unit,
        'use_timing', ep.use_timing,
        'internal_notes', ep.internal_notes,
        'quoting_notes', ep.quoting_notes
      )::text) AS token
    FROM export_products ep
  )
  SELECT
    v_export_id, ep.id, ep.sku, ep.product_name,
    ep.category, ep.container_size_text, ep.unit_size, ep.inventory_unit,
    ep.identity_fp, ep.token, ep.pricing_version, ep.cost_cents,
    ep.tier1_margin, ep.tier1_price_cents,
    ep.tier2_margin, ep.tier2_price_cents,
    ep.tier3_margin, ep.tier3_price_cents,
    ep.suggested_rate, ep.rate_per_acre, ep.rate_unit,
    ep.use_timing, ep.internal_notes, ep.quoting_notes
  FROM tokenized ep
  ORDER BY ep.id;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count = 0 THEN RAISE EXCEPTION 'EXPORT_HAS_NO_PRODUCTS'; END IF;
  IF p_product_ids IS NOT NULL
     AND v_row_count <> cardinality(p_product_ids) THEN
    RAISE EXCEPTION 'EXPORT_PRODUCT_NOT_FOUND_OR_INACTIVE';
  END IF;

  SELECT md5(string_agg(
    product_id::text || ':' || identity_fingerprint || ':' ||
      row_version::text || ':' || row_token,
    '|' ORDER BY product_id
  )) INTO v_manifest_fp
  FROM public.pricing_workbook_export_rows
  WHERE export_id = v_export_id;

  UPDATE public.pricing_workbook_exports
  SET row_count = v_row_count, manifest_fingerprint = v_manifest_fp
  WHERE id = v_export_id;

  SELECT jsonb_build_object(
    'export_id', e.id,
    'format_version', e.format_version,
    'manifest_fingerprint', e.manifest_fingerprint,
    'expires_at', e.expires_at,
    'rows', (
      SELECT jsonb_agg(jsonb_build_object(
        'product_id', r.product_id,
        'sku', COALESCE(r.sku_snapshot, ''),
        'product_name', r.product_name_snapshot,
        'category', COALESCE(r.category_snapshot, ''),
        'container_size', COALESCE(r.container_size_snapshot, ''),
        'unit_size', COALESCE(r.unit_size_snapshot, ''),
        'inventory_unit', COALESCE(r.inventory_unit_snapshot, ''),
        'identity_fingerprint', r.identity_fingerprint,
        'row_token', r.row_token,
        'row_version', r.row_version,
        'current_cost', COALESCE(public._format_pricing_dollars(r.current_cost_cents), ''),
        'current_tier1_margin_percent', COALESCE(public._format_pricing_margin_percent(r.current_tier1_margin), ''),
        'current_tier1_price', COALESCE(public._format_pricing_dollars(r.current_tier1_price_cents), ''),
        'current_tier2_margin_percent', COALESCE(public._format_pricing_margin_percent(r.current_tier2_margin), ''),
        'current_tier2_price', COALESCE(public._format_pricing_dollars(r.current_tier2_price_cents), ''),
        'current_tier3_margin_percent', COALESCE(public._format_pricing_margin_percent(r.current_tier3_margin), ''),
        'current_tier3_price', COALESCE(public._format_pricing_dollars(r.current_tier3_price_cents), ''),
        'suggested_rate', COALESCE(r.suggested_rate_snapshot, ''),
        'rate_per_acre', COALESCE(r.rate_per_acre_snapshot::text, ''),
        'rate_unit', COALESCE(r.rate_unit_snapshot, ''),
        'use_timing', COALESCE(r.use_timing_snapshot, ''),
        'internal_notes', COALESCE(r.internal_notes_snapshot, ''),
        'quoting_notes', COALESCE(r.quoting_notes_snapshot, '')
      ) ORDER BY r.product_id)
      FROM public.pricing_workbook_export_rows r
      WHERE r.export_id = e.id
    )
  ) INTO v_result
  FROM public.pricing_workbook_exports e
  WHERE e.id = v_export_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'create_pricing_workbook_export',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_pricing_workbook_export(
  uuid[], uuid, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_pricing_workbook_export(
  uuid[], uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public._product_cost_basis_row_required(
  p_source text,
  p_row_status text,
  p_submitted_row jsonb,
  p_effect jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $function$
  SELECT p_row_status IN ('ready', 'unchanged') AND (
    COALESCE((p_effect->>'pricing_changed')::boolean, false)
    OR p_submitted_row->'basis_selection' = 'true'::jsonb
  )
$function$;

REVOKE ALL ON FUNCTION public._product_cost_basis_row_required(
  text, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preview_product_cost_basis_changes(
  p_source text,
  p_export_id uuid DEFAULT NULL,
  p_rows jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
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
  v_pricing_result jsonb;
  v_change_set_id uuid;
  v_row record;
  v_product public.products%ROWTYPE;
  v_manifest public.pricing_workbook_export_rows%ROWTYPE;
  v_resolved jsonb;
  v_before jsonb;
  v_after jsonb;
  v_changes jsonb;
  v_rate_per_acre numeric;
  v_rate_unit text;
  v_required_basis_count integer;
  v_basis_change_count integer;
  v_info_change_count integer;
  v_ready_count integer;
  v_unchanged_count integer;
  v_conflict_count integer;
  v_invalid_count integer;
  v_final_status text;
  v_error_message text;
  v_error_code text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'COST_BASIS_ROWS_REQUIRED';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'source', p_source,
    'export_id', p_export_id,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'preview_product_cost_basis_changes'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF p_source = 'pricing_worksheet' AND NOT EXISTS (
    SELECT 1
    FROM public.pricing_workbook_exports e
    WHERE e.id = p_export_id
      AND e.created_by = v_actor
      AND e.status = 'active'
      AND e.expires_at > now()
      AND e.format_version = 'crx-product-pricing-phase2-v2'
  ) THEN
    RAISE EXCEPTION 'WORKBOOK_V2_EXPORT_REQUIRED';
  END IF;

  v_pricing_result := public.preview_product_pricing_changes(
    p_source,
    p_export_id,
    p_rows,
    v_actor,
    p_idempotency_key || ':pricing'
  );
  v_change_set_id := (v_pricing_result->>'change_set_id')::uuid;

  -- The Phase 1a engine remains the pricing authority. Mark its effects before
  -- layering the independent Product-information diff onto worksheet rows.
  UPDATE public.pricing_change_set_preview_rows preview_row
  SET effect = preview_row.effect || jsonb_build_object(
    'pricing_changed', preview_row.row_status = 'ready',
    'product_info_changes', '{}'::jsonb
  )
  WHERE preview_row.change_set_id = v_change_set_id
    AND preview_row.row_status IN ('ready', 'unchanged');

  IF p_source = 'pricing_worksheet' THEN
    FOR v_row IN
      SELECT submitted.value AS submitted_row, submitted.sequence,
             preview_row.product_id, preview_row.row_status
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY
        AS submitted(value, sequence)
      JOIN public.pricing_change_set_preview_rows preview_row
        ON preview_row.change_set_id = v_change_set_id
       AND preview_row.sequence = submitted.sequence
      WHERE preview_row.row_status IN ('ready', 'unchanged')
      ORDER BY submitted.sequence
    LOOP
      BEGIN
        IF NOT (
          v_row.submitted_row ? 'suggested_rate'
          AND v_row.submitted_row ? 'rate_per_acre'
          AND v_row.submitted_row ? 'rate_unit'
          AND v_row.submitted_row ? 'use_timing'
          AND v_row.submitted_row ? 'internal_notes'
          AND v_row.submitted_row ? 'quoting_notes'
        ) THEN
          RAISE EXCEPTION 'PRODUCT_INFO_FIELDS_REQUIRED';
        END IF;

        SELECT * INTO STRICT v_manifest
        FROM public.pricing_workbook_export_rows r
        WHERE r.export_id = p_export_id
          AND r.product_id = v_row.product_id;
        IF v_row.submitted_row->>'row_token' IS DISTINCT FROM v_manifest.row_token
           OR (v_row.submitted_row->>'row_version')::bigint
              IS DISTINCT FROM v_manifest.row_version THEN
          RAISE EXCEPTION 'WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED';
        END IF;

        SELECT * INTO STRICT v_product
        FROM public.products p
        WHERE p.id = v_row.product_id;
        IF v_product.pricing_version IS DISTINCT FROM v_manifest.row_version THEN
          RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
        END IF;

        IF NULLIF(btrim(v_row.submitted_row->>'rate_per_acre'), '') IS NULL THEN
          v_rate_per_acre := NULL;
        ELSE
          v_rate_per_acre := (v_row.submitted_row->>'rate_per_acre')::numeric;
          IF v_rate_per_acre::text IN ('NaN', 'Infinity', '-Infinity')
             OR v_rate_per_acre < 0 THEN
            RAISE EXCEPTION 'PRODUCT_RATE_PER_ACRE_INVALID';
          END IF;
        END IF;
        v_rate_unit := NULLIF(btrim(v_row.submitted_row->>'rate_unit'), '');

        -- An unchanged legacy unit is grandfathered. Every new value must be a
        -- live frozen unit key compatible with the Product form (or type both).
        IF v_rate_unit IS DISTINCT FROM v_manifest.rate_unit_snapshot
           AND v_rate_unit IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public.unit_conversions uc
             WHERE lower(uc.unit) = lower(v_rate_unit)
               AND (
                 v_product.product_form IS NULL
                 OR uc.unit_type = v_product.product_form
                 OR uc.unit_type = 'both'
               )
           ) THEN
          RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID';
        END IF;

        v_before := jsonb_build_object(
          'suggested_rate', NULLIF(btrim(v_manifest.suggested_rate_snapshot), ''),
          'rate_per_acre', v_manifest.rate_per_acre_snapshot,
          'rate_unit', NULLIF(btrim(v_manifest.rate_unit_snapshot), ''),
          'use_timing', NULLIF(btrim(v_manifest.use_timing_snapshot), ''),
          'internal_notes', NULLIF(btrim(v_manifest.internal_notes_snapshot), ''),
          'quoting_notes', NULLIF(btrim(v_manifest.quoting_notes_snapshot), '')
        );
        v_after := jsonb_build_object(
          'suggested_rate', NULLIF(btrim(v_row.submitted_row->>'suggested_rate'), ''),
          'rate_per_acre', v_rate_per_acre,
          'rate_unit', v_rate_unit,
          'use_timing', NULLIF(btrim(v_row.submitted_row->>'use_timing'), ''),
          'internal_notes', NULLIF(btrim(v_row.submitted_row->>'internal_notes'), ''),
          'quoting_notes', NULLIF(btrim(v_row.submitted_row->>'quoting_notes'), '')
        );
        v_changes := '{}'::jsonb;
        IF v_before->'suggested_rate' IS DISTINCT FROM v_after->'suggested_rate' THEN
          v_changes := v_changes || jsonb_build_object(
            'suggested_rate', jsonb_build_object(
              'before', v_before->'suggested_rate', 'after', v_after->'suggested_rate'
            )
          );
        END IF;
        IF v_before->'rate_per_acre' IS DISTINCT FROM v_after->'rate_per_acre' THEN
          v_changes := v_changes || jsonb_build_object(
            'rate_per_acre', jsonb_build_object(
              'before', v_before->'rate_per_acre', 'after', v_after->'rate_per_acre'
            )
          );
        END IF;
        IF v_before->'rate_unit' IS DISTINCT FROM v_after->'rate_unit' THEN
          v_changes := v_changes || jsonb_build_object(
            'rate_unit', jsonb_build_object(
              'before', v_before->'rate_unit', 'after', v_after->'rate_unit'
            )
          );
        END IF;
        IF v_before->'use_timing' IS DISTINCT FROM v_after->'use_timing' THEN
          v_changes := v_changes || jsonb_build_object(
            'use_timing', jsonb_build_object(
              'before', v_before->'use_timing', 'after', v_after->'use_timing'
            )
          );
        END IF;
        IF v_before->'internal_notes' IS DISTINCT FROM v_after->'internal_notes' THEN
          v_changes := v_changes || jsonb_build_object(
            'internal_notes', jsonb_build_object(
              'before', v_before->'internal_notes', 'after', v_after->'internal_notes'
            )
          );
        END IF;
        IF v_before->'quoting_notes' IS DISTINCT FROM v_after->'quoting_notes' THEN
          v_changes := v_changes || jsonb_build_object(
            'quoting_notes', jsonb_build_object(
              'before', v_before->'quoting_notes', 'after', v_after->'quoting_notes'
            )
          );
        END IF;

        IF v_changes <> '{}'::jsonb THEN
          INSERT INTO public.product_info_change_set_rows(
            change_set_id, product_id, expected_version,
            before_values, after_values, changes, output_fingerprint
          ) VALUES (
            v_change_set_id, v_product.id, v_manifest.row_version,
            v_before, v_after, v_changes, md5(v_after::text)
          );

          -- Rate edits alter the trigger-derived per-acre display even when
          -- cost and tier dollars are unchanged. Rebind the retained pricing
          -- output and preview effect to the approved after-rate values.
          UPDATE public.pricing_change_set_rows pricing_row
          SET output_tier1_price_per_acre_cents = CASE
                WHEN public.product_price_per_acre(
                  pricing_row.output_tier1_price_cents::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) IS NULL THEN NULL
                ELSE round(public.product_price_per_acre(
                  pricing_row.output_tier1_price_cents::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) * 100)::bigint END,
              output_tier2_price_per_acre_cents = CASE
                WHEN public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) IS NULL THEN NULL
                ELSE round(public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) * 100)::bigint END,
              output_tier3_price_per_acre_cents = CASE
                WHEN public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) IS NULL THEN NULL
                ELSE round(public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) * 100)::bigint END
          WHERE pricing_row.change_set_id = v_change_set_id
            AND pricing_row.product_id = v_product.id;

          UPDATE public.pricing_change_set_rows pricing_row
          SET output_fingerprint = md5(jsonb_build_object(
            'cost_cents', pricing_row.output_cost_cents,
            'tier1_margin', pricing_row.output_tier1_margin,
            'tier2_margin', pricing_row.output_tier2_margin,
            'tier3_margin', pricing_row.output_tier3_margin,
            'tier1_price_cents', pricing_row.output_tier1_price_cents,
            'tier2_price_cents', pricing_row.output_tier2_price_cents,
            'tier3_price_cents', pricing_row.output_tier3_price_cents,
            'tier1_gross_margin', pricing_row.output_tier1_gross_margin,
            'tier2_gross_margin', pricing_row.output_tier2_gross_margin,
            'tier3_gross_margin', pricing_row.output_tier3_gross_margin,
            'tier1_price_per_acre_cents', pricing_row.output_tier1_price_per_acre_cents,
            'tier2_price_per_acre_cents', pricing_row.output_tier2_price_per_acre_cents,
            'tier3_price_per_acre_cents', pricing_row.output_tier3_price_per_acre_cents
          )::text)
          WHERE pricing_row.change_set_id = v_change_set_id
            AND pricing_row.product_id = v_product.id;

          -- Bind the information row to the derived per-acre values shown in
          -- preview too. This detects conversion-factor drift even when the row
          -- has no pricing delta (and therefore no pricing output fingerprint).
          UPDATE public.product_info_change_set_rows info_row
          SET output_fingerprint = md5(jsonb_build_object(
            'after_values', info_row.after_values,
            'tier1_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(pricing_row.output_tier1_price_cents::numeric / 100,
                       v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(pricing_row.output_tier1_price_cents::numeric / 100,
                       v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier2_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier3_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END
          )::text)
          FROM public.pricing_change_set_rows pricing_row
          WHERE info_row.change_set_id = v_change_set_id
            AND info_row.product_id = v_product.id
            AND pricing_row.change_set_id = info_row.change_set_id
            AND pricing_row.product_id = info_row.product_id;

          -- Info-only rows have no pricing row to join; bind their currently
          -- approved tier prices through the same fingerprint shape.
          UPDATE public.product_info_change_set_rows info_row
          SET output_fingerprint = md5(jsonb_build_object(
            'after_values', info_row.after_values,
            'tier1_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              v_product.tier1_price, v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              v_product.tier1_price, v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier2_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier3_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END
          )::text)
          WHERE info_row.change_set_id = v_change_set_id
            AND info_row.product_id = v_product.id
            AND NOT EXISTS (
              SELECT 1 FROM public.pricing_change_set_rows pricing_row
              WHERE pricing_row.change_set_id = info_row.change_set_id
                AND pricing_row.product_id = info_row.product_id
            );

          UPDATE public.pricing_change_set_preview_rows
          SET row_status = 'ready',
              effect = effect || jsonb_build_object(
                'product_info_changes', v_changes,
                'tier1_price_per_acre_cents', CASE
                  WHEN public.product_price_per_acre(
                    (effect->>'tier1_price')::numeric,
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) IS NULL THEN NULL
                  ELSE round(public.product_price_per_acre(
                    (effect->>'tier1_price')::numeric,
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) * 100)::bigint END,
                'tier2_price_per_acre_cents', CASE
                  WHEN public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier2_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) IS NULL THEN NULL
                  ELSE round(public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier2_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) * 100)::bigint END,
                'tier3_price_per_acre_cents', CASE
                  WHEN public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier3_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) IS NULL THEN NULL
                  ELSE round(public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier3_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) * 100)::bigint END
              )
          WHERE change_set_id = v_change_set_id
            AND sequence = v_row.sequence;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
        v_error_code := CASE
          WHEN v_error_message ~ '^[A-Z0-9_]+$' THEN v_error_message
          ELSE 'PRODUCT_INFO_ROW_INVALID'
        END;
        UPDATE public.pricing_change_set_preview_rows
        SET row_status = CASE WHEN v_error_code = 'PRICING_ROW_CONFLICT'
                              THEN 'conflict' ELSE 'invalid' END,
            error_code = v_error_code,
            effect = NULL
        WHERE change_set_id = v_change_set_id
          AND sequence = v_row.sequence;
      END;
    END LOOP;
  END IF;

  -- Resolve cost basis only for actual pricing changes or an explicit basis
  -- selection. Info-only rows create no synthetic/no-op basis record.
  FOR v_row IN
    SELECT submitted.value AS submitted_row, preview_row.*
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
      AS submitted(value, sequence)
    JOIN public.pricing_change_set_preview_rows preview_row
      ON preview_row.change_set_id = v_change_set_id
     AND preview_row.sequence = submitted.sequence
    WHERE public._product_cost_basis_row_required(
      p_source,
      preview_row.row_status,
      submitted.value,
      preview_row.effect
    )
    ORDER BY submitted.sequence
  LOOP
    v_resolved := public._resolve_product_cost_basis_row(v_row.submitted_row);
    INSERT INTO public.product_cost_basis_change_rows(
      pricing_change_set_id, product_id, expected_version,
      expected_active_basis_id, basis_type,
      cost_cents, supplier_price_observation_id, purchase_order_item_id,
      selection_source, reason, force_selection
    ) VALUES (
      v_change_set_id,
      (v_resolved->>'product_id')::uuid,
      (v_resolved->>'expected_version')::bigint,
      (SELECT active.id
       FROM public.product_cost_basis active
       WHERE active.product_id = (v_resolved->>'product_id')::uuid
         AND active.effective_to IS NULL),
      v_resolved->>'basis_type',
      (v_resolved->>'cost_cents')::bigint,
      NULLIF(v_resolved->>'supplier_price_observation_id', '')::uuid,
      NULLIF(v_resolved->>'purchase_order_item_id', '')::uuid,
      v_resolved->>'selection_source',
      v_resolved->>'reason',
      (v_resolved->>'force_selection')::boolean
    )
    ON CONFLICT (pricing_change_set_id, product_id) DO NOTHING;
  END LOOP;

  SELECT count(*)::integer INTO v_required_basis_count
  FROM public.pricing_change_set_preview_rows preview_row
  WHERE preview_row.change_set_id = v_change_set_id
    AND public._product_cost_basis_row_required(
      p_source,
      preview_row.row_status,
      preview_row.submitted_row,
      preview_row.effect
    );
  IF (SELECT count(*) FROM public.product_cost_basis_change_rows
      WHERE pricing_change_set_id = v_change_set_id)
     IS DISTINCT FROM v_required_basis_count THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_SHAPE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis_change_rows r
    JOIN public.pricing_change_set_preview_rows preview_row
      ON preview_row.change_set_id = r.pricing_change_set_id
     AND preview_row.product_id = r.product_id
    WHERE r.pricing_change_set_id = v_change_set_id
      AND public._resolve_product_cost_basis_row(preview_row.submitted_row)
          IS DISTINCT FROM jsonb_build_object(
            'product_id', r.product_id,
            'expected_version', r.expected_version,
            'basis_type', r.basis_type,
            'cost_cents', r.cost_cents,
            'supplier_price_observation_id', r.supplier_price_observation_id,
            'purchase_order_item_id', r.purchase_order_item_id,
            'selection_source', r.selection_source,
            'reason', r.reason,
            'force_selection', r.force_selection
          )
  ) THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_DRIFT';
  END IF;

  SELECT count(*)::integer INTO v_basis_change_count
  FROM public.product_cost_basis_change_rows r
  JOIN public.products p ON p.id = r.product_id
  LEFT JOIN public.product_cost_basis active
    ON active.product_id = r.product_id AND active.effective_to IS NULL
  WHERE r.pricing_change_set_id = v_change_set_id
    AND (
      round(p.current_cost::numeric * 100)::bigint IS DISTINCT FROM r.cost_cents
      OR r.force_selection
      OR active.id IS NULL
    );

  SELECT count(*)::integer INTO v_info_change_count
  FROM public.product_info_change_set_rows
  WHERE change_set_id = v_change_set_id;
  SELECT
    count(*) FILTER (WHERE row_status = 'ready')::integer,
    count(*) FILTER (WHERE row_status = 'unchanged')::integer,
    count(*) FILTER (WHERE row_status = 'conflict')::integer,
    count(*) FILTER (WHERE row_status = 'invalid')::integer
  INTO v_ready_count, v_unchanged_count, v_conflict_count, v_invalid_count
  FROM public.pricing_change_set_preview_rows
  WHERE change_set_id = v_change_set_id;

  v_final_status := CASE
    WHEN v_conflict_count > 0 OR v_invalid_count > 0 THEN 'invalid'
    WHEN v_ready_count > 0 THEN 'previewed'
    ELSE 'no_changes'
  END;
  UPDATE public.pricing_change_sets
  SET row_count = v_ready_count, status = v_final_status
  WHERE id = v_change_set_id;

  SELECT jsonb_build_object(
    'change_set_id', c.id,
    'request_fingerprint', c.request_fingerprint,
    'source', c.source,
    'status', c.status,
    'expires_at', c.expires_at,
    'submitted_row_count', c.submitted_row_count,
    'ready_count', v_ready_count,
    'unchanged_count', v_unchanged_count,
    'conflict_count', v_conflict_count,
    'invalid_count', v_invalid_count,
    'pricing_change_count', (
      SELECT count(*) FROM public.pricing_change_set_rows r
      WHERE r.change_set_id = c.id
    ),
    'product_info_change_count', v_info_change_count,
    'basis_change_count', v_basis_change_count,
    'apply_allowed', (
      c.status = 'previewed'
      OR (c.status = 'no_changes' AND v_basis_change_count > 0)
    ),
    'rows', (
      SELECT jsonb_agg(to_jsonb(r) - 'change_set_id' ORDER BY r.sequence)
      FROM public.pricing_change_set_preview_rows r
      WHERE r.change_set_id = c.id
    )
  ) INTO v_pricing_result
  FROM public.pricing_change_sets c
  WHERE c.id = v_change_set_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'preview_product_cost_basis_changes',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_pricing_result
    )
  );
  RETURN v_pricing_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_product_cost_basis_changes(
  text, uuid, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_product_cost_basis_changes(
  text, uuid, jsonb, uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_and_version_product_pricing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_core_changed boolean;
  v_per_acre_changed boolean;
  v_info_changed boolean;
  v_actor uuid;
  v_change_set_id uuid;
  v_source text;
BEGIN
  IF NEW.current_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.tier1_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.tier2_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR NEW.tier3_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR round(NEW.current_cost, 2) IS DISTINCT FROM NEW.current_cost
     OR round(NEW.tier1_price, 2) IS DISTINCT FROM NEW.tier1_price
     OR round(NEW.tier2_price, 2) IS DISTINCT FROM NEW.tier2_price
     OR round(NEW.tier3_price, 2) IS DISTINCT FROM NEW.tier3_price THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_CENT_SCALE_INVALID';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.pricing_version := 1;
    RETURN NEW;
  END IF;
  IF NEW.pricing_version IS DISTINCT FROM OLD.pricing_version THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_VERSION_MANAGED_BY_DATABASE';
  END IF;
  v_core_changed := OLD.current_cost IS DISTINCT FROM NEW.current_cost
    OR OLD.tier1_margin IS DISTINCT FROM NEW.tier1_margin
    OR OLD.tier2_margin IS DISTINCT FROM NEW.tier2_margin
    OR OLD.tier3_margin IS DISTINCT FROM NEW.tier3_margin
    OR OLD.tier1_price IS DISTINCT FROM NEW.tier1_price
    OR OLD.tier2_price IS DISTINCT FROM NEW.tier2_price
    OR OLD.tier3_price IS DISTINCT FROM NEW.tier3_price
    OR OLD.tier1_gross_margin IS DISTINCT FROM NEW.tier1_gross_margin
    OR OLD.tier2_gross_margin IS DISTINCT FROM NEW.tier2_gross_margin
    OR OLD.tier3_gross_margin IS DISTINCT FROM NEW.tier3_gross_margin;
  v_per_acre_changed :=
    OLD.tier1_price_per_acre IS DISTINCT FROM NEW.tier1_price_per_acre
    OR OLD.tier2_price_per_acre IS DISTINCT FROM NEW.tier2_price_per_acre
    OR OLD.tier3_price_per_acre IS DISTINCT FROM NEW.tier3_price_per_acre;
  v_info_changed :=
    OLD.suggested_rate IS DISTINCT FROM NEW.suggested_rate
    OR OLD.rate_per_acre IS DISTINCT FROM NEW.rate_per_acre
    OR OLD.rate_unit IS DISTINCT FROM NEW.rate_unit
    OR OLD.use_timing IS DISTINCT FROM NEW.use_timing
    OR OLD.internal_notes IS DISTINCT FROM NEW.internal_notes
    OR OLD.quoting_notes IS DISTINCT FROM NEW.quoting_notes;

  IF (v_core_changed OR v_info_changed)
     AND current_setting('crx.pricing_authorized', true) = 'phase1a' THEN
    v_actor := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
    v_change_set_id := NULLIF(
      current_setting('crx.pricing_change_set_id', true), ''
    )::uuid;
    v_source := NULLIF(current_setting('crx.pricing_source', true), '');
    IF v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
       OR v_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline')
       OR NOT public.is_admin()
       OR NOT EXISTS (
         SELECT 1
         FROM public.pricing_change_sets c
         WHERE c.id = v_change_set_id
           AND c.created_by = v_actor
           AND c.source = v_source
           AND c.status = 'previewed'
           AND (
             EXISTS (
               SELECT 1 FROM public.pricing_change_set_rows pricing_row
               WHERE pricing_row.change_set_id = c.id
                 AND pricing_row.product_id = NEW.id
             )
             OR EXISTS (
               SELECT 1 FROM public.product_info_change_set_rows info_row
               WHERE info_row.change_set_id = c.id
                 AND info_row.product_id = NEW.id
             )
           )
       ) THEN
      RAISE EXCEPTION 'PRODUCT_PRICING_CONTEXT_INVALID';
    END IF;
  END IF;
  IF v_core_changed OR v_per_acre_changed OR v_info_changed THEN
    NEW.pricing_version := OLD.pricing_version + 1;
  ELSE
    NEW.pricing_version := OLD.pricing_version;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_and_version_product_pricing()
  FROM PUBLIC, anon, authenticated, service_role;

-- Apply pricing and Product-information changes through one Product UPDATE per
-- row. This is the atomic boundary that guarantees a combined edit increments
-- pricing_version once and writes at most one cost_history record, while an
-- information-only edit writes no cost_history record.
CREATE OR REPLACE FUNCTION public.apply_product_pricing_change_set(
  p_change_set_id uuid,
  p_request_fingerprint text,
  p_performed_by uuid DEFAULT NULL,
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
  v_idem_request_fp text;
  v_change_set public.pricing_change_sets%ROWTYPE;
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_pricing public.pricing_change_set_rows%ROWTYPE;
  v_info public.product_info_change_set_rows%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_target record;
  v_has_pricing boolean;
  v_has_info boolean;
  v_calc jsonb;
  v_output jsonb;
  v_rate_per_acre numeric;
  v_rate_unit text;
  v_live_info jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_request_fingerprint IS NULL OR btrim(p_request_fingerprint) = '' THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_REQUIRED';
  END IF;

  v_idem_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'change_set_id', p_change_set_id,
    'request_fingerprint', p_request_fingerprint
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'apply_product_pricing_change_set'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_idem_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pricing_change_sets
    WHERE apply_idempotency_key = p_idempotency_key
      AND id IS DISTINCT FROM p_change_set_id
  ) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_CHANGE_SET';
  END IF;

  SELECT * INTO v_change_set
  FROM public.pricing_change_sets
  WHERE id = p_change_set_id
  FOR UPDATE;
  IF NOT FOUND OR v_change_set.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'CHANGE_SET_NOT_FOUND';
  END IF;
  IF v_change_set.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_MISMATCH';
  END IF;
  IF v_change_set.status = 'applied' THEN
    IF v_change_set.apply_idempotency_key IS NOT DISTINCT FROM p_idempotency_key THEN
      RETURN v_change_set.apply_result;
    END IF;
    RAISE EXCEPTION 'CHANGE_SET_ALREADY_APPLIED';
  END IF;
  IF v_change_set.status <> 'previewed' OR v_change_set.row_count <= 0
     OR v_change_set.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_SET_INVALID_OR_EXPIRED';
  END IF;

  -- Preserve the legacy Product-page Phase 1a editor while the global supplier
  -- flag is off, but a v2 worksheet or any companion Phase 2 row may only enter
  -- through the outer wrapper that owns evidence, basis, and info atomicity.
  IF (
       (v_change_set.source = 'pricing_worksheet' AND EXISTS (
          SELECT 1 FROM public.pricing_workbook_exports gated_export
          WHERE gated_export.id = v_change_set.export_id
            AND gated_export.format_version = 'crx-product-pricing-phase2-v2'
        ))
       OR EXISTS (
          SELECT 1 FROM public.product_info_change_set_rows info_row
          WHERE info_row.change_set_id = p_change_set_id
        )
       OR EXISTS (
          SELECT 1 FROM public.product_cost_basis_change_rows basis_row
          WHERE basis_row.pricing_change_set_id = p_change_set_id
        )
     )
     AND (
       current_setting('crx.cost_basis_authorized', true) IS DISTINCT FROM 'phase2'
       OR current_setting('crx.cost_basis_actor', true) IS DISTINCT FROM v_actor::text
       OR current_setting('crx.cost_basis_change_set_id', true)
          IS DISTINCT FROM p_change_set_id::text
     ) THEN
    RAISE EXCEPTION 'PRODUCT_COST_BASIS_CONTEXT_REQUIRED';
  END IF;

  IF v_change_set.export_id IS NOT NULL THEN
    SELECT * INTO v_export
    FROM public.pricing_workbook_exports
    WHERE id = v_change_set.export_id
    FOR UPDATE;
    IF NOT FOUND OR v_export.created_by IS DISTINCT FROM v_actor
       OR v_export.status <> 'active' OR v_export.expires_at <= now() THEN
      RAISE EXCEPTION 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED';
    END IF;
    IF v_change_set.source = 'pricing_worksheet'
       AND v_export.format_version <> 'crx-product-pricing-phase2-v2' THEN
      RAISE EXCEPTION 'WORKBOOK_V2_EXPORT_REQUIRED';
    END IF;
  END IF;

  -- Lock the complete union in deterministic order before validating any row.
  PERFORM p.id
  FROM public.products p
  JOIN (
    SELECT product_id FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    UNION
    SELECT product_id FROM public.product_info_change_set_rows
    WHERE change_set_id = p_change_set_id
  ) changed ON changed.product_id = p.id
  ORDER BY p.id
  FOR UPDATE OF p;

  -- All apply paths lock Product first (the outer Phase 2 wrapper already does
  -- so for basis rows), then every conversion row used by per-acre calculation.
  -- Keeping this order identical for info-only and combined rows avoids a
  -- Product/unit deadlock while freezing conversion meaning through commit.
  PERFORM uc.unit
  FROM public.unit_conversions uc
  JOIN public.products p ON true
  JOIN (
    SELECT product_id FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    UNION
    SELECT product_id FROM public.product_info_change_set_rows
    WHERE change_set_id = p_change_set_id
  ) changed ON changed.product_id = p.id
  LEFT JOIN public.product_info_change_set_rows info_row
    ON info_row.change_set_id = p_change_set_id
   AND info_row.product_id = p.id
  WHERE lower(uc.unit) IN (
    lower(COALESCE(info_row.after_values->>'rate_unit', p.rate_unit)),
    lower(p.inventory_unit),
    lower(p.unit_size)
  )
  ORDER BY lower(uc.unit), uc.unit
  FOR UPDATE OF uc;

  IF v_change_set.row_count IS DISTINCT FROM (
    SELECT count(*) FROM (
      SELECT product_id FROM public.pricing_change_set_rows
      WHERE change_set_id = p_change_set_id
      UNION
      SELECT product_id FROM public.product_info_change_set_rows
      WHERE change_set_id = p_change_set_id
    ) changed
  ) THEN
    RAISE EXCEPTION 'PRICING_CHANGE_SET_SHAPE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pricing_change_set_rows r
    LEFT JOIN public.products p ON p.id = r.product_id
    WHERE r.change_set_id = p_change_set_id
      AND (p.id IS NULL OR NOT p.is_active
        OR p.pricing_version IS DISTINCT FROM r.expected_version
        OR md5(jsonb_build_object(
          'product_id', p.id,
          'sku', COALESCE(p.sku, ''),
          'product_name', p.product_name,
          'category', COALESCE(p.category, ''),
          'container_size', COALESCE(p.container_size::text, ''),
          'unit_size', COALESCE(p.unit_size, ''),
          'inventory_unit', COALESCE(p.inventory_unit, '')
        )::text) IS DISTINCT FROM r.identity_fingerprint)
  ) OR EXISTS (
    SELECT 1
    FROM public.product_info_change_set_rows r
    LEFT JOIN public.products p ON p.id = r.product_id
    LEFT JOIN public.pricing_workbook_export_rows manifest
      ON manifest.export_id = v_change_set.export_id
     AND manifest.product_id = r.product_id
    WHERE r.change_set_id = p_change_set_id
      AND (p.id IS NULL OR NOT p.is_active
        OR manifest.product_id IS NULL
        OR manifest.row_version IS DISTINCT FROM r.expected_version
        OR md5(jsonb_build_object(
          'product_id', p.id,
          'sku', COALESCE(p.sku, ''),
          'product_name', p.product_name,
          'category', COALESCE(p.category, ''),
          'container_size', COALESCE(p.container_size::text, ''),
          'unit_size', COALESCE(p.unit_size, ''),
          'inventory_unit', COALESCE(p.inventory_unit, '')
        )::text) IS DISTINCT FROM manifest.identity_fingerprint
        OR p.pricing_version IS DISTINCT FROM r.expected_version
        OR r.changes IS DISTINCT FROM (
          SELECT COALESCE(jsonb_object_agg(
            before_item.key,
            jsonb_build_object('before', before_item.value, 'after', after_item.value)
          ), '{}'::jsonb)
          FROM jsonb_each(r.before_values) before_item
          JOIN jsonb_each(r.after_values) after_item USING (key)
          WHERE before_item.value IS DISTINCT FROM after_item.value
        )
        OR jsonb_build_object(
          'suggested_rate', NULLIF(btrim(p.suggested_rate), ''),
          'rate_per_acre', p.rate_per_acre,
          'rate_unit', NULLIF(btrim(p.rate_unit), ''),
          'use_timing', NULLIF(btrim(p.use_timing), ''),
          'internal_notes', NULLIF(btrim(p.internal_notes), ''),
          'quoting_notes', NULLIF(btrim(p.quoting_notes), '')
        ) IS DISTINCT FROM r.before_values)
  ) THEN
    RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_info_change_set_rows r
    JOIN public.products p ON p.id = r.product_id
    WHERE r.change_set_id = p_change_set_id
      AND r.after_values->'rate_unit' IS DISTINCT FROM r.before_values->'rate_unit'
      AND r.after_values->>'rate_unit' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.unit_conversions uc
        WHERE lower(uc.unit) = lower(r.after_values->>'rate_unit')
          AND (p.product_form IS NULL OR uc.unit_type = p.product_form
               OR uc.unit_type = 'both')
      )
  ) THEN
    RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID';
  END IF;

  -- A rate edit is approved together with the per-acre amounts displayed in
  -- preview. Recompute those amounts after Product/conversion locks and fail
  -- closed if mutable conversion configuration drifted since preview.
  IF EXISTS (
    SELECT 1
    FROM public.product_info_change_set_rows info_row
    JOIN public.products p ON p.id = info_row.product_id
    JOIN public.pricing_change_set_preview_rows preview_row
      ON preview_row.change_set_id = info_row.change_set_id
     AND preview_row.product_id = info_row.product_id
    LEFT JOIN public.pricing_change_set_rows pricing_row
      ON pricing_row.change_set_id = info_row.change_set_id
     AND pricing_row.product_id = info_row.product_id
    WHERE info_row.change_set_id = p_change_set_id
      AND (info_row.changes ? 'rate_per_acre' OR info_row.changes ? 'rate_unit')
      AND (
        preview_row.effect->'tier1_price_per_acre_cents' IS DISTINCT FROM COALESCE(to_jsonb(
          CASE WHEN public.product_price_per_acre(
            COALESCE(pricing_row.output_tier1_price_cents::numeric / 100,
                     p.tier1_price),
            (info_row.after_values->>'rate_per_acre')::numeric,
            info_row.after_values->>'rate_unit', p.inventory_unit, p.unit_size
          ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
            COALESCE(pricing_row.output_tier1_price_cents::numeric / 100,
                     p.tier1_price),
            (info_row.after_values->>'rate_per_acre')::numeric,
            info_row.after_values->>'rate_unit', p.inventory_unit, p.unit_size
          ) * 100)::bigint END
        ), 'null'::jsonb)
        OR preview_row.effect->'tier2_price_per_acre_cents' IS DISTINCT FROM COALESCE(to_jsonb(
          CASE WHEN public.product_price_per_acre(
            COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0)::numeric / 100,
                     NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                     NULLIF(p.tier2_price, 0), p.tier1_price),
            (info_row.after_values->>'rate_per_acre')::numeric,
            info_row.after_values->>'rate_unit', p.inventory_unit, p.unit_size
          ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
            COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0)::numeric / 100,
                     NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                     NULLIF(p.tier2_price, 0), p.tier1_price),
            (info_row.after_values->>'rate_per_acre')::numeric,
            info_row.after_values->>'rate_unit', p.inventory_unit, p.unit_size
          ) * 100)::bigint END
        ), 'null'::jsonb)
        OR preview_row.effect->'tier3_price_per_acre_cents' IS DISTINCT FROM COALESCE(to_jsonb(
          CASE WHEN public.product_price_per_acre(
            COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0)::numeric / 100,
                     NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                     NULLIF(p.tier3_price, 0), p.tier1_price),
            (info_row.after_values->>'rate_per_acre')::numeric,
            info_row.after_values->>'rate_unit', p.inventory_unit, p.unit_size
          ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
            COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0)::numeric / 100,
                     NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                     NULLIF(p.tier3_price, 0), p.tier1_price),
            (info_row.after_values->>'rate_per_acre')::numeric,
            info_row.after_values->>'rate_unit', p.inventory_unit, p.unit_size
          ) * 100)::bigint END
        ), 'null'::jsonb)
      )
  ) THEN
    RAISE EXCEPTION 'CHANGE_SET_OUTPUT_DRIFT';
  END IF;

  -- Recalculate every retained pricing output against the approved after-rate
  -- values, closing drift between preview and apply.
  FOR v_pricing IN
    SELECT * FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_product FROM public.products WHERE id = v_pricing.product_id;
    SELECT * INTO v_info
    FROM public.product_info_change_set_rows
    WHERE change_set_id = p_change_set_id AND product_id = v_pricing.product_id;
    v_has_info := FOUND;
    v_rate_per_acre := CASE WHEN v_has_info
      THEN (v_info.after_values->>'rate_per_acre')::numeric
      ELSE v_product.rate_per_acre END;
    v_rate_unit := CASE WHEN v_has_info
      THEN v_info.after_values->>'rate_unit'
      ELSE v_product.rate_unit END;
    v_calc := public._calculate_product_pricing(
      v_pricing.pricing_mode,
      v_pricing.input_cost_cents::numeric / 100,
      v_pricing.input_tier1_margin, v_pricing.input_tier2_margin,
      v_pricing.input_tier3_margin,
      CASE WHEN v_pricing.input_tier1_price_cents IS NULL THEN NULL
        ELSE v_pricing.input_tier1_price_cents::numeric / 100 END,
      CASE WHEN v_pricing.input_tier2_price_cents IS NULL THEN NULL
        ELSE v_pricing.input_tier2_price_cents::numeric / 100 END,
      CASE WHEN v_pricing.input_tier3_price_cents IS NULL THEN NULL
        ELSE v_pricing.input_tier3_price_cents::numeric / 100 END
    );
    v_output := jsonb_build_object(
      'cost_cents', round((v_calc->>'current_cost')::numeric * 100)::bigint,
      'tier1_margin', (v_calc->>'tier1_margin')::numeric,
      'tier2_margin', (v_calc->>'tier2_margin')::numeric,
      'tier3_margin', (v_calc->>'tier3_margin')::numeric,
      'tier1_price_cents', round((v_calc->>'tier1_price')::numeric * 100)::bigint,
      'tier2_price_cents', round((v_calc->>'tier2_price')::numeric * 100)::bigint,
      'tier3_price_cents', round((v_calc->>'tier3_price')::numeric * 100)::bigint,
      'tier1_gross_margin', v_calc->'tier1_gross_margin',
      'tier2_gross_margin', v_calc->'tier2_gross_margin',
      'tier3_gross_margin', v_calc->'tier3_gross_margin',
      'tier1_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
        (v_calc->>'tier1_price')::numeric, v_rate_per_acre, v_rate_unit,
        v_product.inventory_unit, v_product.unit_size
      ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
        (v_calc->>'tier1_price')::numeric, v_rate_per_acre, v_rate_unit,
        v_product.inventory_unit, v_product.unit_size
      ) * 100)::bigint END,
      'tier2_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
        COALESCE(NULLIF((v_calc->>'tier2_price')::numeric, 0),
                 (v_calc->>'tier1_price')::numeric),
        v_rate_per_acre, v_rate_unit, v_product.inventory_unit, v_product.unit_size
      ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
        COALESCE(NULLIF((v_calc->>'tier2_price')::numeric, 0),
                 (v_calc->>'tier1_price')::numeric),
        v_rate_per_acre, v_rate_unit, v_product.inventory_unit, v_product.unit_size
      ) * 100)::bigint END,
      'tier3_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
        COALESCE(NULLIF((v_calc->>'tier3_price')::numeric, 0),
                 (v_calc->>'tier1_price')::numeric),
        v_rate_per_acre, v_rate_unit, v_product.inventory_unit, v_product.unit_size
      ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
        COALESCE(NULLIF((v_calc->>'tier3_price')::numeric, 0),
                 (v_calc->>'tier1_price')::numeric),
        v_rate_per_acre, v_rate_unit, v_product.inventory_unit, v_product.unit_size
      ) * 100)::bigint END
    );
    IF md5(v_output::text) IS DISTINCT FROM v_pricing.output_fingerprint THEN
      RAISE EXCEPTION 'CHANGE_SET_OUTPUT_DRIFT';
    END IF;
  END LOOP;

  FOR v_target IN
    SELECT product_id FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    UNION
    SELECT product_id FROM public.product_info_change_set_rows
    WHERE change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_pricing FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id AND product_id = v_target.product_id;
    v_has_pricing := FOUND;
    SELECT * INTO v_info FROM public.product_info_change_set_rows
    WHERE change_set_id = p_change_set_id AND product_id = v_target.product_id;
    v_has_info := FOUND;

    PERFORM set_config('crx.pricing_authorized', 'phase1a', true);
    PERFORM set_config('crx.pricing_actor', v_actor::text, true);
    PERFORM set_config('crx.pricing_source', v_change_set.source, true);
    PERFORM set_config('crx.pricing_reason', CASE WHEN v_has_pricing
      THEN COALESCE(v_pricing.change_reason, '')
      ELSE 'Product information worksheet update' END, true);
    PERFORM set_config('crx.pricing_change_set_id', p_change_set_id::text, true);
    PERFORM set_config('crx.pricing_mode', CASE WHEN v_has_pricing
      THEN v_pricing.pricing_mode ELSE 'margin_driven' END, true);

    UPDATE public.products p
    SET current_cost = CASE WHEN v_has_pricing
          THEN v_pricing.output_cost_cents::numeric / 100 ELSE p.current_cost END,
        tier1_margin = CASE WHEN v_has_pricing
          THEN v_pricing.output_tier1_margin ELSE p.tier1_margin END,
        tier2_margin = CASE WHEN v_has_pricing
          THEN v_pricing.output_tier2_margin ELSE p.tier2_margin END,
        tier3_margin = CASE WHEN v_has_pricing
          THEN v_pricing.output_tier3_margin ELSE p.tier3_margin END,
        tier1_price = CASE WHEN v_has_pricing
          THEN v_pricing.output_tier1_price_cents::numeric / 100 ELSE p.tier1_price END,
        tier2_price = CASE WHEN v_has_pricing
          THEN v_pricing.output_tier2_price_cents::numeric / 100 ELSE p.tier2_price END,
        tier3_price = CASE WHEN v_has_pricing
          THEN v_pricing.output_tier3_price_cents::numeric / 100 ELSE p.tier3_price END,
        suggested_rate = CASE WHEN v_has_info
          THEN v_info.after_values->>'suggested_rate' ELSE p.suggested_rate END,
        rate_per_acre = CASE WHEN v_has_info
          THEN (v_info.after_values->>'rate_per_acre')::numeric ELSE p.rate_per_acre END,
        rate_unit = CASE WHEN v_has_info
          THEN v_info.after_values->>'rate_unit' ELSE p.rate_unit END,
        use_timing = CASE WHEN v_has_info
          THEN v_info.after_values->>'use_timing' ELSE p.use_timing END,
        internal_notes = CASE WHEN v_has_info
          THEN v_info.after_values->>'internal_notes' ELSE p.internal_notes END,
        quoting_notes = CASE WHEN v_has_info
          THEN v_info.after_values->>'quoting_notes' ELSE p.quoting_notes END,
        cost_updated_date = CASE WHEN v_has_pricing
          AND p.current_cost IS DISTINCT FROM v_pricing.output_cost_cents::numeric / 100
          THEN now() ELSE p.cost_updated_date END,
        updated_at = now()
    WHERE p.id = v_target.product_id;

    IF v_has_info THEN
      INSERT INTO public.activity_feed(
        event_type, description, performed_by,
        related_entity_type, related_entity_id
      ) VALUES (
        'product_info_updated',
        'Governed Product information update: ' || v_info.changes::text,
        v_actor, 'product', v_target.product_id
      );
    END IF;
  END LOOP;

  SELECT jsonb_build_object(
    'change_set_id', p_change_set_id,
    'status', 'applied',
    'applied_count', v_change_set.row_count,
    'rows', jsonb_agg(jsonb_build_object(
      'product_id', p.id,
      'pricing_version', p.pricing_version,
      'cost', public._format_pricing_dollars(round(p.current_cost * 100)::bigint),
      'cost_cents', round(p.current_cost * 100)::bigint,
      'tier1_margin_percent', public._format_pricing_margin_percent(p.tier1_margin),
      'tier1_margin', p.tier1_margin,
      'tier1_price', public._format_pricing_dollars(round(p.tier1_price * 100)::bigint),
      'tier1_price_cents', round(p.tier1_price * 100)::bigint,
      'tier2_margin_percent', public._format_pricing_margin_percent(p.tier2_margin),
      'tier2_margin', p.tier2_margin,
      'tier2_price', public._format_pricing_dollars(round(p.tier2_price * 100)::bigint),
      'tier2_price_cents', round(p.tier2_price * 100)::bigint,
      'tier3_margin_percent', public._format_pricing_margin_percent(p.tier3_margin),
      'tier3_margin', p.tier3_margin,
      'tier3_price', public._format_pricing_dollars(round(p.tier3_price * 100)::bigint),
      'tier3_price_cents', round(p.tier3_price * 100)::bigint
    ) ORDER BY p.id)
  ) INTO v_result
  FROM public.products p
  JOIN (
    SELECT product_id FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    UNION
    SELECT product_id FROM public.product_info_change_set_rows
    WHERE change_set_id = p_change_set_id
  ) changed ON changed.product_id = p.id;

  UPDATE public.pricing_change_sets
  SET status = 'applied', applied_by = v_actor, applied_at = now(),
      apply_idempotency_key = p_idempotency_key, apply_result = v_result
  WHERE id = p_change_set_id;
  IF v_change_set.export_id IS NOT NULL THEN
    UPDATE public.pricing_workbook_exports
    SET status = 'consumed'
    WHERE id = v_change_set.export_id AND status = 'active';
  END IF;
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'apply_product_pricing_change_set',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_idem_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_product_pricing_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_pricing_change_set(
  uuid, text, uuid, text
) TO authenticated;

-- The cost-basis wrapper is the only public mutation boundary after Phase 2.
-- SECURITY DEFINER functions owned by the migration role can still call these
-- inner engines, while authenticated callers cannot bypass evidence/basis work.
GRANT EXECUTE ON FUNCTION public.preview_product_pricing_changes(
  text, uuid, jsonb, uuid, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_product_pricing_change_set(
  uuid, text, uuid, text
) TO authenticated;

-- Serialize the governed Phase 2 wrapper before it takes any evidence/Product
-- locks. The retained inner implementation deliberately locks evidence before
-- Products; serialization prevents two mixed batches from each holding a
-- basis Product while requesting the other's info-only Product.
ALTER FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) RENAME TO _apply_product_cost_basis_change_set_serialized_inner;
REVOKE ALL ON FUNCTION public._apply_product_cost_basis_change_set_serialized_inner(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_product_cost_basis_change_set(
  p_change_set_id uuid,
  p_request_fingerprint text,
  p_performed_by uuid DEFAULT NULL,
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
  v_idem_fp text;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_request_fingerprint IS NULL OR btrim(p_request_fingerprint) = '' THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_REQUIRED';
  END IF;

  v_idem_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'change_set_id', p_change_set_id,
    'request_fingerprint', p_request_fingerprint
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'apply_product_cost_basis_change_set'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_idem_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- One transaction-scoped lock is intentionally coarse: pricing workbooks are
  -- an admin batch workflow, and deterministic correctness is worth serializing
  -- the rare apply operation.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx_apply_product_cost_basis_change_set', 0)
  );
  v_result := public._apply_product_cost_basis_change_set_serialized_inner(
    p_change_set_id,
    p_request_fingerprint,
    p_performed_by,
    p_idempotency_key
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) TO authenticated;

DO $workbook_v2_postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products'
      AND column_name = 'quoting_notes'
  ) THEN
    RAISE EXCEPTION 'workbook v2 quoting_notes missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.product_info_change_set_rows'::regclass)
     OR has_table_privilege(
          'authenticated', 'public.product_info_change_set_rows', 'SELECT'
        )
     OR has_table_privilege(
          'service_role', 'public.product_info_change_set_rows', 'SELECT'
        ) THEN
    RAISE EXCEPTION 'workbook v2 private row grants invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pricing_workbook_exports
    WHERE status = 'active'
      AND format_version <> 'crx-product-pricing-phase2-v2'
  ) THEN
    RAISE EXCEPTION 'workbook v2 active legacy export remains';
  END IF;
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'create_pricing_workbook_export',
        'preview_product_cost_basis_changes',
        'apply_product_pricing_change_set',
        '_product_cost_basis_row_required',
        'guard_and_version_product_pricing'
      )
  ) <> 5 THEN
    RAISE EXCEPTION 'workbook v2 function overload drift';
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.apply_product_pricing_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.create_pricing_workbook_export(uuid[],uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'workbook v2 function grants invalid';
  END IF;
END;
$workbook_v2_postflight$;
