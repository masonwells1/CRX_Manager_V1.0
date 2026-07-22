-- Phase 2 follow-up: allow a complete pricing worksheet manifest to include
-- a genuinely unchanged Product that has no current cost.
--
-- The shared Phase 1a preview still validates every submitted workbook row.
-- Only the exact inert/null-cost row shape is omitted from the cost-basis
-- ledger. Every changed row and every explicit basis selection is still
-- resolved, persisted, shape-checked, revalidated, and applied atomically.
-- The supplier_cost_basis_enabled flag is not changed by this migration.

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
  SELECT CASE
    WHEN p_row_status NOT IN ('ready', 'unchanged') THEN false
    WHEN p_source = 'pricing_worksheet'
      AND p_row_status = 'unchanged'
      AND COALESCE(p_submitted_row->>'pricing_mode', '') = ''
      AND COALESCE(p_submitted_row->>'new_cost', '') = ''
      AND p_submitted_row->'basis_selection' = 'false'::jsonb
      AND p_submitted_row->>'basis_type' = 'manual_override'
      AND NULLIF(p_submitted_row->>'supplier_price_observation_id', '') IS NULL
      AND NULLIF(p_submitted_row->>'purchase_order_item_id', '') IS NULL
      AND p_effect #> '{before,cost_cents}' = 'null'::jsonb
      AND p_effect->'cost_cents' = 'null'::jsonb
    THEN false
    ELSE true
  END
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
  v_resolved jsonb;
  v_required_basis_count integer;
  v_basis_change_count integer;
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

  v_pricing_result := public.preview_product_pricing_changes(
    p_source,
    p_export_id,
    p_rows,
    v_actor,
    p_idempotency_key || ':pricing'
  );
  v_change_set_id := (v_pricing_result->>'change_set_id')::uuid;

  -- The shared Phase 1a engine must see every worksheet row so its manifest,
  -- identity, row-token, formula, and unchanged-value checks remain complete.
  -- Resolve provenance only for rows that can affect pricing or explicitly
  -- select a basis. A genuinely unchanged Product with no existing cost is a
  -- validated manifest row, but it has no cost fact to place in the basis ledger.
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

  SELECT count(*)::integer
  INTO v_required_basis_count
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
      AND public._product_cost_basis_row_required(
        p_source,
        preview_row.row_status,
        preview_row.submitted_row,
        preview_row.effect
      )
      AND public._resolve_product_cost_basis_row(preview_row.submitted_row) IS DISTINCT FROM
          jsonb_build_object(
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

  v_pricing_result := v_pricing_result || jsonb_build_object(
    'basis_change_count', v_basis_change_count,
    'apply_allowed', (
      (v_pricing_result->>'status') = 'previewed'
      OR ((v_pricing_result->>'status') = 'no_changes' AND v_basis_change_count > 0)
    )
  );

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

CREATE OR REPLACE FUNCTION public.apply_product_cost_basis_change_set(
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
  v_inner_key text;
  v_change_set public.pricing_change_sets%ROWTYPE;
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_row public.product_cost_basis_change_rows%ROWTYPE;
  v_active public.product_cost_basis%ROWTYPE;
  v_pricing_result jsonb;
  v_basis_rows jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
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

  v_inner_key := p_idempotency_key || ':pricing';
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
    IF v_change_set.apply_idempotency_key IS NOT DISTINCT FROM v_inner_key THEN
      RETURN v_change_set.apply_result;
    END IF;
    RAISE EXCEPTION 'CHANGE_SET_ALREADY_APPLIED';
  END IF;
  IF v_change_set.status NOT IN ('previewed', 'no_changes')
     OR v_change_set.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_SET_INVALID_OR_EXPIRED';
  END IF;
  IF (SELECT count(*) FROM public.product_cost_basis_change_rows
      WHERE pricing_change_set_id = p_change_set_id)
     IS DISTINCT FROM (
       SELECT count(*)
       FROM public.pricing_change_set_preview_rows preview_row
       WHERE preview_row.change_set_id = p_change_set_id
         AND public._product_cost_basis_row_required(
           v_change_set.source,
           preview_row.row_status,
           preview_row.submitted_row,
           preview_row.effect
         )
     ) THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_SHAPE_INVALID';
  END IF;

  -- Basis-only workbook changes do not enter the Phase 1a apply RPC, so lock
  -- and validate their retained export here as well. This preserves the same
  -- one-use and expiry contract for a provenance-only selection.
  IF v_change_set.export_id IS NOT NULL THEN
    SELECT * INTO v_export
    FROM public.pricing_workbook_exports
    WHERE id = v_change_set.export_id
    FOR UPDATE;
    IF NOT FOUND OR v_export.created_by IS DISTINCT FROM v_actor
       OR v_export.status <> 'active' OR v_export.expires_at <= now() THEN
      RAISE EXCEPTION 'WORKBOOK_EXPORT_CONSUMED_OR_EXPIRED';
    END IF;
  END IF;

  -- Hold every mutable source of truth used by evidence resolution until this
  -- transaction commits. In particular, FOR UPDATE on an observation blocks a
  -- concurrent correction INSERT because its supersedes FK needs a row lock.
  -- The fixed table/id order keeps overlapping batches deterministic.
  IF EXISTS (
    SELECT 1 FROM public.product_cost_basis_change_rows
    WHERE pricing_change_set_id = p_change_set_id
      AND basis_type <> 'manual_override'
  ) THEN
    PERFORM setting_key
    FROM public.app_settings
    WHERE setting_key = 'supplier_cost_basis_enabled'
    FOR UPDATE;
  END IF;

  -- Match the correction path: lock the immutable observation first. A
  -- correction holds that row before its replacement takes FK locks on the
  -- referenced link/vendor/product, so reversing this order can deadlock.
  PERFORM o.id
  FROM public.supplier_price_observations o
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id = o.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY o.id
  FOR UPDATE OF o;

  PERFORM l.id
  FROM public.product_supplier_links l
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id IS NOT NULL
  JOIN public.supplier_price_observations o
    ON o.id = r.supplier_price_observation_id
   AND o.product_supplier_link_id = l.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY l.id
  FOR UPDATE OF l;

  PERFORM v.id
  FROM public.vendors v
  JOIN public.supplier_price_observations o ON o.vendor_id = v.id
  JOIN public.product_cost_basis_change_rows r
    ON r.supplier_price_observation_id = o.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY v.id
  FOR UPDATE OF v;

  -- Match receiving/reversal lock order: item first, then parent PO. Reversing a
  -- receipt updates purchase_order_items before purchase_orders, so taking the
  -- opposite order here would create a deadlock cycle under concurrent apply.
  PERFORM poi.id
  FROM public.purchase_order_items poi
  JOIN public.product_cost_basis_change_rows r
    ON r.purchase_order_item_id = poi.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY poi.id
  FOR UPDATE OF poi;

  PERFORM po.id
  FROM public.purchase_orders po
  JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
  JOIN public.product_cost_basis_change_rows r
    ON r.purchase_order_item_id = poi.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY po.id
  FOR UPDATE OF po;

  -- Stable product lock order and an independent version check also protect
  -- basis-only selections where the shared pricing preview had no price delta.
  PERFORM p.id
  FROM public.products p
  JOIN public.product_cost_basis_change_rows r ON r.product_id = p.id
  WHERE r.pricing_change_set_id = p_change_set_id
  ORDER BY p.id
  FOR UPDATE OF p;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis_change_rows r
    LEFT JOIN public.products p ON p.id = r.product_id
    WHERE r.pricing_change_set_id = p_change_set_id
      AND (p.id IS NULL OR NOT p.is_active
        OR p.pricing_version IS DISTINCT FROM r.expected_version
        OR r.expected_active_basis_id IS DISTINCT FROM (
          SELECT active.id
          FROM public.product_cost_basis active
          WHERE active.product_id = r.product_id
            AND active.effective_to IS NULL
        ))
  ) THEN
    RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
  END IF;

  -- Evidence and the OFF-by-default gate are checked again at apply time only
  -- after every Product row is locked. This closes the pricing-free Product
  -- race where a concurrent unit edit could otherwise occur after evidence
  -- resolution but before the Product lock. Source rows were locked above, so
  -- the resolver now observes one stable Product/evidence snapshot.
  FOR v_row IN
    SELECT * FROM public.product_cost_basis_change_rows
    WHERE pricing_change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    PERFORM public._resolve_product_cost_basis_row(jsonb_build_object(
      'product_id', v_row.product_id,
      'row_version', v_row.expected_version,
      'basis_type', v_row.basis_type,
      'new_cost', public._format_pricing_dollars(v_row.cost_cents),
      'basis_reason', v_row.reason,
      'basis_source', v_row.selection_source,
      'basis_selection', v_row.force_selection,
      'supplier_price_observation_id', v_row.supplier_price_observation_id,
      'purchase_order_item_id', v_row.purchase_order_item_id
    ));
  END LOOP;

  PERFORM set_config('crx.cost_basis_authorized', 'phase2', true);
  PERFORM set_config('crx.cost_basis_actor', v_actor::text, true);
  PERFORM set_config('crx.cost_basis_change_set_id', p_change_set_id::text, true);

  IF v_change_set.status = 'previewed' THEN
    v_pricing_result := public.apply_product_pricing_change_set(
      p_change_set_id,
      p_request_fingerprint,
      v_actor,
      v_inner_key
    );
  ELSE
    v_pricing_result := jsonb_build_object(
      'change_set_id', p_change_set_id,
      'status', 'applied',
      'applied_count', 0,
      'rows', '[]'::jsonb
    );
  END IF;

  FOR v_row IN
    SELECT * FROM public.product_cost_basis_change_rows
    WHERE pricing_change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_active
    FROM public.product_cost_basis
    WHERE product_id = v_row.product_id AND effective_to IS NULL
    FOR UPDATE;

    IF v_active.id IS NULL
       OR v_active.cost_cents IS DISTINCT FROM v_row.cost_cents
       OR v_row.force_selection THEN
      IF v_active.id IS NOT NULL THEN
        UPDATE public.product_cost_basis
        SET effective_to = v_now
        WHERE id = v_active.id;
      END IF;

      INSERT INTO public.product_cost_basis(
        product_id, basis_type, cost_cents,
        supplier_price_observation_id, purchase_order_item_id,
        pricing_change_set_id, selection_source, reason,
        selected_by, selected_at, effective_from
      ) VALUES (
        v_row.product_id, v_row.basis_type, v_row.cost_cents,
        v_row.supplier_price_observation_id, v_row.purchase_order_item_id,
        p_change_set_id, v_row.selection_source, v_row.reason,
        v_actor, v_now, v_now
      );
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'product_id', b.product_id,
    'basis_type', b.basis_type,
    'cost_cents', b.cost_cents,
    'supplier_price_observation_id', b.supplier_price_observation_id,
    'purchase_order_item_id', b.purchase_order_item_id,
    'selection_source', b.selection_source,
    'reason', b.reason,
    'selected_at', b.selected_at
  ) ORDER BY b.product_id), '[]'::jsonb)
  INTO v_basis_rows
  FROM public.product_cost_basis b
  WHERE b.pricing_change_set_id = p_change_set_id;

  v_pricing_result := v_pricing_result || jsonb_build_object(
    'cost_basis_rows', v_basis_rows
  );

  UPDATE public.pricing_change_sets
  SET status = 'applied',
      applied_by = v_actor,
      applied_at = COALESCE(applied_at, v_now),
      apply_idempotency_key = v_inner_key,
      apply_result = v_pricing_result
  WHERE id = p_change_set_id;

  IF v_change_set.status = 'no_changes' AND v_change_set.export_id IS NOT NULL THEN
    UPDATE public.pricing_workbook_exports
    SET status = 'consumed'
    WHERE id = v_change_set.export_id AND status = 'active';
  END IF;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'apply_product_cost_basis_change_set',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_idem_fp,
      'response', v_pricing_result
    )
  );
  RETURN v_pricing_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_product_cost_basis_change_set(
  uuid, text, uuid, text
) TO authenticated;
