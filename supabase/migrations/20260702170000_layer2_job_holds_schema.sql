-- Layer 2 — Inventory-aware scheduling · Part A · Cycle A1 (schema foundation)
-- ============================================================================
-- Adds the 'job' inventory-hold type and the job_product_draws ledger so a
-- scheduled job can soft-reserve (earmark) its product demand and, when it
-- descends from a planned quote, draw that demand down against the quote's
-- booking (a single shared remaining-computation — no double-count).
--
-- Owner decisions this builds to (Mason, 2026-07-02):
--   §6.1 WARN (never block)   ·  §6.2 auto-reserve  ·  §6.3 expires_at = NULL
--   §6.5 job draw consumes the quote's drawable booking  ·  §6.6 no backfill
--
-- SCHEMA-ONLY: no behavior change yet. Later cycles wire the reserve engine (A4),
-- make _sync_planned_holds (A2) and draw_down_quote (A3) job-draw-aware, and
-- rewrite completion/release (A5).
--
-- Mirrors quote_product_draws exactly (verified live 2026-07-02): RLS on, single
-- authenticated SELECT policy (is_admin() OR is_sales_rep()), writes via SECURITY
-- DEFINER RPCs only (no write policy), updated_at set by the RPC (no trigger),
-- parent FK ON DELETE CASCADE, products FK without cascade.
-- ============================================================================

-- 1) Extend the hold_type CHECK to add 'job' (superset of the live set).
--    create_inventory_hold's in-body whitelist is DELIBERATELY left as
--    ('manual','crop_program'): the job reserve path (A4) is a separate WARN
--    writer (§6.1) and must NOT go through create_inventory_hold's hard-block or
--    its source_id-less INSERT. Job holds always carry source_id = job_id.
--    All existing rows are 'manual'/'crop_program', so ADD validates cleanly.
ALTER TABLE public.inventory_holds
  DROP CONSTRAINT IF EXISTS inventory_holds_hold_type_check;
ALTER TABLE public.inventory_holds
  ADD CONSTRAINT inventory_holds_hold_type_check
  CHECK (hold_type = ANY (ARRAY['manual'::text, 'crop_program'::text, 'job'::text]));

-- 2) job_product_draws — per-(job, product) draw against the parent planned
--    quote's booking. Exists ONLY for quote-descended jobs whose parent quote
--    is_planned; standalone jobs reserve without a draw row.
CREATE TABLE IF NOT EXISTS public.job_product_draws (
  id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id         uuid        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  quote_id       uuid        NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  product_id     uuid        NOT NULL REFERENCES public.products(id),
  quantity_drawn numeric     NOT NULL DEFAULT 0 CHECK (quantity_drawn >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_product_draws_job_id_product_id_key UNIQUE (job_id, product_id)
);

-- Resync SUM reads by (quote_id, product_id); shortfall/position reads by product.
CREATE INDEX IF NOT EXISTS idx_job_product_draws_quote_product
  ON public.job_product_draws (quote_id, product_id);
CREATE INDEX IF NOT EXISTS idx_job_product_draws_product
  ON public.job_product_draws (product_id);

-- RLS: mirror quote_product_draws — staff read-only; every write goes through a
-- SECURITY DEFINER RPC (which bypasses RLS). No INSERT/UPDATE/DELETE policy.
ALTER TABLE public.job_product_draws ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_product_draws_select_staff
  ON public.job_product_draws
  FOR SELECT
  TO authenticated
  USING (is_admin() OR is_sales_rep());

COMMENT ON TABLE public.job_product_draws IS
  'Layer 2: per-(job, product) draw-down of a parent planned quote''s booking by a scheduled job. Shrinks the quote''s crop_program hold (via _sync_planned_holds) and the quote''s drawable order balance (via draw_down_quote) so the same demand is never double-reserved or double-billed. Reversed on job cancel/soft-delete.';

-- 3) Lock 'job' holds to SECURITY DEFINER writes only (Codex A1 review, P2).
--    inventory_holds' client-facing write policies let ANY authenticated user
--    directly INSERT/UPDATE/DELETE a hold where created_by = auth.uid(). With
--    'job' now a valid hold_type, that would let a client hand-craft a job hold
--    with a bogus/NULL source_id and bypass the reserve/release engine (A4/A5),
--    corrupting the reservation ledger. Adding `hold_type <> 'job'` to each write
--    policy means job holds can ONLY be created/changed by the SECDEF reserve
--    engine (SECURITY DEFINER bypasses RLS). Existing manual/crop_program direct
--    writes are unaffected — the only live direct writer is QuoteBuilder's
--    crop_program hold release (QuoteBuilder.tsx:983); no app path writes a job
--    hold directly. Live policy expressions reproduced verbatim + the single
--    `AND hold_type <> 'job'` guard (hold_type is NOT NULL, so no tri-valued gap).
DROP POLICY IF EXISTS inventory_holds_insert ON public.inventory_holds;
CREATE POLICY inventory_holds_insert ON public.inventory_holds
  FOR INSERT TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = created_by)
    AND hold_type <> 'job'
  );

DROP POLICY IF EXISTS inventory_holds_update ON public.inventory_holds;
CREATE POLICY inventory_holds_update ON public.inventory_holds
  FOR UPDATE TO authenticated
  USING (
    (
      ((SELECT auth.uid()) = created_by)
      OR EXISTS (SELECT 1 FROM profiles
                 WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'admin')
    )
    AND hold_type <> 'job'
  );

DROP POLICY IF EXISTS inventory_holds_delete ON public.inventory_holds;
CREATE POLICY inventory_holds_delete ON public.inventory_holds
  FOR DELETE TO authenticated
  USING (
    (
      ((SELECT auth.uid()) = created_by)
      OR EXISTS (SELECT 1 FROM profiles
                 WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'admin')
    )
    AND hold_type <> 'job'
  );
