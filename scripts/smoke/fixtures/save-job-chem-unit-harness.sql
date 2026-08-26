-- Real-shape harness for proving 20260820120000 (the save_job chemical-unit invariant
-- and derived money totals) in an isolated throwaway PostgreSQL container.
--
-- This is NOT a schema definition for the app. It is the minimum real-shape surface the
-- function touches, plus the five unit/money helpers copied VERBATIM from the live
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
  ('aaaaaaaa-0000-0000-0000-000000000004', 'DRY PRODUCT - pound stock',     'dry'),
  -- product_form NULL is a REAL live shape, not a contrivance: 11 live products carry it,
  -- and one of them ('Accelerate Seed Treatment - Per Unit') is active and billing. Every
  -- form-branching rule in the migration treats NULL as "not dry", which is deliberate and
  -- matches field_app_priced_quantity's own default -- T58 is what stops that default being
  -- an untested assumption.
  ('aaaaaaaa-0000-0000-0000-000000000005', 'PER-UNIT PRODUCT - form unknown', NULL);

-- unit_conversions mirrors the LIVE table, read read-only on 2026-08-24. The
-- recognised-unit backstop added in round 20 consults it, so the harness has to carry the
-- real spellings or the proof would be testing a different allowlist from production.
--
-- The exact contents matter to two tests. 'dry oz' has no arm in normalize_rate_unit, so it
-- is recognised ONLY because this table carries the spelling. 'ton' is the mirror case: it is
-- absent here and recognised only through normalize_rate_unit's canonical outputs. T55
-- exercises both, so dropping either arm of the backstop turns it red.
--
-- Only the columns the backstop reads are modelled; factor_oz and unit_type are carried
-- because the live table has them and a future check may want them, not because this file
-- uses them today.
CREATE TABLE unit_conversions (
  unit text,
  unit_type text,
  factor_oz numeric
);
INSERT INTO unit_conversions (unit, unit_type, factor_oz) VALUES
  ('dry oz', 'dry',    1),
  ('ea',     'both',   1),
  ('fl oz',  'liquid', 1),
  ('g',      'dry',    0.03527396),
  ('gal',    'liquid', 128),
  ('lb',     'dry',    16),
  ('mg',     'dry',    0.00003527396),
  ('oz',     'liquid', 1),
  ('pt',     'liquid', 16),
  ('qt',     'liquid', 32),
  ('unit',   'both',   1);

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
-- pgcrypto lives in the `extensions` schema on the live project, and save_job pins
-- search_path to public, pg_temp -- so it must call extensions.digest by that exact
-- qualified name. The container reproduces that placement rather than installing
-- pgcrypto into public, or the test would pass against a schema layout production
-- does not have and the qualified call would break on the first real save.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- request_fingerprint / request_actor_id mirror live (read read-only 2026-08-24). The
-- PRIMARY KEY is the KEY ALONE, not (key, operation), which also mirrors live and is
-- what makes cross-operation reuse reachable at all -- see T26.
CREATE TABLE idempotency_keys (
  idempotency_key text PRIMARY KEY, operation text, result jsonb, expires_at timestamptz,
  request_fingerprint text, request_actor_id uuid
);

CREATE OR REPLACE FUNCTION next_job_number() RETURNS text
  LANGUAGE sql AS $$ SELECT 'JOB-TEST-' || (SELECT count(*) + 1 FROM jobs)::text $$;
CREATE OR REPLACE FUNCTION compute_season(p_d date) RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN EXTRACT(MONTH FROM p_d) >= 10
                THEN EXTRACT(YEAR FROM p_d)::int + 1
                ELSE EXTRACT(YEAR FROM p_d)::int END $$;

-- ===========================================================================
-- The five helpers, VERBATIM from live (do not edit; re-copy if live changes).
--
-- Note on idempotency_keys above: its PRIMARY KEY is the KEY ALONE, not
-- (key, operation). That mirrors live, where the constraint is the unique
-- index idempotency_keys_idempotency_key_key on idempotency_key by itself
-- (read read-only 2026-08-24). The shape matters -- it is precisely what makes
-- cross-operation key reuse reachable, and T26 depends on it.
-- ===========================================================================

-- check_idempotency, read from live pg_proc 2026-08-24 (md5 of the live body:
-- 2c93efc82ad63c906eab944e8b70c88e; the live text stores mixed CRLF/LF, so this
-- copy matches it in BEHAVIOUR, not byte for byte). This is the canonical guard
-- the rest of the app already routes through -- draw_down_quote and others call
-- it -- and save_job did not, which is the defect T26 and T27 pin.
--
-- DRIFT RISK, stated rather than closed (review, 2026-08-25): the hashes recorded here
-- and at the check_idempotency_intent copy below are OBSERVATIONS of the live bodies on
-- their read dates, and the CONTAINER prover deliberately cannot re-verify them -- it is
-- network-isolated by design, so it proves the migration against these copies, not
-- against live. If a live helper changes after its read date, this suite stays green
-- while testing stale behaviour. The boundary that catches that is the APPLY path, not
-- this prover: immediately before a live apply, re-read both helpers from pg_proc
-- (read-only), compare md5 against the two hashes recorded here, and treat a mismatch
-- as review-invalidating drift -- re-copy, re-prove, re-review. The migration's own
-- preflight asserts the helpers EXIST; equality with the reviewed copies is this
-- documented apply-time obligation.
CREATE OR REPLACE FUNCTION public.check_idempotency(p_key text, p_operation text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;

  -- Serialize every transaction using the same key. The lock is intentionally
  -- key-only so same-operation retries replay and cross-operation reuse fails
  -- before either caller can perform business side effects.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key
     AND expires_at < now();

  SELECT *
    INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_key;

  IF FOUND AND v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing.operation, p_operation;
  END IF;

  IF FOUND THEN
    RETURN v_existing.result;
  END IF;

  RETURN NULL;
END;
$function$;
-- check_idempotency_intent, read from live pg_proc 2026-08-24 (md5 of the live body:
-- edc73be809069669e8441eba7acf443d; the live text stores mixed CRLF/LF, so this copy
-- matches it in BEHAVIOUR, not byte for byte). Note it returns a WRAPPER,
-- {"found": true, "result": ...}, not the bare result -- save_job must unwrap it.
CREATE OR REPLACE FUNCTION public.check_idempotency_intent(p_key text, p_operation text, p_actor uuid, p_fingerprint text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  IF p_fingerprint IS NULL OR btrim(p_fingerprint) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_FINGERPRINT_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_key;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing.operation, p_operation;
  END IF;

  -- Deployment bridge: receipts written before intent binding carry neither column.
  -- Their intent cannot be reconstructed, so fail closed rather than replay.
  IF v_existing.request_actor_id IS NULL
     AND v_existing.request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object(
              'operation', v_existing.operation,
              'result', v_existing.result
            )::text;
  END IF;

  IF v_existing.request_actor_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
  END IF;

  IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object(
              'operation', v_existing.operation,
              'result', v_existing.result
            )::text;
  END IF;

  RETURN jsonb_build_object('found', true, 'result', v_existing.result);
END;
$function$;

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
