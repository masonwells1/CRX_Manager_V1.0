-- Codex gauntlet closeout: make split-invoice provenance private, exact, and
-- atomic with the canonical field/acre creator.
--
-- 20260719024641 stopped trusting arbitrary non-null group IDs, but its posting
-- guard still treated financial_audit_log payloads as authority. Those rows were
-- historically client-writable and are not relationally bound to invoice/order
-- identity. This forward-only repair proves the live legacy set empty, then
-- replaces audit trust with a private owner-only provenance claim.

-- Block every writer that can change split evidence or create an invoice while
-- the empty-live reconciliation, private tables, wrapper, and guards are cut over.
-- An old create_split_invoices_from_order call that started before this lock
-- either finishes first (and makes the preflight fail closed) or resumes after
-- cutover and is rejected by the transaction-claim trigger.
LOCK TABLE
  public.orders,
  public.order_items,
  public.order_item_field_allocations,
  public.invoices,
  public.invoice_items,
  public.financial_audit_log
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_historical jsonb;
  v_protected  jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'audit_id', fal.id,
           'invoice_id', fal.entity_id,
           'created_at', fal.created_at,
           'group_id', fal.new_values->>'group_id'
         ) ORDER BY fal.created_at, fal.id)
    INTO v_historical
    FROM public.financial_audit_log fal
   WHERE fal.operation_type = 'invoice_created'
     AND fal.entity_type = 'invoice'
     AND fal.new_values->>'split_basis' = 'field_acre';

  IF v_historical IS NOT NULL THEN
    RAISE EXCEPTION
      'SPLIT_PROVENANCE_RECONCILIATION_REQUIRED: historical field-acre audit rows cannot be promoted to authority automatically: %',
      v_historical;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'invoice_id', i.id,
           'invoice_number', i.invoice_number,
           'order_id', i.order_id,
           'invoice_group_id', i.invoice_group_id,
           'status', i.status
         ) ORDER BY i.invoice_number, i.id)
    INTO v_protected
    FROM public.invoices i
    JOIN public.orders o ON o.id = i.order_id
   WHERE i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled')
     AND (
       COALESCE(o.needs_split_billing, false)
       OR EXISTS (
         SELECT 1
           FROM public.order_item_field_allocations oifa
           JOIN public.order_items oi ON oi.id = oifa.order_item_id
          WHERE oi.order_id = i.order_id
       )
     );

  IF v_protected IS NOT NULL THEN
    RAISE EXCEPTION
      'SPLIT_PROVENANCE_RECONCILIATION_REQUIRED: live split-protected invoices require explicit reconciliation: %',
      v_protected;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS role_name(name)
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS privilege_name(name)
     WHERE has_table_privilege(
       role_name.name,
       'public.financial_audit_log',
       privilege_name.name
     )
  ) THEN
    RAISE EXCEPTION
      'SPLIT_PROVENANCE_REQUIRES_AUDIT_REVOKE: direct financial_audit_log DML must remain revoked';
  END IF;
END;
$preflight$;

CREATE TABLE public.split_invoice_creation_claims (
  transaction_id xid8 PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  claim_nonce    uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.split_invoice_provenance (
  invoice_id          uuid PRIMARY KEY
    REFERENCES public.invoices(id) ON DELETE RESTRICT,
  order_id            uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  invoice_group_id    uuid NOT NULL,
  customer_id         uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  invoice_type        text NOT NULL,
  season              integer NOT NULL,
  total_amount_cents  bigint NOT NULL CHECK (total_amount_cents >= 0),
  content_claim       jsonb NOT NULL CHECK (jsonb_typeof(content_claim) = 'object'),
  provenance_nonce    uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  contract_version    text NOT NULL DEFAULT 'split_invoice_provenance_v1'
    CHECK (contract_version = 'split_invoice_provenance_v1'),
  UNIQUE (invoice_group_id, invoice_id)
);

CREATE TABLE public.split_invoice_mutation_claims (
  transaction_id xid8 NOT NULL,
  invoice_id     uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  operation      text NOT NULL CHECK (operation IN ('save_invoice', 'delete_invoices')),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transaction_id, invoice_id, operation)
);

ALTER TABLE public.split_invoice_creation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.split_invoice_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.split_invoice_mutation_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY split_invoice_creation_claims_deny_all
ON public.split_invoice_creation_claims
FOR ALL TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY split_invoice_provenance_deny_all
ON public.split_invoice_provenance
FOR ALL TO PUBLIC
USING (false)
WITH CHECK (false);

CREATE POLICY split_invoice_mutation_claims_deny_all
ON public.split_invoice_mutation_claims
FOR ALL TO PUBLIC
USING (false)
WITH CHECK (false);

REVOKE ALL ON TABLE
  public.split_invoice_creation_claims,
  public.split_invoice_provenance,
  public.split_invoice_mutation_claims
FROM PUBLIC, anon, authenticated, service_role;

-- Direct invoice creation/deletion would permit UUID/group identity recycling
-- around an audit-only guard. All repo business writers are owner-context RPCs;
-- clients keep SELECT/UPDATE subject to the existing RLS and hard triggers.
REVOKE INSERT, DELETE, TRUNCATE ON TABLE public.invoices
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._split_invoice_content_claim(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'contract_version', 'split_invoice_provenance_v1',
    'invoice', jsonb_build_object(
      'invoice_id', i.id,
      'invoice_number', i.invoice_number,
      'order_id', i.order_id,
      'customer_id', i.customer_id,
      'invoice_type', i.invoice_type,
      'season', i.season,
      'salesman_id', i.salesman_id,
      'created_by', i.created_by,
      'total_amount_cents', i.total_amount_cents,
      'invoice_date', i.invoice_date,
      'invoice_group_id', i.invoice_group_id,
      'header_notes', i.header_notes,
      'pricing_pending', i.pricing_pending
    ),
    'items', COALESCE((
      SELECT jsonb_agg(
               to_jsonb(ii) - ARRAY['created_at', 'updated_at']::text[]
               ORDER BY ii.sort_order, ii.id
             )
        FROM public.invoice_items ii
       WHERE ii.invoice_id = i.id
    ), '[]'::jsonb)
  )
  FROM public.invoices i
  WHERE i.id = p_invoice_id;
$function$;

REVOKE ALL ON FUNCTION public._split_invoice_content_claim(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.require_split_invoice_creation_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.order_id IS NOT NULL
     AND NEW.invoice_group_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1
           FROM public.orders o
          WHERE o.id = NEW.order_id
            AND COALESCE(o.needs_split_billing, false)
       )
       OR EXISTS (
         SELECT 1
           FROM public.order_item_field_allocations oifa
           JOIN public.order_items oi ON oi.id = oifa.order_item_id
          WHERE oi.order_id = NEW.order_id
       )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.split_invoice_creation_claims claim
        WHERE claim.transaction_id = pg_current_xact_id()
          AND claim.order_id = NEW.order_id
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_CREATION_CLAIM_REQUIRED: split-protected grouped invoices must be created by create_split_invoices_from_order'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_split_invoice_creation_claim()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS require_split_invoice_creation_claim ON public.invoices;
CREATE TRIGGER require_split_invoice_creation_claim
BEFORE INSERT ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.require_split_invoice_creation_claim();

CREATE OR REPLACE FUNCTION public.guard_split_invoice_provenance_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_save_claim   boolean := false;
  v_delete_claim boolean := false;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.split_invoice_provenance p
     WHERE p.invoice_id = OLD.id
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_PROVENANCE_IMMUTABLE: a governed split invoice cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT
      EXISTS (
        SELECT 1
          FROM public.split_invoice_mutation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.invoice_id = OLD.id
           AND claim.operation = 'save_invoice'
      ),
      EXISTS (
        SELECT 1
          FROM public.split_invoice_mutation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.invoice_id = OLD.id
           AND claim.operation = 'delete_invoices'
      )
      INTO v_save_claim, v_delete_claim;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
       OR NEW.season IS DISTINCT FROM OLD.season
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.invoice_group_id IS DISTINCT FROM OLD.invoice_group_id THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_PROVENANCE_IMMUTABLE: governed split invoice identity cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       AND NOT v_delete_claim THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_PROVENANCE_IMMUTABLE: governed split invoices can be soft-deleted only by delete_invoices'
        USING ERRCODE = 'check_violation';
    END IF;

    IF (
         NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
         OR NEW.salesman_id IS DISTINCT FROM OLD.salesman_id
         OR NEW.total_amount_cents IS DISTINCT FROM OLD.total_amount_cents
         OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
         OR NEW.header_notes IS DISTINCT FROM OLD.header_notes
         OR NEW.pricing_pending IS DISTINCT FROM OLD.pricing_pending
       ) AND NOT v_save_claim THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_PROVENANCE_IMMUTABLE: governed split invoice content can be changed only by save_invoice'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_split_invoice_provenance_identity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_split_invoice_provenance_identity ON public.invoices;
CREATE TRIGGER guard_split_invoice_provenance_identity
BEFORE UPDATE OR DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.guard_split_invoice_provenance_identity();

CREATE OR REPLACE FUNCTION public.guard_split_invoice_provenance_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_invoice_id uuid := CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_id END;
  v_new_invoice_id uuid := CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_id END;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.split_invoice_provenance p
     WHERE p.invoice_id = v_old_invoice_id
        OR p.invoice_id = v_new_invoice_id
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.split_invoice_mutation_claims claim
     WHERE claim.transaction_id = pg_current_xact_id()
       AND claim.operation = 'save_invoice'
       AND (claim.invoice_id = v_old_invoice_id OR claim.invoice_id = v_new_invoice_id)
  ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_PROVENANCE_IMMUTABLE: governed split invoice items cannot be inserted, changed, deleted, or re-parented'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_split_invoice_provenance_items()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_split_invoice_provenance_items ON public.invoice_items;
CREATE TRIGGER guard_split_invoice_provenance_items
BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public.guard_split_invoice_provenance_items();

-- Preserve the reviewed live implementation behind a private name. The public
-- wrapper adds the common order->ordered-items serialization and transaction
-- claim, then binds every returned split member to its exact private content.
ALTER FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text)
  RENAME TO _create_split_invoices_from_order_provenance_impl_20260719;

REVOKE ALL ON FUNCTION
  public._create_split_invoices_from_order_provenance_impl_20260719(uuid, uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_split_invoices_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL::uuid,
  p_invoice_type text DEFAULT 'chemical_sale'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_ids uuid[];
  v_claim_nonce uuid := gen_random_uuid();
BEGIN
  -- Canonical order->items lock order. This conflicts with the OIFA writer's
  -- stable parent-item locks before the implementation reads any allocation.
  PERFORM 1
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
   ORDER BY oi.id
   FOR UPDATE;

  INSERT INTO public.split_invoice_creation_claims (
    transaction_id,
    order_id,
    claim_nonce
  ) VALUES (
    pg_current_xact_id(),
    p_order_id,
    v_claim_nonce
  );

  v_invoice_ids := public._create_split_invoices_from_order_provenance_impl_20260719(
    p_order_id,
    p_salesman_id,
    p_invoice_type,
    p_idempotency_key
  );

  INSERT INTO public.split_invoice_provenance (
    invoice_id,
    order_id,
    invoice_group_id,
    customer_id,
    invoice_type,
    season,
    total_amount_cents,
    content_claim,
    provenance_nonce,
    created_by
  )
  SELECT
    i.id,
    i.order_id,
    i.invoice_group_id,
    i.customer_id,
    i.invoice_type,
    i.season,
    i.total_amount_cents,
    public._split_invoice_content_claim(i.id),
    gen_random_uuid(),
    auth.uid()
  FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
  JOIN public.invoices i ON i.id = returned.invoice_id
  WHERE i.order_id = p_order_id
    AND i.invoice_group_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.order_item_field_allocations oifa
        JOIN public.order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = p_order_id
    )
  ON CONFLICT (invoice_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
      FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
      JOIN public.invoices i ON i.id = returned.invoice_id
     WHERE i.order_id = p_order_id
       AND i.invoice_group_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.order_item_field_allocations oifa
           JOIN public.order_items oi ON oi.id = oifa.order_item_id
          WHERE oi.order_id = p_order_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.split_invoice_provenance p
          WHERE p.invoice_id = i.id
            AND p.order_id = i.order_id
            AND p.invoice_group_id = i.invoice_group_id
            AND p.customer_id = i.customer_id
            AND p.invoice_type = i.invoice_type
            AND p.season = i.season
            AND p.total_amount_cents = i.total_amount_cents
            AND p.content_claim = public._split_invoice_content_claim(i.id)
            AND p.contract_version = 'split_invoice_provenance_v1'
       )
  ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_PROVENANCE_REPLAY_MISMATCH: returned split invoice content does not match its immutable claim';
  END IF;

  DELETE FROM public.split_invoice_creation_claims
   WHERE transaction_id = pg_current_xact_id()
     AND order_id = p_order_id
     AND claim_nonce = v_claim_nonce;

  IF FOUND IS FALSE THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_CREATION_CLAIM_LOST';
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text)
  TO authenticated, service_role;

-- Existing UI draft edits are already routed through save_invoice. Preserve
-- that governed path while keeping direct invoice/item edits unable to rewrite
-- private provenance. The private wrapper creates a transaction-scoped claim,
-- runs the fully reviewed live function, then refreshes the exact content claim.
ALTER FUNCTION public.save_invoice(jsonb, jsonb, text)
  RENAME TO _save_invoice_split_provenance_impl_20260719;

REVOKE ALL ON FUNCTION
  public._save_invoice_split_provenance_impl_20260719(jsonb, jsonb, text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_saved_id   uuid;
  v_governed   boolean := false;
BEGIN
  IF v_invoice_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance p
       WHERE p.invoice_id = v_invoice_id
    ) INTO v_governed;
  END IF;

  IF v_governed THEN
    INSERT INTO public.split_invoice_mutation_claims (
      transaction_id, invoice_id, operation
    ) VALUES (
      pg_current_xact_id(), v_invoice_id, 'save_invoice'
    );
  END IF;

  v_saved_id := public._save_invoice_split_provenance_impl_20260719(
    p_invoice,
    p_items,
    p_idempotency_key
  );

  IF v_governed THEN
    IF v_saved_id IS DISTINCT FROM v_invoice_id THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_SAVE_IDENTITY_MISMATCH';
    END IF;

    UPDATE public.split_invoice_provenance p
       SET total_amount_cents = i.total_amount_cents,
           content_claim = public._split_invoice_content_claim(i.id)
      FROM public.invoices i
     WHERE p.invoice_id = v_saved_id
       AND i.id = p.invoice_id
       AND p.order_id = i.order_id
       AND p.invoice_group_id = i.invoice_group_id
       AND p.customer_id = i.customer_id
       AND p.invoice_type = i.invoice_type
       AND p.season = i.season;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_PROVENANCE_REFRESH_FAILED';
    END IF;

    DELETE FROM public.split_invoice_mutation_claims
     WHERE transaction_id = pg_current_xact_id()
       AND invoice_id = v_invoice_id
       AND operation = 'save_invoice';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_MUTATION_CLAIM_LOST';
    END IF;
  END IF;

  RETURN v_saved_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  TO authenticated, service_role;

-- delete_invoices is the only supported draft deletion path in the UI. Allow
-- its soft delete under a private claim, preserve the provenance row/FK forever
-- (so the UUID cannot be recycled), and mark the retired draft cancelled so a
-- fresh canonical split can be created for the order later.
ALTER FUNCTION public.delete_invoices(uuid[], uuid, text)
  RENAME TO _delete_invoices_split_provenance_impl_20260719;

REVOKE ALL ON FUNCTION
  public._delete_invoices_split_provenance_impl_20260719(uuid[], uuid, text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.delete_invoices(
  p_invoice_ids uuid[],
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_deleted_count integer;
  v_governed_ids uuid[] := '{}'::uuid[];
BEGIN
  SELECT COALESCE(array_agg(p.invoice_id ORDER BY p.invoice_id), '{}'::uuid[])
    INTO v_governed_ids
    FROM public.split_invoice_provenance p
   WHERE p.invoice_id = ANY(COALESCE(p_invoice_ids, '{}'::uuid[]));

  INSERT INTO public.split_invoice_mutation_claims (
    transaction_id, invoice_id, operation
  )
  SELECT pg_current_xact_id(), governed.invoice_id, 'delete_invoices'
    FROM unnest(v_governed_ids) AS governed(invoice_id);

  v_deleted_count := public._delete_invoices_split_provenance_impl_20260719(
    p_invoice_ids,
    p_performed_by,
    p_idempotency_key
  );

  UPDATE public.invoices i
     SET status = 'cancelled'
   WHERE i.id = ANY(v_governed_ids)
     AND i.deleted_at IS NOT NULL
     AND i.status IN ('draft', 'unposted');

  DELETE FROM public.split_invoice_mutation_claims claim
   WHERE claim.transaction_id = pg_current_xact_id()
     AND claim.operation = 'delete_invoices'
     AND claim.invoice_id = ANY(v_governed_ids);

  IF cardinality(v_governed_ids) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.split_invoice_provenance p
        WHERE p.invoice_id = ANY(v_governed_ids)
     ) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_PROVENANCE_IDENTITY_LOST';
  END IF;

  RETURN v_deleted_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_invoices(uuid[], uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_invoices(uuid[], uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id    uuid;
  v_needs_split boolean := false;
  v_has_oifa    boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.order_id IS NOT NULL
     AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION
      'INVOICE_ORDER_IMMUTABLE: an existing order-backed invoice cannot clear or change order_id'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.status IN ('posted', 'paid', 'overdue')
          OR NEW.status IN ('posted', 'paid', 'overdue'))
     AND NEW.invoice_group_id IS DISTINCT FROM OLD.invoice_group_id THEN
    RAISE EXCEPTION
      'INVOICE_GROUP_IMMUTABLE_ON_POST: invoice_group_id cannot be assigned, cleared, or changed while an invoice enters or remains active'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status NOT IN ('posted', 'paid', 'overdue')
     OR (TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'paid', 'overdue')) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  IF v_order_id IS NULL THEN RETURN NEW; END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = v_order_id
   ORDER BY oi.id
   FOR UPDATE;

  SELECT COALESCE(o.needs_split_billing, false)
    INTO v_needs_split
    FROM public.orders o
   WHERE o.id = v_order_id;

  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = v_order_id
  ) INTO v_has_oifa;

  IF COALESCE(v_needs_split, false) OR COALESCE(v_has_oifa, false) THEN
    IF NEW.invoice_group_id IS NULL THEN
      RAISE EXCEPTION
        'MONO_INVOICE_SPLIT_BILLING_CONFLICT: cannot post a mono invoice for an order with split-billing evidence; use the split invoice group flow instead'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance p
       WHERE p.invoice_id = NEW.id
         AND p.order_id = v_order_id
         AND p.invoice_group_id = NEW.invoice_group_id
         AND p.customer_id = NEW.customer_id
         AND p.invoice_type = NEW.invoice_type
         AND p.season = NEW.season
         AND p.total_amount_cents = NEW.total_amount_cents
         AND p.content_claim = public._split_invoice_content_claim(NEW.id)
         AND p.contract_version = 'split_invoice_provenance_v1'
    ) OR EXISTS (
      SELECT 1
        FROM public.invoices member
       WHERE member.invoice_group_id = NEW.invoice_group_id
         AND member.order_id = v_order_id
         AND (
           member.deleted_at IS NOT NULL
           OR member.status IN ('voided', 'cancelled')
           OR NOT EXISTS (
             SELECT 1
               FROM public.split_invoice_provenance member_p
              WHERE member_p.invoice_id = member.id
                AND member_p.order_id = member.order_id
                AND member_p.invoice_group_id = member.invoice_group_id
                AND member_p.customer_id = member.customer_id
                AND member_p.invoice_type = member.invoice_type
                AND member_p.season = member.season
                AND member_p.total_amount_cents = member.total_amount_cents
                AND member_p.content_claim = public._split_invoice_content_claim(member.id)
                AND member_p.contract_version = 'split_invoice_provenance_v1'
           )
         )
    ) OR EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance member_p
        LEFT JOIN public.invoices member ON member.id = member_p.invoice_id
       WHERE member_p.invoice_group_id = NEW.invoice_group_id
         AND member_p.order_id = v_order_id
         AND (
           member.id IS NULL
           OR member.order_id IS DISTINCT FROM member_p.order_id
           OR member.invoice_group_id IS DISTINCT FROM member_p.invoice_group_id
           OR member.customer_id IS DISTINCT FROM member_p.customer_id
           OR member.invoice_type IS DISTINCT FROM member_p.invoice_type
           OR member.season IS DISTINCT FROM member_p.season
           OR member.total_amount_cents IS DISTINCT FROM member_p.total_amount_cents
           OR member.deleted_at IS NOT NULL
           OR member.status IN ('voided', 'cancelled')
           OR member_p.content_claim IS DISTINCT FROM public._split_invoice_content_claim(member.id)
         )
    ) THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_GROUP_PROVENANCE_REQUIRED: active split-billing invoices must exactly match the private canonical group claim'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_mono_invoice_split_billing_post()
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_wrapper_source text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.split_invoice_creation_claims)
     OR EXISTS (SELECT 1 FROM public.split_invoice_mutation_claims)
     OR EXISTS (SELECT 1 FROM public.split_invoice_provenance) THEN
    RAISE EXCEPTION 'split provenance cutover expected empty private tables';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS role_name(name)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS privilege_name(name)
     WHERE has_table_privilege(role_name.name, 'public.split_invoice_creation_claims', privilege_name.name)
        OR has_table_privilege(role_name.name, 'public.split_invoice_mutation_claims', privilege_name.name)
        OR has_table_privilege(role_name.name, 'public.split_invoice_provenance', privilege_name.name)
  ) THEN
    RAISE EXCEPTION 'private split provenance tables are accessible to a Data API role';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS role_name(name)
      CROSS JOIN (VALUES ('INSERT'), ('DELETE'), ('TRUNCATE')) AS privilege_name(name)
     WHERE has_table_privilege(role_name.name, 'public.invoices', privilege_name.name)
  ) THEN
    RAISE EXCEPTION 'direct invoice identity creation/deletion remains available to a Data API role';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._split_invoice_content_claim(uuid)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._delete_invoices_split_provenance_impl_20260719(uuid[],uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'private split provenance helpers remain client executable';
  END IF;

  SELECT p.prosrc
    INTO v_wrapper_source
    FROM pg_proc p
   WHERE p.oid = 'public.create_split_invoices_from_order(uuid,uuid,text,text)'::regprocedure;

  IF v_wrapper_source IS NULL
     OR strpos(v_wrapper_source, 'ORDER BY oi.id') = 0
     OR strpos(v_wrapper_source, 'FOR UPDATE') = 0
     OR strpos(v_wrapper_source, 'split_invoice_creation_claims') = 0
     OR strpos(v_wrapper_source, 'split_invoice_provenance') = 0 THEN
    RAISE EXCEPTION 'canonical split creator is missing reviewed serialization/provenance markers';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.invoices'::regclass
       AND t.tgname IN (
         'require_split_invoice_creation_claim',
         'guard_split_invoice_provenance_identity',
         'guard_mono_invoice_split_billing_post'
       )
       AND t.tgenabled = 'O'
       AND NOT t.tgisinternal
     GROUP BY t.tgrelid
    HAVING count(*) = 3
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.invoice_items'::regclass
       AND t.tgname = 'guard_split_invoice_provenance_items'
       AND t.tgenabled = 'O'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'split provenance trigger set is missing or disabled';
  END IF;
END;
$postflight$;
