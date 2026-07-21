\set ON_ERROR_STOP on

CREATE TABLE public.app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL UNIQUE,
  setting_value text NOT NULL DEFAULT '',
  description text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  deleted_at timestamptz
);

CREATE OR REPLACE FUNCTION public.normalize_vendor_alias(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT lower(regexp_replace(btrim(COALESCE(p_value, '')), '\s+', ' ', 'g')) $$;

CREATE TABLE public.legacy_vendor_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_text text NOT NULL,
  normalized_text text GENERATED ALWAYS AS (public.normalize_vendor_alias(original_text)) STORED,
  vendor_id uuid REFERENCES public.vendors(id),
  review_status text NOT NULL DEFAULT 'pending',
  source_table text NOT NULL DEFAULT 'purchase_orders',
  reviewed_at timestamptz
);

CREATE TABLE public.product_supplier_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  supplier_sku text,
  supplier_product_name text NOT NULL,
  supplier_uom text,
  supplier_pack_description text,
  inventory_units_per_supplier_unit numeric(20,8),
  comparison_status text NOT NULL DEFAULT 'pending',
  link_status text NOT NULL DEFAULT 'pending',
  is_reusable boolean GENERATED ALWAYS AS (
    link_status = 'confirmed'
    AND NULLIF(btrim(supplier_sku), '') IS NOT NULL
    AND NULLIF(btrim(supplier_uom), '') IS NOT NULL
    AND NULLIF(btrim(supplier_pack_description), '') IS NOT NULL
  ) STORED,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id)
);

CREATE TABLE public.supplier_price_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id)
);

CREATE TABLE public.supplier_price_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.supplier_price_imports(id)
);

CREATE TABLE public.supplier_price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  product_supplier_link_id uuid NOT NULL REFERENCES public.product_supplier_links(id),
  import_id uuid NOT NULL REFERENCES public.supplier_price_imports(id),
  import_row_id uuid NOT NULL REFERENCES public.supplier_price_import_rows(id),
  price_kind text NOT NULL,
  cost_cents bigint NOT NULL,
  price_unit text NOT NULL,
  package_quantity numeric(20,8) NOT NULL DEFAULT 1,
  effective_from date NOT NULL,
  effective_to date,
  observed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_observation_id uuid REFERENCES public.supplier_price_observations(id),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number text NOT NULL,
  vendor text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  submitted_date date,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity_received numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  unit_cost_cents bigint GENERATED ALWAYS AS (round(unit_cost * 100)::bigint) STORED,
  inventory_units_per_supplier_unit_snapshot numeric(20,8),
  cost_provenance text
);

CREATE OR REPLACE FUNCTION public.get_supplier_market_evidence(p_product_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT '[]'::jsonb $$;
