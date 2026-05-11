-- Migration: perf_drop_duplicate_index
-- Source: Supabase performance advisor duplicate_index (1 WARN).
--
-- payments has two identical indexes on (order_id):
--   idx_payments_order      USING btree (order_id)
--   idx_payments_order_id   USING btree (order_id)
-- Both serve the FK on payments.order_id. The _order_id variant matches the
-- naming convention used elsewhere in this codebase (idx_<table>_<column>);
-- the unsuffixed _order variant is the historical duplicate.
--
-- Drop the unsuffixed one. The remaining index keeps the FK covered with no
-- behavioral change.

DROP INDEX IF EXISTS public.idx_payments_order;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_payments_order') THEN
    RAISE EXCEPTION 'perf_drop_duplicate_index: idx_payments_order was not dropped';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_payments_order_id') THEN
    RAISE EXCEPTION 'perf_drop_duplicate_index: idx_payments_order_id is missing — FK coverage would be lost';
  END IF;
END $$;
