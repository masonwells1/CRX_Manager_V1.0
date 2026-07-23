-- Supplier Pricing Phase 3 / Stage A: dormant-by-default product return-policy
-- foundation.  No Product is classified here: every existing/new Product defaults
-- to `unknown`, which permits returns exactly as before.

CREATE TABLE public.product_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  active_ingredient text,
  formulation text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_families_name_canonical_check
    CHECK (name = btrim(name) AND name <> '')
);

-- Canonical display names are case-insensitively unique; blank and padded
-- names fail closed rather than creating a second near-duplicate family.
CREATE UNIQUE INDEX product_families_name_lower_key
  ON public.product_families (lower(name));

ALTER TABLE public.product_families ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_families_select
  ON public.product_families
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.product_families FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.product_families TO authenticated;

CREATE TRIGGER set_product_families_updated_at
  BEFORE UPDATE ON public.product_families
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.products
  ADD COLUMN product_family_id uuid,
  ADD COLUMN return_policy text NOT NULL DEFAULT 'unknown',
  ADD COLUMN packaging_variant text,
  ADD COLUMN is_full_tote_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT products_product_family_id_fkey
    FOREIGN KEY (product_family_id)
    REFERENCES public.product_families(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT products_return_policy_check
    CHECK (return_policy IN ('returnable', 'no_return', 'not_applicable', 'unknown'));

CREATE INDEX idx_products_product_family_id
  ON public.products (product_family_id)
  WHERE product_family_id IS NOT NULL;

-- The existing products table intentionally uses column-level external grants.
-- New governance metadata remains unavailable for direct app writes in Stage A.
REVOKE INSERT (product_family_id, return_policy, packaging_variant, is_full_tote_only),
       UPDATE (product_family_id, return_policy, packaging_variant, is_full_tote_only)
  ON public.products
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lock_phase3_product_policy_products(p_product_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_id uuid;
BEGIN
  -- Ordering is by UUID, not advisory-lock hash.  The namespace prevents
  -- collisions with unrelated advisory-lock protocols in the shared keyspace.
  FOR v_product_id IN
    SELECT DISTINCT ids.product_id
    FROM unnest(COALESCE(p_product_ids, ARRAY[]::uuid[])) AS ids(product_id)
    WHERE ids.product_id IS NOT NULL
    ORDER BY ids.product_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('phase3_product_policy:' || v_product_id::text, 0)
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_phase3_return_policy(p_product_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_blocked_product_id uuid;
BEGIN
  SELECT p.id
    INTO v_blocked_product_id
    FROM public.products p
    JOIN unnest(COALESCE(p_product_ids, ARRAY[]::uuid[])) AS ids(product_id)
      ON ids.product_id = p.id
   WHERE p.return_policy = 'no_return'
   ORDER BY p.id
   LIMIT 1;

  IF v_blocked_product_id IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_POLICY_NO_RETURN';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_phase3_product_metadata_change_safe(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.return_items ri
      JOIN public.returns r ON r.id = ri.return_id
     WHERE ri.product_id = p_product_id
       AND r.deleted_at IS NULL
       AND r.status IN ('requested', 'approved', 'received')
  ) THEN
    RAISE EXCEPTION 'RETURN_POLICY_ACTIVE_RETURN';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_phase3_return_item_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Deliberately validate-only: a row trigger cannot acquire a multi-product
  -- advisory-lock set in UUID order without reintroducing lock-order inversions.
  IF TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    PERFORM public.assert_phase3_return_policy(ARRAY[NEW.product_id]);
  END IF;
  RETURN NEW;
END;
$function$;

-- The FK normally acquires a Product key-share lock before an AFTER statement
-- trigger can join the advisory-lock protocol. Defer it for just this
-- statement; the AFTER trigger takes the sorted namespaced Product locks,
-- re-reads policy, then forces the FK check before returning. That preserves
-- the constraint while making metadata/direct-write ordering transaction-wide.
ALTER TABLE public.return_items
  DROP CONSTRAINT return_items_product_id_fkey,
  ADD CONSTRAINT return_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.products(id)
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION public.defer_phase3_return_item_product_fk()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  SET CONSTRAINTS return_items_product_id_fkey DEFERRED;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER trigger_w_defer_phase3_return_item_product_fk
  BEFORE INSERT OR UPDATE ON public.return_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.defer_phase3_return_item_product_fk();

CREATE TRIGGER trigger_x_validate_phase3_return_item_policy
  BEFORE INSERT OR UPDATE OF product_id ON public.return_items
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_phase3_return_item_policy();

-- Row validation gives a direct writer the stable refusal immediately. The
-- statement triggers below then acquire the complete UUID-sorted Product lock
-- set before re-reading policy, so a multi-row direct writer cannot race a
-- governed metadata change or invert advisory-lock order.
CREATE OR REPLACE FUNCTION public.lock_and_assert_phase3_return_item_insert_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT n.product_id ORDER BY n.product_id)
    INTO v_product_ids
    FROM new_return_items n;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);
  SET CONSTRAINTS return_items_product_id_fkey IMMEDIATE;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER trigger_y_lock_assert_phase3_return_item_insert_policy
  AFTER INSERT ON public.return_items
  REFERENCING NEW TABLE AS new_return_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.lock_and_assert_phase3_return_item_insert_policy();

CREATE OR REPLACE FUNCTION public.lock_and_assert_phase3_return_item_update_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT n.product_id ORDER BY n.product_id)
    INTO v_product_ids
    FROM new_return_items n
    JOIN old_return_items o ON o.id = n.id
   WHERE n.product_id IS DISTINCT FROM o.product_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);
  SET CONSTRAINTS return_items_product_id_fkey IMMEDIATE;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER trigger_y_lock_assert_phase3_return_item_update_policy
  AFTER UPDATE ON public.return_items
  REFERENCING OLD TABLE AS old_return_items NEW TABLE AS new_return_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.lock_and_assert_phase3_return_item_update_policy();

CREATE OR REPLACE FUNCTION public.lock_phase3_return_status_products()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_ids uuid[];
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = NEW.id;
  -- Lock only: reject/cancel/unapply are reversible retirement paths and stay
  -- legal after a Product becomes no_return.
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trigger_x_lock_phase3_return_status_products
  BEFORE UPDATE OF status ON public.returns
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_phase3_return_status_products();

CREATE OR REPLACE FUNCTION public.guard_phase3_product_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Shell/Product creation continues unchanged. Only a non-default Phase 3
    -- classification on INSERT enters governance.
    IF NEW.product_family_id IS NULL
       AND NEW.return_policy = 'unknown'
       AND NEW.packaging_variant IS NULL
       AND NEW.is_full_tote_only = false THEN
      RETURN NEW;
    END IF;

    IF current_setting('app.phase3_metadata_authorized', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'PRODUCT_PHASE3_METADATA_GOVERNED';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.product_family_id IS NOT DISTINCT FROM OLD.product_family_id
     AND NEW.return_policy IS NOT DISTINCT FROM OLD.return_policy
     AND NEW.packaging_variant IS NOT DISTINCT FROM OLD.packaging_variant
     AND NEW.is_full_tote_only IS NOT DISTINCT FROM OLD.is_full_tote_only THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.phase3_metadata_authorized', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'PRODUCT_PHASE3_METADATA_GOVERNED_WRITE_REQUIRED';
  END IF;

  PERFORM public.assert_phase3_product_metadata_change_safe(NEW.id);
  RETURN NEW;
END;
$function$;

-- `trigger_x` runs before existing `trigger_y`/`trigger_z` pricing governance.
-- Default-valued Product INSERTs are untouched; non-default Phase 3 INSERTs
-- and metadata UPDATEs require the governed transaction-local context.
CREATE TRIGGER trigger_x_require_governed_phase3_product_metadata
  BEFORE INSERT OR UPDATE OF product_family_id, return_policy, packaging_variant, is_full_tote_only
  ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_phase3_product_metadata();

CREATE OR REPLACE FUNCTION public.set_product_phase3_metadata(
  p_product_id uuid,
  p_expected_product_family_id uuid,
  p_expected_return_policy text,
  p_expected_packaging_variant text,
  p_expected_is_full_tote_only boolean,
  p_product_family_id uuid,
  p_return_policy text,
  p_packaging_variant text,
  p_is_full_tote_only boolean,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_product public.products%ROWTYPE;
  v_result jsonb;
  v_idempotency_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_expected_return_policy NOT IN ('returnable', 'no_return', 'not_applicable', 'unknown')
     OR p_return_policy NOT IN ('returnable', 'no_return', 'not_applicable', 'unknown')
     OR p_expected_is_full_tote_only IS NULL
     OR p_is_full_tote_only IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_PHASE3_METADATA_INVALID';
  END IF;

  -- A key is a retry only for this exact actor and full optimistic-update
  -- request.  Never replay a success onto a different Product or target.
  v_idempotency_fingerprint := md5(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'expected_product_family_id', p_expected_product_family_id,
    'expected_return_policy', p_expected_return_policy,
    'expected_packaging_variant', p_expected_packaging_variant,
    'expected_is_full_tote_only', p_expected_is_full_tote_only,
    'product_family_id', p_product_family_id,
    'return_policy', p_return_policy,
    'packaging_variant', p_packaging_variant,
    'is_full_tote_only', p_is_full_tote_only
  )::text);
  v_cached := public.check_idempotency(p_idempotency_key, 'set_product_phase3_metadata');
  IF v_cached IS NOT NULL THEN
    IF v_cached->>'request_fingerprint' IS DISTINCT FROM v_idempotency_fingerprint
       OR NOT (v_cached ? 'response') THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_cached->'response';
  END IF;

  PERFORM public.lock_phase3_product_policy_products(ARRAY[p_product_id]);

  SELECT * INTO v_product
    FROM public.products
   WHERE id = p_product_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;

  IF v_product.product_family_id IS DISTINCT FROM p_expected_product_family_id
     OR v_product.return_policy IS DISTINCT FROM p_expected_return_policy
     OR v_product.packaging_variant IS DISTINCT FROM p_expected_packaging_variant
     OR v_product.is_full_tote_only IS DISTINCT FROM p_expected_is_full_tote_only THEN
    RAISE EXCEPTION 'PRODUCT_PHASE3_METADATA_STALE';
  END IF;

  PERFORM public.assert_phase3_product_metadata_change_safe(p_product_id);
  PERFORM set_config('app.phase3_metadata_authorized', 'true', true);

  UPDATE public.products
     SET product_family_id = p_product_family_id,
         return_policy = p_return_policy,
         packaging_variant = p_packaging_variant,
         is_full_tote_only = p_is_full_tote_only,
         updated_at = now()
   WHERE id = p_product_id;

  -- Scope the authorization to the governed UPDATE above; do not let a later
  -- direct Product metadata write inherit it in this same transaction.
  PERFORM set_config('app.phase3_metadata_authorized', 'false', true);

  v_result := jsonb_build_object(
    'success', true,
    'product_id', p_product_id,
    'product_family_id', p_product_family_id,
    'return_policy', p_return_policy,
    'packaging_variant', p_packaging_variant,
    'is_full_tote_only', p_is_full_tote_only
  );
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'set_product_phase3_metadata',
    jsonb_build_object('request_fingerprint', v_idempotency_fingerprint, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

-- Stage A deliberately has no app-role path for changing classifications. The
-- future Stage C owner migration uses SET LOCAL app.phase3_metadata_authorized
-- = 'true' in its approved transaction; this is intentionally not an app grant.
REVOKE ALL ON FUNCTION public.lock_phase3_product_policy_products(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_phase3_return_policy(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_phase3_product_metadata_change_safe(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_phase3_return_item_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_phase3_product_metadata() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_product_phase3_metadata(uuid, uuid, text, text, boolean, uuid, text, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Fail closed if a concurrent deployment changed a wrapper after the live
-- live catalog capture that this migration was derived from.
DO $baseline$
DECLARE
  v_actual text;
BEGIN
  SELECT encode(extensions.digest(p.prosrc, 'sha256'), 'hex') INTO v_actual
    FROM pg_proc p WHERE p.oid = 'public.create_return(jsonb,jsonb,text)'::regprocedure;
  IF v_actual IS DISTINCT FROM '09801c6e53c932904bd8de8a706ac1fcaf36da04f62ea987a9ac958f0bcbcb0c' THEN
    RAISE EXCEPTION 'PHASE3_BASELINE_DRIFT_create_return';
  END IF;
  SELECT encode(extensions.digest(p.prosrc, 'sha256'), 'hex') INTO v_actual
    FROM pg_proc p WHERE p.oid = 'public.approve_return(uuid,uuid,text)'::regprocedure;
  IF v_actual IS DISTINCT FROM '1f7009482e729a8d95cf3874695512e58ac21412bb454e6947a50c8cc9dc7b4a' THEN
    RAISE EXCEPTION 'PHASE3_BASELINE_DRIFT_approve_return';
  END IF;
  SELECT encode(extensions.digest(p.prosrc, 'sha256'), 'hex') INTO v_actual
    FROM pg_proc p WHERE p.oid = 'public.receive_return(uuid,uuid,text)'::regprocedure;
  IF v_actual IS DISTINCT FROM '87af9c3a52c051e3180c9c5c8bfc88c58623332dec4f475ee4a702efc3ce97e3' THEN
    RAISE EXCEPTION 'PHASE3_BASELINE_DRIFT_receive_return';
  END IF;
  SELECT encode(extensions.digest(p.prosrc, 'sha256'), 'hex') INTO v_actual
    FROM pg_proc p WHERE p.oid = 'public.issue_return_credit(uuid,uuid,text)'::regprocedure;
  IF v_actual IS DISTINCT FROM '28b931c1ab3aec79619ecc45b20d860dad4698a647219883e75fe5ebe973d01b' THEN
    RAISE EXCEPTION 'PHASE3_BASELINE_DRIFT_issue_return_credit';
  END IF;
END;
$baseline$;

CREATE OR REPLACE FUNCTION public.create_return(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_return_id uuid;
  v_return_number text;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_status text;
  v_item jsonb;
  v_order_item record;
  v_qty numeric;
  v_prior_qty numeric;
  v_count integer := 0;
  v_existing jsonb;
  -- Phase 3 addition: sorted advisory locks cover all products in this request.
  v_product_ids uuid[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_customer_id := nullif(p_return->>'customer_id', '')::uuid;
  v_order_id := nullif(p_return->>'order_id', '')::uuid;
  IF v_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED'; END IF;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'RETURN_ORDER_REQUIRED'; END IF;
  IF coalesce(btrim(p_return->>'reason'), '') = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'ITEMS_REQUIRED'; END IF;

  SELECT status INTO v_order_status FROM public.orders
  WHERE id = v_order_id AND customer_id = v_customer_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH'; END IF;
  IF v_order_status IN ('voided', 'cancelled') THEN
    RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) item WHERE nullif(item->>'order_item_id', '') IS NULL) THEN
    RAISE EXCEPTION 'RETURN_ORDER_ITEM_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT item->>'order_item_id') FROM jsonb_array_elements(p_items) item) THEN
    RAISE EXCEPTION 'DUPLICATE_RETURN_ORDER_ITEM';
  END IF;

  PERFORM 1
  FROM public.order_items oi
  JOIN jsonb_array_elements(p_items) item
    ON oi.id = (item->>'order_item_id')::uuid
  WHERE oi.order_id = v_order_id
  ORDER BY oi.id
  FOR UPDATE OF oi;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(*) FROM public.order_items oi
      JOIN jsonb_array_elements(p_items) item ON oi.id = (item->>'order_item_id')::uuid
      WHERE oi.order_id = v_order_id) THEN
    RAISE EXCEPTION 'RETURN_ORDER_ITEM_MISMATCH';
  END IF;

  -- Phase 3 addition: UUID-order locks and a policy re-read happen after all
  -- source order-item locks/validation and before creating any return rows.
  SELECT array_agg(DISTINCT oi.product_id ORDER BY oi.product_id)
    INTO v_product_ids
  FROM public.order_items oi
  JOIN jsonb_array_elements(p_items) item
    ON oi.id = (item->>'order_item_id')::uuid
  WHERE oi.order_id = v_order_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);

  v_return_number := public.next_return_number();
  INSERT INTO public.returns (
    return_number, customer_id, order_id, reason, reason_notes, notes, requested_by, status
  ) VALUES (
    v_return_number, v_customer_id, v_order_id, p_return->>'reason',
    p_return->>'reason_notes', p_return->>'notes', v_actor, 'requested'
  ) RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_order_item
    FROM public.order_items
    WHERE id = (v_item->>'order_item_id')::uuid AND order_id = v_order_id;

    v_qty := coalesce((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'RETURN_QUANTITY_MUST_BE_POSITIVE'; END IF;
    IF coalesce(v_order_item.quantity_delivered, 0) <= 0 THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_DELIVERED';
    END IF;
    IF v_order_item.price_per_unit IS NULL THEN
      RAISE EXCEPTION 'RETURN_SOURCE_PRICE_MISSING';
    END IF;

    SELECT coalesce(sum(ri.quantity), 0) INTO v_prior_qty
    FROM public.return_items ri
    JOIN public.returns r ON r.id = ri.return_id
    WHERE ri.order_item_id = v_order_item.id
      AND r.deleted_at IS NULL
      AND r.status NOT IN ('rejected', 'cancelled');

    IF v_prior_qty + v_qty > v_order_item.quantity_delivered THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_DELIVERED';
    END IF;

    INSERT INTO public.return_items (
      return_id, order_item_id, product_id, product_name, quantity, unit,
      unit_price_cents, extended_cents, condition, restock, sort_order, notes
    ) VALUES (
      v_return_id, v_order_item.id, v_order_item.product_id, v_order_item.product_name,
      v_qty, coalesce(v_order_item.unit_size, 'ea'),
      round(v_order_item.price_per_unit * 100)::bigint,
      round(v_qty * v_order_item.price_per_unit * 100)::bigint,
      coalesce(v_item->>'condition', 'unopened'),
      coalesce((v_item->>'restock')::boolean, false),
      coalesce((v_item->>'sort_order')::integer, v_count), v_item->>'notes'
    );
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_requested', 'Return ' || v_return_number || ' requested for ' || v_count || ' product(s)',
    v_actor, 'return', v_return_id, v_customer_id
  );

  v_existing := jsonb_build_object(
    'success', true, 'return_id', v_return_id,
    'return_number', v_return_number, 'item_count', v_count
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'create_return', v_existing);
  END IF;
  RETURN v_existing;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_return(p_return_id uuid, p_approved_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_return record;
  v_cached jsonb;
  v_result jsonb;
  v_actor uuid;
  -- Phase 3 addition: all policy-sensitive Product locks are ordered by UUID.
  v_product_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'approve_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM public.returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status != 'requested' THEN
    RAISE EXCEPTION 'Only requested returns can be approved (current status: %)', v_return.status;
  END IF;

  -- Phase 3 addition: lock then re-read policy before the status effect.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);

  PERFORM set_config('app.return_rpc', 'true', true);

  UPDATE public.returns
     SET status = 'approved',
         approved_by = v_actor,
         approved_at = now(),
         updated_at = now()
   WHERE id = p_return_id;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  )
  VALUES (
    'return_approved',
    'Return ' || v_return.return_number || ' approved',
    v_actor,
    'return',
    p_return_id,
    v_return.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return.return_number,
    'status', 'approved'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'approve_return', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_return(p_return_id uuid, p_received_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_customer_id uuid;
  v_order_status text;
  v_is_legacy_unlinked boolean := false;
  -- Phase 3 addition: this wrapper takes the sorted multi-product lock set.
  v_product_ids uuid[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'receive_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT r.order_id, r.customer_id INTO v_order_id, v_customer_id
  FROM public.returns r
  WHERE r.id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;

  IF v_order_id IS NOT NULL THEN
    SELECT o.status, o.customer_id INTO v_order_status, v_order_customer_id
    FROM public.orders o
    WHERE o.id = v_order_id AND o.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_order_status IN ('voided', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
    END IF;
    IF v_order_customer_id IS DISTINCT FROM v_customer_id THEN
      RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH';
    END IF;

    -- Older linked rows were writable through table policies, so re-derive and
    -- verify every source fact before the legacy implementation can restock.
    IF NOT EXISTS (
      SELECT 1 FROM public.return_items ri WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items ri
      LEFT JOIN public.order_items oi
        ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
          OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint
        )
    ) OR (
      SELECT count(*) <> count(DISTINCT ri.order_item_id)
      FROM public.return_items ri
      WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items current_ri
      JOIN public.order_items oi
        ON oi.id = current_ri.order_item_id AND oi.order_id = v_order_id
      WHERE current_ri.return_id = p_return_id
        AND (
          SELECT coalesce(sum(other_ri.quantity), 0)
          FROM public.return_items other_ri
          JOIN public.returns other_r ON other_r.id = other_ri.return_id
          WHERE other_ri.order_item_id = oi.id
            AND other_r.deleted_at IS NULL
            AND other_r.status NOT IN ('rejected', 'cancelled')
        ) > coalesce(oi.quantity_delivered, 0)
    ) THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  ELSE
    -- Exact one-time compatibility for the sole approved production RMA that
    -- predates order-line capture. IDs and immutable source/money fields were
    -- verified read-only immediately before this migration was authored.
    v_is_legacy_unlinked := p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = p_return_id
          AND r.return_number = 'RMA-2026-0001'
          AND r.customer_id = 'df6087cb-232f-4962-bb33-c74580a06935'::uuid
          AND r.requested_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.approved_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.reason = 'overstock'
          AND r.created_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.requested_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.approved_at = timestamptz '2026-07-10 16:45:29.044351+00'
          AND r.total_credit_cents = 0
      )
      AND 1 = (
        SELECT count(*) FROM public.return_items ri WHERE ri.return_id = p_return_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.return_items ri
        WHERE ri.return_id = p_return_id
          AND ri.id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd'::uuid
          AND ri.order_item_id IS NULL
          AND ri.product_id = 'fad3ea45-cd8c-4bb8-b0ce-8a515941586c'::uuid
          AND ri.product_name = 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'
          AND ri.quantity = 15.00
          AND ri.unit = 'ea'
          AND ri.unit_price_cents = 7597
          AND ri.extended_cents = 113955
          AND ri.condition = 'unopened'
          AND ri.restock = true
          AND ri.restocked = false
          AND ri.sort_order = 0
          AND ri.notes IS NULL
          AND ri.created_at = timestamptz '2026-04-30 20:48:19.173027+00'
      );
    IF NOT v_is_legacy_unlinked THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  END IF;

  -- Phase 3 addition: policy is checked after all source verification and
  -- immediately before invoking the untouched private receive implementation.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);
  RETURN public._receive_return_impl_20260714(p_return_id, v_actor, p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_return_credit(p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_customer_id uuid;
  v_order_status text;
  v_is_legacy_unlinked boolean := false;
  -- Phase 3 addition: this wrapper takes the sorted multi-product lock set.
  v_product_ids uuid[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT r.order_id, r.customer_id INTO v_order_id, v_customer_id
  FROM public.returns r
  WHERE r.id = p_return_id AND r.status = 'received'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_CREDITABLE'; END IF;

  IF v_order_id IS NULL THEN
    -- The same exact production record may be credited after receive_return
    -- advances it to received. No other source-free/caller-priced row qualifies.
    v_is_legacy_unlinked := p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = p_return_id
          AND r.return_number = 'RMA-2026-0001'
          AND r.customer_id = 'df6087cb-232f-4962-bb33-c74580a06935'::uuid
          AND r.requested_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.approved_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.reason = 'overstock'
          AND r.created_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.requested_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.approved_at = timestamptz '2026-07-10 16:45:29.044351+00'
          AND r.total_credit_cents = 0
      )
      AND 1 = (
        SELECT count(*) FROM public.return_items ri WHERE ri.return_id = p_return_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.return_items ri
        WHERE ri.return_id = p_return_id
          AND ri.id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd'::uuid
          AND ri.order_item_id IS NULL
          AND ri.product_id = 'fad3ea45-cd8c-4bb8-b0ce-8a515941586c'::uuid
          AND ri.product_name = 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'
          AND ri.quantity = 15.00
          AND ri.unit = 'ea'
          AND ri.unit_price_cents = 7597
          AND ri.extended_cents = 113955
          AND ri.condition = 'unopened'
          AND ri.restock = true
          AND ri.sort_order = 0
          AND ri.notes IS NULL
          AND ri.created_at = timestamptz '2026-04-30 20:48:19.173027+00'
      );
    IF NOT v_is_legacy_unlinked THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  ELSE
    SELECT o.status, o.customer_id INTO v_order_status, v_order_customer_id
    FROM public.orders o
    WHERE o.id = v_order_id AND o.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_order_status IN ('voided', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
    END IF;
    IF v_order_customer_id IS DISTINCT FROM v_customer_id THEN
      RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.return_items ri WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items ri
      LEFT JOIN public.order_items oi
        ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
          OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint
        )
    ) OR (
      SELECT count(*) <> count(DISTINCT ri.order_item_id)
      FROM public.return_items ri
      WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items current_ri
      JOIN public.order_items oi
        ON oi.id = current_ri.order_item_id AND oi.order_id = v_order_id
      WHERE current_ri.return_id = p_return_id
        AND (
          SELECT coalesce(sum(other_ri.quantity), 0)
          FROM public.return_items other_ri
          JOIN public.returns other_r ON other_r.id = other_ri.return_id
          WHERE other_ri.order_item_id = oi.id
            AND other_r.deleted_at IS NULL
            AND other_r.status NOT IN ('rejected', 'cancelled')
        ) > coalesce(oi.quantity_delivered, 0)
    ) THEN RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED'; END IF;
  END IF;

  -- Phase 3 addition: policy is checked after all source verification and
  -- immediately before invoking the untouched private credit implementation.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);
  RETURN public._issue_return_credit_impl(p_return_id, v_actor, p_idempotency_key);
END;
$function$;

-- Latest production cancellation/reversal bodies are re-emitted below only to
-- establish the Phase 3 Product lock before any durable inventory or ledger
-- mutation. These source hashes are pinned to the approved 2026-07-22 live
-- public-schema dump (highwater 20260722202622), not the 20260719 baseline.
-- Fail closed if a later migration has changed either source.
DO $phase3_reversal_preflight$
DECLARE v_hash text;
BEGIN
  SELECT encode(extensions.digest(prosrc, 'sha256'), 'hex') INTO v_hash
    FROM pg_proc WHERE oid = 'public.cancel_return(uuid,text,uuid,text)'::regprocedure;
  IF v_hash IS DISTINCT FROM '832d63367837da5db7b96040e316691741823293a2cce655c4e1637a988fa2ec' THEN
    RAISE EXCEPTION 'PHASE3_CANCEL_RETURN_SOURCE_HASH_MISMATCH';
  END IF;
  SELECT encode(extensions.digest(prosrc, 'sha256'), 'hex') INTO v_hash
    FROM pg_proc WHERE oid = 'public.unapply_credit_memo(uuid,text,uuid,text)'::regprocedure;
  IF v_hash IS DISTINCT FROM '93ce6fa9d974c52e0e50919eeea4ed03cfe6a64761d4f01a86f69d033e7459b8' THEN
    RAISE EXCEPTION 'PHASE3_UNAPPLY_CREDIT_MEMO_SOURCE_HASH_MISMATCH';
  END IF;
END;
$phase3_reversal_preflight$;

CREATE OR REPLACE FUNCTION public.cancel_return(
  p_return_id uuid,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_return record;
  v_item record;
  v_cached jsonb;
  v_result jsonb;
  v_reversed_ids uuid[] := ARRAY[]::uuid[];
  v_skipped_ids uuid[] := ARRAY[]::uuid[];
  v_reversed_qty bigint := 0;
  v_reversed_count int := 0;
  v_skipped_count int := 0;
  v_was_received boolean;
  v_actor uuid;
  v_product_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'cancel_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is required to cancel a return'; END IF;
  SELECT id, return_number, status, customer_id INTO v_return FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status NOT IN ('requested', 'approved', 'received') THEN RAISE EXCEPTION 'Cannot cancel return in status "%" - only requested/approved/received returns can be cancelled', v_return.status; END IF;

  -- Lock every linked Product before inventory is touched.  The helper sorts
  -- UUIDs, matching receive_return and the direct-write backstop trigger.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id) INTO v_product_ids
    FROM public.return_items ri WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);

  v_was_received := (v_return.status = 'received');
  IF v_was_received THEN
    FOR v_item IN
      SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition, inv.id AS inv_id, inv.location AS inv_location
      FROM public.return_items ri
      LEFT JOIN LATERAL (SELECT id, location FROM public.inventory WHERE product_id = ri.product_id AND location = 'Main Warehouse' LIMIT 1) inv ON true
      WHERE ri.return_id = p_return_id AND ri.restocked = true ORDER BY ri.sort_order
    LOOP
      IF v_item.inv_id IS NOT NULL THEN
        UPDATE public.inventory SET quantity_available = quantity_available - v_item.quantity, updated_at = now() WHERE id = v_item.inv_id;
        INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
        VALUES (v_item.product_id, 'returned', -v_item.quantity, v_item.inv_location, v_actor, 'Cancel of return ' || v_return.return_number || ': ' || v_item.product_name || ' (' || v_item.condition || ') - restock reversed: ' || p_reason);
        v_reversed_ids := array_append(v_reversed_ids, v_item.item_id); v_reversed_qty := v_reversed_qty + v_item.quantity; v_reversed_count := v_reversed_count + 1;
      ELSE
        RAISE WARNING 'Cancel of return %: item % (product %) was restocked but inventory row no longer exists - skipping reversal, restocked flag will still be cleared.', v_return.return_number, v_item.item_id, v_item.product_id;
        v_skipped_ids := array_append(v_skipped_ids, v_item.item_id); v_skipped_count := v_skipped_count + 1;
      END IF;
    END LOOP;
  END IF;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.returns SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancellation_reason = p_reason, updated_at = now() WHERE id = p_return_id;
  PERFORM set_config('app.admin_override', 'false', true);
  IF array_length(v_reversed_ids, 1) > 0 OR array_length(v_skipped_ids, 1) > 0 THEN UPDATE public.return_items SET restocked = false WHERE id = ANY(v_reversed_ids || v_skipped_ids); END IF;
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_cancelled', 'Return ' || v_return.return_number || ' cancelled' || CASE WHEN v_was_received THEN ' - ' || v_reversed_count || ' item(s) un-restocked' || CASE WHEN v_skipped_count > 0 THEN ' (' || v_skipped_count || ' skipped: inventory row missing - admin must reconcile)' ELSE '' END ELSE '' END || ': ' || p_reason, v_actor, 'return', p_return_id, v_return.customer_id);
  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number, 'status', 'cancelled', 'was_received', v_was_received, 'reversed_count', v_reversed_count, 'reversed_quantity', v_reversed_qty, 'skipped_count', v_skipped_count);
  IF p_idempotency_key IS NOT NULL THEN PERFORM public.save_idempotency(p_idempotency_key, 'cancel_return', v_result); END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unapply_credit_memo(p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_invoice record; v_return record; v_existing jsonb; v_result jsonb; v_capp record; v_product_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is required to unapply a credit memo'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'unapply_credit_memo';
    IF v_existing IS NOT NULL THEN IF (v_existing->>'credit_memo_id')::uuid IS DISTINCT FROM p_credit_memo_id THEN RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: idempotency key was already used for a different credit memo'; END IF; RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_invoice FROM invoices WHERE id = p_credit_memo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_credit_memo_id; END IF;
  IF v_invoice.invoice_type != 'credit_memo' THEN RAISE EXCEPTION 'Invoice % is not a credit memo (type: %)', v_invoice.invoice_number, v_invoice.invoice_type; END IF;
  IF v_invoice.status != 'posted' THEN RAISE EXCEPTION 'Only posted credit memos can be unapplied (current status: %)', v_invoice.status; END IF;
  PERFORM check_period_open(v_invoice.invoice_date);
  -- Acquire Return/Product protocol before reversing applications or voiding the memo.
  SELECT * INTO v_return FROM returns WHERE credit_invoice_id = p_credit_memo_id FOR UPDATE;
  IF v_return.id IS NOT NULL THEN
    SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id) INTO v_product_ids FROM return_items ri WHERE ri.return_id = v_return.id;
    PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  END IF;
  FOR v_capp IN SELECT id, applied_at FROM credit_memo_applications WHERE credit_memo_id = p_credit_memo_id AND reversed_at IS NULL ORDER BY id LOOP
    PERFORM check_period_open(v_capp.applied_at::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, v_actor, (SELECT role FROM profiles WHERE id = v_actor), 'Auto-reversed: credit memo ' || v_invoice.invoice_number || ' unapplied — ' || p_reason);
  END LOOP;
  UPDATE invoices SET status = 'voided', voided_by = v_actor, voided_at = now(), void_reason = p_reason, updated_at = now() WHERE id = p_credit_memo_id;
  IF v_return.id IS NOT NULL THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET status = 'received', credit_invoice_id = NULL, total_credit_cents = 0, credited_at = NULL, credited_by = NULL, updated_at = now() WHERE id = v_return.id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('credit_memo_unapplied', 'invoice', p_credit_memo_id, (SELECT role FROM profiles WHERE id = v_actor), jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents), jsonb_build_object('status', 'voided', 'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END), -v_invoice.total_amount_cents, 'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('credit_memo_unapplied', 'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason, v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id);
  v_result := jsonb_build_object('success', true, 'credit_memo_id', p_credit_memo_id, 'invoice_number', v_invoice.invoice_number, 'return_id', v_return.id, 'return_reverted', v_return.id IS NOT NULL);
  IF p_idempotency_key IS NOT NULL THEN INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at) VALUES (p_idempotency_key, 'unapply_credit_memo', v_result, now() + interval '24 hours') ON CONFLICT (idempotency_key) DO NOTHING; END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_return(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_return(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_return(jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.issue_return_credit(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lock_and_assert_phase3_return_item_insert_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_and_assert_phase3_return_item_update_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_phase3_return_status_products() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_phase3_return_item_product_fk() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_return(jsonb, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_return(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receive_return(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_return_credit(uuid, uuid, text) TO authenticated, service_role;

-- Post-replacement structural assertions catch accidental loss of the current
-- actor/GUC topology while accepting only the deliberate policy additions.
DO $assertions$
DECLARE
  v_src text;
  v_hash text;
  v_trigger_def text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.approve_return(uuid,uuid,text)'::regprocedure;
  SELECT encode(extensions.digest(v_src, 'sha256'), 'hex') INTO v_hash;
  IF v_hash IS DISTINCT FROM '72bd250452fdee8d0a607292f6b8a5b476094a0d9905cde2cec0117c93da8882' THEN
    RAISE EXCEPTION 'PHASE3_APPROVE_RETURN_BODY_HASH_ASSERTION_FAILED';
  END IF;
  IF position('ACTOR_MISMATCH' IN v_src) = 0 OR position('app.return_rpc' IN v_src) = 0 OR position('assert_phase3_return_policy' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PHASE3_APPROVE_RETURN_ASSERTION_FAILED';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.create_return(jsonb,jsonb,text)'::regprocedure;
  SELECT encode(extensions.digest(v_src, 'sha256'), 'hex') INTO v_hash;
  IF v_hash IS DISTINCT FROM 'fb6cb463febd77dbe05ef8f71a4131161896681f8e189685cc67f4f7fe0e78ea' THEN
    RAISE EXCEPTION 'PHASE3_CREATE_RETURN_BODY_HASH_ASSERTION_FAILED';
  END IF;
  IF position('auth.uid()' IN v_src) = 0 OR position('assert_phase3_return_policy' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PHASE3_CREATE_RETURN_ASSERTION_FAILED';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.receive_return(uuid,uuid,text)'::regprocedure;
  SELECT encode(extensions.digest(v_src, 'sha256'), 'hex') INTO v_hash;
  IF v_hash IS DISTINCT FROM '9f5e2cfa95f6c0fb6ae06c3d7f0c04a31efdd8309b431f6dba5330c78aad9ded' THEN
    RAISE EXCEPTION 'PHASE3_RECEIVE_RETURN_BODY_HASH_ASSERTION_FAILED';
  END IF;
  IF position('ACTOR_MISMATCH' IN v_src) = 0 OR position('assert_phase3_return_policy' IN v_src) = 0 OR position('_receive_return_impl_20260714' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PHASE3_RECEIVE_RETURN_ASSERTION_FAILED';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.issue_return_credit(uuid,uuid,text)'::regprocedure;
  SELECT encode(extensions.digest(v_src, 'sha256'), 'hex') INTO v_hash;
  IF v_hash IS DISTINCT FROM '55607c6dae0cc11f4837f67c54de88a6f4d83413cd3686e04c21bf33afa4ffa5' THEN
    RAISE EXCEPTION 'PHASE3_ISSUE_RETURN_CREDIT_BODY_HASH_ASSERTION_FAILED';
  END IF;
  IF position('ACTOR_MISMATCH' IN v_src) = 0 OR position('assert_phase3_return_policy' IN v_src) = 0 OR position('_issue_return_credit_impl' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PHASE3_ISSUE_RETURN_CREDIT_ASSERTION_FAILED';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.cancel_return(uuid,text,uuid,text)'::regprocedure;
  SELECT encode(extensions.digest(v_src, 'sha256'), 'hex') INTO v_hash;
  IF v_hash IS DISTINCT FROM '84e3721397dc5d904c0e0d0fe279a821c2a8f1eeec24e87969261dba5984fe45' THEN
    RAISE EXCEPTION 'PHASE3_CANCEL_RETURN_POST_HASH_ASSERTION_FAILED';
  END IF;
  IF position('ACTOR_MISMATCH' IN v_src) = 0
     OR position('lock_phase3_product_policy_products' IN v_src) = 0
     OR position('UPDATE public.inventory' IN v_src) = 0
     OR position('lock_phase3_product_policy_products' IN v_src) > position('UPDATE public.inventory' IN v_src)
     OR position('app.admin_override' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PHASE3_CANCEL_RETURN_LOCK_ORDER_ASSERTION_FAILED';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.unapply_credit_memo(uuid,text,uuid,text)'::regprocedure;
  SELECT encode(extensions.digest(v_src, 'sha256'), 'hex') INTO v_hash;
  IF v_hash IS DISTINCT FROM '286de5b0ac196331713278f335ba1b02e73e9de334cc2fb5f22e49629922b374' THEN
    RAISE EXCEPTION 'PHASE3_UNAPPLY_CREDIT_MEMO_POST_HASH_ASSERTION_FAILED';
  END IF;
  IF position('ACTOR_MISMATCH' IN v_src) = 0
     OR position('lock_phase3_product_policy_products' IN v_src) = 0
     OR position('_reverse_credit_memo_application' IN v_src) = 0
     OR position('lock_phase3_product_policy_products' IN v_src) > position('_reverse_credit_memo_application' IN v_src)
     OR position('app.admin_override' IN v_src) = 0 THEN
    RAISE EXCEPTION 'PHASE3_UNAPPLY_CREDIT_MEMO_LOCK_ORDER_ASSERTION_FAILED';
  END IF;

  -- Direct return-item writers and return status writers must use the same
  -- sorted, namespaced Product lock protocol as the governed wrappers.
  FOREACH v_src IN ARRAY ARRAY[
    'lock_and_assert_phase3_return_item_insert_policy',
    'lock_and_assert_phase3_return_item_update_policy',
    'lock_phase3_return_status_products',
    'defer_phase3_return_item_product_fk'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = ('public.' || v_src || '()')::regprocedure
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public, pg_temp']
    ) THEN
      RAISE EXCEPTION 'PHASE3_LOCK_TRIGGER_FUNCTION_ASSERTION_FAILED: %', v_src;
    END IF;
    IF EXISTS (
         SELECT 1
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE p.oid = ('public.' || v_src || '()')::regprocedure
            AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR has_function_privilege('anon', ('public.' || v_src || '()')::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || v_src || '()')::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'PHASE3_LOCK_TRIGGER_GRANT_ASSERTION_FAILED: %', v_src;
    END IF;
  END LOOP;
  FOREACH v_src IN ARRAY ARRAY[
    'trigger_y_lock_assert_phase3_return_item_insert_policy',
    'trigger_y_lock_assert_phase3_return_item_update_policy',
    'trigger_x_lock_phase3_return_status_products',
    'trigger_w_defer_phase3_return_item_product_fk'
  ] LOOP
    SELECT pg_get_triggerdef(t.oid) INTO v_trigger_def
      FROM pg_trigger t
     WHERE t.tgname = v_src AND t.tgrelid='public.return_items'::regclass AND NOT t.tgisinternal
     UNION ALL
    SELECT pg_get_triggerdef(t.oid)
      FROM pg_trigger t
     WHERE t.tgname = v_src AND t.tgrelid='public.returns'::regclass AND NOT t.tgisinternal;
    IF v_trigger_def IS NULL OR position('phase3_' IN v_trigger_def) = 0 THEN
      RAISE EXCEPTION 'PHASE3_LOCK_TRIGGER_ASSERTION_FAILED: %', v_src;
    END IF;
  END LOOP;
  SELECT pg_get_triggerdef(t.oid) INTO v_trigger_def
    FROM pg_trigger t WHERE t.tgname='trigger_y_lock_assert_phase3_return_item_insert_policy';
  IF position('REFERENCING NEW TABLE AS new_return_items' IN v_trigger_def) = 0
     OR position('FOR EACH STATEMENT' IN v_trigger_def) = 0 THEN
    RAISE EXCEPTION 'PHASE3_INSERT_TRANSITION_LOCK_ASSERTION_FAILED';
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_trigger_def
    FROM pg_trigger t WHERE t.tgname='trigger_y_lock_assert_phase3_return_item_update_policy';
  IF position('REFERENCING OLD TABLE AS old_return_items NEW TABLE AS new_return_items' IN v_trigger_def) = 0
     OR position('FOR EACH STATEMENT' IN v_trigger_def) = 0 THEN
    RAISE EXCEPTION 'PHASE3_UPDATE_TRANSITION_LOCK_ASSERTION_FAILED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.return_items'::regclass
       AND c.connamespace='public'::regnamespace
       AND c.conname='return_items_product_id_fkey'
       AND c.condeferrable AND NOT c.condeferred
  ) OR 1 <> (SELECT count(*) FROM pg_constraint c WHERE c.connamespace='public'::regnamespace AND c.conname='return_items_product_id_fkey') THEN
    RAISE EXCEPTION 'PHASE3_RETURN_ITEM_FK_TIMING_ASSERTION_FAILED';
  END IF;
  IF has_table_privilege('anon', 'public.product_families', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.product_families', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_families' AND roles @> ARRAY['anon'::name]) THEN
    RAISE EXCEPTION 'PHASE3_PRODUCT_FAMILIES_GRANT_ASSERTION_FAILED';
  END IF;
END;
$assertions$;
