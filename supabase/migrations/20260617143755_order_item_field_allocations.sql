-- Feature (nightly-debug #1): multi-field split invoices, allocated by acres.
-- Migration A of 2 (additive): the per-LINE field/acre attribution that the schema
-- lacks today. An order line can currently be tied (loosely, by section_name) to at
-- most one field; there is no way to say "this 1,250 gal line covers Field A (100 ac)
-- + Field B (150 ac)". This table adds exactly that, on the ORDER side (Mason 2026-06-17:
-- the split is entered on the order right before invoicing, NOT on the quote — so this
-- build does NOT touch save_quote / convert_quote_to_order).
--
-- Migration B rewrites create_split_invoices_from_order to read these rows: split each
-- line's total across its fields BY ACRES, then split each field's portion among that
-- field's owners (field_billing_defaults) BY split_pct, penny-exact via calculate_billing_splits.
--
-- DORMANT: 0 split invoices have ever been created and there are 0 multi-field quotes,
-- so there is no data to backfill and nothing live to break (additive only).
--
-- RLS mirrors the parent order_items policies EXACTLY (role-based, no per-row ownership
-- join — same as order_items, where any admin/sales_rep sees all rows):
--   SELECT/INSERT: admin OR sales_rep   ·   UPDATE/DELETE: admin only.
-- Writes from the UI go through a direct PostgREST insert/delete (same pattern as
-- order_shares); the acres>0 CHECK + (order_item_id, field_id) UNIQUE are the row guards.
--
-- Rollback: DROP TABLE public.order_item_field_allocations;

CREATE TABLE IF NOT EXISTS public.order_item_field_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES public.fields(id),
  acres numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_item_field_allocations_acres_check CHECK (acres > 0),
  CONSTRAINT order_item_field_allocations_unique_line_field UNIQUE (order_item_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_oifa_order_item ON public.order_item_field_allocations(order_item_id);
CREATE INDEX IF NOT EXISTS idx_oifa_field ON public.order_item_field_allocations(field_id);

ALTER TABLE public.order_item_field_allocations ENABLE ROW LEVEL SECURITY;

-- Mirror order_items policies exactly.
CREATE POLICY oifa_select ON public.order_item_field_allocations
  FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY oifa_insert ON public.order_item_field_allocations
  FOR INSERT TO public
  WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY oifa_update ON public.order_item_field_allocations
  FOR UPDATE TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY oifa_delete ON public.order_item_field_allocations
  FOR DELETE TO authenticated
  USING (is_admin());
