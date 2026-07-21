-- Forward-only repair for the private split-invoice provenance cutover.
--
-- Ledger version 20260719044912 correctly made governed split identity/content immutable, but
-- its mutation claims covered only save_invoice/delete_invoices. Two canonical
-- owner RPCs also change the protected total during terminal lifecycle work:
--   * void_invoice zeroes a posted/paid/overdue invoice while voiding it;
--   * cancel_order zeroes draft/unposted invoices while cancelling the order.
-- Wrap those exact live implementations behind private names, issue owner-only
-- transaction claims, and permit only their exact terminal transitions.

LOCK TABLE
  public.orders,
  public.order_items,
  public.order_item_field_allocations,
  public.invoices,
  public.invoice_items,
  public.idempotency_keys,
  public.split_invoice_creation_claims,
  public.split_invoice_mutation_claims,
  public.split_invoice_provenance
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_void_source    text;
  v_cancel_source  text;
  v_split_source   text;
  v_delete_source  text;
  v_guard_source   text;
BEGIN
  SELECT p.prosrc INTO v_void_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.void_invoice(uuid,text,text)');
  SELECT p.prosrc INTO v_cancel_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.cancel_order(uuid,uuid,text)');
  SELECT p.prosrc INTO v_split_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public.create_split_invoices_from_order(uuid,uuid,text,text)'
   );
  SELECT p.prosrc INTO v_delete_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.delete_invoices(uuid[],uuid,text)');
  SELECT p.prosrc INTO v_guard_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.guard_split_invoice_provenance_identity()');

  IF md5(COALESCE(v_void_source, '')) <> '79fcec96021b44ab0e08b14e9ae2b865' THEN
    RAISE EXCEPTION 'void_invoice live definition drifted before terminal-lifecycle cutover';
  END IF;
  IF md5(COALESCE(v_cancel_source, '')) <> '84f6f675216389d8c927b562f107ca10' THEN
    RAISE EXCEPTION 'cancel_order live definition drifted before terminal-lifecycle cutover';
  END IF;
  IF md5(COALESCE(v_split_source, '')) <> '9d01c243cbaac6b851733ebb5bda29e0' THEN
    RAISE EXCEPTION 'create_split_invoices_from_order live definition drifted before request binding';
  END IF;
  IF md5(COALESCE(v_delete_source, '')) <> 'b45812a529b42616e5eaaa8ec569b618' THEN
    RAISE EXCEPTION 'delete_invoices live definition drifted before request binding';
  END IF;
  IF md5(COALESCE(v_guard_source, '')) <> '9a61065412b661a94403e46f13245813' THEN
    RAISE EXCEPTION 'split provenance identity guard drifted before terminal-lifecycle cutover';
  END IF;
  IF to_regprocedure('public._void_invoice_split_provenance_impl_20260719(uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public._cancel_order_split_provenance_impl_20260719(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'terminal-lifecycle private implementation name already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.split_invoice_creation_claims)
     OR EXISTS (SELECT 1 FROM public.split_invoice_mutation_claims) THEN
    RAISE EXCEPTION 'transient split provenance claim survived outside its owner transaction';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.idempotency_keys k
     WHERE k.operation IN (
       'create_split_invoices_from_order',
       'delete_invoices',
       'void_invoice',
       'cancel_order'
     )
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECONCILIATION_REQUIRED: an unbound pre-cutover lifecycle key exists';
  END IF;
END;
$preflight$;

ALTER TABLE public.split_invoice_mutation_claims
  DROP CONSTRAINT split_invoice_mutation_claims_operation_check,
  ADD CONSTRAINT split_invoice_mutation_claims_operation_check
    CHECK (operation IN ('save_invoice', 'delete_invoices', 'void_invoice', 'cancel_order'));

-- All four affected public RPCs now own a bound placeholder before any business
-- mutation. The operation-specific and global locks remain held for the whole
-- transaction; private reviewed implementations receive a NULL key so they
-- cannot write an unbound or cross-operation legacy result row.
CREATE FUNCTION public._claim_bound_lifecycle_idempotency(
  p_key text,
  p_operation text,
  p_contract text,
  p_request_fingerprint text,
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_operation text;
  v_existing jsonb;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_operation || ':' || p_key, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key
     AND expires_at < now();

  SELECT k.operation, k.result
    INTO v_existing_operation, v_existing
    FROM public.idempotency_keys k
   WHERE k.idempotency_key = p_key;

  IF NOT FOUND THEN
    INSERT INTO public.idempotency_keys (
      idempotency_key, operation, result, expires_at
    ) VALUES (
      p_key,
      p_operation,
      jsonb_build_object(
        '_contract', p_contract,
        'request_fingerprint', p_request_fingerprint,
        'request', p_request,
        'response', NULL
      ),
      now() + interval '24 hours'
    );
    RETURN NULL;
  END IF;
  IF v_existing_operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing_operation, p_operation;
  END IF;
  IF v_existing->>'_contract' IS DISTINCT FROM p_contract
     OR NOT (v_existing ? 'request_fingerprint') THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_UNBOUND_REPLAY: key % has no % request binding; use a new key',
      p_key, p_contract;
  END IF;
  IF v_existing->>'request_fingerprint' IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_REQUEST_MISMATCH: key % was already used with different % arguments',
      p_key, p_operation;
  END IF;
  IF NOT (v_existing ? 'response') OR v_existing->'response' = 'null'::jsonb THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_INCOMPLETE_REPLAY: key % has no completed % response',
      p_key, p_operation;
  END IF;

  RETURN v_existing->'response';
END;
$function$;

REVOKE ALL ON FUNCTION public._claim_bound_lifecycle_idempotency(
  text, text, text, text, jsonb
)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._bind_completed_lifecycle_idempotency(
  p_key text,
  p_operation text,
  p_contract text,
  p_request_fingerprint text,
  p_request jsonb,
  p_response jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_key IS NULL THEN
    RETURN;
  END IF;
  IF p_response IS NULL OR p_response = 'null'::jsonb THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESPONSE_REQUIRED: % key %', p_operation, p_key;
  END IF;

  UPDATE public.idempotency_keys k
     SET result = jsonb_build_object(
           '_contract', p_contract,
           'request_fingerprint', p_request_fingerprint,
           'request', p_request,
           'response', p_response
         ),
         expires_at = now() + interval '24 hours'
   WHERE k.idempotency_key = p_key
     AND k.operation = p_operation
     AND k.result->>'_contract' IS NOT DISTINCT FROM p_contract
     AND k.result->>'request_fingerprint' IS NOT DISTINCT FROM p_request_fingerprint
     AND k.result->'response' = 'null'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CLAIM_LOST: % key % disappeared before request binding',
      p_operation, p_key;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._bind_completed_lifecycle_idempotency(
  text, text, text, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_split_invoice_provenance_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_save_claim    boolean := false;
  v_delete_claim  boolean := false;
  v_void_claim    boolean := false;
  v_cancel_claim  boolean := false;
  v_exact_void    boolean := false;
  v_exact_cancel  boolean := false;
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
      ),
      EXISTS (
        SELECT 1
          FROM public.split_invoice_mutation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.invoice_id = OLD.id
           AND claim.operation = 'void_invoice'
      ),
      EXISTS (
        SELECT 1
          FROM public.split_invoice_mutation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.invoice_id = OLD.id
           AND claim.operation = 'cancel_order'
      )
      INTO v_save_claim, v_delete_claim, v_void_claim, v_cancel_claim;

    v_exact_void :=
      v_void_claim
      AND OLD.status IN ('posted', 'paid', 'overdue')
      AND NEW.status = 'voided'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.voided_by IS NOT NULL
      AND NEW.voided_at IS NOT NULL
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.salesman_id IS NOT DISTINCT FROM OLD.salesman_id
      AND NEW.invoice_date IS NOT DISTINCT FROM OLD.invoice_date
      AND NEW.header_notes IS NOT DISTINCT FROM OLD.header_notes
      AND NEW.pricing_pending IS NOT DISTINCT FROM OLD.pricing_pending;

    v_exact_cancel :=
      v_cancel_claim
      AND OLD.status IN ('draft', 'unposted')
      AND NEW.status = 'cancelled'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.salesman_id IS NOT DISTINCT FROM OLD.salesman_id
      AND NEW.invoice_date IS NOT DISTINCT FROM OLD.invoice_date
      AND NEW.header_notes IS NOT DISTINCT FROM OLD.header_notes
      AND NEW.pricing_pending IS NOT DISTINCT FROM OLD.pricing_pending;

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
       ) AND NOT v_save_claim
         AND NOT v_exact_void
         AND NOT v_exact_cancel THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_PROVENANCE_IMMUTABLE: governed split invoice content can be changed only by save_invoice or an exact terminal lifecycle RPC'
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

CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(
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
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'create_split_invoices_from_order_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_invoice_ids uuid[] := '{}'::uuid[];
  v_claim_nonce uuid := gen_random_uuid();
  v_has_split_evidence boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id,
    'salesman_id', p_salesman_id,
    'invoice_type', p_invoice_type
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request
    );
  END IF;

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

  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = p_order_id
  ) INTO v_has_split_evidence;

  IF v_replay IS NOT NULL THEN
    SELECT COALESCE(
             array_agg(replayed.invoice_id ORDER BY replayed.ordinality),
             '{}'::uuid[]
           )
      INTO v_invoice_ids
      FROM (
        SELECT value::uuid AS invoice_id, ordinality
          FROM jsonb_array_elements_text(v_replay) WITH ORDINALITY
      ) replayed;
  ELSE
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
      NULL::text
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
      v_actor
    FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
    JOIN public.invoices i ON i.id = returned.invoice_id
    WHERE i.order_id = p_order_id
      AND i.invoice_group_id IS NOT NULL
      AND v_has_split_evidence
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
        WHERE returned.invoice_id IS NULL
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(DISTINCT returned.invoice_id)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
        WHERE i.order_id = p_order_id
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH: every returned invoice must belong exactly to the requested order';
  END IF;

  IF v_has_split_evidence
     AND cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
         JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
        WHERE i.order_id = p_order_id
          AND i.invoice_group_id IS NOT NULL
          AND p.order_id = i.order_id
          AND p.invoice_group_id = i.invoice_group_id
          AND p.customer_id = i.customer_id
          AND p.invoice_type = i.invoice_type
          AND p.season = i.season
          AND p.total_amount_cents = i.total_amount_cents
          AND p.content_claim = public._split_invoice_content_claim(i.id)
          AND p.contract_version = 'split_invoice_provenance_v1'
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_PROVENANCE_REPLAY_MISMATCH: returned split invoice content does not match its exact private claim';
  END IF;

  IF v_replay IS NULL THEN
    DELETE FROM public.split_invoice_creation_claims
     WHERE transaction_id = pg_current_xact_id()
       AND order_id = p_order_id
       AND claim_nonce = v_claim_nonce;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_CREATION_CLAIM_LOST';
    END IF;

    PERFORM public._bind_completed_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request,
      to_jsonb(v_invoice_ids)
    );
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_invoices(
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
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'delete_invoices_v1';
  v_request_ids uuid[] := '{}'::uuid[];
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_deleted_count integer;
  v_governed_ids uuid[] := '{}'::uuid[];
  v_claim_count integer := 0;
BEGIN
  PERFORM public.require_admin();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT requested.invoice_id ORDER BY requested.invoice_id), '{}'::uuid[])
    INTO v_request_ids
    FROM unnest(COALESCE(p_invoice_ids, '{}'::uuid[])) AS requested(invoice_id)
   WHERE requested.invoice_id IS NOT NULL;
  IF cardinality(v_request_ids) = 0 THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'invoice_ids', to_jsonb(v_request_ids)
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'delete_invoices',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_replay IS NOT NULL THEN
      RETURN (v_replay #>> '{}')::integer;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(p.invoice_id ORDER BY p.invoice_id), '{}'::uuid[])
    INTO v_governed_ids
    FROM public.split_invoice_provenance p
   WHERE p.invoice_id = ANY(v_request_ids);

  INSERT INTO public.split_invoice_mutation_claims (
    transaction_id, invoice_id, operation
  )
  SELECT pg_current_xact_id(), governed.invoice_id, 'delete_invoices'
    FROM unnest(v_governed_ids) AS governed(invoice_id);

  v_deleted_count := public._delete_invoices_split_provenance_impl_20260719(
    v_request_ids,
    p_performed_by,
    NULL::text
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
  GET DIAGNOSTICS v_claim_count = ROW_COUNT;
  IF v_claim_count IS DISTINCT FROM cardinality(v_governed_ids) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_DELETE_CLAIM_LOST';
  END IF;

  IF cardinality(v_governed_ids) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.split_invoice_provenance p
        WHERE p.invoice_id = ANY(v_governed_ids)
     ) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_PROVENANCE_IDENTITY_LOST';
  END IF;

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'delete_invoices',
    v_contract,
    v_fingerprint,
    v_request,
    to_jsonb(v_deleted_count)
  );

  RETURN v_deleted_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_invoices(uuid[], uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_invoices(uuid[], uuid, text)
  TO authenticated, service_role;

-- Preserve the exact live void implementation behind an owner-only name. The
-- wrapper locks the invoice, issues the narrowly scoped claim only when the
-- invoice has private split provenance, and refreshes the terminal claim after
-- the original function completes or replays its idempotency result.
ALTER FUNCTION public.void_invoice(uuid, text, text)
  RENAME TO _void_invoice_split_provenance_impl_20260719;

REVOKE ALL ON FUNCTION
  public._void_invoice_split_provenance_impl_20260719(uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'void_invoice_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_governed boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = v_actor
       AND p.is_active = true
       AND p.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin users can void invoices';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'invoice_id', p_invoice_id,
    'void_reason', p_void_reason
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'void_invoice',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_replay IS NOT NULL THEN
      RETURN;
    END IF;
  END IF;

  PERFORM 1
    FROM public.invoices i
   WHERE i.id = p_invoice_id
   FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
      FROM public.split_invoice_provenance p
     WHERE p.invoice_id = p_invoice_id
  ) INTO v_governed;

  IF v_governed THEN
    INSERT INTO public.split_invoice_mutation_claims (
      transaction_id, invoice_id, operation
    ) VALUES (
      pg_current_xact_id(), p_invoice_id, 'void_invoice'
    );
  END IF;

  PERFORM public._void_invoice_split_provenance_impl_20260719(
    p_invoice_id,
    p_void_reason,
    NULL::text
  );

  IF v_governed THEN
    UPDATE public.split_invoice_provenance p
       SET total_amount_cents = i.total_amount_cents,
           content_claim = public._split_invoice_content_claim(i.id)
      FROM public.invoices i
     WHERE p.invoice_id = p_invoice_id
       AND i.id = p.invoice_id
       AND p.order_id = i.order_id
       AND p.invoice_group_id = i.invoice_group_id
       AND p.customer_id = i.customer_id
       AND p.invoice_type = i.invoice_type
       AND p.season = i.season
       AND i.status IN ('voided', 'cancelled');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_TERMINAL_PROVENANCE_REFRESH_FAILED';
    END IF;

    DELETE FROM public.split_invoice_mutation_claims
     WHERE transaction_id = pg_current_xact_id()
       AND invoice_id = p_invoice_id
       AND operation = 'void_invoice';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_VOID_CLAIM_LOST';
    END IF;
  END IF;

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'void_invoice',
    v_contract,
    v_fingerprint,
    v_request,
    'true'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.void_invoice(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_invoice(uuid, text, text)
  TO authenticated, service_role;

-- cancel_order owns the order lock before scanning and locking governed split
-- members in deterministic invoice-id order. Its exact reviewed implementation
-- then runs under per-member claims, and the wrapper refreshes only members the
-- original RPC actually retired. Posted members remain untouched and exact.
ALTER FUNCTION public.cancel_order(uuid, uuid, text)
  RENAME TO _cancel_order_split_provenance_impl_20260719;

REVOKE ALL ON FUNCTION
  public._cancel_order_split_provenance_impl_20260719(uuid, uuid, text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_order(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'cancel_order_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_governed_ids uuid[] := '{}'::uuid[];
  v_result jsonb;
  v_claim_count integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = v_actor
       AND p.is_active = true
       AND p.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'cancel_order',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_replay IS NOT NULL THEN
      RETURN v_replay;
    END IF;
  END IF;

  PERFORM 1
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  SELECT COALESCE(array_agg(locked.invoice_id ORDER BY locked.invoice_id), '{}'::uuid[])
    INTO v_governed_ids
    FROM (
      SELECT i.id AS invoice_id
        FROM public.invoices i
        JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
       WHERE i.order_id = p_order_id
       ORDER BY i.id
       FOR UPDATE OF i
    ) locked;

  INSERT INTO public.split_invoice_mutation_claims (
    transaction_id, invoice_id, operation
  )
  SELECT pg_current_xact_id(), governed.invoice_id, 'cancel_order'
    FROM unnest(v_governed_ids) AS governed(invoice_id);

  v_result := public._cancel_order_split_provenance_impl_20260719(
    p_order_id,
    p_performed_by,
    NULL::text
  );

  UPDATE public.split_invoice_provenance p
     SET total_amount_cents = i.total_amount_cents,
         content_claim = public._split_invoice_content_claim(i.id)
    FROM public.invoices i
   WHERE p.invoice_id = i.id
     AND p.invoice_id = ANY(v_governed_ids)
     AND p.order_id = i.order_id
     AND p.invoice_group_id = i.invoice_group_id
     AND p.customer_id = i.customer_id
     AND p.invoice_type = i.invoice_type
     AND p.season = i.season
     AND i.status IN ('voided', 'cancelled');

  IF EXISTS (
    SELECT 1
      FROM public.invoices i
      JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
     WHERE i.id = ANY(v_governed_ids)
       AND i.status IN ('voided', 'cancelled')
       AND (
         p.total_amount_cents IS DISTINCT FROM i.total_amount_cents
         OR p.content_claim IS DISTINCT FROM public._split_invoice_content_claim(i.id)
       )
  ) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_CANCEL_PROVENANCE_REFRESH_FAILED';
  END IF;

  DELETE FROM public.split_invoice_mutation_claims claim
   WHERE claim.transaction_id = pg_current_xact_id()
     AND claim.operation = 'cancel_order'
     AND claim.invoice_id = ANY(v_governed_ids);
  GET DIAGNOSTICS v_claim_count = ROW_COUNT;
  IF v_claim_count IS DISTINCT FROM cardinality(v_governed_ids) THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_CANCEL_CLAIM_LOST';
  END IF;

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'cancel_order',
    v_contract,
    v_fingerprint,
    v_request,
    v_result
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_order(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text)
  TO authenticated, service_role;

DO $postflight$
DECLARE
  v_constraint text;
  v_void_wrapper text;
  v_cancel_wrapper text;
  v_split_wrapper text;
  v_delete_wrapper text;
  v_claim_helper text;
  v_guard_source text;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_constraint
    FROM pg_constraint c
   WHERE c.conrelid = 'public.split_invoice_mutation_claims'::regclass
     AND c.conname = 'split_invoice_mutation_claims_operation_check';

  SELECT p.prosrc INTO v_void_wrapper
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.void_invoice(uuid,text,text)');
  SELECT p.prosrc INTO v_cancel_wrapper
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.cancel_order(uuid,uuid,text)');
  SELECT p.prosrc INTO v_split_wrapper
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public.create_split_invoices_from_order(uuid,uuid,text,text)'
   );
  SELECT p.prosrc INTO v_delete_wrapper
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.delete_invoices(uuid[],uuid,text)');
  SELECT p.prosrc INTO v_claim_helper
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)'
   );
  SELECT p.prosrc INTO v_guard_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.guard_split_invoice_provenance_identity()');

  IF v_constraint NOT LIKE '%void_invoice%'
     OR v_constraint NOT LIKE '%cancel_order%' THEN
    RAISE EXCEPTION 'terminal lifecycle operations missing from mutation-claim constraint';
  END IF;
  IF v_void_wrapper NOT LIKE '%_void_invoice_split_provenance_impl_20260719%'
     OR v_void_wrapper NOT LIKE '%operation = ''void_invoice''%'
     OR v_cancel_wrapper NOT LIKE '%_cancel_order_split_provenance_impl_20260719%'
     OR v_cancel_wrapper NOT LIKE '%operation = ''cancel_order''%'
     OR v_cancel_wrapper NOT LIKE '%ORDER BY i.id%'
     OR v_split_wrapper NOT LIKE '%create_split_invoices_from_order_v1%'
     OR v_split_wrapper NOT LIKE '%SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH%'
     OR v_split_wrapper NOT LIKE '%p.content_claim = public._split_invoice_content_claim(i.id)%'
     OR v_delete_wrapper NOT LIKE '%delete_invoices_v1%'
     OR v_delete_wrapper NOT LIKE '%v_request_ids%'
     OR v_claim_helper NOT LIKE '%IDEMPOTENCY_REQUEST_MISMATCH%'
     OR v_claim_helper NOT LIKE '%crx:idempotency:%'
     OR v_claim_helper NOT LIKE '%''response'', NULL%'
     OR v_guard_source NOT LIKE '%v_exact_void%'
     OR v_guard_source NOT LIKE '%v_exact_cancel%' THEN
    RAISE EXCEPTION 'terminal lifecycle wrapper/guard markers missing after cutover';
  END IF;

  IF EXISTS (SELECT 1 FROM public.split_invoice_creation_claims)
     OR EXISTS (SELECT 1 FROM public.split_invoice_mutation_claims) THEN
    RAISE EXCEPTION 'transient split provenance claim survived terminal-lifecycle cutover';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.idempotency_keys k
     WHERE k.operation IN (
       'create_split_invoices_from_order',
       'delete_invoices',
       'void_invoice',
       'cancel_order'
     )
       AND (
         NOT (k.result ? '_contract')
         OR NOT (k.result ? 'request_fingerprint')
         OR NOT (k.result ? 'response')
       )
  ) THEN
    RAISE EXCEPTION 'unbound lifecycle idempotency row survived request-binding cutover';
  END IF;

  IF has_function_privilege(
       'anon',
       'public._void_invoice_split_provenance_impl_20260719(uuid,text,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._void_invoice_split_provenance_impl_20260719(uuid,text,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public._void_invoice_split_provenance_impl_20260719(uuid,text,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public._cancel_order_split_provenance_impl_20260719(uuid,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._cancel_order_split_provenance_impl_20260719(uuid,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public._cancel_order_split_provenance_impl_20260719(uuid,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public._bind_completed_lifecycle_idempotency(text,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'terminal lifecycle private implementation is executable by a Data API role';
  END IF;

  IF has_function_privilege('anon', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_order(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cancel_order(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cancel_order(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_split_invoices_from_order(uuid,uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_split_invoices_from_order(uuid,uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.create_split_invoices_from_order(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.delete_invoices(uuid[],uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.delete_invoices(uuid[],uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.delete_invoices(uuid[],uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_split_invoice_provenance_identity()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_split_invoice_provenance_identity()', 'EXECUTE') THEN
    RAISE EXCEPTION 'terminal lifecycle function grants drifted after cutover';
  END IF;
END;
$postflight$;
