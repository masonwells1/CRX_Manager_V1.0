-- Data-integrity sentinel — daily sweep that flags NEW integrity breaks
-- ============================================================================
-- BUILT ONLY — NOT applied. Apply is gated on Mason's explicit OK (review cold
-- first: /migration-review + Codex gate).
--
-- Why: 5 daily pg_cron jobs already ACT on the data (verified live 2026-07-05:
-- 06:00 mark-overdue-invoices · 06:05 auto-expire-quotes · 06:10
-- check-unpriced-orders · 06:15 release-expired-quote-holds · 06:30
-- check-remainder-reminders), but nothing WATCHES the numbers themselves. The
-- ~128x field-app billing bug proved unwatched numbers drift silently. This adds
-- a 6th daily job at 06:45 UTC that INSERTs one integrity_alerts row per NEW
-- break. Warn-only: it reads business tables and writes ONLY its own alert
-- table — it never blocks, mutates, or repairs business data.
--
-- Four checks (all live column names verified 2026-07-05 via
-- information_schema.columns + pg_constraint on the live DB):
--   (a) negative_inventory       — per-product SUM(inventory.quantity_available) < 0
--                                  across locations, SKIPPING the pre-existing
--                                  negatives seeded into integrity_negative_baseline
--                                  below (owner item H1 — exactly 17 products at
--                                  build time, matching the known H1 count).
--   (b) negative_invoice_balance — invoices.balance_cents < 0. balance_cents is
--                                  GENERATED ALWAYS (verified) — read-only here,
--                                  never written.
--   (c) stale_quote_hold         — active crop_program inventory_holds whose parent
--                                  quote (source_id = quotes.id) sits in a terminal
--                                  status ('declined','expired','cancelled',
--                                  'closed_by_application' — the terminal subset of
--                                  the live quotes_status_check). Restricted to
--                                  hold_type = 'crop_program' because 'job' holds
--                                  carry source_id = job_id (Layer 2 A1,
--                                  20260702170000) and 'manual' holds have no
--                                  source quote — joining those to quotes.id would
--                                  be meaningless.
--   (d) booking_overdraw         — quote_product_draws.quantity_drawn exceeds the
--                                  booking cap. Cap semantics verified from
--                                  20260610145253 (draw_down_quote / fully-drawn
--                                  check, lines building `booked`): the per-
--                                  (quote_id, product_id) cap is
--                                  SUM(COALESCE(quote_items.total_units_needed, 0)).
--                                  drawn > that sum = drew more than was booked.
--
-- Idempotency note: run_data_integrity_sweep() takes NO p_idempotency_key —
-- deliberately, matching all 5 live cron functions (none accepts one; convention
-- checked in their live definitions/migrations). It is a scheduled internal
-- function invoked by pg_cron, not a client-facing mutating RPC, and it is
-- INSERT-only with a hard dedupe: the UNIQUE partial index on
-- (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL plus
-- ON CONFLICT DO NOTHING makes any re-run (same day, retry, or concurrent) a
-- no-op for alerts that are already open. Resolving an alert (resolved_at set by
-- an admin) re-arms detection for that entity on purpose — a NEW break of the
-- same kind should alarm again.
-- idempotency-body-check: exempt — cron-driven sweep, no client caller (see above)
-- ============================================================================

-- 1) integrity_alerts — one row per detected break. Written ONLY by the SECDEF
--    sweep (which bypasses RLS as table owner); admins read and resolve.
CREATE TABLE IF NOT EXISTS public.integrity_alerts (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_type   text        NOT NULL CHECK (alert_type = ANY (ARRAY[
                             'negative_inventory'::text,
                             'negative_invoice_balance'::text,
                             'stale_quote_hold'::text,
                             'booking_overdraw'::text])),
  entity_table text        NOT NULL,
  entity_id    uuid        NOT NULL,  -- all referenced entities (products, invoices, inventory_holds, quote_product_draws) verified uuid PKs live
  details      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- Hard dedupe: at most ONE open (unresolved) alert per (type, table, entity).
-- The sweep's ON CONFLICT DO NOTHING leans on this index, so duplicate-skipping
-- is race-proof, not best-effort.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrity_alerts_open_dedupe
  ON public.integrity_alerts (alert_type, entity_table, entity_id)
  WHERE resolved_at IS NULL;

-- Admin dashboard reads open alerts newest-first.
CREATE INDEX IF NOT EXISTS idx_integrity_alerts_open_detected
  ON public.integrity_alerts (detected_at DESC)
  WHERE resolved_at IS NULL;

-- RLS: admin-only SELECT + UPDATE (resolve = set resolved_at). No INSERT/DELETE
-- policy — inserts come only from the SECURITY DEFINER sweep. Policy shape
-- mirrors the live app_settings settings_update admin policy (USING is_admin()
-- WITH CHECK is_admin(), TO authenticated).
ALTER TABLE public.integrity_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY integrity_alerts_select_admin
  ON public.integrity_alerts
  FOR SELECT
  TO authenticated
  USING (is_admin());

CREATE POLICY integrity_alerts_update_admin
  ON public.integrity_alerts
  FOR UPDATE
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- No anon access at all (defense-in-depth on top of RLS having no anon policy).
REVOKE ALL ON TABLE public.integrity_alerts FROM anon;

COMMENT ON TABLE public.integrity_alerts IS
  'Data-integrity sentinel findings: one row per NEW break found by the daily run_data_integrity_sweep() cron (06:45 UTC). Warn-only — the sweep never mutates business data. resolved_at set by an admin re-arms detection for that entity.';

-- 2) integrity_negative_baseline — the products ALREADY negative when this
--    sentinel ships (owner item H1: 17 products awaiting physical counts).
--    Seeded at migration time so pre-existing negatives never alarm; only a NEW
--    product going negative (or a baselined one, once its row is removed after
--    the H1 re-base) raises an alert.
CREATE TABLE IF NOT EXISTS public.integrity_negative_baseline (
  product_id           uuid        NOT NULL PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  quantity_at_baseline numeric     NOT NULL,
  baselined_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.integrity_negative_baseline ENABLE ROW LEVEL SECURITY;

CREATE POLICY integrity_negative_baseline_select_admin
  ON public.integrity_negative_baseline
  FOR SELECT
  TO authenticated
  USING (is_admin());

-- Deliberate escape hatch: once H1's physical count re-bases a product, an
-- admin deletes its baseline row and the sentinel starts watching it again.
-- Without this, un-baselining would need the SQL console.
CREATE POLICY integrity_negative_baseline_delete_admin
  ON public.integrity_negative_baseline
  FOR DELETE
  TO authenticated
  USING (is_admin());

REVOKE ALL ON TABLE public.integrity_negative_baseline FROM anon;

COMMENT ON TABLE public.integrity_negative_baseline IS
  'Products whose net inventory (SUM(inventory.quantity_available) across locations) was already negative when the integrity sentinel shipped (owner item H1). The sweep skips these; delete a row after its physical-count re-base to resume watching that product.';

-- Seed with the currently-negative products (per-product net across locations —
-- the same aggregate the sweep checks). ON CONFLICT keeps a re-run additive-safe.
INSERT INTO public.integrity_negative_baseline (product_id, quantity_at_baseline)
SELECT product_id, SUM(quantity_available)
FROM public.inventory
GROUP BY product_id
HAVING SUM(quantity_available) < 0
ON CONFLICT (product_id) DO NOTHING;

-- 3) The sweep. SECURITY DEFINER (owner = postgres = alert-table owner, so the
--    INSERTs bypass RLS); pg_cron calls it with auth.uid() = NULL. The
--    authenticated-caller admin gate mirrors check_unpriced_orders /
--    check_remainder_reminders, purely as defense-in-depth — EXECUTE is revoked
--    from authenticated below anyway.
CREATE OR REPLACE FUNCTION public.run_data_integrity_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_negative_inventory integer := 0;
  v_negative_invoices  integer := 0;
  v_stale_holds        integer := 0;
  v_overdraws          integer := 0;
BEGIN
  -- admin-only when an authenticated user calls this; pg_cron / service_role
  -- (auth.uid() = NULL) bypass. Same pattern as check_unpriced_orders.
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- (a) NEW negative inventory: per-product net position across locations,
  --     skipping the pre-existing negatives in the baseline (H1).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_inventory', 'products', neg.product_id,
         jsonb_build_object('net_quantity_available', neg.net_qty)
  FROM (
    SELECT product_id, SUM(quantity_available) AS net_qty
    FROM inventory
    GROUP BY product_id
    HAVING SUM(quantity_available) < 0
  ) neg
  WHERE NOT EXISTS (
    SELECT 1 FROM integrity_negative_baseline b WHERE b.product_id = neg.product_id
  )
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_inventory = ROW_COUNT;

  -- (b) Invoices with a negative balance. balance_cents is GENERATED ALWAYS
  --     ((total - paid - prepay_applied - write_off)) — SELECT-only here.
  --     Negative means we over-collected against the invoice: always anomalous.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_invoice_balance', 'invoices', inv.id,
         jsonb_build_object(
           'invoice_number', inv.invoice_number,
           'status',         inv.status,
           'balance_cents',  inv.balance_cents)
  FROM invoices inv
  WHERE inv.balance_cents < 0
    AND inv.deleted_at IS NULL
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_invoices = ROW_COUNT;

  -- (c) Active crop_program holds whose parent quote is terminal — those holds
  --     should have been released by the decline/expire/cancel/close paths;
  --     a survivor silently shrinks Net Free forever.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'stale_quote_hold', 'inventory_holds', h.id,
         jsonb_build_object(
           'quote_id',     q.id,
           'quote_status', q.status,
           'product_id',   h.product_id,
           'quantity',     h.quantity)
  FROM inventory_holds h
  JOIN quotes q ON q.id = h.source_id
  WHERE h.is_active = true
    AND h.hold_type = 'crop_program'
    AND q.status IN ('declined', 'expired', 'cancelled', 'closed_by_application')
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_stale_holds = ROW_COUNT;

  -- (d) Booking overdraw: drawn more than the booking cap. Cap = the same
  --     SUM(COALESCE(quote_items.total_units_needed, 0)) per (quote, product)
  --     that draw_down_quote's fully-drawn check uses (20260610145253).
  --     Also catches drawn > 0 rows whose quote_items lines were edited away
  --     (cap collapses to 0) — that IS drift worth flagging.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'booking_overdraw', 'quote_product_draws', d.id,
         jsonb_build_object(
           'quote_id',       d.quote_id,
           'product_id',     d.product_id,
           'quantity_drawn', d.quantity_drawn,
           'booking_cap',    cap.booked)
  FROM quote_product_draws d
  JOIN quotes q ON q.id = d.quote_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(qi.total_units_needed, 0)), 0) AS booked
    FROM quote_items qi
    WHERE qi.quote_id = d.quote_id AND qi.product_id = d.product_id
  ) cap
  WHERE q.deleted_at IS NULL
    AND d.quantity_drawn > cap.booked
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_overdraws = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'new_negative_inventory', v_negative_inventory,
    'new_negative_invoice_balance', v_negative_invoices,
    'new_stale_quote_holds', v_stale_holds,
    'new_booking_overdraws', v_overdraws
  );
END;
$function$;

-- ACL: pg_cron runs as postgres (function owner) and needs no grant; keep
-- service_role for ops/manual runs. NO anon, NO authenticated (the in-body
-- admin gate stays as defense-in-depth if that ever changes).
-- caller-analysis: run_data_integrity_sweep :: new cron fn; no UI caller (cron-driven); authenticated revoked outright, in-body admin gate (auth.uid IS NOT NULL AND NOT is_admin → INSUFFICIENT_ROLE) kept as defense-in-depth; ACL = service_role only
REVOKE EXECUTE ON FUNCTION public.run_data_integrity_sweep() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.run_data_integrity_sweep() FROM anon;
REVOKE EXECUTE ON FUNCTION public.run_data_integrity_sweep() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.run_data_integrity_sweep() TO service_role;

COMMENT ON FUNCTION public.run_data_integrity_sweep() IS
  'Daily 06:45 UTC data-integrity sentinel: inserts one integrity_alerts row per NEW break (negative inventory beyond the H1 baseline, negative invoice balance, active hold on a terminal quote, booking overdraw). INSERT-only + partial-unique dedupe; never mutates business data.';

-- 4) Schedule the daily sweep (idempotent re-point by job name), 06:45 daily —
--    after the 5 existing jobs (06:00/06:05/06:10/06:15/06:30) so it audits the
--    state they leave behind.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'data-integrity-sweep') THEN
    PERFORM cron.unschedule('data-integrity-sweep');
  END IF;
  PERFORM cron.schedule('data-integrity-sweep', '45 6 * * *', 'SELECT public.run_data_integrity_sweep()');
END
$cron$;
