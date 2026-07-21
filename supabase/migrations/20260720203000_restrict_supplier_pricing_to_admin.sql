-- Restrict supplier pricing evidence to ADMIN-ONLY.
--
-- WHY: the Phase 1b evidence migration (ledger 20260718225511) gated its six
-- evidence tables' SELECT policies, the evidence-PDF storage bucket SELECT
-- policy, and all five SECURITY DEFINER reader RPCs with
-- (is_admin() OR is_sales_rep()). That contradicts the standing RLS contract
-- (src/lib/rlsContracts.test.ts): cost_history and purchase_orders/items are
-- "CRITICAL: admin-only — sales reps must never see cost columns", and
-- get_product_price_history returns cost_history.new_cost plus PO ids/numbers/
-- unit costs through the definer path, bypassing those table policies.
-- Flagged by the Codex GitHub review on PR #179; Mason settled it 2026-07-20:
-- supplier cost data is admin-only.
--
-- WHAT: recreates the seven SELECT policies with is_admin() only and
-- re-emits the five reader RPCs verbatim from the applied migration with the
-- single gate line changed to admin-only (ADMIN_REQUIRED). Mutating RPCs were
-- already admin-only and are untouched. No data is changed or deleted.

-- ─── Table SELECT policies → admin-only ───────────────────────────────────

DROP POLICY IF EXISTS vendor_aliases_select ON public.vendor_aliases;
CREATE POLICY vendor_aliases_select ON public.vendor_aliases
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS legacy_vendor_resolution_select ON public.legacy_vendor_resolution;
CREATE POLICY legacy_vendor_resolution_select ON public.legacy_vendor_resolution
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS product_supplier_links_select ON public.product_supplier_links;
CREATE POLICY product_supplier_links_select ON public.product_supplier_links
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS supplier_price_imports_select ON public.supplier_price_imports;
CREATE POLICY supplier_price_imports_select ON public.supplier_price_imports
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS supplier_price_import_rows_select ON public.supplier_price_import_rows;
CREATE POLICY supplier_price_import_rows_select ON public.supplier_price_import_rows
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS supplier_price_observations_select ON public.supplier_price_observations;
CREATE POLICY supplier_price_observations_select ON public.supplier_price_observations
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ─── Evidence-PDF bucket SELECT → admin-only ──────────────────────────────

DROP POLICY IF EXISTS supplier_price_evidence_objects_select ON storage.objects;
CREATE POLICY supplier_price_evidence_objects_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'supplier-price-evidence'
    AND public.is_admin()
  );

-- ─── Reader RPCs → admin-only (bodies verbatim except the gate) ───────────

CREATE OR REPLACE FUNCTION public.get_supplier_quote_sheet(p_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_vendor public.vendors%ROWTYPE;
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
      'effective_date', current_date,
      'price_kind', 'quote'
    ) ORDER BY p.product_name, l.supplier_sku), '[]'::jsonb)
  ) INTO v_result
  FROM public.product_supplier_links l
  JOIN public.products p ON p.id = l.product_id AND p.is_active
  LEFT JOIN LATERAL (
    SELECT o.cost_cents, o.effective_from
    FROM public.supplier_price_observations o
    WHERE o.product_supplier_link_id = l.id
      AND o.effective_from <= current_date
      AND (o.effective_to IS NULL OR o.effective_to >= current_date)
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
      AND o.effective_from <= current_date
      AND (o.effective_to IS NULL OR o.effective_to >= current_date)
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
          FILTER (WHERE purchase_date >= current_date - 365)
        / NULLIF(
          sum(quantity_received) FILTER (WHERE purchase_date >= current_date - 365),
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

CREATE OR REPLACE FUNCTION public.get_supplier_pricing_workspace(
  p_product_id uuid DEFAULT NULL,
  p_vendor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;

  SELECT jsonb_build_object(
    'vendors', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name) ORDER BY v.name), '[]'::jsonb)
      FROM public.vendors v WHERE v.deleted_at IS NULL
    ),
    'products', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', p.id, 'product_name', p.product_name, 'sku', p.sku, 'inventory_unit', p.inventory_unit
      ) ORDER BY p.product_name), '[]'::jsonb)
      FROM public.products p
      WHERE p.is_active AND (p_product_id IS NULL OR p.id = p_product_id)
    ),
    'links', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', l.id,
        'product_id', l.product_id,
        'product_name', p.product_name,
        'vendor_id', l.vendor_id,
        'vendor_name', v.name,
        'supplier_sku', l.supplier_sku,
        'supplier_product_name', l.supplier_product_name,
        'supplier_uom', l.supplier_uom,
        'supplier_pack_description', l.supplier_pack_description,
        'inventory_units_per_supplier_unit', l.inventory_units_per_supplier_unit,
        'conversion_unit', l.conversion_unit,
        'comparison_status', l.comparison_status,
        'comparison_note', l.comparison_note,
        'link_status', l.link_status,
        'is_reusable', l.is_reusable,
        'is_preferred', l.is_preferred,
        'is_active', l.is_active
      ) ORDER BY p.product_name, v.name, l.supplier_sku), '[]'::jsonb)
      FROM public.product_supplier_links l
      JOIN public.products p ON p.id = l.product_id
      JOIN public.vendors v ON v.id = l.vendor_id
      WHERE (p_product_id IS NULL OR l.product_id = p_product_id)
        AND (p_vendor_id IS NULL OR l.vendor_id = p_vendor_id)
    ),
    'imports', (
      SELECT COALESCE(jsonb_agg(import_row ORDER BY (import_row->>'created_at') DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', i.id,
          'vendor_id', i.vendor_id,
          'vendor_name', v.name,
          'document_date', i.document_date,
          'ingestion_method', i.ingestion_method,
          'status', i.status,
          'row_count', i.row_count,
          'eligible_row_count', i.eligible_row_count,
          'approved_observation_count', i.approved_observation_count,
          'source_document_name', i.source_document_name,
          'created_at', i.created_at
        ) AS import_row
        FROM public.supplier_price_imports i
        JOIN public.vendors v ON v.id = i.vendor_id
        WHERE (p_vendor_id IS NULL OR i.vendor_id = p_vendor_id)
        ORDER BY i.created_at DESC
        LIMIT 50
      ) recent
    ),
    'aliases', CASE WHEN public.is_admin() THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id,
        'vendor_id', a.vendor_id,
        'proposed_vendor_id', a.proposed_vendor_id,
        'alias_raw', a.alias_raw,
        'alias_normalized', a.alias_normalized,
        'alias_display', a.alias_display,
        'source', a.source,
        'review_status', a.review_status,
        'review_note', a.review_note,
        'created_at', a.created_at
      ) ORDER BY a.review_status, a.alias_display), '[]'::jsonb)
      FROM public.vendor_aliases a
    ) ELSE '[]'::jsonb END,
    'evidence', public.get_supplier_market_evidence(
      CASE WHEN p_product_id IS NULL THEN NULL ELSE ARRAY[p_product_id] END
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_supplier_price_import(p_import_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;

  SELECT jsonb_build_object(
    'id', i.id,
    'vendor_id', i.vendor_id,
    'vendor_name', v.name,
    'document_date', i.document_date,
    'ingestion_method', i.ingestion_method,
    'format_version', i.format_version,
    'status', i.status,
    'source_document_name', i.source_document_name,
    'row_count', i.row_count,
    'eligible_row_count', i.eligible_row_count,
    'approved_observation_count', i.approved_observation_count,
    'created_at', i.created_at,
    'rows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id,
        'row_number', r.row_number,
        'product_id', r.product_id,
        'product_name', p.product_name,
        'product_supplier_link_id', r.product_supplier_link_id,
        'supplier_sku', r.supplier_sku,
        'supplier_product_name', r.supplier_product_name,
        'cost_cents', r.cost_cents,
        'price_unit', r.price_unit,
        'package_quantity', r.package_quantity,
        'effective_from', r.effective_from,
        'effective_to', r.effective_to,
        'price_kind', r.price_kind,
        'row_status', r.row_status,
        'validation_errors', r.validation_errors,
        'observation_id', r.observation_id
      ) ORDER BY r.row_number), '[]'::jsonb)
      FROM public.supplier_price_import_rows r
      LEFT JOIN public.products p ON p.id = r.product_id
      WHERE r.import_id = i.id
    )
  ) INTO v_result
  FROM public.supplier_price_imports i
  JOIN public.vendors v ON v.id = i.vendor_id
  WHERE i.id = p_import_id;

  IF v_result IS NULL THEN RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_FOUND'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_product_price_history(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  WITH history_points AS (
    SELECT
      'supplier_observation'::text AS stream,
      o.id::text AS source_id,
      o.vendor_id,
      v.name AS supplier_name,
      o.cost_cents,
      CASE
        WHEN l.comparison_status = 'comparable'
         AND l.inventory_units_per_supplier_unit > 0
        THEN round(o.cost_cents::numeric / o.package_quantity / l.inventory_units_per_supplier_unit)::bigint
        ELSE NULL
      END AS normalized_cost_cents,
      o.effective_from::timestamptz AS occurred_at,
      o.price_kind AS detail,
      jsonb_build_object(
        'import_id', o.import_id,
        'import_row_id', o.import_row_id,
        'product_supplier_link_id', o.product_supplier_link_id,
        'price_unit', o.price_unit,
        'package_quantity', o.package_quantity
      ) AS provenance
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l ON l.id = o.product_supplier_link_id
    JOIN public.vendors v ON v.id = o.vendor_id
    WHERE o.product_id = p_product_id

    UNION ALL

    SELECT
      'selected_cost_basis'::text,
      ch.id::text,
      NULL::uuid,
      NULL::text,
      round(ch.new_cost * 100)::bigint,
      round(ch.new_cost * 100)::bigint,
      ch.changed_at,
      COALESCE(ch.change_note, ch.change_source, 'Product pricing history'),
      jsonb_build_object('change_set_id', ch.change_set_id, 'changed_by', ch.changed_by)
    FROM public.cost_history ch
    WHERE ch.product_id = p_product_id
      AND ch.new_cost IS NOT NULL

    UNION ALL

    SELECT
      'actual_purchase'::text,
      poi.id::text,
      resolved.vendor_id,
      COALESCE(v.name, 'supplier unknown'),
      poi.unit_cost_cents,
      CASE
        WHEN poi.inventory_units_per_supplier_unit_snapshot > 0
        THEN round(poi.unit_cost_cents::numeric / poi.inventory_units_per_supplier_unit_snapshot)::bigint
        ELSE NULL
      END,
      COALESCE(po.submitted_date::timestamptz, po.created_at),
      'actual_purchase',
      jsonb_build_object(
        'purchase_order_id', po.id,
        'purchase_order_item_id', poi.id,
        'po_number', po.po_number,
        'legacy_vendor_text', po.vendor,
        'resolution_status', CASE WHEN resolved.vendor_id IS NULL THEN 'supplier unknown' ELSE 'reviewed' END,
        'cost_provenance', poi.cost_provenance
      )
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN public.legacy_vendor_resolution resolved
      ON resolved.normalized_text = public.normalize_vendor_alias(po.vendor)
     AND resolved.review_status = 'approved'
    LEFT JOIN public.vendors v ON v.id = resolved.vendor_id
    WHERE poi.product_id = p_product_id
      AND poi.quantity_received > 0
      AND poi.unit_cost_cents IS NOT NULL
      AND po.status <> 'cancelled'
  )
  SELECT jsonb_build_object(
    'product_id', p_product_id,
    'summary', COALESCE(
      public.get_supplier_market_evidence(ARRAY[p_product_id])->0,
      jsonb_build_object(
        'product_id', p_product_id,
        'supplier_quote_count', 0,
        'comparable_quote_count', 0,
        'replacement_cost_cents', NULL,
        'replacement_cost_as_of', NULL,
        'best_supplier', NULL,
        'last_paid_cents', NULL,
        'last_paid_as_of', NULL,
        'recent_po_weighted_average_cents', NULL,
        'recent_po_window', 'trailing_12_months',
        'comparison_status', 'no_evidence',
        'suppliers', '[]'::jsonb
      )
    ),
    'suppliers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.vendor_id, 'name', s.supplier_name) ORDER BY s.supplier_name)
      FROM (
        SELECT DISTINCT vendor_id, supplier_name
        FROM history_points
        WHERE vendor_id IS NOT NULL
      ) s
    ), '[]'::jsonb),
    'points', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'stream', h.stream,
        'source_id', h.source_id,
        'vendor_id', h.vendor_id,
        'supplier_name', h.supplier_name,
        'cost_cents', h.cost_cents,
        'normalized_cost_cents', h.normalized_cost_cents,
        'occurred_at', h.occurred_at,
        'detail', h.detail,
        'provenance', h.provenance
      ) ORDER BY h.occurred_at, h.stream, h.source_id)
      FROM history_points h
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ─── Re-assert ACLs (CREATE OR REPLACE preserves grants; made explicit) ───

REVOKE ALL ON FUNCTION public.get_supplier_quote_sheet(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_market_evidence(uuid[])
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_pricing_workspace(uuid, uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_price_import(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_product_price_history(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_supplier_quote_sheet(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_market_evidence(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_pricing_workspace(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_import(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_price_history(uuid) TO authenticated;

-- ─── Verify: nothing supplier-pricing-facing still mentions is_sales_rep ──

DO $verify$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ')
  INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_supplier_quote_sheet',
      'get_supplier_market_evidence',
      'get_supplier_pricing_workspace',
      'get_supplier_price_import',
      'get_product_price_history'
    )
    AND p.prosrc LIKE '%is_sales_rep%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: reader RPCs still reference is_sales_rep: %', v_bad;
  END IF;

  SELECT string_agg(schemaname || '.' || tablename || '/' || policyname, ', ')
  INTO v_bad
  FROM pg_policies
  WHERE (
      (schemaname = 'public' AND tablename IN (
        'vendor_aliases', 'legacy_vendor_resolution', 'product_supplier_links',
        'supplier_price_imports', 'supplier_price_import_rows', 'supplier_price_observations'
      ))
      OR (schemaname = 'storage' AND tablename = 'objects'
          AND policyname LIKE 'supplier_price_evidence%')
    )
    AND (COALESCE(qual, '') LIKE '%is_sales_rep%'
         OR COALESCE(with_check, '') LIKE '%is_sales_rep%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: policies still reference is_sales_rep: %', v_bad;
  END IF;
END;
$verify$;
