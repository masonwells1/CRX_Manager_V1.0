-- Migration: Lock order_shares edits once a posted invoice exists for the order
-- Date: 2026-05-04
-- Source: docs/OPEN_ITEMS.md Item #1 (P2-2 from 2026-04-30 data-integrity audit)
--
-- Problem: order_shares can be inserted/updated/deleted at any time, even after
-- one of the order's invoices has been posted. The invoice carries its own
-- denormalized invoice_shares snapshot, so changing the parent order_shares
-- after-the-fact creates drift between what the customer was billed on the
-- (already-posted) invoice and what the order claims the split should be.
--
-- Fix: BEFORE INSERT OR UPDATE OR DELETE trigger on order_shares that rejects
-- the change when any non-soft-deleted invoice on the same order has status
-- in ('posted', 'paid', 'overdue'). Drafts, unposted, voided, and cancelled
-- invoices stay editable — those are still in flight.
--
-- This is defense-in-depth: the UI also hides the editor in the same case,
-- but the trigger catches admin scripts, REST writes, and anything else that
-- bypasses the UI.

CREATE OR REPLACE FUNCTION public.prevent_order_shares_edit_after_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id     uuid;
  v_blocking_inv text;
BEGIN
  -- DELETE → look at OLD; INSERT/UPDATE → look at NEW
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

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
      'Cannot modify bill split — invoice % is already posted. Void the invoice first or adjust the split on a new order.',
      v_blocking_inv
      USING ERRCODE = 'check_violation';
  END IF;

  -- INSERT / UPDATE return NEW; DELETE returns OLD
  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_shares_lock_when_posted ON public.order_shares;
CREATE TRIGGER trg_order_shares_lock_when_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_shares
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_order_shares_edit_after_post();

COMMENT ON FUNCTION public.prevent_order_shares_edit_after_post() IS
  'Blocks INSERT/UPDATE/DELETE on order_shares when a posted/paid/overdue invoice exists for the order. Prevents drift between order_shares and the historical invoice_shares snapshot. See docs/OPEN_ITEMS.md item #1.';
