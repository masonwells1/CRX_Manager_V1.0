-- Overnight bug-hunt LOW: lifecycle:order_item_field_allocations:no-edit-lock
--
-- BUG: order_item_field_allocations (the per-field acre split feeding
-- create_split_invoices_from_order) has NO post-invoice edit-lock trigger, while its
-- sibling order_shares DOES (prevent_order_shares_edit_after_post). The UI writes/deletes
-- these rows via direct PostgREST with no status gate. Residual exposure (the active
-- double-bill is already blocked by create_split_invoices_from_order's active-invoice
-- guard): generate split invoices -> void/cancel them -> edit allocations -> re-run ->
-- regenerated invoices reflect the EDITED (not originally-billed) split = audit/reporting
-- divergence. This brings oifa to PARITY with order_shares.
--
-- FIX: add an edit-lock trigger mirroring prevent_order_shares_edit_after_post. oifa has
-- no order_id column, so resolve the parent order via order_item_id -> order_items.order_id.
-- Additive (new function + trigger); validated by plpgsql_check. Latent on live data
-- (0 order_item_field_allocations rows, 0 split invoices).

CREATE OR REPLACE FUNCTION public.prevent_oifa_edit_after_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order_id     uuid;
  v_blocking_inv text;
BEGIN
  -- order_item_field_allocations has no order_id; resolve it via the order item.
  SELECT oi.order_id
    INTO v_order_id
    FROM order_items oi
   WHERE oi.id = COALESCE(NEW.order_item_id, OLD.order_item_id);

  IF v_order_id IS NULL THEN
    IF (TG_OP = 'DELETE') THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT i.invoice_number
    INTO v_blocking_inv
    FROM invoices i
   WHERE i.order_id    = v_order_id
     AND i.deleted_at IS NULL
     AND i.status      IN ('posted', 'paid', 'overdue')
   ORDER BY i.created_at
   LIMIT 1;

  IF v_blocking_inv IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot modify field allocation — invoice % is already posted. Void the invoice first or adjust the allocation on a new order.',
      v_blocking_inv
      USING ERRCODE = 'check_violation';
  END IF;

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_oifa_lock_when_posted
  BEFORE INSERT OR DELETE OR UPDATE ON public.order_item_field_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_oifa_edit_after_post();
