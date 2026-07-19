-- Codex gauntlet closeout: preserve quote-first serialization while preventing
-- revert_quote_status from deadlocking with cancel_order's order->quote path.
--
-- Body reproduced from the live 20260719023344 definition. The sole behavioral
-- change is the marked NOWAIT order-lock block: if cancel_order already owns an
-- order row while waiting for this quote, revert fails with a retryable 40001,
-- releases its quote lock, and lets cancellation finish. No AB/BA wait remains.

CREATE OR REPLACE FUNCTION public.revert_quote_status(p_quote_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor              uuid;
  v_quote              record;
  v_existing           jsonb;
  v_existing_operation text;
  v_result             jsonb;
  v_reason             text;
  v_request            jsonb;
  v_fingerprint        text;
  v_contract CONSTANT text := 'revert_quote_status_v1';
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to revert quote status';
  END IF;
  v_reason := btrim(p_reason);

  IF p_idempotency_key IS NOT NULL THEN
    IF btrim(p_idempotency_key) = '' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
    END IF;

    v_request := jsonb_build_object(
      'contract_version', v_contract,
      'quote_id', p_quote_id,
      'actor_id', v_actor,
      'reason', v_reason
    );
    v_fingerprint := md5(v_request::text);

    PERFORM pg_advisory_xact_lock(
      hashtextextended('crx:idempotency:revert_quote_status:' || p_idempotency_key, 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
    );

    DELETE FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND expires_at < now();

    SELECT operation, result
      INTO v_existing_operation, v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      IF v_existing_operation IS DISTINCT FROM 'revert_quote_status' THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation revert_quote_status',
          p_idempotency_key, v_existing_operation;
      END IF;
      IF v_existing->>'_contract' IS DISTINCT FROM v_contract
         OR NOT (v_existing ? 'request_fingerprint') THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_UNBOUND_REPLAY: key % has no revert_quote_status_v1 request binding; use a new key',
          p_idempotency_key;
      END IF;
      IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_REQUEST_MISMATCH: key % was already used with different revert_quote_status arguments',
          p_idempotency_key;
      END IF;
      IF NOT (v_existing ? 'response') OR v_existing->'response' = 'null'::jsonb THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_INCOMPLETE_REPLAY: key % has no completed revert_quote_status response',
          p_idempotency_key;
      END IF;
      RETURN v_existing->'response';
    END IF;

    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (
      p_idempotency_key,
      'revert_quote_status',
      jsonb_build_object(
        '_contract', v_contract,
        'request_fingerprint', v_fingerprint,
        'request', v_request,
        'response', NULL
      ),
      now() + interval '24 hours'
    );
  END IF;

  SELECT * INTO v_quote
    FROM quotes
   WHERE id = p_quote_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'accepted') THEN
    RAISE EXCEPTION 'Cannot revert quote in status "%" — only declined, expired, cancelled, or accepted quotes can be reverted', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    -- DEADLOCK FIX: keep the quote-first contract shared with conversion, but
    -- never wait on an order that cancel_order may hold while it waits here.
    -- A serialization_failure is safe to retry; the whole idempotency claim and
    -- every earlier action roll back with this transaction.
    BEGIN
      PERFORM 1
        FROM orders
       WHERE quote_id = p_quote_id
       ORDER BY id
       FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION
        'QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY: an order from quote % is changing; retry after the cancellation finishes',
        v_quote.quote_number
        USING ERRCODE = '40001';
    END;

    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'Cannot revert accepted quote % — an active (non-cancelled) order exists from it', v_quote.quote_number;
    END IF;

    IF EXISTS (
         SELECT 1
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND COALESCE(oi.quantity_delivered, 0) > 0
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN deliveries d ON d.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND d.status = 'completed'
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN invoices i ON i.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND i.deleted_at IS NULL
            AND i.status NOT IN ('voided', 'cancelled')
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN commissions c ON c.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND c.status = 'paid'
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN commissions c ON c.order_id = o.id
           JOIN commission_payment_items cpi ON cpi.commission_id = c.id
           JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
          WHERE o.quote_id = p_quote_id
            AND cp.status <> 'voided'
       ) THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_HAS_ORDER_HISTORY: quote % has delivered, invoiced, or paid/batched commission history; create a new quote/order instead of re-converting it', v_quote.quote_number;
    END IF;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  IF v_quote.status = 'accepted' THEN
    UPDATE quote_product_draws
       SET quantity_drawn = 0, updated_at = now()
     WHERE quote_id = p_quote_id AND quantity_drawn <> 0;
  END IF;

  IF v_quote.is_planned THEN
    PERFORM create_planned_holds(p_quote_id, v_actor, NULL);
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'quote_status_reverted', 'quote', p_quote_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_quote.status),
    jsonb_build_object('status', 'sent'),
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || v_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_status_reverted',
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || v_reason,
    v_actor, 'quote', p_quote_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'quote_id',      p_quote_id,
    'quote_number',  v_quote.quote_number,
    'old_status',    v_quote.status,
    'new_status',    'sent'
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE idempotency_keys
       SET result = jsonb_build_object(
             '_contract', v_contract,
             'request_fingerprint', v_fingerprint,
             'request', v_request,
             'response', v_result
           ),
           expires_at = now() + interval '24 hours'
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'revert_quote_status';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CLAIM_LOST: revert_quote_status key % disappeared', p_idempotency_key;
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.revert_quote_status(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_quote_status(uuid, text, uuid, text)
  TO authenticated, service_role;

DO $postflight$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.revert_quote_status(uuid,text,uuid,text)'::regprocedure;

  IF v_source IS NULL
     OR strpos(v_source, 'FOR UPDATE NOWAIT') = 0
     OR strpos(v_source, 'QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY') = 0
     OR strpos(v_source, 'request_fingerprint') = 0
     OR strpos(v_source, 'QUOTE_REOPEN_HAS_ORDER_HISTORY') = 0 THEN
    RAISE EXCEPTION 'revert_quote_status deadlock/idempotency/history contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = 'public.revert_quote_status(uuid,text,uuid,text)'::regprocedure
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'revert_quote_status security contract drifted';
  END IF;
END;
$postflight$;
