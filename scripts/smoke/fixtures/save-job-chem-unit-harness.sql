-- Real-shape harness for proving 20260820120000 (the save_job chemical-unit invariant
-- and derived money totals) in an isolated throwaway PostgreSQL container.
--
-- This is NOT a schema definition for the app. It is the minimum real-shape surface the
-- function touches, plus the three unit/money helpers copied VERBATIM from the live
-- catalog (pg_get_functiondef, read 2026-08-23). Copying them verbatim is the point: the
-- bug this migration exists to stop was a client-side COPY of the unit table drifting
-- from the server's, so a prover that reimplements them would prove nothing.
--
-- Driven by scripts/smoke/prove-save-job-chem-unit-invariant.mjs.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;

CREATE TABLE profiles (id uuid PRIMARY KEY, is_active boolean, role text);
INSERT INTO profiles VALUES ('11111111-1111-1111-1111-111111111111', true, 'admin');

CREATE TABLE products (
  id uuid PRIMARY KEY,
  product_name text,
  product_form text
);
INSERT INTO products VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '1A TEST PRODUCT - FAKE PRODUCT', 'liquid'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Acuron - 2.5 Gal',              'liquid'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '[UI-TEST] Acuron GT',           'liquid'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'DRY PRODUCT - pound stock',     'dry');

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number text, customer_id uuid, status text, job_date date, scheduled_time time,
  applicator_id uuid, vehicle_id uuid, recipe_id uuid, application_service_id uuid,
  notes text, tags text[], batch_id text, season integer,
  total_acres numeric, total_cost_cents bigint, total_price_cents bigint,
  call_date date, date_proposed date, time_proposed time, schedule_date date, date_expires date,
  consultant_id uuid, loader_comment text, additional_info text, internal_memo text,
  created_by uuid, updated_by uuid
);
CREATE TABLE job_fields (
  job_id uuid, field_id uuid, acres_to_treat numeric, planted_acres numeric,
  crop text, strip text, pests text, sort_order integer
);
CREATE TABLE job_field_shares (
  job_id uuid, field_id uuid, customer_id uuid, split_pct numeric, is_primary boolean
);
CREATE TABLE job_chemicals (
  job_id uuid, product_id uuid NOT NULL, quantity numeric, unit text, rate_per_acre numeric,
  rate_unit text, cost_per_unit_cents bigint, price_per_unit_cents bigint,
  diluent_rate numeric, rei_hours integer, phi_days integer, warehouse text, vendor text,
  customer_supplied boolean, sort_order integer
);
CREATE TABLE idempotency_keys (
  idempotency_key text PRIMARY KEY, operation text, result jsonb, expires_at timestamptz
);

CREATE OR REPLACE FUNCTION next_job_number() RETURNS text
  LANGUAGE sql AS $$ SELECT 'JOB-TEST-' || (SELECT count(*) + 1 FROM jobs)::text $$;
CREATE OR REPLACE FUNCTION compute_season(p_d date) RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN EXTRACT(MONTH FROM p_d) >= 10
                THEN EXTRACT(YEAR FROM p_d)::int + 1
                ELSE EXTRACT(YEAR FROM p_d)::int END $$;

-- ===========================================================================
-- The three helpers, VERBATIM from live (do not edit; re-copy if live changes).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.safe_cents_qty(p_cents bigint, p_qty numeric)
 RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ROUND(COALESCE(p_cents, 0)::numeric * COALESCE(p_qty, 0))::bigint;
$function$;

CREATE OR REPLACE FUNCTION public.normalize_rate_unit(p_unit text)
 RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  raw  text := lower(btrim(COALESCE(p_unit, '')));
  base text;
BEGIN
  IF raw = '' THEN RETURN NULL; END IF;
  IF raw ~ '\s*/\s*(ac|acre|acres|a)\s*$' THEN
    base := btrim(regexp_replace(raw, '\s*/\s*(ac|acre|acres|a)\s*$', ''));
  ELSIF raw ~ '\s+per\s+acre$' THEN
    base := btrim(regexp_replace(raw, '\s+per\s+acre$', ''));
  ELSIF position('/' IN raw) > 0 THEN
    RETURN raw;
  ELSE
    base := raw;
  END IF;
  IF base = '' THEN RETURN NULL; END IF;
  RETURN CASE base
    WHEN 'oz'    THEN 'oz'  WHEN 'ounce'    THEN 'oz'  WHEN 'ounces'    THEN 'oz'
    WHEN 'fl oz' THEN 'oz'  WHEN 'floz'     THEN 'oz'  WHEN 'fluid ounce' THEN 'oz'
    WHEN 'pt'    THEN 'pt'  WHEN 'pint'     THEN 'pt'  WHEN 'pints'     THEN 'pt'
    WHEN 'qt'    THEN 'qt'  WHEN 'quart'    THEN 'qt'  WHEN 'quarts'    THEN 'qt'
    WHEN 'gal'   THEN 'gal' WHEN 'gallon'   THEN 'gal' WHEN 'gallons'   THEN 'gal' WHEN 'gl' THEN 'gal'
    WHEN 'lb'    THEN 'lb'  WHEN 'lbs'      THEN 'lb'  WHEN 'pound'     THEN 'lb'  WHEN 'pounds' THEN 'lb'
    WHEN 'ton'   THEN 'ton' WHEN 'tons'     THEN 'ton'
    WHEN 'g'     THEN 'g'   WHEN 'gram'     THEN 'g'   WHEN 'grams'     THEN 'g'
    WHEN 'kg'    THEN 'kg'  WHEN 'kilogram' THEN 'kg'  WHEN 'kilograms' THEN 'kg'
    WHEN 'l'     THEN 'l'   WHEN 'liter'    THEN 'l'   WHEN 'liters'    THEN 'l' WHEN 'litre' THEN 'l' WHEN 'litres' THEN 'l'
    WHEN 'ml'    THEN 'ml'
    ELSE base
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text)
 RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r  text := lower(btrim(coalesce(p_rate_unit, '')));
  i  text := lower(btrim(coalesce(p_inventory_unit, '')));
  sr numeric;
  si numeric;
BEGIN
  IF p_applied_qty IS NULL THEN RETURN NULL; END IF;
  IF r = i THEN RETURN p_applied_qty; END IF;
  IF r = '' OR i = '' THEN RETURN NULL; END IF;
  IF lower(coalesce(p_product_form, '')) = 'dry' THEN
    sr := CASE WHEN r IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN r IN ('lb','lbs','pound','pounds')    THEN 16
               WHEN r IN ('ton','tons')                   THEN 32000 ELSE NULL END;
    si := CASE WHEN i IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN i IN ('lb','lbs','pound','pounds')    THEN 16
               WHEN i IN ('ton','tons')                   THEN 32000 ELSE NULL END;
  ELSE
    sr := CASE WHEN r IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN r IN ('pt','pint','pints')                THEN 16
               WHEN r IN ('qt','quart','quarts')              THEN 32
               WHEN r IN ('gl','gal','gallon','gallons')      THEN 128 ELSE NULL END;
    si := CASE WHEN i IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN i IN ('pt','pint','pints')                THEN 16
               WHEN i IN ('qt','quart','quarts')              THEN 32
               WHEN i IN ('gl','gal','gallon','gallons')      THEN 128 ELSE NULL END;
  END IF;
  IF sr IS NULL OR si IS NULL THEN RETURN NULL; END IF;
  RETURN p_applied_qty * sr / si;
END;
$function$;

-- The roles the postflight asserts against. In the container these are bare roles;
-- the ACL shape (authenticated + service_role hold EXECUTE, anon and PUBLIC do not)
-- is what the assertions actually read, and it is reproduced faithfully below by
-- the grant/revoke the prover issues after installing the function.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role;  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon;          END IF;
END
$roles$;
