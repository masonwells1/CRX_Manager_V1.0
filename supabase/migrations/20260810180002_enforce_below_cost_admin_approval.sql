-- Enforce below-cost approval inside PostgreSQL for every sell-side money RPC.
--
-- The browser confirmation is useful UX, but it is not an authorization
-- boundary: a direct PostgREST caller can skip it. This migration makes the
-- database the hard wall for the seven settled write paths:
--   create_direct_order, create_rush_order, bulk_import_order,
--   update_order_items, price_order, save_invoice, and save_quote.
--
-- Design:
--   * thin public wrappers preserve every existing signature and delegate to
--     the already-hardened implementations;
--   * wrappers set transaction-local context naming the authoritative RPC and
--     the fresh approval reason carried by that request;
--   * BEFORE triggers lock products.current_cost and reject below-cost writes
--     unless auth.uid() is an active admin and the request carries a reason;
--   * update_order_items and price_order also replace browser-supplied/order-
--     snapshot cost with that locked current product cost, then recompute all
--     dependent line money from the same value;
--   * an immutable, admin-readable audit row is inserted in the same database
--     transaction as the money write. A rejected/rolled-back sale leaves no
--     orphan approval record.
--
-- create_rush_order is wrapped with the other six paths, but its deliberately
-- unpriced pricing_pending rows are exempt until price_order supplies a price.

CREATE TABLE public.below_cost_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation text NOT NULL CHECK (operation IN (
    'create_direct_order',
    'create_rush_order',
    'bulk_import_order',
    'update_order_items',
    'price_order',
    'save_invoice',
    'save_quote',
    'convert_quote_to_order',
    'draw_down_quote',
    'restore_quote_version',
    'duplicate_quote'
  )),
  entity_type text NOT NULL CHECK (entity_type IN ('order', 'invoice', 'quote')),
  entity_id uuid NOT NULL,
  line_id uuid NOT NULL,
  -- NULL identifies a classified non-product invoice line (for example an
  -- application fee). Its total stored revenue/cost is still governed below.
  product_id uuid REFERENCES public.products(id),
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  locked_unit_cost_cents bigint NOT NULL CHECK (locked_unit_cost_cents > 0),
  quantity numeric NOT NULL CHECK (quantity >= 0),
  total_shortfall_cents bigint NOT NULL CHECK (total_shortfall_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.below_cost_approvals IS
  'Immutable audit of active-admin overrides for sell-side prices below the product cost locked by PostgreSQL in the same transaction, or below the stored total cost on a classified non-product invoice line.';
COMMENT ON COLUMN public.below_cost_approvals.product_id IS
  'Product whose catalog cost was locked; NULL only for a classified non-product invoice line governed against its stored total cost.';
COMMENT ON COLUMN public.below_cost_approvals.unit_price_cents IS
  'Unit sale price for product lines; stored total revenue for a classified non-product invoice line.';
COMMENT ON COLUMN public.below_cost_approvals.locked_unit_cost_cents IS
  'Locked catalog unit cost for product lines; stored total cost for a classified non-product invoice line.';

CREATE INDEX below_cost_approvals_entity_idx
  ON public.below_cost_approvals (entity_type, entity_id, created_at DESC);
CREATE INDEX below_cost_approvals_product_idx
  ON public.below_cost_approvals (product_id, created_at DESC);

ALTER TABLE public.below_cost_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS below_cost_approvals_admin_read
  ON public.below_cost_approvals;

CREATE POLICY below_cost_approvals_admin_read
  ON public.below_cost_approvals
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_active = true
        AND p.role = 'admin'
    )
  );

-- Local and hosted projects may carry default privileges for service_role, so
-- revoke it explicitly rather than relying on the new-table default ACL.
REVOKE ALL ON TABLE public.below_cost_approvals
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.below_cost_approvals TO authenticated;

-- Line collections are RPC-owned. RLS alone is not an authorization boundary
-- when a permissive policy still exists, so remove the table-write privilege
-- that would let PostgREST callers bypass the governed money RPCs. Existing
-- browser paths only SELECT these tables; SECURITY DEFINER RPCs execute as the
-- owner and retain their write path.
REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.order_items, public.invoice_items, public.quote_items
  FROM PUBLIC, anon, authenticated, service_role;

-- The authorization comparison is cent-exact only if both inputs are cent-
-- representable. Production was measured clean (zero fractional-cent values in
-- all three columns) immediately before this migration was reviewed. Make that
-- a database invariant so no privileged or future writer can round a below-cost
-- unit price up to the same comparison cent as its cost.
ALTER TABLE public.products
  ADD CONSTRAINT products_current_cost_cent_scale_chk
  CHECK (current_cost IS NULL OR (
    current_cost = round(current_cost, 2)
    AND current_cost > '-Infinity'::numeric
    AND current_cost < 'Infinity'::numeric
  ));

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_price_per_unit_cent_scale_chk
  CHECK (price_per_unit IS NULL OR (
    price_per_unit = round(price_per_unit, 2)
    AND price_per_unit > '-Infinity'::numeric
    AND price_per_unit < 'Infinity'::numeric
  ));

ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_price_per_unit_cent_scale_chk
  CHECK (price_per_unit IS NULL OR (
    price_per_unit = round(price_per_unit, 2)
    AND price_per_unit > '-Infinity'::numeric
    AND price_per_unit < 'Infinity'::numeric
  ));

CREATE OR REPLACE FUNCTION public._guard_below_cost_approval_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'BELOW_COST_APPROVAL_IMMUTABLE';
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_below_cost_approval_immutable()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_below_cost_approvals_immutable
  ON public.below_cost_approvals;

CREATE TRIGGER a_below_cost_approvals_immutable
  BEFORE UPDATE OR DELETE ON public.below_cost_approvals
  FOR EACH ROW EXECUTE FUNCTION public._guard_below_cost_approval_immutable();

-- Kept for the shared table convention even though the immutable guard above
-- rejects every update before this trigger can change the timestamp.
DROP TRIGGER IF EXISTS z_below_cost_approvals_updated_at
  ON public.below_cost_approvals;

CREATE TRIGGER z_below_cost_approvals_updated_at
  BEFORE UPDATE ON public.below_cost_approvals
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

-- Extract the single-line marker written by src/lib/internalNotes.ts. The
-- browser strips any old marker before appending a fresh one, so this returns
-- the reason for this exact save attempt rather than accumulating history.
CREATE FUNCTION public._below_cost_reason_from_text(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT NULLIF(
    btrim(
      substring(
        COALESCE(p_value, '')
        FROM '(?:^|[\r\n])Below-cost approved:[[:space:]]*([^\r\n]+)'
      )
    ),
    ''
  );
$function$;

REVOKE ALL ON FUNCTION public._below_cost_reason_from_text(text)
  FROM PUBLIC, anon, authenticated;

-- Recursively find a marker in JSON payloads (invoice/quote item notes and the
-- explicit per-attempt value carried by order edit / price-order item JSON).
CREATE FUNCTION public._below_cost_reason_from_json(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_child jsonb;
  v_reason text;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN
    RETURN NULL;
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'string' THEN
      v_reason := public._below_cost_reason_from_text(p_value #>> '{}');
      IF v_reason IS NULL AND length(btrim(p_value #>> '{}')) > 0
         AND (p_value #>> '{}') NOT LIKE '%Below-cost approved:%' THEN
        -- update_order_items / price_order carry the fresh reason as a plain
        -- below_cost_reason JSON property. The object branch below calls this
        -- string branch only for that named property.
        RETURN NULL;
      END IF;
      RETURN v_reason;
    WHEN 'array' THEN
      FOR v_child IN SELECT value FROM jsonb_array_elements(p_value)
      LOOP
        v_reason := public._below_cost_reason_from_json(v_child);
        IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
      END LOOP;
    WHEN 'object' THEN
      IF p_value ? 'below_cost_reason' THEN
        v_reason := NULLIF(btrim(p_value->>'below_cost_reason'), '');
        IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
      END IF;
      FOR v_child IN SELECT value FROM jsonb_each(p_value)
      LOOP
        v_reason := public._below_cost_reason_from_json(v_child);
        IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
      END LOOP;
    ELSE
      NULL;
  END CASE;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._below_cost_reason_from_json(jsonb)
  FROM PUBLIC, anon, authenticated;

-- Called only by the SECURITY DEFINER public wrappers below. It establishes
-- transaction-local context after independently validating the current actor;
-- the renamed implementation then repeats its existing, path-specific gates.
CREATE FUNCTION public._begin_below_cost_money_write(
  p_operation text,
  p_performed_by uuid,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF p_operation NOT IN (
    'create_direct_order', 'create_rush_order', 'bulk_import_order',
    'update_order_items', 'price_order', 'save_invoice', 'save_quote',
    'convert_quote_to_order', 'draw_down_quote',
    'restore_quote_version', 'duplicate_quote'
  ) THEN
    RAISE EXCEPTION 'BELOW_COST_OPERATION_INVALID';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = v_actor
      AND p.is_active = true
      AND p.role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  PERFORM set_config('app.crx_below_cost_operation', p_operation, true);
  PERFORM set_config(
    'app.crx_below_cost_reason',
    COALESCE(public._below_cost_reason_from_json(p_payload), ''),
    true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._begin_below_cost_money_write(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public._enforce_below_cost_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public._enforce_below_cost_line()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER zz_crx_below_cost_order_items
  BEFORE INSERT OR UPDATE OF product_id, price_per_unit, total_units_needed
  ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_below_cost_line();
CREATE TRIGGER zz_crx_below_cost_invoice_items
  BEFORE INSERT OR UPDATE OF product_id, order_item_id, unit_price_cents,
    extended_cents, cost_cents, quantity, is_application_fee
  ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_below_cost_line();
CREATE TRIGGER zz_crx_below_cost_quote_items
  BEFORE INSERT OR UPDATE OF product_id, price_per_unit, total_units_needed
  ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_below_cost_line();

-- Preserve the hardened implementations behind non-API names. The public
-- wrappers keep the exact existing signatures, so the web deployment remains
-- compatible before, during, and after this migration's live transaction.
ALTER FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text)
  RENAME TO _create_direct_order_below_cost_impl_20260810;
ALTER FUNCTION public.create_rush_order(uuid, jsonb, text, text, uuid, text)
  RENAME TO _create_rush_order_below_cost_impl_20260810;
ALTER FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text)
  RENAME TO _bulk_import_order_below_cost_impl_20260810;
ALTER FUNCTION public.update_order_items(uuid, jsonb, uuid, text)
  RENAME TO _update_order_items_below_cost_impl_20260810;
ALTER FUNCTION public.price_order(uuid, jsonb, uuid, text)
  RENAME TO _price_order_below_cost_impl_20260810;
ALTER FUNCTION public.save_invoice(jsonb, jsonb, text)
  RENAME TO _save_invoice_below_cost_impl_20260810;
ALTER FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text)
  RENAME TO _save_quote_below_cost_impl_20260810;

REVOKE ALL ON FUNCTION public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._create_rush_order_below_cost_impl_20260810(uuid, jsonb, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._bulk_import_order_below_cost_impl_20260810(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._update_order_items_below_cost_impl_20260810(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._price_order_below_cost_impl_20260810(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._save_invoice_below_cost_impl_20260810(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._save_quote_below_cost_impl_20260810(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._create_rush_order_below_cost_impl_20260810(uuid, jsonb, text, text, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._bulk_import_order_below_cost_impl_20260810(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._update_order_items_below_cost_impl_20260810(uuid, jsonb, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._price_order_below_cost_impl_20260810(uuid, jsonb, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._save_invoice_below_cost_impl_20260810(jsonb, jsonb, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._save_quote_below_cost_impl_20260810(uuid, jsonb, jsonb, uuid, text) TO postgres;

CREATE FUNCTION public.create_direct_order(
  p_customer_id uuid,
  p_order_date date,
  p_order_name text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_customer_po_number text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('create_direct_order', p_performed_by, to_jsonb(p_notes));
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'create_direct_order');
  END IF;
  RETURN public._create_direct_order_below_cost_impl_20260810(
    p_customer_id, p_order_date, p_order_name, p_notes, p_items,
    p_performed_by, p_idempotency_key, p_customer_po_number
  );
END;
$function$;

CREATE FUNCTION public.create_rush_order(
  p_customer_id uuid,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_notes text DEFAULT NULL,
  p_customer_po_number text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('create_rush_order', p_performed_by, p_items);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'create_rush_order');
  END IF;
  RETURN public._create_rush_order_below_cost_impl_20260810(
    p_customer_id, p_items, p_notes, p_customer_po_number, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.bulk_import_order(
  p_order_number text,
  p_customer_id uuid,
  p_status text,
  p_total_price numeric,
  p_total_cost numeric,
  p_total_profit numeric,
  p_total_margin_pct numeric,
  p_order_date date,
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('bulk_import_order', NULL, to_jsonb(p_notes));
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'bulk_import_order');
  END IF;
  RETURN public._bulk_import_order_below_cost_impl_20260810(
    p_order_number, p_customer_id, p_status, p_total_price, p_total_cost,
    p_total_profit, p_total_margin_pct, p_order_date, p_items, p_notes,
    p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('update_order_items', p_performed_by, p_items);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'update_order_items');
  END IF;
  RETURN public._update_order_items_below_cost_impl_20260810(
    p_order_id, p_items, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.price_order(
  p_order_id uuid,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('price_order', p_performed_by, p_items);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'price_order');
  END IF;
  RETURN public._price_order_below_cost_impl_20260810(
    p_order_id, p_items, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('save_invoice', NULL, p_items);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'save_invoice');
  END IF;
  RETURN public._save_invoice_below_cost_impl_20260810(p_invoice, p_items, p_idempotency_key);
END;
$function$;

CREATE FUNCTION public.save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write('save_quote', p_performed_by, p_sections);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'save_quote');
  END IF;
  RETURN public._save_quote_below_cost_impl_20260810(
    p_quote_id, p_quote_payload, p_sections, p_performed_by, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_rush_order(uuid, jsonb, text, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.price_order(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_rush_order(uuid, jsonb, text, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.price_order(uuid, jsonb, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;

-- Quote lifecycle writes use the same hard wall. Keep the existing, heavily
-- reviewed implementations private and add one trailing optional reason so old
-- browser bundles remain compatible while the current bundle can retry an
-- admin-approved below-cost operation using the server's locked live cost.
ALTER FUNCTION public.convert_quote_to_order(uuid, uuid, text, bigint)
  RENAME TO _convert_quote_to_order_below_cost_impl_20260810;
ALTER FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text)
  RENAME TO _draw_down_quote_below_cost_impl_20260810;
ALTER FUNCTION public.restore_quote_version(uuid, uuid, uuid, text, bigint)
  RENAME TO _restore_quote_version_below_cost_impl_20260810;
ALTER FUNCTION public.duplicate_quote(uuid, uuid, text)
  RENAME TO _duplicate_quote_below_cost_impl_20260810;

REVOKE ALL ON FUNCTION public._convert_quote_to_order_below_cost_impl_20260810(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._restore_quote_version_below_cost_impl_20260810(uuid, uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._duplicate_quote_below_cost_impl_20260810(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public._convert_quote_to_order_below_cost_impl_20260810(uuid, uuid, text, bigint) TO postgres;
GRANT EXECUTE ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._restore_quote_version_below_cost_impl_20260810(uuid, uuid, uuid, text, bigint) TO postgres;
GRANT EXECUTE ON FUNCTION public._duplicate_quote_below_cost_impl_20260810(uuid, uuid, text) TO postgres;

CREATE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_expected_row_version bigint DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write(
    'convert_quote_to_order', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._convert_quote_to_order_below_cost_impl_20260810(
    p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version
  );
END;
$function$;

CREATE FUNCTION public.draw_down_quote(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write(
    'draw_down_quote', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._draw_down_quote_below_cost_impl_20260810(
    p_quote_id, p_draws, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE FUNCTION public.restore_quote_version(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_expected_row_version bigint DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write(
    'restore_quote_version', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._restore_quote_version_below_cost_impl_20260810(
    p_quote_id, p_version_id, p_performed_by, p_idempotency_key,
    p_expected_row_version
  );
END;
$function$;

CREATE FUNCTION public.duplicate_quote(
  p_source_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._begin_below_cost_money_write(
    'duplicate_quote', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._duplicate_quote_below_cost_impl_20260810(
    p_source_quote_id, p_performed_by, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.convert_quote_to_order(uuid, uuid, text, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_quote_version(uuid, uuid, uuid, text, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.duplicate_quote(uuid, uuid, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.convert_quote_to_order(uuid, uuid, text, bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_quote_version(uuid, uuid, uuid, text, bigint, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.duplicate_quote(uuid, uuid, text, text) TO authenticated, service_role;

DO $verify$
DECLARE
  v_name text;
  v_role text;
  v_table text;
  v_privilege text;
  v_column_shape jsonb;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'create_direct_order', 'create_rush_order', 'bulk_import_order',
    'update_order_items', 'price_order', 'save_invoice', 'save_quote',
    'convert_quote_to_order', 'draw_down_quote',
    'restore_quote_version', 'duplicate_quote'
  ]
  LOOP
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name) <> 1 THEN
      RAISE EXCEPTION 'verify failed: % overload drift', v_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = v_name
        AND prosecdef = true
        AND proconfig @> ARRAY['search_path=public, pg_temp']::text[]
        AND position('_begin_below_cost_money_write' in prosrc) > 0
    ) THEN
      RAISE EXCEPTION 'verify failed: % lost below-cost wrapper contract', v_name;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'zz_crx_below_cost_%') <> 3 THEN
    RAISE EXCEPTION 'verify failed: expected three below-cost line triggers';
  END IF;

  SELECT jsonb_object_agg(
           a.attname,
           jsonb_build_object(
             'type', format_type(a.atttypid, a.atttypmod),
             'not_null', a.attnotnull
           )
         )
    INTO v_column_shape
  FROM pg_attribute a
  WHERE a.attrelid = 'public.below_cost_approvals'::regclass
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_column_shape IS DISTINCT FROM jsonb_build_object(
    'id', jsonb_build_object('type', 'uuid', 'not_null', true),
    'operation', jsonb_build_object('type', 'text', 'not_null', true),
    'entity_type', jsonb_build_object('type', 'text', 'not_null', true),
    'entity_id', jsonb_build_object('type', 'uuid', 'not_null', true),
    'line_id', jsonb_build_object('type', 'uuid', 'not_null', true),
    'product_id', jsonb_build_object('type', 'uuid', 'not_null', false),
    'actor_user_id', jsonb_build_object('type', 'uuid', 'not_null', true),
    'reason', jsonb_build_object('type', 'text', 'not_null', true),
    'unit_price_cents', jsonb_build_object('type', 'bigint', 'not_null', true),
    'locked_unit_cost_cents', jsonb_build_object('type', 'bigint', 'not_null', true),
    'quantity', jsonb_build_object('type', 'numeric', 'not_null', true),
    'total_shortfall_cents', jsonb_build_object('type', 'bigint', 'not_null', true),
    'created_at', jsonb_build_object('type', 'timestamp with time zone', 'not_null', true),
    'updated_at', jsonb_build_object('type', 'timestamp with time zone', 'not_null', true)
  ) THEN
    RAISE EXCEPTION 'verify failed: below_cost_approvals column shape drifted: %', v_column_shape;
  END IF;

  IF NOT (SELECT c.relrowsecurity
          FROM pg_class c
          WHERE c.oid = 'public.below_cost_approvals'::regclass)
     OR (SELECT count(*) FROM pg_policy p
         WHERE p.polrelid = 'public.below_cost_approvals'::regclass) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_policy p
       WHERE p.polrelid = 'public.below_cost_approvals'::regclass
         AND p.polname = 'below_cost_approvals_admin_read'
         AND p.polcmd = 'r'
     ) THEN
    RAISE EXCEPTION 'verify failed: below_cost_approvals RLS/policy shape drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = 'public.below_cost_approvals'::regclass
         AND t.tgname = 'a_below_cost_approvals_immutable'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
     )
     OR has_table_privilege('anon', 'public.below_cost_approvals', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.below_cost_approvals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.below_cost_approvals', 'INSERT')
     OR has_table_privilege('authenticated', 'public.below_cost_approvals', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.below_cost_approvals', 'DELETE')
     OR has_table_privilege('service_role', 'public.below_cost_approvals', 'SELECT')
     OR has_table_privilege('service_role', 'public.below_cost_approvals', 'INSERT')
     OR has_table_privilege('service_role', 'public.below_cost_approvals', 'UPDATE')
     OR has_table_privilege('service_role', 'public.below_cost_approvals', 'DELETE') THEN
    RAISE EXCEPTION 'verify failed: below_cost_approvals immutability/ACL shape drifted';
  END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'products_current_cost_cent_scale_chk',
    'order_items_price_per_unit_cent_scale_chk',
    'quote_items_price_per_unit_cent_scale_chk'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conname = v_name
        AND c.contype = 'c'
        AND c.convalidated = true
        AND position('round(' in lower(pg_get_constraintdef(c.oid))) > 0
        AND position('''-infinity''' in lower(pg_get_constraintdef(c.oid))) > 0
        AND position('''infinity''' in lower(pg_get_constraintdef(c.oid))) > 0
    ) THEN
      RAISE EXCEPTION 'verify failed: % cent-scale constraint missing or incomplete', v_name;
    END IF;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    FOREACH v_table IN ARRAY ARRAY['order_items', 'invoice_items', 'quote_items']
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE']
      LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_privilege) THEN
          RAISE EXCEPTION 'verify failed: %.% retains % for %',
            'public', v_table, v_privilege, v_role;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$verify$;
