-- Supplier Pricing Phase 1a additive bootstrap.
-- Promoted after Mason's explicit 2026-07-16 live-apply approval and
-- exact-SQL disposable proof; live apply remains proof-gated.
--
-- This first half is deliberately backward-compatible with the currently
-- deployed frontend. It installs the governed pricing engine, retained
-- workbook manifests, versioned change sets, and trigger-owned history for
-- governed RPC writes. The separate cutover draft closes legacy direct writes
-- only after the new frontend is deployed and its rollback window is closed.

-- ---------------------------------------------------------------------------
-- 1. Pricing concurrency token and history context
-- ---------------------------------------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS pricing_version bigint NOT NULL DEFAULT 1;

ALTER TABLE public.cost_history
  ADD COLUMN IF NOT EXISTS old_tier1_margin numeric,
  ADD COLUMN IF NOT EXISTS new_tier1_margin numeric,
  ADD COLUMN IF NOT EXISTS old_tier2_margin numeric,
  ADD COLUMN IF NOT EXISTS new_tier2_margin numeric,
  ADD COLUMN IF NOT EXISTS old_tier3_margin numeric,
  ADD COLUMN IF NOT EXISTS new_tier3_margin numeric,
  ADD COLUMN IF NOT EXISTS change_source text,
  ADD COLUMN IF NOT EXISTS change_reason text,
  ADD COLUMN IF NOT EXISTS change_set_id uuid,
  ADD COLUMN IF NOT EXISTS old_pricing_version bigint,
  ADD COLUMN IF NOT EXISTS new_pricing_version bigint;

UPDATE public.cost_history
SET change_source = 'legacy_frontend'
WHERE change_source IS NULL;

ALTER TABLE public.cost_history
  ALTER COLUMN change_source SET DEFAULT 'legacy_frontend',
  ALTER COLUMN change_source SET NOT NULL;

ALTER TABLE public.cost_history
  DROP CONSTRAINT IF EXISTS cost_history_change_source_check;
ALTER TABLE public.cost_history
  ADD CONSTRAINT cost_history_change_source_check
  CHECK (change_source IN (
    'legacy_frontend', 'pricing_worksheet', 'product_page', 'products_inline'
  ));

-- ---------------------------------------------------------------------------
-- 2. Server-owned export manifests and approved change sets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pricing_workbook_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  request_fingerprint text NOT NULL,
  manifest_fingerprint text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  row_count integer NOT NULL CHECK (row_count > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'consumed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS public.pricing_workbook_export_rows (
  export_id uuid NOT NULL REFERENCES public.pricing_workbook_exports(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  sku_snapshot text,
  product_name_snapshot text NOT NULL,
  category_snapshot text,
  container_size_snapshot text,
  unit_size_snapshot text,
  inventory_unit_snapshot text,
  identity_fingerprint text NOT NULL,
  row_token text NOT NULL,
  row_version bigint NOT NULL CHECK (row_version >= 1),
  current_cost_cents bigint,
  current_tier1_margin numeric,
  current_tier1_price_cents bigint,
  current_tier2_margin numeric,
  current_tier2_price_cents bigint,
  current_tier3_margin numeric,
  current_tier3_price_cents bigint,
  PRIMARY KEY (export_id, product_id),
  CHECK (current_cost_cents IS NULL OR current_cost_cents >= 0),
  CHECK (current_tier1_price_cents IS NULL OR current_tier1_price_cents >= 0),
  CHECK (current_tier2_price_cents IS NULL OR current_tier2_price_cents >= 0),
  CHECK (current_tier3_price_cents IS NULL OR current_tier3_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS public.pricing_change_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid REFERENCES public.pricing_workbook_exports(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  source text NOT NULL CHECK (source IN (
    'pricing_worksheet', 'product_page', 'products_inline'
  )),
  request_fingerprint text NOT NULL,
  preview_idempotency_key text NOT NULL UNIQUE,
  submitted_row_count integer NOT NULL CHECK (submitted_row_count > 0),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  status text NOT NULL DEFAULT 'invalid'
    CHECK (status IN ('previewed', 'invalid', 'no_changes', 'applied', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  applied_by uuid REFERENCES public.profiles(id),
  applied_at timestamptz,
  apply_idempotency_key text,
  apply_result jsonb,
  CHECK (expires_at > created_at),
  CHECK (
    (source = 'pricing_worksheet' AND export_id IS NOT NULL)
    OR (source IN ('product_page', 'products_inline') AND export_id IS NULL)
  ),
  CHECK (
    (status = 'applied' AND applied_by IS NOT NULL AND applied_at IS NOT NULL
      AND apply_idempotency_key IS NOT NULL AND apply_result IS NOT NULL)
    OR status <> 'applied'
  )
);

CREATE TABLE IF NOT EXISTS public.pricing_change_set_rows (
  change_set_id uuid NOT NULL REFERENCES public.pricing_change_sets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  identity_fingerprint text NOT NULL,
  expected_version bigint NOT NULL CHECK (expected_version >= 1),
  pricing_mode text NOT NULL CHECK (pricing_mode IN ('margin_driven', 'price_driven')),
  change_reason text,
  input_cost_cents bigint NOT NULL CHECK (input_cost_cents >= 0),
  input_tier1_margin numeric,
  input_tier2_margin numeric,
  input_tier3_margin numeric,
  input_tier1_price_cents bigint,
  input_tier2_price_cents bigint,
  input_tier3_price_cents bigint,
  output_cost_cents bigint NOT NULL CHECK (output_cost_cents >= 0),
  output_tier1_margin numeric NOT NULL,
  output_tier2_margin numeric NOT NULL,
  output_tier3_margin numeric NOT NULL,
  output_tier1_price_cents bigint NOT NULL CHECK (output_tier1_price_cents >= 0),
  output_tier2_price_cents bigint NOT NULL CHECK (output_tier2_price_cents >= 0),
  output_tier3_price_cents bigint NOT NULL CHECK (output_tier3_price_cents >= 0),
  output_tier1_gross_margin numeric,
  output_tier2_gross_margin numeric,
  output_tier3_gross_margin numeric,
  output_tier1_price_per_acre_cents bigint,
  output_tier2_price_per_acre_cents bigint,
  output_tier3_price_per_acre_cents bigint,
  output_fingerprint text NOT NULL,
  PRIMARY KEY (change_set_id, product_id),
  CHECK (
    (pricing_mode = 'margin_driven'
      AND input_tier1_margin IS NOT NULL
      AND input_tier2_margin IS NOT NULL
      AND input_tier3_margin IS NOT NULL
      AND input_tier1_price_cents IS NULL
      AND input_tier2_price_cents IS NULL
      AND input_tier3_price_cents IS NULL)
    OR
    (pricing_mode = 'price_driven'
      AND input_tier1_margin IS NULL
      AND input_tier2_margin IS NULL
      AND input_tier3_margin IS NULL
      AND input_tier1_price_cents IS NOT NULL
      AND input_tier2_price_cents IS NOT NULL
      AND input_tier3_price_cents IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.pricing_change_set_preview_rows (
  change_set_id uuid NOT NULL REFERENCES public.pricing_change_sets(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  submitted_row jsonb NOT NULL,
  row_status text NOT NULL CHECK (row_status IN ('ready', 'conflict', 'invalid', 'unchanged')),
  error_code text,
  effect jsonb,
  PRIMARY KEY (change_set_id, sequence),
  CHECK (
    (row_status IN ('ready', 'unchanged') AND error_code IS NULL AND effect IS NOT NULL)
    OR (row_status IN ('conflict', 'invalid') AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pricing_workbook_exports_actor
  ON public.pricing_workbook_exports(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_workbook_export_rows_product
  ON public.pricing_workbook_export_rows(product_id);
CREATE INDEX IF NOT EXISTS idx_pricing_change_sets_actor
  ON public.pricing_change_sets(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_change_sets_export
  ON public.pricing_change_sets(export_id) WHERE export_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_change_sets_applied_by
  ON public.pricing_change_sets(applied_by) WHERE applied_by IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_change_sets_apply_idempotency_key
  ON public.pricing_change_sets(apply_idempotency_key)
  WHERE apply_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_change_set_rows_product
  ON public.pricing_change_set_rows(product_id);
CREATE INDEX IF NOT EXISTS idx_pricing_change_set_preview_rows_product
  ON public.pricing_change_set_preview_rows(product_id)
  WHERE product_id IS NOT NULL;

ALTER TABLE public.pricing_workbook_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_workbook_export_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_change_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_change_set_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_change_set_preview_rows ENABLE ROW LEVEL SECURITY;

-- These tables are RPC-only. Explicit deny-all policies make that boundary
-- visible to static review as well as enforced by the revoked table grants.
CREATE POLICY pricing_workbook_exports_rpc_only
  ON public.pricing_workbook_exports
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);
CREATE POLICY pricing_workbook_export_rows_rpc_only
  ON public.pricing_workbook_export_rows
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);
CREATE POLICY pricing_change_sets_rpc_only
  ON public.pricing_change_sets
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);
CREATE POLICY pricing_change_set_rows_rpc_only
  ON public.pricing_change_set_rows
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);
CREATE POLICY pricing_change_set_preview_rows_rpc_only
  ON public.pricing_change_set_preview_rows
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- All reads/writes travel through the three authenticated SECURITY DEFINER
-- RPCs below. Direct table privileges remain revoked.
REVOKE ALL ON TABLE public.pricing_workbook_exports FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.pricing_workbook_export_rows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.pricing_change_sets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.pricing_change_set_rows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.pricing_change_set_preview_rows FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.cost_history
  DROP CONSTRAINT IF EXISTS cost_history_change_set_id_fkey;
ALTER TABLE public.cost_history
  ADD CONSTRAINT cost_history_change_set_id_fkey
  FOREIGN KEY (change_set_id)
  REFERENCES public.pricing_change_sets(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cost_history_change_set
  ON public.cost_history(change_set_id)
  WHERE change_set_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. One deterministic calculator for preview, apply, and the live trigger
-- ---------------------------------------------------------------------------

-- Browser and workbook code sends exact decimal strings. These helpers are the
-- only public-schema boundary that converts display dollars/percentages to the
-- bigint cents/ratio values retained by the governed change set.
CREATE OR REPLACE FUNCTION public._parse_pricing_dollars(p_value text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_value numeric;
BEGIN
  IF p_value !~ '^[0-9]+([.][0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'PRICING_DOLLARS_INVALID';
  END IF;
  v_value := p_value::numeric;
  IF v_value > 92233720368547758.07 THEN
    RAISE EXCEPTION 'PRICING_DOLLARS_INVALID';
  END IF;
  RETURN (v_value * 100)::bigint;
EXCEPTION
  WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RAISE EXCEPTION 'PRICING_DOLLARS_INVALID';
END;
$function$;

CREATE OR REPLACE FUNCTION public._parse_pricing_margin_percent(p_value text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_value numeric;
BEGIN
  IF p_value !~ '^[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'PRICING_MARGIN_PERCENT_INVALID';
  END IF;
  v_value := p_value::numeric;
  IF v_value < 0 OR v_value >= 100 THEN
    RAISE EXCEPTION 'PRICING_MARGIN_PERCENT_INVALID';
  END IF;
  RETURN v_value / 100;
EXCEPTION
  WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RAISE EXCEPTION 'PRICING_MARGIN_PERCENT_INVALID';
END;
$function$;

CREATE OR REPLACE FUNCTION public._format_pricing_dollars(p_cents bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $function$
  SELECT (p_cents / 100)::text || '.' || lpad((p_cents % 100)::text, 2, '0')
$function$;

CREATE OR REPLACE FUNCTION public._format_pricing_margin_percent(p_ratio numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $function$
  SELECT trim_scale(round(p_ratio * 100, 8))::text
$function$;

REVOKE ALL ON FUNCTION public._parse_pricing_dollars(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._parse_pricing_margin_percent(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._format_pricing_dollars(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._format_pricing_margin_percent(numeric)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._calculate_product_pricing(
  p_mode text,
  p_current_cost numeric,
  p_tier1_margin numeric,
  p_tier2_margin numeric,
  p_tier3_margin numeric,
  p_tier1_price numeric,
  p_tier2_price numeric,
  p_tier3_price numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t1_margin numeric := p_tier1_margin;
  v_t2_margin numeric := p_tier2_margin;
  v_t3_margin numeric := p_tier3_margin;
  v_t1_price numeric := p_tier1_price;
  v_t2_price numeric := p_tier2_price;
  v_t3_price numeric := p_tier3_price;
  v_t1_gross numeric;
  v_t2_gross numeric;
  v_t3_gross numeric;
BEGIN
  IF p_mode NOT IN ('legacy_margin', 'margin_driven', 'price_driven') THEN
    RAISE EXCEPTION 'PRICING_MODE_INVALID';
  END IF;
  IF (p_mode <> 'legacy_margin' AND p_current_cost IS NULL)
     OR p_current_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_current_cost < 0 THEN
    RAISE EXCEPTION 'PRICING_COST_INVALID';
  END IF;

  IF p_mode IN ('legacy_margin', 'margin_driven') THEN
    IF p_mode = 'margin_driven' AND (
      v_t1_margin IS NULL OR v_t2_margin IS NULL OR v_t3_margin IS NULL
      OR v_t1_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t2_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t3_margin::text IN ('NaN', 'Infinity', '-Infinity')
      OR v_t1_margin < 0 OR v_t1_margin >= 1
      OR v_t2_margin < 0 OR v_t2_margin >= 1
      OR v_t3_margin < 0 OR v_t3_margin >= 1
    ) THEN
      RAISE EXCEPTION 'PRICING_MARGIN_INVALID';
    END IF;

    -- legacy_margin deliberately preserves the exact pre-Phase-1a behavior:
    -- only positive margins on a positive cost overwrite the matching price.
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t1_margin IS NOT NULL AND v_t1_margin >= 0 AND v_t1_margin < 1
       AND (p_mode = 'margin_driven' OR v_t1_margin > 0) THEN
      v_t1_price := round(p_current_cost / (1 - v_t1_margin), 2);
      v_t1_gross := CASE WHEN v_t1_margin = 1 THEN NULL
                         ELSE round(v_t1_margin / (1 - v_t1_margin), 4) END;
    ELSE
      v_t1_gross := NULL;
    END IF;
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t2_margin IS NOT NULL AND v_t2_margin >= 0 AND v_t2_margin < 1
       AND (p_mode = 'margin_driven' OR v_t2_margin > 0) THEN
      v_t2_price := round(p_current_cost / (1 - v_t2_margin), 2);
      v_t2_gross := CASE WHEN v_t2_margin = 1 THEN NULL
                         ELSE round(v_t2_margin / (1 - v_t2_margin), 4) END;
    ELSE
      v_t2_gross := NULL;
    END IF;
    IF (p_mode = 'margin_driven' OR p_current_cost > 0)
       AND v_t3_margin IS NOT NULL AND v_t3_margin >= 0 AND v_t3_margin < 1
       AND (p_mode = 'margin_driven' OR v_t3_margin > 0) THEN
      v_t3_price := round(p_current_cost / (1 - v_t3_margin), 2);
      v_t3_gross := CASE WHEN v_t3_margin = 1 THEN NULL
                         ELSE round(v_t3_margin / (1 - v_t3_margin), 4) END;
    ELSE
      v_t3_gross := NULL;
    END IF;
  ELSE
    IF v_t1_price IS NULL OR v_t2_price IS NULL OR v_t3_price IS NULL
       OR v_t1_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t2_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t3_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_t1_price < 0 OR v_t2_price < 0 OR v_t3_price < 0
       OR round(v_t1_price, 2) IS DISTINCT FROM v_t1_price
       OR round(v_t2_price, 2) IS DISTINCT FROM v_t2_price
       OR round(v_t3_price, 2) IS DISTINCT FROM v_t3_price THEN
      RAISE EXCEPTION 'PRICING_PRICE_INVALID';
    END IF;
    IF (v_t1_price = 0 AND p_current_cost > 0)
       OR (v_t2_price = 0 AND p_current_cost > 0)
       OR (v_t3_price = 0 AND p_current_cost > 0) THEN
      RAISE EXCEPTION 'PRICING_ZERO_PRICE_BELOW_COST';
    END IF;

    v_t1_margin := CASE WHEN v_t1_price = 0 THEN 0
                        ELSE round((v_t1_price - p_current_cost) / v_t1_price, 8) END;
    v_t2_margin := CASE WHEN v_t2_price = 0 THEN 0
                        ELSE round((v_t2_price - p_current_cost) / v_t2_price, 8) END;
    v_t3_margin := CASE WHEN v_t3_price = 0 THEN 0
                        ELSE round((v_t3_price - p_current_cost) / v_t3_price, 8) END;
    v_t1_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t1_price - p_current_cost) / p_current_cost, 4) END;
    v_t2_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t2_price - p_current_cost) / p_current_cost, 4) END;
    v_t3_gross := CASE WHEN p_current_cost = 0 THEN NULL
                       ELSE round((v_t3_price - p_current_cost) / p_current_cost, 4) END;
  END IF;

  RETURN jsonb_build_object(
    'current_cost', p_current_cost,
    'tier1_margin', v_t1_margin,
    'tier2_margin', v_t2_margin,
    'tier3_margin', v_t3_margin,
    'tier1_price', v_t1_price,
    'tier2_price', v_t2_price,
    'tier3_price', v_t3_price,
    'tier1_gross_margin', v_t1_gross,
    'tier2_gross_margin', v_t2_gross,
    'tier3_gross_margin', v_t3_gross
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._calculate_product_pricing(
  text, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) FROM PUBLIC, anon, authenticated;

-- Latest live behavior came from 20260702190000. This rewrite keeps its
-- legacy mode byte-for-byte in effect outside the governed RPC, but lets the
-- same calculator honor explicit prices in price_driven mode.
CREATE OR REPLACE FUNCTION public.calculate_prices_from_margin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_mode text := COALESCE(NULLIF(current_setting('crx.pricing_mode', true), ''), 'legacy_margin');
  v_calc jsonb;
BEGIN
  -- The live trigger historically does nothing when cost is null/nonpositive;
  -- preserve that exact early-return behavior for every non-governed write.
  IF v_mode = 'legacy_margin' AND (NEW.current_cost IS NULL OR NEW.current_cost <= 0) THEN
    RETURN NEW;
  END IF;

  v_calc := public._calculate_product_pricing(
    v_mode,
    NEW.current_cost,
    NEW.tier1_margin, NEW.tier2_margin, NEW.tier3_margin,
    NEW.tier1_price, NEW.tier2_price, NEW.tier3_price
  );

  NEW.current_cost := (v_calc->>'current_cost')::numeric;
  NEW.tier1_margin := (v_calc->>'tier1_margin')::numeric;
  NEW.tier2_margin := (v_calc->>'tier2_margin')::numeric;
  NEW.tier3_margin := (v_calc->>'tier3_margin')::numeric;
  NEW.tier1_price := (v_calc->>'tier1_price')::numeric;
  NEW.tier2_price := (v_calc->>'tier2_price')::numeric;
  NEW.tier3_price := (v_calc->>'tier3_price')::numeric;
  NEW.tier1_gross_margin := (v_calc->>'tier1_gross_margin')::numeric;
  NEW.tier2_gross_margin := (v_calc->>'tier2_gross_margin')::numeric;
  NEW.tier3_gross_margin := (v_calc->>'tier3_gross_margin')::numeric;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.calculate_prices_from_margin()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalc_product_price_per_acre()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Export and preview RPCs
-- ---------------------------------------------------------------------------

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
    'product_ids', COALESCE(to_jsonb(p_product_ids), 'null'::jsonb)
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'create_pricing_workbook_export');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF p_product_ids IS NOT NULL AND (
    cardinality(p_product_ids) = 0
    OR cardinality(p_product_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_product_ids) x)
  ) THEN
    RAISE EXCEPTION 'EXPORT_PRODUCT_IDS_INVALID';
  END IF;

  INSERT INTO public.pricing_workbook_exports(
    created_by, request_fingerprint, manifest_fingerprint,
    idempotency_key, row_count
  ) VALUES (
    v_actor, v_request_fp, 'pending', p_idempotency_key, 1
  ) RETURNING id INTO v_export_id;

  INSERT INTO public.pricing_workbook_export_rows(
    export_id, product_id, sku_snapshot, product_name_snapshot,
    category_snapshot, container_size_snapshot, unit_size_snapshot,
    inventory_unit_snapshot, identity_fingerprint, row_token, row_version,
    current_cost_cents,
    current_tier1_margin, current_tier1_price_cents,
    current_tier2_margin, current_tier2_price_cents,
    current_tier3_margin, current_tier3_price_cents
  )
  WITH export_products AS (
    SELECT
      p.id, p.sku, p.product_name, p.category,
      p.container_size::text AS container_size_text,
      p.unit_size, p.inventory_unit, p.pricing_version,
      md5(jsonb_build_object(
        'product_id', p.id,
        'sku', COALESCE(p.sku, ''),
        'product_name', p.product_name,
        'category', COALESCE(p.category, ''),
        'container_size', COALESCE(p.container_size::text, ''),
        'unit_size', COALESCE(p.unit_size, ''),
        'inventory_unit', COALESCE(p.inventory_unit, '')
      )::text) AS identity_fp,
      CASE WHEN p.current_cost IS NULL THEN NULL ELSE round(p.current_cost * 100)::bigint END AS cost_cents,
      p.tier1_margin,
      CASE WHEN p.tier1_price IS NULL THEN NULL ELSE round(p.tier1_price * 100)::bigint END AS tier1_price_cents,
      p.tier2_margin,
      CASE WHEN p.tier2_price IS NULL THEN NULL ELSE round(p.tier2_price * 100)::bigint END AS tier2_price_cents,
      p.tier3_margin,
      CASE WHEN p.tier3_price IS NULL THEN NULL ELSE round(p.tier3_price * 100)::bigint END AS tier3_price_cents
    FROM public.products p
    WHERE p.is_active = true
      AND (p_product_ids IS NULL OR p.id = ANY(p_product_ids))
  )
  SELECT
    v_export_id, ep.id, ep.sku, ep.product_name,
    ep.category, ep.container_size_text, ep.unit_size, ep.inventory_unit,
    ep.identity_fp,
    md5(jsonb_build_object(
      'export_id', v_export_id,
      'product_id', ep.id,
      'identity_fingerprint', ep.identity_fp,
      'row_version', ep.pricing_version,
      'current_cost_cents', ep.cost_cents,
      'current_tier1_margin', ep.tier1_margin,
      'current_tier1_price_cents', ep.tier1_price_cents,
      'current_tier2_margin', ep.tier2_margin,
      'current_tier2_price_cents', ep.tier2_price_cents,
      'current_tier3_margin', ep.tier3_margin,
      'current_tier3_price_cents', ep.tier3_price_cents
    )::text),
    ep.pricing_version, ep.cost_cents,
    ep.tier1_margin, ep.tier1_price_cents,
    ep.tier2_margin, ep.tier2_price_cents,
    ep.tier3_margin, ep.tier3_price_cents
  FROM export_products ep
  ORDER BY ep.id;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count = 0 THEN RAISE EXCEPTION 'EXPORT_HAS_NO_PRODUCTS'; END IF;
  IF p_product_ids IS NOT NULL AND v_row_count <> cardinality(p_product_ids) THEN
    RAISE EXCEPTION 'EXPORT_PRODUCT_NOT_FOUND_OR_INACTIVE';
  END IF;

  SELECT md5(string_agg(
    product_id::text || ':' || identity_fingerprint || ':' || row_version::text,
    '|' ORDER BY product_id
  )) INTO v_manifest_fp
  FROM public.pricing_workbook_export_rows
  WHERE export_id = v_export_id;

  UPDATE public.pricing_workbook_exports
  SET row_count = v_row_count, manifest_fingerprint = v_manifest_fp
  WHERE id = v_export_id;

  SELECT jsonb_build_object(
    'export_id', e.id,
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
        'current_tier3_price', COALESCE(public._format_pricing_dollars(r.current_tier3_price_cents), '')
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
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.preview_product_pricing_changes(
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
  v_change_set_id uuid;
  v_export public.pricing_workbook_exports%ROWTYPE;
  v_row jsonb;
  v_sequence integer;
  v_product public.products%ROWTYPE;
  v_manifest public.pricing_workbook_export_rows%ROWTYPE;
  v_preview_product_id uuid;
  v_mode text;
  v_cost_cents bigint;
  v_t1_margin numeric;
  v_t2_margin numeric;
  v_t3_margin numeric;
  v_t1_price_cents bigint;
  v_t2_price_cents bigint;
  v_t3_price_cents bigint;
  v_calc jsonb;
  v_output jsonb;
  v_output_fp text;
  v_identity_fp text;
  v_expected_version bigint;
  v_error_message text;
  v_error_code text;
  v_final_status text;
  v_changed_count integer := 0;
  v_unchanged_count integer := 0;
  v_conflict_count integer := 0;
  v_invalid_count integer := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline') THEN
    RAISE EXCEPTION 'PRICING_SOURCE_INVALID';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'PRICING_ROWS_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) row_value
    GROUP BY row_value->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PRICING_DUPLICATE_PRODUCT_ID';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'source', p_source,
    'export_id', p_export_id,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'preview_product_pricing_changes');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF p_source = 'pricing_worksheet' THEN
    IF p_export_id IS NULL THEN RAISE EXCEPTION 'WORKBOOK_EXPORT_REQUIRED'; END IF;
    SELECT * INTO v_export FROM public.pricing_workbook_exports e
    WHERE e.id = p_export_id
      AND e.created_by = v_actor
      AND e.status = 'active'
      AND e.expires_at > now();
    IF NOT FOUND THEN RAISE EXCEPTION 'WORKBOOK_EXPORT_INVALID_OR_EXPIRED'; END IF;
    IF jsonb_array_length(p_rows) IS DISTINCT FROM v_export.row_count THEN
      RAISE EXCEPTION 'WORKBOOK_MANIFEST_ROW_COUNT_MISMATCH';
    END IF;
  ELSIF p_export_id IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_PRICING_EXPORT_NOT_ALLOWED';
  END IF;

  INSERT INTO public.pricing_change_sets(
    export_id, created_by, source, request_fingerprint,
    preview_idempotency_key, submitted_row_count, row_count, status
  ) VALUES (
    p_export_id, v_actor, p_source, v_request_fp,
    p_idempotency_key, jsonb_array_length(p_rows), 0, 'invalid'
  ) RETURNING id INTO v_change_set_id;

  FOR v_sequence, v_row IN
    SELECT ordinality::integer, value
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    v_preview_product_id := NULL;
    v_product.id := NULL;

    BEGIN
      IF jsonb_typeof(v_row) <> 'object'
         OR COALESCE(v_row->>'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR COALESCE(v_row->>'row_version', '') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'PRICING_ROW_IDENTITY_INVALID';
      END IF;

      IF p_source = 'pricing_worksheet' AND (
        NOT (v_row ? 'has_formula')
        OR jsonb_typeof(v_row->'has_formula') <> 'boolean'
        OR (v_row->>'has_formula')::boolean
        OR (v_row ? 'formula_cells' AND (
          jsonb_typeof(v_row->'formula_cells') <> 'array'
          OR jsonb_array_length(v_row->'formula_cells') > 0
        ))
      ) THEN
        RAISE EXCEPTION 'WORKBOOK_FORMULA_REJECTED';
      END IF;

      SELECT * INTO v_product
      FROM public.products
      WHERE id = (v_row->>'product_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'PRICING_PRODUCT_NOT_FOUND'; END IF;
      IF NOT v_product.is_active THEN RAISE EXCEPTION 'PRICING_PRODUCT_INACTIVE'; END IF;
      v_preview_product_id := v_product.id;

      v_expected_version := (v_row->>'row_version')::bigint;
      v_identity_fp := md5(jsonb_build_object(
        'product_id', v_product.id,
        'sku', COALESCE(v_product.sku, ''),
        'product_name', v_product.product_name,
        'category', COALESCE(v_product.category, ''),
        'container_size', COALESCE(v_product.container_size::text, ''),
        'unit_size', COALESCE(v_product.unit_size, ''),
        'inventory_unit', COALESCE(v_product.inventory_unit, '')
      )::text);

      IF p_source = 'pricing_worksheet' THEN
        SELECT * INTO v_manifest
        FROM public.pricing_workbook_export_rows
        WHERE export_id = p_export_id AND product_id = v_product.id;
        IF NOT FOUND THEN RAISE EXCEPTION 'WORKBOOK_UNKNOWN_PRODUCT'; END IF;

        IF NOT (v_row ?& ARRAY[
             'sku', 'product_name', 'category', 'container_size', 'unit_size',
             'inventory_unit', 'identity_fingerprint', 'row_token',
             'current_cost', 'current_tier1_margin_percent', 'current_tier1_price',
             'current_tier2_margin_percent', 'current_tier2_price',
             'current_tier3_margin_percent', 'current_tier3_price'
           ])
           OR v_row->>'sku' IS DISTINCT FROM COALESCE(v_manifest.sku_snapshot, '')
           OR v_row->>'product_name' IS DISTINCT FROM v_manifest.product_name_snapshot
           OR v_row->>'category' IS DISTINCT FROM COALESCE(v_manifest.category_snapshot, '')
           OR v_row->>'container_size' IS DISTINCT FROM COALESCE(v_manifest.container_size_snapshot, '')
           OR v_row->>'unit_size' IS DISTINCT FROM COALESCE(v_manifest.unit_size_snapshot, '')
           OR v_row->>'inventory_unit' IS DISTINCT FROM COALESCE(v_manifest.inventory_unit_snapshot, '')
           OR v_row->>'identity_fingerprint' IS DISTINCT FROM v_manifest.identity_fingerprint
           OR v_row->>'row_token' IS DISTINCT FROM v_manifest.row_token
           OR v_expected_version IS DISTINCT FROM v_manifest.row_version
           OR v_row->>'current_cost' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_cost_cents), '')
           OR v_row->>'current_tier1_margin_percent' IS DISTINCT FROM COALESCE(public._format_pricing_margin_percent(v_manifest.current_tier1_margin), '')
           OR v_row->>'current_tier1_price' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_tier1_price_cents), '')
           OR v_row->>'current_tier2_margin_percent' IS DISTINCT FROM COALESCE(public._format_pricing_margin_percent(v_manifest.current_tier2_margin), '')
           OR v_row->>'current_tier2_price' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_tier2_price_cents), '')
           OR v_row->>'current_tier3_margin_percent' IS DISTINCT FROM COALESCE(public._format_pricing_margin_percent(v_manifest.current_tier3_margin), '')
           OR v_row->>'current_tier3_price' IS DISTINCT FROM COALESCE(public._format_pricing_dollars(v_manifest.current_tier3_price_cents), '') THEN
          RAISE EXCEPTION 'WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED';
        END IF;
        IF v_product.pricing_version IS DISTINCT FROM v_manifest.row_version
           OR v_identity_fp IS DISTINCT FROM v_manifest.identity_fingerprint THEN
          RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
        END IF;
      ELSIF v_product.pricing_version IS DISTINCT FROM v_expected_version THEN
        RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
      END IF;

      v_mode := NULLIF(btrim(COALESCE(v_row->>'pricing_mode', '')), '');
      IF p_source = 'pricing_worksheet' AND v_mode IS NULL THEN
        -- Blank mode is the safe worksheet default. Proposed cells may remain
        -- blank or repeat the exact server-exported baseline, but cannot hide a
        -- pricing edit without an explicit mode.
        IF (COALESCE(v_row->>'new_cost', '') <> ''
              AND v_row->>'new_cost' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_cost_cents))
           OR (COALESCE(v_row->>'tier1_margin_percent', '') <> ''
              AND v_row->>'tier1_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier1_margin))
           OR (COALESCE(v_row->>'tier1_price', '') <> ''
              AND v_row->>'tier1_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier1_price_cents))
           OR (COALESCE(v_row->>'tier2_margin_percent', '') <> ''
              AND v_row->>'tier2_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier2_margin))
           OR (COALESCE(v_row->>'tier2_price', '') <> ''
              AND v_row->>'tier2_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier2_price_cents))
           OR (COALESCE(v_row->>'tier3_margin_percent', '') <> ''
              AND v_row->>'tier3_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier3_margin))
           OR (COALESCE(v_row->>'tier3_price', '') <> ''
              AND v_row->>'tier3_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier3_price_cents)) THEN
          RAISE EXCEPTION 'WORKBOOK_BLANK_MODE_CHANGED_VALUES';
        END IF;

        v_output := jsonb_build_object(
          'product_id', v_product.id,
          'product_name', v_product.product_name,
          'sku', COALESCE(v_product.sku, ''),
          'before', jsonb_build_object(
            'cost', public._format_pricing_dollars(round(v_product.current_cost * 100)::bigint),
            'cost_cents', round(v_product.current_cost * 100)::bigint,
            'tier1_margin_percent', public._format_pricing_margin_percent(v_product.tier1_margin),
            'tier1_margin', v_product.tier1_margin,
            'tier1_price', public._format_pricing_dollars(round(v_product.tier1_price * 100)::bigint),
            'tier1_price_cents', round(v_product.tier1_price * 100)::bigint,
            'tier2_margin_percent', public._format_pricing_margin_percent(v_product.tier2_margin),
            'tier2_margin', v_product.tier2_margin,
            'tier2_price', public._format_pricing_dollars(round(v_product.tier2_price * 100)::bigint),
            'tier2_price_cents', round(v_product.tier2_price * 100)::bigint,
            'tier3_margin_percent', public._format_pricing_margin_percent(v_product.tier3_margin),
            'tier3_margin', v_product.tier3_margin,
            'tier3_price', public._format_pricing_dollars(round(v_product.tier3_price * 100)::bigint),
            'tier3_price_cents', round(v_product.tier3_price * 100)::bigint,
            'tier1_price_per_acre_cents', round(v_product.tier1_price_per_acre * 100)::bigint,
            'tier2_price_per_acre_cents', round(v_product.tier2_price_per_acre * 100)::bigint,
            'tier3_price_per_acre_cents', round(v_product.tier3_price_per_acre * 100)::bigint
          ),
          'cost', public._format_pricing_dollars(v_manifest.current_cost_cents),
          'cost_cents', v_manifest.current_cost_cents,
          'tier1_margin_percent', public._format_pricing_margin_percent(v_manifest.current_tier1_margin),
          'tier1_margin', v_manifest.current_tier1_margin,
          'tier1_price', public._format_pricing_dollars(v_manifest.current_tier1_price_cents),
          'tier1_price_cents', v_manifest.current_tier1_price_cents,
          'tier2_margin_percent', public._format_pricing_margin_percent(v_manifest.current_tier2_margin),
          'tier2_margin', v_manifest.current_tier2_margin,
          'tier2_price', public._format_pricing_dollars(v_manifest.current_tier2_price_cents),
          'tier2_price_cents', v_manifest.current_tier2_price_cents,
          'tier3_margin_percent', public._format_pricing_margin_percent(v_manifest.current_tier3_margin),
          'tier3_margin', v_manifest.current_tier3_margin,
          'tier3_price', public._format_pricing_dollars(v_manifest.current_tier3_price_cents),
          'tier3_price_cents', v_manifest.current_tier3_price_cents
        );
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, effect
        ) VALUES (
          v_change_set_id, v_sequence, v_product.id, v_row, 'unchanged', v_output
        );
        v_unchanged_count := v_unchanged_count + 1;
        CONTINUE;
      END IF;

      IF v_mode NOT IN ('margin_driven', 'price_driven') THEN
        RAISE EXCEPTION 'PRICING_MODE_INVALID';
      END IF;
      IF NOT (v_row ? 'new_cost') OR jsonb_typeof(v_row->'new_cost') <> 'string' THEN
        RAISE EXCEPTION 'PRICING_DOLLARS_INVALID';
      END IF;
      v_cost_cents := public._parse_pricing_dollars(v_row->>'new_cost');

      IF v_mode = 'margin_driven' THEN
        IF NOT (v_row ?& ARRAY['tier1_margin_percent', 'tier2_margin_percent', 'tier3_margin_percent'])
           OR jsonb_typeof(v_row->'tier1_margin_percent') <> 'string'
           OR jsonb_typeof(v_row->'tier2_margin_percent') <> 'string'
           OR jsonb_typeof(v_row->'tier3_margin_percent') <> 'string' THEN
          RAISE EXCEPTION 'MARGIN_DRIVEN_FIELDS_INVALID';
        END IF;
        IF p_source = 'pricing_worksheet' AND (
             (COALESCE(v_row->>'tier1_price', '') <> '' AND v_row->>'tier1_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier1_price_cents))
          OR (COALESCE(v_row->>'tier2_price', '') <> '' AND v_row->>'tier2_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier2_price_cents))
          OR (COALESCE(v_row->>'tier3_price', '') <> '' AND v_row->>'tier3_price' IS DISTINCT FROM public._format_pricing_dollars(v_manifest.current_tier3_price_cents))
        ) THEN
          RAISE EXCEPTION 'MARGIN_DRIVEN_COMPANION_FIELDS_CHANGED';
        ELSIF p_source <> 'pricing_worksheet' AND (
          COALESCE(v_row->>'tier1_price', '') <> '' OR COALESCE(v_row->>'tier2_price', '') <> ''
          OR COALESCE(v_row->>'tier3_price', '') <> ''
        ) THEN
          RAISE EXCEPTION 'MARGIN_DRIVEN_FIELDS_INVALID';
        END IF;
        v_t1_margin := public._parse_pricing_margin_percent(v_row->>'tier1_margin_percent');
        v_t2_margin := public._parse_pricing_margin_percent(v_row->>'tier2_margin_percent');
        v_t3_margin := public._parse_pricing_margin_percent(v_row->>'tier3_margin_percent');
        v_t1_price_cents := NULL; v_t2_price_cents := NULL; v_t3_price_cents := NULL;
      ELSE
        IF NOT (v_row ?& ARRAY['tier1_price', 'tier2_price', 'tier3_price'])
           OR jsonb_typeof(v_row->'tier1_price') <> 'string'
           OR jsonb_typeof(v_row->'tier2_price') <> 'string'
           OR jsonb_typeof(v_row->'tier3_price') <> 'string' THEN
          RAISE EXCEPTION 'PRICE_DRIVEN_FIELDS_INVALID';
        END IF;
        IF p_source = 'pricing_worksheet' AND (
             (COALESCE(v_row->>'tier1_margin_percent', '') <> '' AND v_row->>'tier1_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier1_margin))
          OR (COALESCE(v_row->>'tier2_margin_percent', '') <> '' AND v_row->>'tier2_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier2_margin))
          OR (COALESCE(v_row->>'tier3_margin_percent', '') <> '' AND v_row->>'tier3_margin_percent' IS DISTINCT FROM public._format_pricing_margin_percent(v_manifest.current_tier3_margin))
        ) THEN
          RAISE EXCEPTION 'PRICE_DRIVEN_COMPANION_FIELDS_CHANGED';
        ELSIF p_source <> 'pricing_worksheet' AND (
          COALESCE(v_row->>'tier1_margin_percent', '') <> '' OR COALESCE(v_row->>'tier2_margin_percent', '') <> ''
          OR COALESCE(v_row->>'tier3_margin_percent', '') <> ''
        ) THEN
          RAISE EXCEPTION 'PRICE_DRIVEN_FIELDS_INVALID';
        END IF;
        v_t1_margin := NULL; v_t2_margin := NULL; v_t3_margin := NULL;
        v_t1_price_cents := public._parse_pricing_dollars(v_row->>'tier1_price');
        v_t2_price_cents := public._parse_pricing_dollars(v_row->>'tier2_price');
        v_t3_price_cents := public._parse_pricing_dollars(v_row->>'tier3_price');
      END IF;

      v_calc := public._calculate_product_pricing(
        v_mode,
        v_cost_cents::numeric / 100,
        v_t1_margin, v_t2_margin, v_t3_margin,
        CASE WHEN v_t1_price_cents IS NULL THEN NULL ELSE v_t1_price_cents::numeric / 100 END,
        CASE WHEN v_t2_price_cents IS NULL THEN NULL ELSE v_t2_price_cents::numeric / 100 END,
        CASE WHEN v_t3_price_cents IS NULL THEN NULL ELSE v_t3_price_cents::numeric / 100 END
      );

      v_output := jsonb_build_object(
        'product_id', v_product.id,
        'product_name', v_product.product_name,
        'sku', COALESCE(v_product.sku, ''),
        'before', jsonb_build_object(
          'cost', public._format_pricing_dollars(round(v_product.current_cost * 100)::bigint),
          'cost_cents', round(v_product.current_cost * 100)::bigint,
          'tier1_margin_percent', public._format_pricing_margin_percent(v_product.tier1_margin),
          'tier1_margin', v_product.tier1_margin,
          'tier1_price', public._format_pricing_dollars(round(v_product.tier1_price * 100)::bigint),
          'tier1_price_cents', round(v_product.tier1_price * 100)::bigint,
          'tier2_margin_percent', public._format_pricing_margin_percent(v_product.tier2_margin),
          'tier2_margin', v_product.tier2_margin,
          'tier2_price', public._format_pricing_dollars(round(v_product.tier2_price * 100)::bigint),
          'tier2_price_cents', round(v_product.tier2_price * 100)::bigint,
          'tier3_margin_percent', public._format_pricing_margin_percent(v_product.tier3_margin),
          'tier3_margin', v_product.tier3_margin,
          'tier3_price', public._format_pricing_dollars(round(v_product.tier3_price * 100)::bigint),
          'tier3_price_cents', round(v_product.tier3_price * 100)::bigint,
          'tier1_price_per_acre_cents', round(v_product.tier1_price_per_acre * 100)::bigint,
          'tier2_price_per_acre_cents', round(v_product.tier2_price_per_acre * 100)::bigint,
          'tier3_price_per_acre_cents', round(v_product.tier3_price_per_acre * 100)::bigint
        ),
        'pricing_mode', v_mode,
        'cost', public._format_pricing_dollars(round((v_calc->>'current_cost')::numeric * 100)::bigint),
        'cost_cents', round((v_calc->>'current_cost')::numeric * 100)::bigint,
        'tier1_margin_percent', public._format_pricing_margin_percent((v_calc->>'tier1_margin')::numeric),
        'tier1_margin', (v_calc->>'tier1_margin')::numeric,
        'tier2_margin_percent', public._format_pricing_margin_percent((v_calc->>'tier2_margin')::numeric),
        'tier2_margin', (v_calc->>'tier2_margin')::numeric,
        'tier3_margin_percent', public._format_pricing_margin_percent((v_calc->>'tier3_margin')::numeric),
        'tier3_margin', (v_calc->>'tier3_margin')::numeric,
        'tier1_price', public._format_pricing_dollars(round((v_calc->>'tier1_price')::numeric * 100)::bigint),
        'tier1_price_cents', round((v_calc->>'tier1_price')::numeric * 100)::bigint,
        'tier2_price', public._format_pricing_dollars(round((v_calc->>'tier2_price')::numeric * 100)::bigint),
        'tier2_price_cents', round((v_calc->>'tier2_price')::numeric * 100)::bigint,
        'tier3_price', public._format_pricing_dollars(round((v_calc->>'tier3_price')::numeric * 100)::bigint),
        'tier3_price_cents', round((v_calc->>'tier3_price')::numeric * 100)::bigint,
        'tier1_gross_margin', v_calc->'tier1_gross_margin',
        'tier2_gross_margin', v_calc->'tier2_gross_margin',
        'tier3_gross_margin', v_calc->'tier3_gross_margin',
        'tier1_price_per_acre_cents', CASE
          WHEN public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
          THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
        'tier2_price_per_acre_cents', CASE
          WHEN public.product_price_per_acre((v_calc->>'tier2_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
          THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier2_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
        'tier3_price_per_acre_cents', CASE
          WHEN public.product_price_per_acre((v_calc->>'tier3_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
          THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier3_price')::numeric,
            v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END
      );
      v_output_fp := md5((v_output - ARRAY[
        'product_id', 'product_name', 'sku', 'before', 'pricing_mode', 'cost',
        'tier1_margin_percent', 'tier2_margin_percent', 'tier3_margin_percent',
        'tier1_price', 'tier2_price', 'tier3_price'
      ]::text[])::text);

      IF (v_output->>'cost_cents')::bigint IS NOT DISTINCT FROM round(v_product.current_cost * 100)::bigint
         AND (v_output->>'tier1_margin')::numeric IS NOT DISTINCT FROM v_product.tier1_margin
         AND (v_output->>'tier2_margin')::numeric IS NOT DISTINCT FROM v_product.tier2_margin
         AND (v_output->>'tier3_margin')::numeric IS NOT DISTINCT FROM v_product.tier3_margin
         AND (v_output->>'tier1_price_cents')::bigint IS NOT DISTINCT FROM round(v_product.tier1_price * 100)::bigint
         AND (v_output->>'tier2_price_cents')::bigint IS NOT DISTINCT FROM round(v_product.tier2_price * 100)::bigint
         AND (v_output->>'tier3_price_cents')::bigint IS NOT DISTINCT FROM round(v_product.tier3_price * 100)::bigint THEN
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, effect
        ) VALUES (
          v_change_set_id, v_sequence, v_product.id, v_row, 'unchanged', v_output
        );
        v_unchanged_count := v_unchanged_count + 1;
        CONTINUE;
      END IF;

      INSERT INTO public.pricing_change_set_rows(
        change_set_id, product_id, identity_fingerprint, expected_version,
        pricing_mode, change_reason,
        input_cost_cents, input_tier1_margin, input_tier2_margin, input_tier3_margin,
        input_tier1_price_cents, input_tier2_price_cents, input_tier3_price_cents,
        output_cost_cents, output_tier1_margin, output_tier2_margin, output_tier3_margin,
        output_tier1_price_cents, output_tier2_price_cents, output_tier3_price_cents,
        output_tier1_gross_margin, output_tier2_gross_margin, output_tier3_gross_margin,
        output_tier1_price_per_acre_cents, output_tier2_price_per_acre_cents,
        output_tier3_price_per_acre_cents, output_fingerprint
      ) VALUES (
        v_change_set_id, v_product.id, v_identity_fp, v_expected_version,
        v_mode, NULLIF(btrim(v_row->>'change_reason'), ''),
        v_cost_cents, v_t1_margin, v_t2_margin, v_t3_margin,
        v_t1_price_cents, v_t2_price_cents, v_t3_price_cents,
        (v_output->>'cost_cents')::bigint,
        (v_output->>'tier1_margin')::numeric,
        (v_output->>'tier2_margin')::numeric,
        (v_output->>'tier3_margin')::numeric,
        (v_output->>'tier1_price_cents')::bigint,
        (v_output->>'tier2_price_cents')::bigint,
        (v_output->>'tier3_price_cents')::bigint,
        (v_output->>'tier1_gross_margin')::numeric,
        (v_output->>'tier2_gross_margin')::numeric,
        (v_output->>'tier3_gross_margin')::numeric,
        (v_output->>'tier1_price_per_acre_cents')::bigint,
        (v_output->>'tier2_price_per_acre_cents')::bigint,
        (v_output->>'tier3_price_per_acre_cents')::bigint,
        v_output_fp
      );
      INSERT INTO public.pricing_change_set_preview_rows(
        change_set_id, sequence, product_id, submitted_row, row_status, effect
      ) VALUES (
        v_change_set_id, v_sequence, v_product.id, v_row, 'ready', v_output
      );
      v_changed_count := v_changed_count + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
      v_error_code := CASE
        WHEN v_error_message ~ '^[A-Z0-9_]+$' THEN v_error_message
        ELSE 'PRICING_ROW_INVALID'
      END;
      IF v_error_code = 'PRICING_ROW_CONFLICT' THEN
        v_conflict_count := v_conflict_count + 1;
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, error_code
        ) VALUES (
          v_change_set_id, v_sequence, v_preview_product_id, v_row, 'conflict', v_error_code
        );
      ELSE
        v_invalid_count := v_invalid_count + 1;
        INSERT INTO public.pricing_change_set_preview_rows(
          change_set_id, sequence, product_id, submitted_row, row_status, error_code
        ) VALUES (
          v_change_set_id, v_sequence, v_preview_product_id, v_row, 'invalid', v_error_code
        );
      END IF;
    END;
  END LOOP;

  v_final_status := CASE
    WHEN v_conflict_count > 0 OR v_invalid_count > 0 THEN 'invalid'
    WHEN v_changed_count = 0 THEN 'no_changes'
    ELSE 'previewed'
  END;
  UPDATE public.pricing_change_sets
  SET row_count = v_changed_count, status = v_final_status
  WHERE id = v_change_set_id;
  SELECT jsonb_build_object(
    'change_set_id', c.id,
    'request_fingerprint', c.request_fingerprint,
    'source', c.source,
    'status', c.status,
    'expires_at', c.expires_at,
    'submitted_row_count', c.submitted_row_count,
    'ready_count', c.row_count,
    'unchanged_count', v_unchanged_count,
    'conflict_count', v_conflict_count,
    'invalid_count', v_invalid_count,
    'apply_allowed', (c.status = 'previewed' AND c.row_count > 0),
    'rows', (
      SELECT jsonb_agg(to_jsonb(r) - 'change_set_id' ORDER BY r.sequence)
      FROM public.pricing_change_set_preview_rows r WHERE r.change_set_id = c.id
    )
  ) INTO v_result
  FROM public.pricing_change_sets c WHERE c.id = v_change_set_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'preview_product_pricing_changes',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Ordered compatibility/version trigger and governed history writer
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_and_version_product_pricing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_core_changed boolean;
  v_per_acre_changed boolean;
  v_actor uuid;
  v_change_set_id uuid;
  v_source text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The additive bootstrap must remain compatible with the currently
    -- deployed Product form, which can still create a priced Product. The
    -- cutover migration adds the strict governed-path trigger after the new
    -- frontend is deployed. The version itself is always server-owned.
    NEW.pricing_version := 1;
    RETURN NEW;
  END IF;

  IF NEW.pricing_version IS DISTINCT FROM OLD.pricing_version THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_VERSION_MANAGED_BY_DATABASE';
  END IF;

  v_core_changed :=
    OLD.current_cost IS DISTINCT FROM NEW.current_cost
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

  IF v_core_changed THEN
    -- Legacy direct writes remain temporarily allowed during the additive
    -- rollout. Governed RPC writes identify themselves and must satisfy the
    -- complete context check even before final cutover.
    IF current_setting('crx.pricing_authorized', true) = 'phase1a' THEN
      v_actor := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
      v_change_set_id := NULLIF(current_setting('crx.pricing_change_set_id', true), '')::uuid;
      v_source := NULLIF(current_setting('crx.pricing_source', true), '');
      IF v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
         OR v_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline')
         OR NOT public.is_admin()
         OR NOT EXISTS (
           SELECT 1 FROM public.pricing_change_sets c
           JOIN public.pricing_change_set_rows r ON r.change_set_id = c.id
           WHERE c.id = v_change_set_id
             AND c.created_by = v_actor
             AND c.source = v_source
             AND c.status = 'previewed'
             AND r.product_id = NEW.id
         ) THEN
        RAISE EXCEPTION 'PRODUCT_PRICING_CONTEXT_INVALID';
      END IF;
    END IF;
  END IF;

  IF v_core_changed OR v_per_acre_changed THEN
    NEW.pricing_version := OLD.pricing_version + 1;
  ELSE
    NEW.pricing_version := OLD.pricing_version;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_z_guard_version_product_pricing ON public.products;
CREATE TRIGGER trigger_z_guard_version_product_pricing
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_and_version_product_pricing();

CREATE OR REPLACE FUNCTION public.write_product_pricing_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
  v_source text := NULLIF(current_setting('crx.pricing_source', true), '');
  v_reason text := NULLIF(current_setting('crx.pricing_reason', true), '');
  v_change_set_id uuid := NULLIF(current_setting('crx.pricing_change_set_id', true), '')::uuid;
BEGIN
  IF NOT (
    OLD.current_cost IS DISTINCT FROM NEW.current_cost
    OR OLD.tier1_margin IS DISTINCT FROM NEW.tier1_margin
    OR OLD.tier2_margin IS DISTINCT FROM NEW.tier2_margin
    OR OLD.tier3_margin IS DISTINCT FROM NEW.tier3_margin
    OR OLD.tier1_price IS DISTINCT FROM NEW.tier1_price
    OR OLD.tier2_price IS DISTINCT FROM NEW.tier2_price
    OR OLD.tier3_price IS DISTINCT FROM NEW.tier3_price
    OR OLD.tier1_gross_margin IS DISTINCT FROM NEW.tier1_gross_margin
    OR OLD.tier2_gross_margin IS DISTINCT FROM NEW.tier2_gross_margin
    OR OLD.tier3_gross_margin IS DISTINCT FROM NEW.tier3_gross_margin
  ) THEN
    RETURN NEW;
  END IF;

  -- Until cutover, the deployed frontend remains the writer for legacy direct
  -- changes. Skip those here so its explicit history INSERT stays exactly-once.
  IF current_setting('crx.pricing_authorized', true) IS DISTINCT FROM 'phase1a' THEN
    RETURN NEW;
  END IF;

  IF v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
     OR v_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline')
     OR NOT public.is_admin()
     OR v_change_set_id IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_HISTORY_CONTEXT_INVALID';
  END IF;

  INSERT INTO public.cost_history(
    product_id, changed_by,
    old_cost, new_cost,
    old_tier1_price, new_tier1_price,
    old_tier2_price, new_tier2_price,
    old_tier3_price, new_tier3_price,
    old_tier1_margin, new_tier1_margin,
    old_tier2_margin, new_tier2_margin,
    old_tier3_margin, new_tier3_margin,
    change_note, change_source, change_reason, change_set_id,
    old_pricing_version, new_pricing_version
  ) VALUES (
    NEW.id, v_actor,
    OLD.current_cost, NEW.current_cost,
    OLD.tier1_price, NEW.tier1_price,
    OLD.tier2_price, NEW.tier2_price,
    OLD.tier3_price, NEW.tier3_price,
    OLD.tier1_margin, NEW.tier1_margin,
    OLD.tier2_margin, NEW.tier2_margin,
    OLD.tier3_margin, NEW.tier3_margin,
    v_reason, v_source, v_reason, v_change_set_id,
    OLD.pricing_version, NEW.pricing_version
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_write_product_pricing_history ON public.products;
CREATE TRIGGER trigger_write_product_pricing_history
  AFTER UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.write_product_pricing_history();

REVOKE ALL ON FUNCTION public.guard_and_version_product_pricing()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_product_pricing_history()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Atomic apply RPC
-- ---------------------------------------------------------------------------

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
  v_row public.pricing_change_set_rows%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_calc jsonb;
  v_output jsonb;
  v_output_fp text;
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
  v_existing := public.check_idempotency(p_idempotency_key, 'apply_product_pricing_change_set');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_idem_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- The shared cache expires, but an apply key may never be rebound to a
  -- different durable change set. The unique partial index closes the
  -- concurrent race; this check provides a stable owner-facing error for the
  -- ordinary sequential retry/reuse case.
  IF EXISTS (
    SELECT 1
    FROM public.pricing_change_sets
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
    -- The shared idempotency cache is finite-lived. The applied change set is
    -- the durable receipt, so the exact original key remains retry-safe even
    -- after that cache row expires; every different key still fails closed.
    IF v_change_set.apply_idempotency_key IS NOT DISTINCT FROM p_idempotency_key THEN
      RETURN v_change_set.apply_result;
    END IF;
    RAISE EXCEPTION 'CHANGE_SET_ALREADY_APPLIED';
  END IF;
  IF v_change_set.status <> 'previewed' OR v_change_set.row_count <= 0
     OR v_change_set.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_SET_INVALID_OR_EXPIRED';
  END IF;

  -- Lock and validate the retained workbook export before any product lock.
  -- This prevents a second preview from applying after the same workbook was
  -- already consumed. An exact apply idempotency retry returned above.
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

  -- Stable lock order prevents two overlapping batches from deadlocking. No
  -- product is changed until every row has been locked and version-validated.
  PERFORM p.id
  FROM public.products p
  JOIN public.pricing_change_set_rows r ON r.product_id = p.id
  WHERE r.change_set_id = p_change_set_id
  ORDER BY p.id
  FOR UPDATE OF p;

  IF v_change_set.row_count IS DISTINCT FROM (
    SELECT count(*) FROM public.pricing_change_set_rows r WHERE r.change_set_id = p_change_set_id
  ) OR EXISTS (
    SELECT 1
    FROM public.pricing_change_set_rows r
    LEFT JOIN public.products p ON p.id = r.product_id
    WHERE r.change_set_id = p_change_set_id
      AND (
        p.id IS NULL
        OR NOT p.is_active
        OR p.pricing_version IS DISTINCT FROM r.expected_version
        OR md5(jsonb_build_object(
          'product_id', p.id,
          'sku', COALESCE(p.sku, ''),
          'product_name', p.product_name,
          'category', COALESCE(p.category, ''),
          'container_size', COALESCE(p.container_size::text, ''),
          'unit_size', COALESCE(p.unit_size, ''),
          'inventory_unit', COALESCE(p.inventory_unit, '')
        )::text) IS DISTINCT FROM r.identity_fingerprint
      )
  ) THEN
    RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
  END IF;

  FOR v_row IN
    SELECT * FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    SELECT * INTO v_product FROM public.products WHERE id = v_row.product_id;
    v_calc := public._calculate_product_pricing(
      v_row.pricing_mode,
      v_row.input_cost_cents::numeric / 100,
      v_row.input_tier1_margin, v_row.input_tier2_margin, v_row.input_tier3_margin,
      CASE WHEN v_row.input_tier1_price_cents IS NULL THEN NULL ELSE v_row.input_tier1_price_cents::numeric / 100 END,
      CASE WHEN v_row.input_tier2_price_cents IS NULL THEN NULL ELSE v_row.input_tier2_price_cents::numeric / 100 END,
      CASE WHEN v_row.input_tier3_price_cents IS NULL THEN NULL ELSE v_row.input_tier3_price_cents::numeric / 100 END
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
      'tier1_price_per_acre_cents', CASE
        WHEN public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
        THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier1_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
      'tier2_price_per_acre_cents', CASE
        WHEN public.product_price_per_acre((v_calc->>'tier2_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
        THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier2_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END,
      'tier3_price_per_acre_cents', CASE
        WHEN public.product_price_per_acre((v_calc->>'tier3_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) IS NULL
        THEN NULL ELSE round(public.product_price_per_acre((v_calc->>'tier3_price')::numeric,
          v_product.rate_per_acre, v_product.rate_unit, v_product.inventory_unit, v_product.unit_size) * 100)::bigint END
    );
    v_output_fp := md5(v_output::text);
    IF v_output_fp IS DISTINCT FROM v_row.output_fingerprint THEN
      RAISE EXCEPTION 'CHANGE_SET_OUTPUT_DRIFT';
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT * FROM public.pricing_change_set_rows
    WHERE change_set_id = p_change_set_id
    ORDER BY product_id
  LOOP
    PERFORM set_config('crx.pricing_authorized', 'phase1a', true);
    PERFORM set_config('crx.pricing_actor', v_actor::text, true);
    PERFORM set_config('crx.pricing_source', v_change_set.source, true);
    PERFORM set_config('crx.pricing_reason', COALESCE(v_row.change_reason, ''), true);
    PERFORM set_config('crx.pricing_change_set_id', p_change_set_id::text, true);
    PERFORM set_config('crx.pricing_mode', v_row.pricing_mode, true);

    UPDATE public.products
    SET current_cost = v_row.output_cost_cents::numeric / 100,
        tier1_margin = v_row.output_tier1_margin,
        tier2_margin = v_row.output_tier2_margin,
        tier3_margin = v_row.output_tier3_margin,
        tier1_price = v_row.output_tier1_price_cents::numeric / 100,
        tier2_price = v_row.output_tier2_price_cents::numeric / 100,
        tier3_price = v_row.output_tier3_price_cents::numeric / 100,
        cost_updated_date = CASE
          WHEN current_cost IS DISTINCT FROM v_row.output_cost_cents::numeric / 100 THEN now()
          ELSE cost_updated_date END,
        updated_at = now()
    WHERE id = v_row.product_id;
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
  JOIN public.pricing_change_set_rows r ON r.product_id = p.id
  WHERE r.change_set_id = p_change_set_id;

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
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_idem_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Backward-compatible RPC grants
-- ---------------------------------------------------------------------------

-- caller-analysis: create_pricing_workbook_export :: new authenticated-admin
-- Products-page export caller; PUBLIC/anon/service_role intentionally receive
-- no EXECUTE, authenticated is granted below, and the function rechecks
-- auth.uid(), strict actor identity, active admin role, and idempotency.
REVOKE ALL ON FUNCTION public.create_pricing_workbook_export(uuid[], uuid, text)
  FROM PUBLIC, anon, service_role;
-- caller-analysis: preview_product_pricing_changes :: new authenticated-admin
-- caller shared by ProductDetail, Products inline edits, and worksheet upload;
-- authenticated is granted below and all other API roles are revoked.
REVOKE ALL ON FUNCTION public.preview_product_pricing_changes(text, uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, service_role;
-- caller-analysis: apply_product_pricing_change_set :: new authenticated-admin
-- approval caller shared by the same three UI surfaces; authenticated is
-- granted below, with actor, change-set, row-version, identity, atomicity, and
-- durable idempotency checks enforced inside the SECURITY DEFINER function.
REVOKE ALL ON FUNCTION public.apply_product_pricing_change_set(uuid, text, uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_pricing_workbook_export(uuid[], uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_product_pricing_changes(text, uuid, jsonb, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_product_pricing_change_set(uuid, text, uuid, text)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Migration-time assertions (catalog only; no business-data smoke here)
-- ---------------------------------------------------------------------------

DO $assertions$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'create_pricing_workbook_export', 'preview_product_pricing_changes',
      'apply_product_pricing_change_set', '_calculate_product_pricing',
      '_parse_pricing_dollars', '_parse_pricing_margin_percent',
      '_format_pricing_dollars', '_format_pricing_margin_percent',
      'calculate_prices_from_margin', 'guard_and_version_product_pricing',
      'write_product_pricing_history'
    );
  IF v_count <> 11 THEN RAISE EXCEPTION 'pricing function overload/drift detected: %', v_count; END IF;

  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'pricing_workbook_exports', 'pricing_workbook_export_rows',
      'pricing_change_sets', 'pricing_change_set_rows',
      'pricing_change_set_preview_rows'
    )
    AND c.relkind = 'r'
    AND c.relrowsecurity;
  IF v_count <> 5 THEN RAISE EXCEPTION 'pricing private table/RLS drift detected: %', v_count; END IF;

  SELECT count(*) INTO v_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'pricing_workbook_exports', 'pricing_workbook_export_rows',
      'pricing_change_sets', 'pricing_change_set_rows',
      'pricing_change_set_preview_rows'
    )
    AND p.polname LIKE '%\_rpc\_only' ESCAPE '\'
    AND pg_get_expr(p.polqual, p.polrelid) = 'false'
    AND pg_get_expr(p.polwithcheck, p.polrelid) = 'false';
  IF v_count <> 5 THEN RAISE EXCEPTION 'pricing private table/policy drift detected: %', v_count; END IF;

  SELECT count(*) INTO v_count
  FROM (VALUES
    ('pricing_workbook_exports'),
    ('pricing_workbook_export_rows'),
    ('pricing_change_sets'),
    ('pricing_change_set_rows'),
    ('pricing_change_set_preview_rows')
  ) AS t(relname)
  CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role_name)
  WHERE has_table_privilege(
    r.role_name,
    format('public.%I', t.relname),
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  );
  IF v_count <> 0 THEN RAISE EXCEPTION 'pricing private table privilege drift detected: %', v_count; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.products'::regclass
      AND tgname = 'trigger_z_guard_version_product_pricing'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.products'::regclass
      AND tgname = 'trigger_write_product_pricing_history'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'pricing guard/history trigger missing';
  END IF;

  -- The bootstrap is intentionally additive. The deployed legacy frontend
  -- still needs these grants until the new RPC-only frontend has shipped.
  IF NOT has_table_privilege('authenticated', 'public.products', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.products', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.cost_history', 'INSERT') THEN
    RAISE EXCEPTION 'additive bootstrap removed a legacy frontend write grant';
  END IF;
  IF has_table_privilege('authenticated', 'public.pricing_change_set_preview_rows', 'SELECT')
     OR has_table_privilege('authenticated', 'public.pricing_change_set_preview_rows', 'INSERT')
     OR has_table_privilege('anon', 'public.pricing_change_set_preview_rows', 'SELECT') THEN
    RAISE EXCEPTION 'preview rows were exposed outside governed RPCs';
  END IF;
END;
$assertions$;
