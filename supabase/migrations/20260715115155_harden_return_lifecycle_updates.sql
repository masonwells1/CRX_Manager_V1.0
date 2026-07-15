-- 20260715115155_harden_return_lifecycle_updates.sql
-- Live Foundation Gauntlet Section 8 follow-up.
--
-- July 14 source-of-truth hardening made return source fields immutable and
-- made return lines RPC-owned, but authenticated users with the returns_update
-- table policy could still update lifecycle/audit columns directly without
-- changing status. That could forge approval/receive/cancel/credit attribution
-- or retarget a credit_invoice_id while bypassing the RPC side effects.
--
-- Fix:
--   1. Block direct UPDATEs to return lifecycle/audit columns unless the write
--      is running inside a vetted return RPC (app.return_rpc) or the existing
--      scoped admin_override used by cancel/unapply flows. Direct soft-delete
--      and hard-delete remain allowed only for requested/rejected/cancelled
--      returns, matching the UI and preserving active returns for terminal-order
--      guards.
--   2. Tighten approve_return and cancel_return so nullable actor arguments no
--      longer write NULL attribution through direct RPC calls. The UI already
--      supplies the actor id; service callers can pass auth.uid() explicitly.

CREATE OR REPLACE FUNCTION public.enforce_return_lifecycle_rpc_owned()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('requested', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_DELETE_STATUS_LOCKED: only requested, rejected, or cancelled returns may be deleted';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     AND OLD.status NOT IN ('requested', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'RETURN_DELETE_STATUS_LOCKED: only requested, rejected, or cancelled returns may be soft-deleted';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.received_by IS DISTINCT FROM OLD.received_by
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
     OR NEW.credit_invoice_id IS DISTINCT FROM OLD.credit_invoice_id
     OR NEW.total_credit_cents IS DISTINCT FROM OLD.total_credit_cents
     OR NEW.credited_by IS DISTINCT FROM OLD.credited_by
     OR NEW.credited_at IS DISTINCT FROM OLD.credited_at THEN
    IF public._is_admin_override()
       OR current_setting('app.return_rpc', true) = 'true' THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'RETURN_LIFECYCLE_VIA_RPC_ONLY: return lifecycle and credit fields must be changed through return RPCs';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_return_lifecycle_rpc_owned()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_return_lifecycle_rpc_owned ON public.returns;
CREATE TRIGGER trg_return_lifecycle_rpc_owned
  BEFORE UPDATE OR DELETE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_return_lifecycle_rpc_owned();

CREATE OR REPLACE FUNCTION public.approve_return(
  p_return_id uuid,
  p_approved_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
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
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'cancel_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to cancel a return';
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM public.returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found: %', p_return_id;
  END IF;

  IF v_return.status NOT IN ('requested', 'approved', 'received') THEN
    RAISE EXCEPTION 'Cannot cancel return in status "%" - only requested/approved/received returns can be cancelled', v_return.status;
  END IF;

  v_was_received := (v_return.status = 'received');

  IF v_was_received THEN
    FOR v_item IN
      SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
             inv.id AS inv_id, inv.location AS inv_location
      FROM public.return_items ri
      LEFT JOIN LATERAL (
        SELECT id, location FROM public.inventory
        WHERE product_id = ri.product_id AND location = 'Main Warehouse'
        LIMIT 1
      ) inv ON true
      WHERE ri.return_id = p_return_id AND ri.restocked = true
      ORDER BY ri.sort_order
    LOOP
      IF v_item.inv_id IS NOT NULL THEN
        UPDATE public.inventory
           SET quantity_available = quantity_available - v_item.quantity,
               updated_at = now()
         WHERE id = v_item.inv_id;

        INSERT INTO public.inventory_transactions (
          product_id, transaction_type, quantity, to_location, performed_by, notes
        )
        VALUES (
          v_item.product_id,
          'returned',
          -v_item.quantity,
          v_item.inv_location,
          v_actor,
          'Cancel of return ' || v_return.return_number || ': ' || v_item.product_name ||
          ' (' || v_item.condition || ') - restock reversed: ' || p_reason
        );

        v_reversed_ids := array_append(v_reversed_ids, v_item.item_id);
        v_reversed_qty := v_reversed_qty + v_item.quantity;
        v_reversed_count := v_reversed_count + 1;
      ELSE
        RAISE WARNING 'Cancel of return %: item % (product %) was restocked but inventory row no longer exists - skipping reversal, restocked flag will still be cleared.',
          v_return.return_number, v_item.item_id, v_item.product_id;
        v_skipped_ids := array_append(v_skipped_ids, v_item.item_id);
        v_skipped_count := v_skipped_count + 1;
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE public.returns
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = v_actor,
         cancellation_reason = p_reason,
         updated_at = now()
   WHERE id = p_return_id;

  PERFORM set_config('app.admin_override', 'false', true);

  IF array_length(v_reversed_ids, 1) > 0 OR array_length(v_skipped_ids, 1) > 0 THEN
    UPDATE public.return_items
       SET restocked = false
     WHERE id = ANY(v_reversed_ids || v_skipped_ids);
  END IF;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  )
  VALUES (
    'return_cancelled',
    'Return ' || v_return.return_number || ' cancelled' ||
    CASE WHEN v_was_received
         THEN ' - ' || v_reversed_count || ' item(s) un-restocked' ||
              CASE WHEN v_skipped_count > 0
                   THEN ' (' || v_skipped_count || ' skipped: inventory row missing - admin must reconcile)'
                   ELSE '' END
         ELSE '' END ||
    ': ' || p_reason,
    v_actor,
    'return',
    p_return_id,
    v_return.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return.return_number,
    'status', 'cancelled',
    'was_received', v_was_received,
    'reversed_count', v_reversed_count,
    'reversed_quantity', v_reversed_qty,
    'skipped_count', v_skipped_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'cancel_return', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_return(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_return(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_return(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_return(uuid, text, uuid, text) TO authenticated, service_role;

DO $$
DECLARE
  v_guard_src text;
  v_approve_src text;
  v_cancel_src text;
BEGIN
  SELECT prosrc
    INTO v_guard_src
    FROM pg_proc
   WHERE oid = 'public.enforce_return_lifecycle_rpc_owned()'::regprocedure;
  SELECT prosrc
    INTO v_approve_src
    FROM pg_proc
   WHERE oid = 'public.approve_return(uuid,uuid,text)'::regprocedure;
  SELECT prosrc
    INTO v_cancel_src
    FROM pg_proc
   WHERE oid = 'public.cancel_return(uuid,text,uuid,text)'::regprocedure;

  IF v_guard_src IS NULL
     OR v_guard_src NOT LIKE '%RETURN_LIFECYCLE_VIA_RPC_ONLY%'
     OR v_guard_src NOT LIKE '%RETURN_DELETE_STATUS_LOCKED%'
     OR v_guard_src NOT LIKE '%TG_OP = ''DELETE''%'
     OR v_guard_src NOT LIKE '%IF OLD.status NOT IN%'
     OR v_guard_src LIKE '%IF TG_OP = ''DELETE'' THEN%current_setting(''app.return_rpc'', true)%OLD.status NOT IN%'
     OR v_guard_src NOT LIKE '%RETURN OLD%'
     OR v_guard_src NOT LIKE '%requested_at%'
     OR v_guard_src NOT LIKE '%deleted_at%'
     OR v_guard_src NOT LIKE '%credit_invoice_id%'
     OR v_guard_src NOT LIKE '%total_credit_cents%'
     OR v_guard_src NOT LIKE '%current_setting(''app.return_rpc'', true)%'
     OR v_guard_src NOT LIKE '%_is_admin_override%' THEN
    RAISE EXCEPTION 'return lifecycle direct-update guard missing expected checks';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.returns'::regclass
      AND tgname = 'trg_return_lifecycle_rpc_owned'
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'return lifecycle direct-update trigger missing';
  END IF;

  IF v_approve_src IS NULL
     OR v_approve_src NOT LIKE '%p_approved_by IS DISTINCT FROM v_actor%'
     OR v_approve_src LIKE '%p_approved_by IS NOT NULL AND%'
     OR v_approve_src NOT LIKE '%approved_by = v_actor%' THEN
    RAISE EXCEPTION 'approve_return actor attribution is not strict';
  END IF;

  IF v_cancel_src IS NULL
     OR v_cancel_src NOT LIKE '%p_performed_by IS DISTINCT FROM v_actor%'
     OR v_cancel_src LIKE '%p_performed_by IS NOT NULL AND%'
     OR v_cancel_src NOT LIKE '%cancelled_by = v_actor%'
     OR v_cancel_src NOT LIKE '%performed_by, notes%'
     OR v_cancel_src NOT LIKE '%v_actor%' THEN
    RAISE EXCEPTION 'cancel_return actor attribution is not strict';
  END IF;
END $$;
