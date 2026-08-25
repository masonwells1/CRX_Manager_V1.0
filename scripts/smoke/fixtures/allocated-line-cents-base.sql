-- allocated-line-cents-base.sql
--
-- Disposable schema for prove-allocated-line-cents.mjs. Reproduces the live
-- tables, money CHECK constraints and BEFORE triggers that the three lifecycle
-- functions touch, so the chain exercises the REAL guards rather than a model
-- of them. Table DDL was introspected from production; the two trigger bodies
-- are byte-exact copies of the live functions (asserted by the prover).
--
-- Nothing here is under test. The three functions under test are planted by
-- the prover straight out of their migration files.


-- Supabase ships these roles; a bare postgres image does not. The migration
-- under proof REVOKEs EXECUTE from them, and its postconditions assert neither
-- helper is callable by either — so both must exist for that check to mean
-- anything rather than erroring out.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE app_actor (id uuid);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT id FROM public.app_actor LIMIT 1 $fn$;

CREATE TABLE profiles (id uuid NOT NULL PRIMARY KEY, email text NOT NULL, full_name text NOT NULL DEFAULT ''::text, role text NOT NULL DEFAULT 'sales_rep'::text, phone text, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), applicator_license_number text, faa_certificate_number text, denied_pages text[] NOT NULL DEFAULT '{}'::text[]);

CREATE FUNCTION public.current_season() RETURNS integer LANGUAGE sql IMMUTABLE AS $fn$ SELECT 2026 $fn$;
CREATE SEQUENCE public.inv_seq START 1000;
CREATE FUNCTION public.next_invoice_number(p_type text DEFAULT 'chemical_sale') RETURNS text
  LANGUAGE sql VOLATILE AS $fn$ SELECT 'INV-' || nextval('public.inv_seq')::text $fn$;
CREATE FUNCTION public.generate_order_number() RETURNS text LANGUAGE sql VOLATILE AS $fn$ SELECT 'ORD-' || nextval('public.inv_seq')::text $fn$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE((SELECT role IN ('owner','admin') FROM public.profiles WHERE id = auth.uid()), false) $fn$;
CREATE TABLE idempotency_keys (k text PRIMARY KEY, op text, result jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.check_idempotency(p_key text, p_op text) RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  SELECT result FROM public.idempotency_keys WHERE k = p_key AND op = p_op $fn$;
CREATE FUNCTION public.save_idempotency(p_key text, p_op text, p_result jsonb) RETURNS void LANGUAGE sql VOLATILE AS $fn$
  INSERT INTO public.idempotency_keys(k, op, result) VALUES (p_key, p_op, p_result)
  ON CONFLICT (k) DO NOTHING $fn$;
CREATE FUNCTION public._sync_planned_holds(p_order_id uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $fn$ BEGIN RETURN; END; $fn$;
CREATE FUNCTION public.create_split_invoices_from_order(p_order_id uuid, p_delivery_id uuid DEFAULT NULL, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE AS $fn$ BEGIN RETURN jsonb_build_object('ok', true, 'stubbed', true); END; $fn$;

CREATE TABLE customers (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), farm_name text NOT NULL DEFAULT '', deleted_at timestamptz);
CREATE TABLE products (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), product_name text NOT NULL, unit_size text, current_cost numeric, tier1_price numeric, tier2_price numeric, tier3_price numeric, is_active boolean NOT NULL DEFAULT true, inventory_unit text, container_unit text, epa_registration text, product_form text, return_policy text NOT NULL DEFAULT 'unknown'::text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE accounting_periods (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), period_start date NOT NULL, period_end date NOT NULL, status text NOT NULL DEFAULT 'open'::text, closed_by uuid, closed_at timestamptz, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE activity_feed (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL DEFAULT ''::text, description text NOT NULL DEFAULT ''::text, performed_by uuid NOT NULL, related_entity_type text, related_entity_id uuid, customer_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE commission_payment_items (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), commission_payment_id uuid NOT NULL, commission_id uuid NOT NULL, amount numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE commission_payments (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), payment_number text NOT NULL, recipient_id uuid NOT NULL, total_amount numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'unposted'::text, payment_method text, reference_number text, payment_date date NOT NULL DEFAULT CURRENT_DATE, posted_by uuid, posted_at timestamptz, notes text, season integer, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE commissions (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, customer_id uuid NOT NULL, recipient text NOT NULL DEFAULT ''::text, split_percentage numeric NOT NULL DEFAULT 0, commission_amount numeric NOT NULL DEFAULT 0, order_profit numeric NOT NULL DEFAULT 0, order_date date, status text NOT NULL DEFAULT 'pending'::text, created_at timestamptz NOT NULL DEFAULT now(), paid_date date, paid_note text, recipient_user_id uuid, season integer, deleted_at timestamptz, order_number text, customer_name text, job_id uuid, invoice_id uuid);
CREATE TABLE deliveries (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), delivery_number text NOT NULL, order_id uuid NOT NULL, customer_id uuid NOT NULL, delivery_address_id uuid, assigned_driver uuid, scheduled_date date NOT NULL DEFAULT CURRENT_DATE, scheduled_time text, status text NOT NULL DEFAULT 'scheduled'::text, delivery_notes text, completed_at timestamptz, signature_url text, signed_by text, receipt_pdf_url text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), season integer, deleted_at timestamptz, priority text DEFAULT 'normal'::text, delivery_window_start text, delivery_window_end text, cancelled_at timestamptz, cancelled_by uuid, cancel_reason text, issue_type text, issue_notes text, last_edited_by uuid, last_edited_at timestamptz, is_quick_delivery boolean DEFAULT false);
CREATE TABLE delivery_items (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL, order_item_id uuid NOT NULL, product_id uuid NOT NULL, quantity numeric NOT NULL DEFAULT 0, unit_size text, notes text, quantity_delivered numeric DEFAULT 0, tote_number text);
CREATE TABLE delivery_remainders (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), original_delivery_id uuid NOT NULL, order_id uuid NOT NULL, order_item_id uuid NOT NULL, customer_id uuid NOT NULL, product_id uuid NOT NULL, quantity_remaining numeric NOT NULL, unit_size text, status text NOT NULL DEFAULT 'pending'::text, followup_delivery_id uuid, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), reminder_sent_at timestamptz, escalation_sent_at timestamptz);
CREATE TABLE financial_audit_log (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), operation_type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, actor_user_id uuid NOT NULL DEFAULT auth.uid(), actor_role text, old_values jsonb, new_values jsonb, total_impact_cents bigint, description text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE inventory (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL, location text NOT NULL DEFAULT 'Main Warehouse'::text, quantity_available numeric NOT NULL DEFAULT 0, quantity_prebooked numeric NOT NULL DEFAULT 0, quantity_on_order numeric NOT NULL DEFAULT 0, unit_size text, last_counted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), reorder_point numeric NOT NULL DEFAULT 0, min_stock_level numeric NOT NULL DEFAULT 0, manufactured_at_delivery boolean NOT NULL DEFAULT false);
CREATE TABLE inventory_holds (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL, customer_id uuid, quantity numeric NOT NULL DEFAULT 0, hold_type text NOT NULL DEFAULT 'manual'::text, source_id uuid, notes text, created_by uuid NOT NULL, expires_at date, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE inventory_transactions (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL, transaction_type text NOT NULL, quantity numeric NOT NULL DEFAULT 0, from_location text, to_location text, order_id uuid, purchase_order_id uuid, delivery_id uuid, performed_by uuid NOT NULL, notes text, created_at timestamptz NOT NULL DEFAULT now(), requires_review boolean NOT NULL DEFAULT false, job_id uuid);
CREATE TABLE notifications (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL DEFAULT ''::text, message text NOT NULL DEFAULT ''::text, notification_type text NOT NULL DEFAULT ''::text, is_read boolean NOT NULL DEFAULT false, related_entity_type text, related_entity_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE order_item_field_allocations (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid NOT NULL, field_id uuid NOT NULL, acres numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE orders (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), order_number text NOT NULL, quote_id uuid, customer_id uuid NOT NULL, status text NOT NULL DEFAULT 'confirmed'::text, commission_split jsonb, total_price numeric NOT NULL DEFAULT 0, total_cost numeric NOT NULL DEFAULT 0, total_profit numeric NOT NULL DEFAULT 0, total_margin_pct numeric NOT NULL DEFAULT 0, order_date date NOT NULL DEFAULT CURRENT_DATE, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), season integer, salesman_id uuid, deleted_at timestamptz, order_name text, customer_po_number text, is_planned boolean NOT NULL DEFAULT false, program_notes text, booking_draw boolean NOT NULL DEFAULT false, pricing_status text NOT NULL DEFAULT 'priced'::text, pricing_reminder_sent_at timestamptz, pricing_escalation_sent_at timestamptz, needs_split_billing boolean);
CREATE TABLE order_items (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL, product_id uuid NOT NULL, quote_item_id uuid, section_name text, product_name text NOT NULL DEFAULT ''::text, price_per_unit numeric NOT NULL DEFAULT 0, cost_per_unit numeric NOT NULL DEFAULT 0, actual_rate numeric, rate_unit text, acres numeric, total_units_needed numeric NOT NULL DEFAULT 0, unit_size text, total_price numeric NOT NULL DEFAULT 0, profit numeric NOT NULL DEFAULT 0, net_margin numeric NOT NULL DEFAULT 0, quantity_delivered numeric NOT NULL DEFAULT 0, quantity_remaining numeric NOT NULL DEFAULT 0, sort_order integer DEFAULT 0, notes text, cost_at_time_cents bigint, pricing_pending boolean NOT NULL DEFAULT false, suggested_price numeric);
CREATE TABLE quotes (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), quote_number text NOT NULL, customer_id uuid NOT NULL, created_by uuid NOT NULL, tier integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'draft'::text, commission_split jsonb, total_price numeric NOT NULL DEFAULT 0, total_cost numeric NOT NULL DEFAULT 0, total_profit numeric NOT NULL DEFAULT 0, total_margin_pct numeric NOT NULL DEFAULT 0, valid_days integer NOT NULL DEFAULT 15, expires_at date, header_notes text, footer_notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, is_planned boolean NOT NULL DEFAULT false, season integer, salesman_id uuid, deleted_at timestamptz, pdf_template_id uuid, pdf_columns_override jsonb, row_version bigint NOT NULL DEFAULT 1);
CREATE TABLE quote_items (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), quote_id uuid NOT NULL, section_id uuid NOT NULL, product_id uuid NOT NULL, sort_order integer NOT NULL DEFAULT 0, notes text, price_per_unit numeric NOT NULL DEFAULT 0, current_cost numeric NOT NULL DEFAULT 0, suggested_rate text, actual_rate numeric, rate_unit text, oz_per_acre numeric, price_per_acre numeric, acres numeric, total_units_needed numeric, unit_size text, profit numeric NOT NULL DEFAULT 0, total_price numeric NOT NULL DEFAULT 0, net_margin numeric NOT NULL DEFAULT 0, calc_mode text DEFAULT 'rate_acres'::text, price_unit text, price_override numeric, cost_at_quote_cents bigint);
CREATE TABLE quote_product_draws (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), quote_id uuid NOT NULL, product_id uuid NOT NULL, quantity_drawn numeric NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE invoices (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL DEFAULT next_invoice_number('field_application'::text), order_id uuid, blend_ticket_id uuid, customer_id uuid NOT NULL, invoice_type text NOT NULL DEFAULT 'chemical_sale'::text, status text NOT NULL DEFAULT 'draft'::text, season integer NOT NULL DEFAULT current_season(), salesman_id uuid, created_by uuid NOT NULL DEFAULT auth.uid(), total_amount_cents bigint NOT NULL DEFAULT 0, paid_amount_cents bigint NOT NULL DEFAULT 0, prepay_applied_cents bigint NOT NULL DEFAULT 0, posted_by uuid, posted_at timestamptz, voided_by uuid, voided_at timestamptz, void_reason text, invoice_date date NOT NULL DEFAULT CURRENT_DATE, due_date date, purchase_order_ref text, header_notes text, footer_notes text, parent_invoice_id uuid, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), crop_type text, field_names text[], total_acres numeric(12,2), applicator_name text, vehicle_name text, application_date date, job_id uuid, total_cost_cents bigint DEFAULT 0, is_quick_delivery boolean DEFAULT false, write_off_cents bigint NOT NULL DEFAULT 0, invoice_group_id uuid, application_service_id uuid, delivery_id uuid, wind_direction text, temperature_text text, pricing_pending boolean NOT NULL DEFAULT false, payment_terms text, internal_notes text, discount_earned_cents bigint NOT NULL DEFAULT 0, discount_date date, credit_applied_cents bigint NOT NULL DEFAULT 0,
  balance_cents bigint GENERATED ALWAYS AS ((((total_amount_cents - paid_amount_cents) - prepay_applied_cents) - write_off_cents) + CASE WHEN (invoice_type = 'credit_memo'::text) THEN credit_applied_cents ELSE (- credit_applied_cents) END) STORED,
  send_disposition text NOT NULL DEFAULT 'normal'::text, field_app_billing_set_id uuid);
CREATE TABLE invoice_items (id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, order_item_id uuid, product_id uuid, description text NOT NULL DEFAULT ''::text, quantity numeric(12,4) NOT NULL DEFAULT 0, unit_price_cents bigint NOT NULL DEFAULT 0, extended_cents bigint NOT NULL DEFAULT 0, cost_cents bigint NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0, rate_per_acre numeric(12,4), acres numeric(12,2), unit_size text, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), rate_unit text, total_applied numeric(12,4), total_applied_unit text, total_applied_gl_lb numeric(12,4), gl_lb_unit text, epa_registration text, product_form text, is_application_fee boolean DEFAULT false, tote_number text, quoted_price_cents bigint, price_source text, warehouse text, vendor text, billing_line_id uuid);

ALTER TABLE order_items ADD CONSTRAINT order_items_total_price_whole_cents_chk
  CHECK ((total_price = round(total_price, 2)) AND (total_price > '-Infinity'::numeric) AND (total_price < 'Infinity'::numeric));
ALTER TABLE order_items ADD CONSTRAINT order_items_profit_whole_cents_chk
  CHECK ((profit = round(profit, 2)) AND (profit > '-Infinity'::numeric) AND (profit < 'Infinity'::numeric));
ALTER TABLE order_items ADD CONSTRAINT chk_oi_qty_delivered CHECK (quantity_delivered >= 0);
ALTER TABLE order_items ADD CONSTRAINT chk_oi_qty_remaining CHECK (quantity_remaining >= 0);

CREATE FUNCTION public._round_money_to_whole_cents() RETURNS trigger LANGUAGE plpgsql AS $body_round$
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
$body_round$;
CREATE FUNCTION public._enforce_below_cost_line() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body_bc$
DECLARE
  v_operation text := current_setting('app.crx_below_cost_operation', true);
  v_reason text := NULLIF(btrim(current_setting('app.crx_below_cost_reason', true)), '');
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_product_name text;
  v_cost numeric;
  v_cost_cents bigint;
  v_price_cents bigint;
  v_quantity numeric;
  v_entity_type text;
  v_entity_id uuid;
  v_line_id uuid;
  v_product_id uuid;
  v_is_application_fee boolean;
  v_detail jsonb;
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    -- Delivery completion and cancellation update fulfillment counters on an
    -- already-approved sale. They do not make a new pricing decision. Let
    -- context-free bookkeeping (and exposure-reducing quantity corrections)
    -- proceed, while a product/price change or quantity increase still reaches
    -- the fail-closed approval wall below.
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    -- Rush orders intentionally carry zero prices until price_order. They are
    -- not sales decisions yet, so defer the wall to the pricing RPC.
    IF NEW.pricing_pending = true AND NEW.price_per_unit = 0 THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'order';
    v_entity_id := NEW.order_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := NEW.total_units_needed;
  ELSIF TG_TABLE_NAME = 'invoice_items' THEN
    -- complete_delivery can materialize an invoice line from an already-made
    -- order pricing decision. Permit only an exact, exposure-bounded descendant
    -- of that governed order line; a caller cannot use this hatch to substitute
    -- another Product, price, cost snapshot, or larger quantity. Browser roles
    -- also have no direct INSERT privilege on invoice_items.
    IF TG_OP = 'INSERT'
       AND COALESCE(v_operation, '') = ''
       AND NEW.order_item_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM public.order_items oi
         WHERE oi.id = NEW.order_item_id
           AND oi.product_id IS NOT DISTINCT FROM NEW.product_id
           AND round(oi.price_per_unit * 100)::bigint = NEW.unit_price_cents
           AND round(COALESCE(oi.cost_per_unit, 0) * 100)::bigint = NEW.cost_cents
           AND COALESCE(NEW.quantity, 0) >= 0
           AND COALESCE(NEW.quantity, 0) <= COALESCE(oi.total_units_needed, 0)
       ) THEN
      RETURN NEW;
    END IF;
    -- Partial delivery can reduce a draft invoice line and tote-copy updates
    -- bookkeeping only. Neither increases the approved below-cost exposure.
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT NULL
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
       AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents
       AND NEW.cost_cents IS NOT DISTINCT FROM OLD.cost_cents
       AND COALESCE(NEW.is_application_fee, false)
           IS NOT DISTINCT FROM COALESCE(OLD.is_application_fee, false)
       AND COALESCE(NEW.quantity, 0) <= COALESCE(OLD.quantity, 0) THEN
      RETURN NEW;
    END IF;
    v_is_application_fee := COALESCE(NEW.is_application_fee, false);
    IF v_is_application_fee AND NEW.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'APPLICATION_FEE_PRODUCT_INVALID';
    END IF;
    v_entity_type := 'invoice';
    v_entity_id := NEW.invoice_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    IF v_product_id IS NULL THEN
      -- A non-product line has no catalog row to lock, but save_invoice lets a
      -- caller supply cost_cents. Zero-cost fees/miscellaneous charges are not
      -- below cost. Positive-cost lines compare their total stored revenue to
      -- total stored cost and use quantity=1 in the approval audit so neither
      -- an application fee nor a null-product misc line can bypass the wall.
      IF COALESCE(NEW.cost_cents, 0) < 0 THEN
        RAISE EXCEPTION 'INVALID_COST';
      END IF;
      IF NEW.quantity IS NULL
         OR NEW.quantity::text IN ('NaN', 'Infinity', '-Infinity')
         OR NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
      END IF;
      IF COALESCE(NEW.cost_cents, 0) = 0 THEN
        RETURN NEW;
      END IF;
      v_product_name := COALESCE(
        NULLIF(btrim(NEW.description), ''),
        CASE WHEN v_is_application_fee
          THEN 'Application fee'
          ELSE 'Non-product invoice line'
        END
      );
      v_price_cents := COALESCE(
        NEW.extended_cents,
        round(COALESCE(NEW.unit_price_cents, 0) * COALESCE(NEW.quantity, 0))::bigint
      );
      v_cost_cents := CASE
        WHEN v_is_application_fee THEN NEW.cost_cents
        ELSE round(NEW.cost_cents * COALESCE(NEW.quantity, 0))::bigint
      END;
      v_quantity := 1;
    ELSE
      v_price_cents := NEW.unit_price_cents;
      v_quantity := NEW.quantity;
    END IF;
  ELSIF TG_TABLE_NAME = 'quote_items' THEN
    -- save_quote first inserts the client shape and then, in the same
    -- transaction, recomputes every line from the locked Product row. App
    -- roles cannot insert quote_items directly. Defer this private transient
    -- INSERT so the authoritative UPDATE below is the single enforcement and
    -- approval-audit point; any failure there rolls the entire save back.
    IF TG_OP = 'INSERT' AND v_operation = 'save_quote' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'quote';
    v_entity_id := NEW.quote_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := COALESCE(NEW.total_units_needed, 0);
  ELSE
    RAISE EXCEPTION 'BELOW_COST_TRIGGER_TABLE_INVALID';
  END IF;

  IF v_price_cents < 0 THEN RAISE EXCEPTION 'INVALID_PRICE'; END IF;

  IF v_product_id IS NOT NULL THEN
    -- FOR SHARE prevents products.current_cost from changing between the check
    -- and the line write, while allowing unrelated product rows to proceed.
    SELECT p.product_name, p.current_cost
      INTO v_product_name, v_cost
    FROM public.products p
    WHERE p.id = v_product_id
    FOR SHARE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
    IF v_cost IS NULL
       OR v_cost::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_cost <= 0 THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;
    IF v_cost <> round(v_cost, 2) THEN
      RAISE EXCEPTION 'COST_BASIS_CENTS_REQUIRED:%', v_product_id;
    END IF;

    v_cost_cents := round(v_cost * 100)::bigint;
  END IF;

  -- update_order_items previously trusted p_items.cost_per_unit, and
  -- price_order previously reused an older snapshot. Both must write the same
  -- locked current cost used by this guard, including every dependent amount.
  IF TG_TABLE_NAME = 'order_items'
     AND v_operation IN (
       'create_direct_order', 'bulk_import_order',
       'update_order_items', 'price_order'
     ) THEN
    NEW.cost_per_unit := v_cost_cents::numeric / 100;
    NEW.cost_at_time_cents := v_cost_cents;
    -- This trigger sorts after trg_order_items_round_money, so it must preserve
    -- that canonical whole-cent invariant after replacing caller/stale cost.
    NEW.total_price := round(NEW.price_per_unit * NEW.total_units_needed, 2);
    NEW.profit := NEW.total_price
                  - round(NEW.cost_per_unit * NEW.total_units_needed, 2);
    NEW.net_margin := CASE
      WHEN NEW.price_per_unit > 0
        THEN round(((NEW.price_per_unit - NEW.cost_per_unit) / NEW.price_per_unit) * 100, 2)
      ELSE 0
    END;
  END IF;

  IF v_price_cents >= v_cost_cents THEN
    RETURN NEW;
  END IF;

  v_detail := jsonb_build_object(
    'operation', v_operation,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'line_id', v_line_id,
    'product_id', v_product_id,
    'product_name', v_product_name,
    'unit_price_cents', v_price_cents,
    'locked_unit_cost_cents', v_cost_cents
  );

  -- There are many owner-run RPCs and triggers that can write these shared line
  -- tables. A missing context may proceed above cost, but it can never create a
  -- below-cost sale. Known customer-facing paths declare context through thin
  -- wrappers below; any missed future path fails closed here automatically.
  IF v_operation IS NULL OR v_operation = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_CONTEXT_REQUIRED:' || v_detail::text;
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || v_detail::text;
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_detail::text;
  END IF;

  INSERT INTO public.below_cost_approvals (
    operation, entity_type, entity_id, line_id, product_id, actor_user_id,
    reason, unit_price_cents, locked_unit_cost_cents, quantity,
    total_shortfall_cents
  ) VALUES (
    v_operation, v_entity_type, v_entity_id, v_line_id, v_product_id, v_actor,
    left(v_reason, 1000), v_price_cents, v_cost_cents, v_quantity,
    round((v_cost_cents - v_price_cents) * v_quantity)::bigint
  );

  RETURN NEW;
END;
$body_bc$;

CREATE TRIGGER trg_order_items_round_money BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION public._round_money_to_whole_cents();
CREATE TRIGGER zz_crx_below_cost_order_items BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_below_cost_line();
CREATE TRIGGER zz_crx_below_cost_invoice_items BEFORE INSERT OR UPDATE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_below_cost_line();

-- ═══════════════════════════════════════════════════════════════════════════
-- Chain scaffolding
--
-- Seed rows and four helpers the chain uses to build orders, deliveries and
-- to read back what was billed. None of this is under test — the functions
-- under test are planted by prove-allocated-line-cents.mjs straight out of
-- their migration files.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO profiles(id, email, full_name, role, is_active)
VALUES ('11111111-1111-4111-8111-111111111111', 'smoke@example.test', '[SMOKE] Admin', 'admin', true);
INSERT INTO app_actor(id) VALUES ('11111111-1111-4111-8111-111111111111');

INSERT INTO customers(id, farm_name)
VALUES ('22222222-2222-4222-8222-222222222222', '[SMOKE] Allocation Farm');

INSERT INTO products(id, product_name, unit_size, current_cost, inventory_unit)
VALUES ('33333333-3333-4333-8333-333333333333', '[SMOKE] Allocated Cent Concentrate', 'gal', 0.10, 'gal');

-- quantity_prebooked is seeded well above anything the chain releases so that
-- Cancel Remaining's INVENTORY_PREBOOK_UNDERFLOW guard is not what fails.
INSERT INTO inventory(product_id, quantity_available, quantity_prebooked, unit_size)
VALUES ('33333333-3333-4333-8333-333333333333', 1000, 1000, 'gal');

INSERT INTO accounting_periods(period_start, period_end, status)
VALUES (date_trunc('year', CURRENT_DATE)::date,
        (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date, 'open');

/**
 * One order with one line, where total_price is the ALLOCATED cents the
 * tier-split draw-down assigned — deliberately not ROUND(price * quantity, 2).
 * That divergence is the whole point: it is what the lifecycle must carry.
 */
CREATE FUNCTION mk_order(p_units numeric, p_price numeric, p_allocated numeric, p_tag text)
RETURNS uuid LANGUAGE plpgsql AS $mk$
DECLARE v_order uuid;
BEGIN
  INSERT INTO orders(order_number, customer_id, status, salesman_id, season)
    VALUES ('[SMOKE]-ORD-' || p_tag, '22222222-2222-4222-8222-222222222222', 'confirmed',
            '11111111-1111-4111-8111-111111111111', 2026)
    RETURNING id INTO v_order;
  INSERT INTO order_items(order_id, product_id, product_name, price_per_unit, cost_per_unit,
                          total_units_needed, unit_size, total_price, quantity_remaining)
    VALUES (v_order, '33333333-3333-4333-8333-333333333333', '[SMOKE] Allocated Cent Concentrate',
            p_price, 0.10, p_units, 'gal', p_allocated, p_units);
  RETURN v_order;
END
$mk$;

/** A delivery in the in_progress state complete_delivery requires. */
CREATE FUNCTION mk_delivery(p_order uuid, p_qty numeric, p_tag text)
RETURNS uuid LANGUAGE plpgsql AS $mk$
DECLARE v_del uuid; v_item record;
BEGIN
  SELECT oi.id, oi.product_id, oi.unit_size INTO v_item
    FROM order_items oi WHERE oi.order_id = p_order LIMIT 1;
  INSERT INTO deliveries(delivery_number, order_id, customer_id, status, created_by, season)
    VALUES ('[SMOKE]-DEL-' || p_tag, p_order, '22222222-2222-4222-8222-222222222222', 'in_progress',
            '11111111-1111-4111-8111-111111111111', 2026)
    RETURNING id INTO v_del;
  INSERT INTO delivery_items(delivery_id, order_item_id, product_id, quantity, unit_size, quantity_delivered)
    VALUES (v_del, v_item.id, v_item.product_id, p_qty, v_item.unit_size, p_qty);
  RETURN v_del;
END
$mk$;

/** Cents actually billed to the customer on live (non-voided) invoices. */
CREATE FUNCTION billed_cents(p_order uuid) RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(SUM(ii.extended_cents), 0)::bigint
    FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id
   WHERE inv.order_id = p_order AND inv.deleted_at IS NULL
     AND inv.status NOT IN ('voided', 'cancelled')
$f$;

/** Cents the order itself claims the line is worth. */
CREATE FUNCTION line_cents(p_order uuid) RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(ROUND(SUM(total_price) * 100), 0)::bigint
    FROM order_items WHERE order_id = p_order
$f$;
