-- Layer 2 · Part A polish · Cycle A3.9 — release_inventory_hold rejects 'job' holds
-- (§4A.6 / Codex A+B round-4 P1)
-- ============================================================================
-- The Inventory page lists every active hold with an admin "Release" action that
-- calls release_inventory_hold (SECURITY DEFINER). A1's RLS write-guards keep
-- CLIENTS from touching 'job' holds, but a SECDEF RPC bypasses RLS — so an admin
-- could deactivate a job reservation through this generic path WITHOUT deleting the
-- matching job_product_draws row or resyncing the parent quote's crop_program hold.
-- That leaves the job "drawn but not reserved": the booking still shows the units
-- consumed, but the stock is no longer protected.
--
-- FIX: reject hold_type='job' here. Job reservations are released ONLY via the job
-- lifecycle (cancel / complete / delete → the A4 `jobs` trigger releases the hold,
-- reverses the draw when appropriate, and resyncs the quote). Reproduced verbatim
-- from the live definition; the ONLY change is the LAYER2 guard block.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_inventory_hold(p_hold_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_hold record;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'release_inventory_hold');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_hold FROM inventory_holds WHERE id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory hold not found';
  END IF;

  -- LAYER2<<< a job reservation is lifecycle-managed, never manually released here —
  -- releasing it via this generic path would orphan its job_product_draws row and
  -- leave the parent quote's crop_program hold un-resynced (§4A.6 / Codex round-4 P1).
  IF v_hold.hold_type = 'job' THEN
    RAISE EXCEPTION 'JOB_HOLD_NOT_MANUALLY_RELEASABLE: this is a job reservation — it releases automatically when the job is cancelled, completed, or deleted, not by manual release';
  END IF;
  -- >>>LAYER2

  IF NOT v_hold.is_active THEN
    RETURN jsonb_build_object('status', 'already_released');
  END IF;

  UPDATE inventory_holds SET is_active = false WHERE id = p_hold_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'inventory_hold_released',
    'Inventory hold released for product ' || v_hold.product_id::text,
    v_actor, 'inventory_hold', p_hold_id
  );

  v_result := jsonb_build_object('status', 'released', 'hold_id', p_hold_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'release_inventory_hold', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
