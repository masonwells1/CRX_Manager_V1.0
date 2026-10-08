-- STATUS: NOT APPLIED.
-- Record completed deliveries that were billed OUTSIDE CRX (e.g. in QuickBooks, before CRX
-- invoicing was in use), so the books and the integrity checks stop treating them as unbilled.
--
-- Why: spring 2026 deliveries were completed in CRX but invoiced in QuickBooks. CRX still sees
-- them as "completed with no invoice", so:
--   * the monthly integrity report's Delivery-Invoice Quantity check (src/lib/reconciliation.ts,
--     checkDeliveryInvoiceQuantityParity) fails on every one of them, and
--   * the admin Integrity Cleanup page offers "Create draft invoice" on each, which would bill a
--     customer a second time for goods already billed elsewhere.
-- Creating CRX invoices for them would invent revenue and receivables that do not exist in CRX's
-- books, so instead this records the fact explicitly.
--
-- What this file does (schema only; it marks NO deliveries — that is a separate, owner-approved
-- data migration):
--   1. delivery_external_billings: one row per delivery billed outside CRX, with a reason.
--      Admin read-only through RLS. No INSERT/UPDATE/DELETE grant to any API role, so a row can
--      only be written by a reviewed migration (postgres).
--   2. guard_delivery_external_billing (BEFORE INSERT/UPDATE on the new table): a delivery can be
--      recorded only if it is a completed, non-deleted order delivery that NO active CRX invoice
--      covers (same coverage rule as src/lib/deliveryInvoiceCoverage.ts and the Integrity Cleanup
--      page: a non-credit, non-deleted, non-voided/cancelled invoice on the order whose
--      delivery_id is this delivery or NULL). The delivery row and then its order row are locked
--      first — the order every invoice writer and void_delivery use — so a concurrent invoice or
--      void cannot slip in between the check and the commit.
--   3. guard_invoice_delivery_billed_outside_crx (BEFORE INSERT/UPDATE OF delivery_id, order_id,
--      invoice_type on invoices), refusing with DELIVERY_BILLED_OUTSIDE_CRX:
--        * an invoice for a delivery recorded here (create_invoice_for_unbilled_delivery,
--          complete_delivery's per-delivery invoice, the Delivery page's create-invoice action);
--        * a WHOLE-ORDER invoice (delivery_id NULL) on an order with any recorded delivery —
--          save_invoice and the split-by-field engine both bill a fully delivered order without
--          naming a delivery, which would bill the recorded deliveries again. Such an order's
--          remaining deliveries are still invoiced per delivery; complete_delivery's automatic
--          split attempt already falls back to "needs split billing" when its engine refuses.
--      Every invoice writer is a postgres-owned SECURITY DEFINER function, so a table trigger
--      binds all of them. Credit memos are exempt: they credit, never bill. The trigger is named
--      zz_ so it fires after trg_guard_invoice_terminal_order, which locks the order: by then a
--      recording committed by guard 2 (which holds the same lock) is visible.
--
-- No existing row changes. No money moves. Reversible: drop the two triggers, their functions and
-- the table (rollback block at the end of this comment).
--
-- Rollback (only after removing any dependent frontend reads):
--   DROP TRIGGER IF EXISTS zz_guard_invoice_delivery_billed_outside_crx ON public.invoices;
--   DROP FUNCTION IF EXISTS public.guard_invoice_delivery_billed_outside_crx();
--   DROP TABLE IF EXISTS public.delivery_external_billings;
--   DROP FUNCTION IF EXISTS public.guard_delivery_external_billing();
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  -- get_dashboard_action_items is re-emitted below from its live body with one added predicate.
  -- Refuse if live has moved since that body was read (2026-10-07, md5 of prosrc), so this file
  -- can never silently revert a newer change.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_dashboard_action_items') <> 1
     OR (SELECT md5(p.prosrc) FROM pg_proc p
          WHERE p.oid = 'public.get_dashboard_action_items(integer)'::regprocedure)
        IS DISTINCT FROM 'd2fb4364e19598c3dbe9d998adae7fae' THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_PREFLIGHT: get_dashboard_action_items(integer) differs from the reviewed live body; re-base this migration';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.delivery_external_billings (
  delivery_id uuid PRIMARY KEY REFERENCES public.deliveries(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  recorded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_external_billings_reason_chk
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500)
);

COMMENT ON TABLE public.delivery_external_billings IS
  'Completed deliveries that were billed outside CRX (e.g. QuickBooks). Excluded from the delivery-invoice integrity check and the unbilled-delivery cleanup list; CRX refuses to invoice them. Written only by reviewed migrations.';

ALTER TABLE public.delivery_external_billings OWNER TO postgres;
ALTER TABLE public.delivery_external_billings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_external_billings_admin_select ON public.delivery_external_billings;
CREATE POLICY delivery_external_billings_admin_select
  ON public.delivery_external_billings
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Supabase default privileges grant every API role full table access; take it all back and give
-- the app read access only (RLS then limits it to admins).
REVOKE ALL ON TABLE public.delivery_external_billings FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.delivery_external_billings TO authenticated;

DROP TRIGGER IF EXISTS set_updated_at ON public.delivery_external_billings;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.delivery_external_billings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.guard_delivery_external_billing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_status text;
  v_deleted_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id THEN
    RETURN NEW;
  END IF;

  -- Lock the delivery, then its order: the same order every invoice writer and void_delivery
  -- take them in, so this cannot deadlock against them and the status read cannot go stale.
  SELECT d.order_id, d.status, d.deleted_at
    INTO v_order_id, v_status, v_deleted_at
    FROM public.deliveries d
   WHERE d.id = NEW.delivery_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_DELIVERY_NOT_FOUND: delivery % does not exist', NEW.delivery_id;
  END IF;

  IF v_status <> 'completed' OR v_deleted_at IS NOT NULL OR v_order_id IS NULL THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_REQUIRES_COMPLETED_ORDER_DELIVERY: delivery % is %, deleted=%, order=%',
      NEW.delivery_id, v_status, v_deleted_at IS NOT NULL, v_order_id;
  END IF;

  -- Invoice writers lock the order before inserting; taking the same lock here means an invoice
  -- created concurrently is either visible below or waits until this row is committed (and is
  -- then refused by guard_invoice_delivery_billed_outside_crx).
  PERFORM 1 FROM public.orders o WHERE o.id = v_order_id FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.order_id = v_order_id
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('voided', 'cancelled')
       AND i.invoice_type <> 'credit_memo'
       AND (i.delivery_id = NEW.delivery_id OR i.delivery_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'DELIVERY_ALREADY_INVOICED_IN_CRX: delivery % is covered by an active CRX invoice', NEW.delivery_id;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.guard_delivery_external_billing() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_delivery_external_billing() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_delivery_external_billing ON public.delivery_external_billings;
CREATE TRIGGER trg_guard_delivery_external_billing
  BEFORE INSERT OR UPDATE OF delivery_id ON public.delivery_external_billings
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_external_billing();

CREATE OR REPLACE FUNCTION public.guard_invoice_delivery_billed_outside_crx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.invoice_type = 'credit_memo' OR NEW.order_id IS NULL AND NEW.delivery_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type THEN
    RETURN NEW;
  END IF;

  IF NEW.delivery_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.delivery_external_billings b WHERE b.delivery_id = NEW.delivery_id
    ) THEN
      RAISE EXCEPTION 'DELIVERY_BILLED_OUTSIDE_CRX: this delivery was billed outside CRX, so CRX will not invoice it again'
        USING DETAIL = format('delivery_id=%s', NEW.delivery_id);
    END IF;
  ELSIF EXISTS (
    -- A whole-order invoice (save_invoice, the split-by-field engine) bills every delivery on
    -- the order, including the ones already billed outside CRX.
    SELECT 1
      FROM public.delivery_external_billings b
      JOIN public.deliveries d ON d.id = b.delivery_id
     WHERE d.order_id = NEW.order_id
  ) THEN
    RAISE EXCEPTION 'DELIVERY_BILLED_OUTSIDE_CRX: this order has deliveries billed outside CRX, so CRX will not bill the whole order; invoice each remaining delivery instead'
      USING DETAIL = format('order_id=%s', NEW.order_id);
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.guard_invoice_delivery_billed_outside_crx() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_invoice_delivery_billed_outside_crx() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS zz_guard_invoice_delivery_billed_outside_crx ON public.invoices;
CREATE TRIGGER zz_guard_invoice_delivery_billed_outside_crx
  BEFORE INSERT OR UPDATE OF delivery_id, order_id, invoice_type ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_delivery_billed_outside_crx();

-- 4. The dashboard's "Delivered, not invoiced" list (section 9) skips deliveries billed outside
--    CRX. Body copied verbatim from live (preflight-pinned above); the only change is the
--    delivery_external_billings NOT EXISTS in section 9. CREATE OR REPLACE keeps the OID, owner
--    and ACL; the postflight re-checks them.
CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- 1. Overdue Invoices
  SELECT jsonb_agg(row_to_json(t))
  INTO v_result
  FROM (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
      AND i.invoice_type <> 'credit_memo'
      AND i.deleted_at IS NULL
    ORDER BY (v_today - i.due_date) DESC
    LIMIT p_limit
  ) t;

  v_result := jsonb_build_object('overdue_invoices', COALESCE(v_result, '[]'::jsonb));

  -- 2. Cancelled Orders with Posted Invoices
  v_result := v_result || jsonb_build_object('cancelled_posted', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        o.id,
        o.order_number AS primary_text,
        c.farm_name AS secondary_text,
        i.invoice_number
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN invoices i ON i.order_id = o.id
        AND i.status = 'posted'
        AND i.invoice_type <> 'credit_memo'
        AND i.deleted_at IS NULL
      WHERE o.status = 'cancelled'
      ORDER BY o.created_at DESC
      LIMIT p_limit
    ) t
  ));

  -- 3. Overdue Deliveries
  v_result := v_result || jsonb_build_object('overdue_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        (v_today - d.scheduled_date) AS days_overdue
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status IN ('scheduled', 'in_progress')
        AND d.scheduled_date < v_today
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- 4. Low Stock Items
  v_result := v_result || jsonb_build_object('low_stock', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        p.id,
        p.product_name AS primary_text,
        p.category AS secondary_text,
        COALESCE(inv.quantity_available, 0) AS current_qty,
        COALESCE(inv.reorder_point, 0) AS reorder_point
      FROM products p
      JOIN inventory inv ON inv.product_id = p.id
      WHERE p.is_active = true
        AND (
          (inv.reorder_point IS NOT NULL
            AND inv.reorder_point > 0
            AND COALESCE(inv.quantity_available, 0) < inv.reorder_point)
          OR COALESCE(inv.quantity_available, 0) < 0
        )
      ORDER BY (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) ASC
      LIMIT p_limit
    ) t
  ));

  -- 5. Expiring Quotes (within 7 days)
  v_result := v_result || jsonb_build_object('expiring_quotes', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        q.id,
        q.quote_number AS primary_text,
        c.farm_name AS secondary_text,
        (q.expires_at::date - v_today) AS days_until_expiry
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE q.status IN ('sent', 'revised')
        AND q.is_planned = false
        AND q.expires_at IS NOT NULL
        AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
      ORDER BY q.expires_at ASC
      LIMIT p_limit
    ) t
  ));

  -- 6. Unassigned Deliveries
  v_result := v_result || jsonb_build_object('unassigned_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'scheduled'
        AND d.assigned_driver IS NULL
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- U13<<< 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no
  -- currently-active per-location dispatch — neither the wizard's per-location
  -- assignment NOR (indirectly, via the sync triggers above) a whole-job
  -- applicator has reached the field crew. deleted_at IS NULL mirrors the other
  -- job reads.
  v_result := v_result || jsonb_build_object('unassigned_jobs', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        j.id,
        j.job_number AS primary_text,
        c.farm_name AS secondary_text,
        j.job_date AS scheduled_date
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.status = 'scheduled'
        AND j.deleted_at IS NULL
        -- Codex R1 P2: a job with a legacy WHOLE-JOB applicator is assigned,
        -- not "unassigned" — pre-trigger jobs have no dispatch rows yet (no
        -- backfill: business-data writes are outside this run's additive-only
        -- mandate; rows materialize via the triggers on the next edit, and
        -- FieldView already surfaces legacy assignments client-side).
        AND j.applicator_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM job_location_dispatches d
          WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
        )
      ORDER BY j.job_date ASC
      LIMIT p_limit
    ) t
  ));
  -- >>>U13

  -- 8. Due-today deliveries that have not been started.
  v_result := v_result || jsonb_build_object('due_today_not_started', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.scheduled_date = v_today
        AND d.status = 'scheduled'
        AND d.deleted_at IS NULL
      ORDER BY d.delivery_number ASC
      LIMIT p_limit
    ) t
  ));

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice,
  --    and not billed outside CRX (delivery_external_billings).
  v_result := v_result || jsonb_build_object('unbilled_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'completed'
        AND d.deleted_at IS NULL
        AND d.order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM invoices i
          WHERE i.order_id = d.order_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
            AND i.invoice_type <> 'credit_memo'
            AND i.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_external_billings b WHERE b.delivery_id = d.id
        )
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guard_delivery_external_billing'
         AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guard_invoice_delivery_billed_outside_crx'
         AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('guard_delivery_external_billing', 'guard_invoice_delivery_billed_outside_crx')) <> 2 THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: expected exactly one definition of each guard function, with the intended security mode and search_path';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delivery_external_billings') <> 5 THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: delivery_external_billings does not have the expected shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_external_billings'::regclass
                  AND tgname = 'trg_guard_delivery_external_billing' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: recording guard trigger missing or disabled';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.delivery_external_billings'::regclass) THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: RLS is not enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.delivery_external_billings'::regclass) <> 1 THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: expected exactly one (admin SELECT) policy';
  END IF;
  IF has_table_privilege('authenticated', 'public.delivery_external_billings', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.delivery_external_billings', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('service_role', 'public.delivery_external_billings', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.delivery_external_billings', 'SELECT') THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: table privileges are not admin-read-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass
                  AND tgname = 'zz_guard_invoice_delivery_billed_outside_crx' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: invoice guard trigger missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid = 'public.get_dashboard_action_items(integer)'::regprocedure
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND p.prosrc LIKE '%delivery_external_billings%') <> 1
     OR has_function_privilege('anon', 'public.get_dashboard_action_items(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_dashboard_action_items(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: get_dashboard_action_items lost its security mode, owner, search_path or grants';
  END IF;
END
$postflight$;
