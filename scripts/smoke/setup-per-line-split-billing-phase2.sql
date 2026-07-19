-- Minimal disposable PostgreSQL schema for the Phase 2 per-line calculator proof.
-- This file is never valid against production. The Node harness additionally
-- requires a network-isolated Docker container with the crx-per-line-p2-proof-
-- prefix before it streams this SQL.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND is_active) $$;
CREATE OR REPLACE FUNCTION public.is_sales_rep()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'sales_rep' AND is_active) $$;
CREATE OR REPLACE FUNCTION public.is_applicator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'applicator' AND is_active) $$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.current_season()
RETURNS integer LANGUAGE sql IMMUTABLE
AS $$ SELECT 2026 $$;

-- Minimal legacy-preview dependencies. The proof harness loads the exact
-- checked-in production preview definition from its canonical 20260630180000
-- migration so Phase 2's md5 precondition is exercised, not bypassed.
CREATE OR REPLACE FUNCTION public.compute_fuel_surcharge_cents(
  p_acres numeric,
  p_subtotal_cents bigint
)
RETURNS bigint LANGUAGE sql IMMUTABLE
AS $$ SELECT 0::bigint $$;

CREATE OR REPLACE FUNCTION public.derive_customer_shares_from_fields(
  p_field_ids uuid[],
  p_applied_acres_map jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'customers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_id', x.customer_id,
        'customer_name', x.farm_name,
        'tier', x.assigned_tier,
        'is_primary', x.is_primary
      ) ORDER BY x.customer_id)
      FROM (
        SELECT d.customer_id, c.farm_name, c.assigned_tier, bool_or(d.is_primary) AS is_primary
        FROM public.field_billing_defaults d
        JOIN public.customers c ON c.id = d.customer_id
        WHERE d.field_id = ANY(p_field_ids)
        GROUP BY d.customer_id, c.farm_name, c.assigned_tier
      ) x
    ), '[]'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'field_id', d.field_id,
        'field_name', f.field_name,
        'customer_id', d.customer_id,
        'share_acres', COALESCE((p_applied_acres_map->>d.field_id::text)::numeric, 0)
          * d.split_pct / 100,
        'price_override_cents', d.price_override_cents
      ) ORDER BY d.field_id, d.customer_id)
      FROM public.field_billing_defaults d
      JOIN public.fields f ON f.id = d.field_id
      WHERE d.field_id = ANY(p_field_ids)
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(
  p_applied_qty numeric,
  p_rate_unit text,
  p_inventory_unit text,
  p_product_form text
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  r text := lower(btrim(coalesce(p_rate_unit, '')));
  i text := lower(btrim(coalesce(p_inventory_unit, '')));
  sr numeric;
  si numeric;
BEGIN
  IF p_applied_qty IS NULL THEN RETURN NULL; END IF;
  IF r = i THEN RETURN p_applied_qty; END IF;
  IF r = '' OR i = '' THEN RETURN NULL; END IF;
  IF lower(coalesce(p_product_form, '')) = 'dry' THEN
    sr := CASE WHEN r IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN r IN ('lb','lbs','pound','pounds') THEN 16
               WHEN r IN ('ton','tons') THEN 32000 END;
    si := CASE WHEN i IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN i IN ('lb','lbs','pound','pounds') THEN 16
               WHEN i IN ('ton','tons') THEN 32000 END;
  ELSE
    sr := CASE WHEN r IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN r IN ('pt','pint','pints') THEN 16
               WHEN r IN ('qt','quart','quarts') THEN 32
               WHEN r IN ('gl','gal','gallon','gallons') THEN 128 END;
    si := CASE WHEN i IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN i IN ('pt','pint','pints') THEN 16
               WHEN i IN ('qt','quart','quarts') THEN 32
               WHEN i IN ('gl','gal','gallon','gallons') THEN 128 END;
  END IF;
  IF sr IS NULL OR si IS NULL THEN RETURN NULL; END IF;
  RETURN p_applied_qty * sr / si;
END;
$$;

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  farm_name text NOT NULL,
  assigned_tier integer NOT NULL DEFAULT 1,
  assigned_sales_rep uuid REFERENCES public.profiles(id)
);
CREATE TABLE public.jobs (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  quote_section_id uuid,
  season integer,
  application_service_id uuid,
  created_by uuid REFERENCES public.profiles(id)
);
CREATE TABLE public.fields (
  id uuid PRIMARY KEY,
  field_name text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  total_acres numeric,
  crop_type text
);
CREATE TABLE public.job_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  field_id uuid NOT NULL REFERENCES public.fields(id),
  acres_to_treat numeric,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (job_id, field_id)
);
CREATE TABLE public.field_billing_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES public.fields(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  split_pct numeric(9,6) NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  price_override_cents bigint,
  pricing_note text,
  UNIQUE (field_id, customer_id)
);
CREATE TABLE public.job_field_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  field_id uuid NOT NULL REFERENCES public.fields(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  split_pct numeric(9,6) NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (job_id, field_id, customer_id)
);
CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  product_name text NOT NULL,
  inventory_unit text,
  product_form text,
  current_cost numeric,
  tier1_price numeric,
  tier2_price numeric,
  tier3_price numeric
);
CREATE TABLE public.job_chemicals (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  rate_per_acre numeric,
  rate_unit text,
  cost_per_unit_cents bigint NOT NULL DEFAULT 0,
  price_per_unit_cents bigint,
  sort_order integer NOT NULL DEFAULT 0,
  customer_supplied boolean NOT NULL DEFAULT false
);
CREATE TABLE public.application_services (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  default_rate_per_acre_cents bigint NOT NULL DEFAULT 0,
  cost_per_acre_cents bigint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.customer_application_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  application_service_id uuid NOT NULL REFERENCES public.application_services(id),
  rate_per_acre_cents bigint NOT NULL,
  season integer NOT NULL,
  UNIQUE (customer_id, application_service_id, season)
);
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  season integer,
  status text NOT NULL,
  expires_at date,
  deleted_at timestamptz
);
CREATE TABLE public.quote_sections (
  id uuid PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id),
  field_id uuid REFERENCES public.fields(id)
);
CREATE TABLE public.quote_items (
  id uuid PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id),
  section_id uuid NOT NULL REFERENCES public.quote_sections(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  price_per_unit numeric,
  price_unit text
);
CREATE TABLE public.app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL UNIQUE,
  setting_value text NOT NULL DEFAULT '',
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.customers(id),
  invoice_group_id uuid,
  job_id uuid REFERENCES public.jobs(id),
  application_service_id uuid REFERENCES public.application_services(id),
  season integer,
  status text NOT NULL DEFAULT 'draft',
  posted_at timestamptz,
  total_amount_cents bigint NOT NULL DEFAULT 0,
  total_cost_cents bigint DEFAULT 0,
  deleted_at timestamptz,
  created_by uuid REFERENCES public.profiles(id),
  salesman_id uuid REFERENCES public.profiles(id)
);
CREATE TABLE public.invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  quantity numeric(12,4) NOT NULL DEFAULT 0,
  acres numeric(12,2),
  unit_price_cents bigint NOT NULL DEFAULT 0,
  extended_cents bigint NOT NULL DEFAULT 0,
  cost_cents bigint NOT NULL DEFAULT 0,
  unit_size text
);
