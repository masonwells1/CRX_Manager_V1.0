-- 20260513050000 — order_items.cost_at_time_cents snapshot (audit #32)
--
-- Closes audit finding #32 (product price + cost history not retained per order).
--
-- The audit asked: "Did order X price the products at their cost-at-the-time?"
-- order_items already has `cost_per_unit numeric` but it's caller-supplied —
-- for orders converted from quotes, it carries the cost from quote-time
-- (potentially weeks earlier). For orders created via the front end, the
-- frontend sends whatever cost it had cached. There was no field that
-- AUTHORITATIVELY snapshotted `products.current_cost` at the moment the
-- order_items row was inserted.
--
-- This migration:
--   1. Adds `cost_at_time_cents bigint NULL` to order_items.
--   2. Adds a BEFORE INSERT trigger that snapshots `products.current_cost`
--      converted to cents whenever `cost_at_time_cents` is NULL on insert.
--      Existing RPCs don't need changes — the trigger handles every insert
--      path (convert_quote_to_order, create_direct_order, create_quick_delivery,
--      bulk_import_order, create_order_from_blend_ticket).
--   3. Backfills existing rows from `cost_per_unit * 100` (rounded). This is
--      the best historical signal we have — it represents what was actually
--      used for margin reporting on those orders.
--   4. Documents the semantic distinction:
--        - cost_per_unit       = the cost the seller used for margin (mutable)
--        - cost_at_time_cents  = products.current_cost at insert time (immutable)

BEGIN;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS cost_at_time_cents bigint;

COMMENT ON COLUMN public.order_items.cost_at_time_cents IS
  'Snapshot of products.current_cost (in cents, rounded) at the moment this row was inserted. Distinct from cost_per_unit which is caller-supplied and may be a stale quote cost or manual override. Populated automatically by trg_snapshot_order_item_cost.';

CREATE OR REPLACE FUNCTION public._snapshot_order_item_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only snapshot if caller didn't pre-populate (lets a future RPC override
  -- if it has a more precise value, e.g. from a vendor invoice).
  IF NEW.cost_at_time_cents IS NULL AND NEW.product_id IS NOT NULL THEN
    SELECT ROUND(current_cost * 100)::bigint INTO NEW.cost_at_time_cents
    FROM public.products WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_snapshot_order_item_cost ON public.order_items;
CREATE TRIGGER trg_snapshot_order_item_cost
  BEFORE INSERT ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public._snapshot_order_item_cost();

-- Backfill: existing rows snapshot what was actually billed (cost_per_unit * 100).
-- This is what the original margin calculations used — the ground truth for
-- historical margin reporting.
UPDATE public.order_items
   SET cost_at_time_cents = ROUND(cost_per_unit * 100)::bigint
 WHERE cost_at_time_cents IS NULL
   AND cost_per_unit IS NOT NULL;

COMMIT;

-- Verification
DO $$
DECLARE
  v_unsnapshotted int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'cost_at_time_cents'
  ) THEN RAISE EXCEPTION 'verify failed: order_items.cost_at_time_cents missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.order_items'::regclass AND tgname = 'trg_snapshot_order_item_cost'
  ) THEN RAISE EXCEPTION 'verify failed: trg_snapshot_order_item_cost missing'; END IF;

  SELECT count(*) INTO v_unsnapshotted FROM public.order_items WHERE cost_at_time_cents IS NULL AND cost_per_unit IS NOT NULL;
  IF v_unsnapshotted > 0 THEN
    RAISE EXCEPTION 'verify failed: % order_items rows still NULL after backfill', v_unsnapshotted;
  END IF;
END$$;
