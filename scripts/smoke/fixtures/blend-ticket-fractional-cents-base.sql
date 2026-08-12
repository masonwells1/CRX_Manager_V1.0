-- Base schema for prove-blend-ticket-fractional-cents.mjs.
--
-- Planted into a disposable, network-isolated PostgreSQL 17 container so the
-- CRX-MONEY-001 regression can be proved end to end without touching the live
-- database. Everything that decides the outcome is copied VERBATIM from live
-- (pulled from pg_proc / pg_constraint on 2026-08-11):
--
--   * orders_total_cost_whole_cents_chk / orders_total_profit_whole_cents_chk
--     — the two validated CHECKs the pre-fix RPC violated.
--   * _round_money_to_whole_cents + trg_order_items_round_money (BEFORE ROW)
--   * trg_recalc_order_totals + after_order_items_change (AFTER ROW)
--     — the canonical header writer the fix defers to.
--   * field_app_priced_quantity, normalize_rate_unit
--   * check_idempotency, save_idempotency
--   * create_order_from_blend_ticket — the PRE-FIX body, byte-for-byte, so the
--     migration's md5 precondition is a real gate in here too.
--
-- Each of those was md5-verified against live pg_proc on 2026-08-11; the six
-- helper bodies match exactly (modulo CRLF), so nothing under test is a
-- paraphrase of production.
--
-- ONE DELIBERATE STAND-IN, not a copy:
--
--   * link_blend_ticket_to_order — live is 8.3 KB and reads a dozen tables this
--     fixture trims away. The version here is a behavior-equivalent stub: it
--     maps blend lines to order items, refuses an inexact or empty mapping, and
--     flips order_link_status to 'linked', which is all the chain asserts. It
--     is NOT byte-identical to live, so never treat a green run here as proof
--     of that function's behavior — only of create_order_from_blend_ticket's.
--
-- Table definitions are trimmed to the columns these bodies touch. Anything
-- trimmed cannot change the arithmetic under test.

-- Supabase's built-in roles. The migration's REVOKE/GRANT pair and the smoke
-- chain's grantee assertion both name them, so they have to exist here too.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END;
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  -- Same shape as Supabase's own auth.uid(): an unset OR blank claims setting
  -- must yield NULL, not a json parse error.
  SELECT NULLIF(
    COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
      ''
    ),
    ''
  )::uuid;
$$;

-- ── tables ───────────────────────────────────────────────────────────────────

CREATE TABLE profiles (
  id        uuid PRIMARY KEY,
  role      text,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_name     text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  assigned_tier integer,
  deleted_at    timestamptz
);

CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name   text NOT NULL,
  tier1_price    numeric,
  tier2_price    numeric,
  tier3_price    numeric,
  current_cost   numeric,
  inventory_unit text,
  unit_size      text,
  product_form   text,
  is_active      boolean NOT NULL DEFAULT true
);

CREATE TABLE blend_tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number     text NOT NULL,
  uploaded_by       uuid NOT NULL,
  customer_id       uuid,
  salesman_id       uuid,
  status            text NOT NULL DEFAULT 'pending',
  review_status     text NOT NULL DEFAULT 'unreviewed',
  payment_status    text NOT NULL DEFAULT 'unbilled',
  order_link_status text NOT NULL DEFAULT 'unlinked',
  total_acres       numeric,
  season            text,
  source            text NOT NULL DEFAULT 'ocr',
  deleted_at        timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blend_ticket_products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id    uuid NOT NULL REFERENCES blend_tickets(id),
  product_id         uuid,
  product_name       text NOT NULL DEFAULT '',
  quantity           numeric NOT NULL DEFAULT 0,
  unit               text,
  rate_per_acre      numeric,
  rate_per_acre_unit text,
  sequence_order     integer NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number     text NOT NULL,
  customer_id      uuid NOT NULL,
  status           text,
  order_date       date,
  notes            text,
  season           text,
  salesman_id      uuid,
  pricing_status   text DEFAULT 'priced',
  total_price      numeric DEFAULT 0,
  total_cost       numeric DEFAULT 0,
  total_profit     numeric DEFAULT 0,
  total_margin_pct numeric DEFAULT 0,
  deleted_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'partially_fulfilled'::text, 'fulfilled'::text, 'cancelled'::text, 'voided'::text]))),
  CONSTRAINT orders_pricing_status_check CHECK ((pricing_status = ANY (ARRAY['priced'::text, 'needs_pricing'::text]))),
  CONSTRAINT orders_total_price_non_negative CHECK ((total_price >= (0)::numeric)),
  CONSTRAINT orders_total_cost_whole_cents_chk CHECK (((total_cost IS NULL) OR ((total_cost = round(total_cost, 2)) AND (total_cost > '-Infinity'::numeric) AND (total_cost < 'Infinity'::numeric)))),
  CONSTRAINT orders_total_profit_whole_cents_chk CHECK (((total_profit IS NULL) OR ((total_profit = round(total_profit, 2)) AND (total_profit > '-Infinity'::numeric) AND (total_profit < 'Infinity'::numeric))))
);

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  product_id         uuid,
  product_name       text,
  price_per_unit     numeric,
  cost_per_unit      numeric,
  actual_rate        numeric,
  rate_unit          text,
  acres              numeric,
  total_units_needed numeric,
  unit_size          text,
  total_price        numeric NOT NULL DEFAULT 0,
  profit             numeric,
  net_margin         numeric,
  quantity_delivered numeric DEFAULT 0,
  quantity_remaining numeric,
  sort_order         integer
);

CREATE TABLE blend_ticket_to_order_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id         uuid NOT NULL,
  blend_ticket_product_id uuid,
  order_item_id           uuid,
  order_id                uuid,
  quantity_applied        numeric,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blend_ticket_product_id, order_item_id)
);

CREATE TABLE inventory (
  product_id         uuid NOT NULL,
  location           text NOT NULL,
  quantity_available numeric DEFAULT 0,
  quantity_prebooked numeric DEFAULT 0,
  quantity_on_order  numeric DEFAULT 0,
  unit_size          text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location)
);

CREATE TABLE inventory_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL,
  transaction_type text NOT NULL,
  quantity         numeric,
  to_location      text,
  order_id         uuid,
  performed_by     uuid NOT NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_feed (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type          text,
  description         text,
  performed_by        uuid,
  related_entity_type text,
  related_entity_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE financial_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type  text,
  entity_type     text,
  entity_id       uuid,
  actor_user_id   uuid,
  actor_role      text,
  new_values      jsonb,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid,
  order_id        uuid,
  status          text,
  deleted_at      timestamptz
);

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  operation       text NOT NULL,
  result          jsonb,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── role helpers ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active AND role = 'sales_rep'
  );
$$;

CREATE OR REPLACE FUNCTION public.require_admin_or_sales_rep() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required';
  END IF;
END;
$$;

-- ── live bodies, verbatim ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.normalize_rate_unit(p_unit text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
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
    -- A non-acre denominator present → keep the whole string so it can't match a bare unit.
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
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  r  text := lower(btrim(coalesce(p_rate_unit, '')));
  i  text := lower(btrim(coalesce(p_inventory_unit, '')));
  sr numeric;  -- size of the rate unit in the form's base unit
  si numeric;  -- size of the inventory unit in the form's base unit
BEGIN
  IF p_applied_qty IS NULL THEN RETURN NULL; END IF;
  IF r = i THEN RETURN p_applied_qty; END IF;            -- same unit: no conversion needed
  IF r = '' OR i = '' THEN RETURN NULL; END IF;
  IF lower(coalesce(p_product_form, '')) = 'dry' THEN
    -- Dry base = ounce. (dry oz == oz == 1; lb = 16; ton = 32000.)
    sr := CASE WHEN r IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN r IN ('lb','lbs','pound','pounds')    THEN 16
               WHEN r IN ('ton','tons')                   THEN 32000 ELSE NULL END;
    si := CASE WHEN i IN ('oz','dry oz','ounce','ounces') THEN 1
               WHEN i IN ('lb','lbs','pound','pounds')    THEN 16
               WHEN i IN ('ton','tons')                   THEN 32000 ELSE NULL END;
  ELSE
    -- Liquid base = fluid ounce. (oz/fl oz = 1; pt = 16; qt = 32; gal = 128.)
    -- NULL/unknown product_form is treated as liquid, matching convert_to_gl_lb.
    sr := CASE WHEN r IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN r IN ('pt','pint','pints')                THEN 16
               WHEN r IN ('qt','quart','quarts')              THEN 32
               WHEN r IN ('gl','gal','gallon','gallons')      THEN 128 ELSE NULL END;
    si := CASE WHEN i IN ('oz','fl oz','floz','fluid ounce') THEN 1
               WHEN i IN ('pt','pint','pints')                THEN 16
               WHEN i IN ('qt','quart','quarts')              THEN 32
               WHEN i IN ('gl','gal','gallon','gallons')      THEN 128 ELSE NULL END;
  END IF;
  IF sr IS NULL OR si IS NULL THEN RETURN NULL; END IF;  -- not convertible -> caller errors
  RETURN p_applied_qty * sr / si;                        -- qty in inventory (pricing) unit
END;
$function$;

CREATE OR REPLACE FUNCTION public._round_money_to_whole_cents()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    IF NEW.total_price IS NOT NULL THEN
      NEW.total_price := ROUND(NEW.total_price, 2);
    END IF;

    -- DERIVED, not merely rounded (changed 2026-08-09; see this file's header).
    -- Both sides are rounded to whole cents BEFORE subtracting, so this value
    -- and the header that sums the same two rounded quantities agree exactly.
    -- Whatever the caller passed in NEW.profit is discarded: that field is no
    -- longer an input. This is what stops _convert_quote_to_order_owner_impl
    -- from carrying a stale quote_items.profit onto an order line.
    --
    -- The NULL check is defensive only. order_items.total_price is NOT NULL
    -- WITH DEFAULT 0, so no committed row can skip this branch. (An earlier
    -- draft justified it as protecting pricing_pending lines; that was wrong.
    -- An unpriced line stores the default 0, not NULL, and create_rush_order
    -- also inserts cost_per_unit = 0, so such a line derives to 0 — not to a
    -- negative.)
    --
    -- One real behaviour change on unpriced lines, disclosed rather than
    -- hidden: a pricing_pending line with total_price = 0 but a NON-zero
    -- cost_per_unit now stores a NEGATIVE line profit where the caller may have
    -- stored 0. That makes the line agree with the header, which has always
    -- subtracted that cost — so it is a display change, not a money change.
    IF NEW.total_price IS NOT NULL THEN
      NEW.profit := NEW.total_price
                    - ROUND(COALESCE(NEW.cost_per_unit, 0)
                            * COALESCE(NEW.total_units_needed, 0), 2);
    END IF;
  ELSIF TG_TABLE_NAME = 'commissions' THEN
    IF NEW.commission_amount IS NOT NULL THEN
      NEW.commission_amount := ROUND(NEW.commission_amount, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_recalc_order_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order_id uuid;
  v_total_price numeric;
  v_total_cost numeric;
  v_total_profit numeric;
  v_margin_pct numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  -- Both sides summed from PER-LINE whole-cent values, matching how each line
  -- derives its own profit. The result: v_total_profit == SUM(order_items.profit)
  -- for the same order, exactly, for every line whose stored profit is the
  -- derived value. Verified across all 62 live orders with line items before
  -- this was written.
  SELECT
    COALESCE(SUM(ROUND(total_price, 2)), 0),
    COALESCE(SUM(ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)), 0)
  INTO v_total_price, v_total_cost
  FROM order_items
  WHERE order_id = v_order_id;

  v_total_profit := v_total_price - v_total_cost;
  v_margin_pct := CASE WHEN v_total_price > 0
    THEN ROUND((v_total_profit / v_total_price) * 100, 2)
    ELSE 0
  END;

  UPDATE orders SET
    total_price = ROUND(v_total_price, 2),
    total_cost = ROUND(v_total_cost, 2),
    total_profit = ROUND(v_total_profit, 2),
    total_margin_pct = v_margin_pct,
    -- REMOVED: balance_due = ... (AR tracked via invoices.balance_cents)
    updated_at = now()
  WHERE id = v_order_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE TRIGGER trg_order_items_round_money
  BEFORE INSERT OR UPDATE OF total_price, profit, cost_per_unit, total_units_needed
  ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._round_money_to_whole_cents();

CREATE TRIGGER after_order_items_change
  AFTER INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_recalc_order_totals();

CREATE OR REPLACE FUNCTION public.check_idempotency(p_key text, p_operation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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

CREATE OR REPLACE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  WHERE idempotency_key = p_key
    AND operation <> p_operation
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing_op, p_operation;
  END IF;

  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

-- ── link_blend_ticket_to_order: BEHAVIOURAL STAND-IN, not the live body ──────
--
-- This is the one dependency that is NOT copied verbatim. It is downstream of
-- the money math under test (it runs after every order_items INSERT and never
-- touches orders.total_*), so a faithful stand-in cannot flatter the result.
-- It reproduces the parts the caller and the smoke chain actually depend on:
--   * requires auth.uid() and admin-or-sales
--   * validates that each blend line's mappings sum EXACTLY to its quantity,
--     the live contract that would mask a silently-altered converted quantity
--   * writes blend_ticket_to_order_items, flips order_link_status to 'linked',
--     and returns {"success": true}
-- The live function additionally re-locks the ticket and order, re-checks the
-- invoice/payment gates, and writes financial_audit_log; none of that can
-- change the header totals this proof measures.
CREATE OR REPLACE FUNCTION public.link_blend_ticket_to_order(p_blend_ticket_id uuid, p_order_id uuid, p_item_mappings jsonb, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_map            jsonb;
  v_count          int := 0;
  v_product_count  int;
  v_bad            int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  PERFORM 1 FROM blend_tickets WHERE id = p_blend_ticket_id FOR UPDATE;
  PERFORM 1 FROM orders WHERE id = p_order_id FOR UPDATE;

  FOR v_map IN SELECT * FROM jsonb_array_elements(COALESCE(p_item_mappings, '[]'::jsonb))
  LOOP
    INSERT INTO blend_ticket_to_order_items (
      blend_ticket_id, blend_ticket_product_id, order_item_id, order_id,
      quantity_applied, created_by
    ) VALUES (
      p_blend_ticket_id,
      (v_map->>'blend_product_id')::uuid,
      (v_map->>'order_item_id')::uuid,
      p_order_id,
      (v_map->>'quantity_applied')::numeric,
      p_performed_by
    )
    ON CONFLICT (blend_ticket_product_id, order_item_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  SELECT count(*) INTO v_product_count
    FROM blend_ticket_products
   WHERE blend_ticket_id = p_blend_ticket_id
     AND product_id IS NOT NULL;

  IF v_count < v_product_count THEN
    RAISE EXCEPTION 'BLEND_TICKET_ORDER_LINK_EMPTY_OR_INEXACT';
  END IF;

  -- Every mapped blend line must be accounted for to the last unit.
  -- Wrapped in a subquery so v_bad is genuinely "how many blend lines are
  -- short or over". Without it, SELECT count(*) ... GROUP BY ... HAVING puts
  -- the FIRST offending group's row count into v_bad, which still trips the
  -- guard but does not mean what the name says (CodeRabbit, PR #384).
  SELECT count(*) INTO v_bad
    FROM (
      SELECT btp.id
        FROM blend_ticket_products btp
        LEFT JOIN blend_ticket_to_order_items m
               ON m.blend_ticket_product_id = btp.id
              AND m.order_id = p_order_id
       WHERE btp.blend_ticket_id = p_blend_ticket_id
         AND btp.product_id IS NOT NULL
       GROUP BY btp.id, btp.quantity
      HAVING COALESCE(sum(m.quantity_applied), -1) IS DISTINCT FROM btp.quantity
    ) bad_lines;

  IF COALESCE(v_bad, 0) > 0 THEN
    RAISE EXCEPTION 'BLEND_TICKET_ORDER_LINK_EMPTY_OR_INEXACT';
  END IF;

  UPDATE blend_tickets
     SET order_link_status = 'linked', updated_at = now()
   WHERE id = p_blend_ticket_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, new_values, description)
  VALUES ('link_blend_ticket_to_order', 'blend_ticket', p_blend_ticket_id, p_performed_by,
          jsonb_build_object('order_id', p_order_id, 'lines', v_count),
          'Blend ticket linked to order');

  RETURN json_build_object('success', true, 'linked_items', v_count);
END;
$function$;
