\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END;
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'sales_rep',
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applicator_license_number text,
  faa_certificate_number text,
  denied_pages text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL,
  sku text,
  category text,
  vendor text,
  manufacturer text,
  container_size numeric,
  unit_size text,
  current_cost numeric,
  cost_updated_date timestamptz,
  tier1_price numeric,
  tier1_margin numeric,
  tier2_price numeric,
  tier2_margin numeric,
  tier3_price numeric,
  tier3_margin numeric,
  tier1_price_per_acre numeric,
  tier2_price_per_acre numeric,
  tier3_price_per_acre numeric,
  suggested_rate text,
  rate_per_acre numeric,
  rate_unit text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  tier1_gross_margin numeric,
  tier2_gross_margin numeric,
  tier3_gross_margin numeric,
  epa_registration text,
  product_form text,
  inventory_unit text,
  container_unit text,
  container_type text,
  is_rup boolean NOT NULL DEFAULT false,
  signal_word text,
  internal_notes text,
  rei_hours integer,
  phi_days integer,
  max_label_rate numeric,
  max_label_rate_unit text,
  use_timing text
);

CREATE TABLE public.cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES public.profiles(id),
  old_cost numeric,
  new_cost numeric,
  old_tier1_price numeric,
  new_tier1_price numeric,
  old_tier2_price numeric,
  new_tier2_price numeric,
  old_tier3_price numeric,
  new_tier3_price numeric,
  change_note text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit text NOT NULL UNIQUE,
  factor_oz numeric NOT NULL DEFAULT 0,
  notes text,
  unit_type text NOT NULL DEFAULT 'both'
);

CREATE TABLE public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  operation text NOT NULL,
  result jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);

INSERT INTO public.unit_conversions(unit, factor_oz, unit_type)
VALUES ('oz', 1, 'both'), ('gal', 128, 'both'), ('lb', 16, 'both');

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'
      AND is_active = true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RETURN NULL; END IF;
  IF btrim(p_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );
  DELETE FROM public.idempotency_keys
  WHERE idempotency_key = p_key AND expires_at < now();
  SELECT * INTO v_existing
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF v_existing.operation IS DISTINCT FROM p_operation THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
        p_key, v_existing.operation, p_operation;
    END IF;
    RETURN v_existing.result;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_idempotency(
  p_key text,
  p_operation text,
  p_result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_op text;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  SELECT operation INTO v_existing_op
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key AND operation <> p_operation
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE'; END IF;
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public._guard_idempotency_key_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_operation text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || NEW.idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
  WHERE idempotency_key = NEW.idempotency_key
    AND expires_at < now();

  SELECT operation INTO v_existing_operation
  FROM public.idempotency_keys
  WHERE idempotency_key = NEW.idempotency_key;

  IF FOUND THEN
    IF v_existing_operation IS DISTINCT FROM NEW.operation THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
        NEW.idempotency_key, v_existing_operation, NEW.operation;
    END IF;

    IF NEW.operation = 'allocate_payment'
       AND NEW.result->>'_contract' = 'allocate_payment_v1'
       AND NEW.result ? 'request'
       AND NEW.result->'response' = 'null'::jsonb THEN
      RETURN NULL;
    END IF;

    RAISE EXCEPTION
      'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY: operation % with key % completed concurrently; retry to read its saved result',
      NEW.operation, NEW.idempotency_key;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_idempotency_key_insert
BEFORE INSERT ON public.idempotency_keys
FOR EACH ROW EXECUTE FUNCTION public._guard_idempotency_key_insert();

CREATE OR REPLACE FUNCTION public.product_price_per_acre(
  p_tier_price numeric,
  p_rate_per_acre numeric,
  p_rate_unit text,
  p_inventory_unit text,
  p_unit_size text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rate_factor numeric;
  v_inv_factor numeric;
  v_inv_unit text;
BEGIN
  IF p_rate_per_acre IS NULL OR p_rate_per_acre <= 0 THEN RETURN NULL; END IF;
  v_rate_factor := COALESCE(
    (SELECT factor_oz FROM public.unit_conversions WHERE lower(unit) = lower(p_rate_unit) LIMIT 1),
    1
  );
  v_inv_unit := COALESCE(NULLIF(p_inventory_unit, ''), p_unit_size);
  v_inv_factor := COALESCE(
    (SELECT factor_oz FROM public.unit_conversions WHERE lower(unit) = lower(v_inv_unit) LIMIT 1),
    1
  );
  IF v_inv_factor <= 0 THEN RETURN NULL; END IF;
  RETURN round((COALESCE(p_tier_price, 0) * p_rate_per_acre * v_rate_factor / v_inv_factor)::numeric, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_prices_from_margin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.current_cost IS NOT NULL AND NEW.current_cost > 0 THEN
    IF NEW.tier1_margin IS NOT NULL AND NEW.tier1_margin < 1 AND NEW.tier1_margin > 0 THEN
      NEW.tier1_price := round(NEW.current_cost / (1 - NEW.tier1_margin), 2);
      NEW.tier1_gross_margin := round(NEW.tier1_margin / (1 - NEW.tier1_margin), 4);
    ELSE NEW.tier1_gross_margin := NULL;
    END IF;
    IF NEW.tier2_margin IS NOT NULL AND NEW.tier2_margin < 1 AND NEW.tier2_margin > 0 THEN
      NEW.tier2_price := round(NEW.current_cost / (1 - NEW.tier2_margin), 2);
      NEW.tier2_gross_margin := round(NEW.tier2_margin / (1 - NEW.tier2_margin), 4);
    ELSE NEW.tier2_gross_margin := NULL;
    END IF;
    IF NEW.tier3_margin IS NOT NULL AND NEW.tier3_margin < 1 AND NEW.tier3_margin > 0 THEN
      NEW.tier3_price := round(NEW.current_cost / (1 - NEW.tier3_margin), 2);
      NEW.tier3_gross_margin := round(NEW.tier3_margin / (1 - NEW.tier3_margin), 4);
    ELSE NEW.tier3_gross_margin := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalc_product_price_per_acre()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_t1 numeric := COALESCE(NEW.tier1_price, 0);
BEGIN
  NEW.tier1_price_per_acre := public.product_price_per_acre(
    v_t1, NEW.rate_per_acre, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size);
  NEW.tier2_price_per_acre := public.product_price_per_acre(
    COALESCE(NULLIF(NEW.tier2_price, 0), v_t1),
    NEW.rate_per_acre, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size);
  NEW.tier3_price_per_acre := public.product_price_per_acre(
    COALESCE(NULLIF(NEW.tier3_price, 0), v_t1),
    NEW.rate_per_acre, NEW.rate_unit, NEW.inventory_unit, NEW.unit_size);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_product_units()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_form IS NOT NULL AND NEW.inventory_unit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.unit_conversions
      WHERE unit = NEW.inventory_unit
        AND (unit_type = NEW.product_form OR unit_type = 'both')
    ) THEN
      RAISE EXCEPTION 'inventory_unit "%" is not valid for product_form "%"',
        NEW.inventory_unit, NEW.product_form;
    END IF;
  END IF;

  IF NEW.product_form IS NOT NULL AND NEW.container_unit IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.unit_conversions
      WHERE unit = NEW.container_unit
        AND (unit_type = NEW.product_form OR unit_type = 'both')
    ) THEN
      RAISE EXCEPTION 'container_unit "%" is not valid for product_form "%"',
        NEW.container_unit, NEW.product_form;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_product_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.category = 'Post Emergence' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Post-Emergence';
  ELSIF NEW.category = 'Pre-Emerge Soybean' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Pre-Emerge Soybean';
  ELSIF NEW.category = 'Pre-Emerge Corn' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Pre-Emerge Corn';
  ELSIF NEW.category = 'Volunteer Corn' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Volunteer Corn';
  ELSIF NEW.category = 'Range Pasture Turf' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Range/Pasture/Turf';
  ELSIF NEW.category IN ('Foliar Nutrition', 'Foliar Nutrition & Liquid Fertilizer') THEN
    NEW.category := 'Foliar Fertilizer'; NEW.use_timing := 'Foliar';
  ELSIF NEW.category = 'Utility' THEN
    NEW.category := 'Other';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_calculate_prices_from_margin
BEFORE INSERT OR UPDATE OF current_cost, tier1_margin, tier2_margin, tier3_margin
ON public.products
FOR EACH ROW EXECUTE FUNCTION public.calculate_prices_from_margin();

CREATE TRIGGER trigger_recalc_product_price_per_acre
BEFORE INSERT OR UPDATE OF
  current_cost, tier1_margin, tier2_margin, tier3_margin,
  tier1_price, tier2_price, tier3_price,
  rate_per_acre, rate_unit, inventory_unit, unit_size
ON public.products
FOR EACH ROW EXECUTE FUNCTION public.recalc_product_price_per_acre();

CREATE TRIGGER trg_normalize_product_category
BEFORE INSERT OR UPDATE OF category ON public.products
FOR EACH ROW EXECUTE FUNCTION public.normalize_product_category();

CREATE TRIGGER trg_validate_product_units
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.validate_product_units();

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_select ON public.products
  FOR SELECT TO authenticated USING (true);
CREATE POLICY products_insert ON public.products
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY products_update ON public.products
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY cost_history_select ON public.cost_history
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY cost_history_insert ON public.cost_history
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cost_history TO authenticated, service_role;
GRANT SELECT ON public.profiles, public.unit_conversions TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys TO service_role;

REVOKE ALL ON FUNCTION public.check_idempotency(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_idempotency(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._guard_idempotency_key_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_idempotency(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_idempotency(text, text, jsonb) TO service_role;
