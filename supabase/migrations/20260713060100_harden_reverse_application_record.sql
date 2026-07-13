-- idempotency-body-check: exempt
-- ============================================================================
-- Harden application-record removal and reverse blend-ticket inventory exactly.
--
-- Bug B: application_records had an admin DELETE policy, but deleting a
-- blend-ticket application record did not restore the quantity deducted by
-- create_application_record_from_blend_ticket(). Deletion also cleared that
-- RPC's source guard, allowing the ticket to be processed again and deducted a
-- second time.
--
-- inventory_transactions has no application_record_id/reference_id column. The
-- current create RPC records the exact converted deduction in quantity and
-- embeds "(application record <uuid>)" in notes. This RPC deliberately uses
-- those immutable ledger quantities rather than recomputing from current units
-- or product metadata. It refuses to delete when the expected deduction-ledger
-- row count is incomplete, because clearing the source guard without a provable
-- full credit would recreate the double-deduction bug.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reverse_application_record(
  p_application_record_id uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor                uuid := auth.uid();
  v_cached               jsonb;
  v_record               record;
  v_original_txn         record;
  v_inventory            record;
  v_expected_deductions  integer := 0;
  v_ledger_deductions    integer := 0;
  v_reversed_count       integer := 0;
  v_result               jsonb;
  v_prior_reversal       boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to reverse application records';
  END IF;

  -- Canonical helper-based replay check. Bind the cached result to this RPC's
  -- sole business argument so reuse of a key for another record fails loudly.
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'reverse_application_record');
    IF v_cached IS NOT NULL THEN
      IF (v_cached->>'application_record_id')::uuid IS DISTINCT FROM p_application_record_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used to reverse a different application record',
          p_idempotency_key;
      END IF;
      RETURN v_cached;
    END IF;
  END IF;

  -- Serializes concurrent reversals of the same record. After the first caller
  -- commits its DELETE, a waiting caller observes no row and returns a no-op.
  SELECT ar.*
    INTO v_record
    FROM public.application_records ar
   WHERE ar.id = p_application_record_id
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.inventory_transactions it
       WHERE it.transaction_type = 'adjusted'
         AND strpos(
               COALESCE(it.notes, ''),
               '(reversed application record ' || p_application_record_id::text || ')'
             ) > 0
    ) INTO v_prior_reversal;

    v_result := jsonb_build_object(
      'success', true,
      'status', CASE WHEN v_prior_reversal THEN 'already_reversed' ELSE 'not_found' END,
      'application_record_id', p_application_record_id,
      'inventory_transactions_reversed', 0,
      'already_reversed', v_prior_reversal
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(
        p_idempotency_key,
        'reverse_application_record',
        v_result
      );
    END IF;
    RETURN v_result;
  END IF;

  -- This reversal is intentionally scoped to the create RPC named in Bug B.
  -- Job-sourced records have a separate job lifecycle and ledger-link shape.
  IF v_record.source_type IS DISTINCT FROM 'blend_ticket' THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_NOT_REVERSIBLE: only blend_ticket application records can be reversed by this RPC';
  END IF;

  -- The create RPC writes one deduction transaction for every positive,
  -- product-linked product_data row. Count both sides before changing stock so
  -- a missing/edited ledger cannot produce a partial credit followed by DELETE.
  SELECT count(*)::integer
    INTO v_expected_deductions
    FROM jsonb_array_elements(COALESCE(v_record.product_data, '[]'::jsonb)) AS item
   WHERE NULLIF(item->>'product_id', '') IS NOT NULL
     AND COALESCE((item->>'quantity')::numeric, 0) > 0;

  SELECT count(*)::integer
    INTO v_ledger_deductions
    FROM public.inventory_transactions it
   WHERE it.transaction_type = 'job_applied'
     AND it.from_location = 'Main Warehouse'
     AND it.quantity > 0
     AND it.notes LIKE 'Blend ticket application:%'
     AND strpos(
           COALESCE(it.notes, ''),
           '(application record ' || p_application_record_id::text || ')'
         ) > 0;

  IF v_ledger_deductions IS DISTINCT FROM v_expected_deductions THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_REVERSAL_LEDGER_MISMATCH: record % expects % deduction row(s), found %; record was not deleted',
      p_application_record_id, v_expected_deductions, v_ledger_deductions;
  END IF;

  -- Lock and credit products in deterministic order. quantity is the exact
  -- converted amount originally deducted; no unit conversion is repeated here.
  FOR v_original_txn IN
    SELECT it.id, it.product_id, it.quantity
      FROM public.inventory_transactions it
     WHERE it.transaction_type = 'job_applied'
       AND it.from_location = 'Main Warehouse'
       AND it.quantity > 0
       AND it.notes LIKE 'Blend ticket application:%'
       AND strpos(
             COALESCE(it.notes, ''),
             '(application record ' || p_application_record_id::text || ')'
           ) > 0
     ORDER BY it.product_id, it.id
     FOR UPDATE
  LOOP
    SELECT inv.*
      INTO v_inventory
      FROM public.inventory inv
     WHERE inv.product_id = v_original_txn.product_id
       AND inv.location = 'Main Warehouse'
     FOR UPDATE;

    IF NOT FOUND THEN
      -- The create RPC creates this row when absent. Recreate only if it was
      -- subsequently removed, preserving the same canonical warehouse shape.
      INSERT INTO public.inventory (
        product_id, location, quantity_available,
        quantity_prebooked, quantity_on_order
      ) VALUES (
        v_original_txn.product_id, 'Main Warehouse', v_original_txn.quantity,
        0, 0
      )
      ON CONFLICT (product_id, location) DO UPDATE
        SET quantity_available = public.inventory.quantity_available + EXCLUDED.quantity_available,
            updated_at = now();
    ELSE
      UPDATE public.inventory
         SET quantity_available = quantity_available + v_original_txn.quantity,
             updated_at = now()
       WHERE id = v_inventory.id;
    END IF;

    -- "adjusted" is an existing allowed inventory transaction type and is the
    -- closest available type for a non-delivery stock correction. Positive
    -- quantity + to_location mirrors the physical credit back to the warehouse.
    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      performed_by, notes, requires_review
    ) VALUES (
      v_original_txn.product_id,
      'adjusted',
      v_original_txn.quantity,
      'Main Warehouse',
      v_actor,
      'Reversed blend ticket application record ' || v_record.record_number ||
        '; original inventory transaction ' || v_original_txn.id::text ||
        ' (reversed application record ' || p_application_record_id::text || ')',
      false
    );

    v_reversed_count := v_reversed_count + 1;
  END LOOP;

  -- Both child tables use ON DELETE CASCADE, but explicit deletes make the
  -- intended removal order clear and remain harmless if either table is empty.
  DELETE FROM public.application_record_lots
   WHERE application_record_id = p_application_record_id;
  DELETE FROM public.application_record_fields
   WHERE application_record_id = p_application_record_id;
  DELETE FROM public.application_records
   WHERE id = p_application_record_id;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'application_record_reversed',
    'Application record ' || v_record.record_number || ' reversed; ' ||
      v_reversed_count || ' inventory deduction(s) restored',
    v_actor,
    'blend_ticket',
    v_record.source_id,
    v_record.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'status', 'reversed',
    'application_record_id', p_application_record_id,
    'blend_ticket_id', v_record.source_id,
    'record_number', v_record.record_number,
    'inventory_transactions_reversed', v_reversed_count,
    'already_reversed', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'reverse_application_record',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_application_record(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_application_record(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reverse_application_record(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_application_record(uuid, text) TO service_role;

COMMENT ON FUNCTION public.reverse_application_record(uuid, text) IS
  'Atomically restores exact blend-ticket application inventory deductions, writes reversal ledger rows, removes the application record, and enforces argument-bound idempotency.';

-- Raw RLS DELETE bypassed the inventory reversal. All application-record
-- removal must now enter through the SECURITY DEFINER RPC above.
DROP POLICY IF EXISTS app_records_delete ON public.application_records;

-- Fail the migration if an unexpected overload exists or the security/policy
-- hardening did not land exactly as intended.
DO $$
DECLARE
  v_count integer;
  v_secdef boolean;
  v_config text[];
BEGIN
  SELECT count(*)::integer
    INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'reverse_application_record';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'reverse_application_record verification: expected 1 overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig
    INTO v_secdef, v_config
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'reverse_application_record';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'reverse_application_record verification: SECURITY DEFINER missing';
  END IF;
  IF v_config IS NULL
     OR NOT (v_config @> ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'reverse_application_record verification: safe search_path missing (got %)', v_config;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'application_records'
       AND policyname = 'app_records_delete'
  ) THEN
    RAISE EXCEPTION 'reverse_application_record verification: app_records_delete still exists';
  END IF;
END;
$$;
