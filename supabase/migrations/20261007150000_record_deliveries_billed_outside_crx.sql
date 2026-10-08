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
--      delivery_id is this delivery or NULL). The order row is locked first so a concurrent
--      invoice writer, which locks the same order, cannot slip an invoice in between.
--   3. guard_invoice_delivery_billed_outside_crx (BEFORE INSERT/UPDATE OF delivery_id on
--      invoices): CRX refuses to create an invoice for a delivery recorded here
--      (DELIVERY_BILLED_OUTSIDE_CRX). Every invoice writer is a postgres-owned SECURITY DEFINER
--      function, so a table trigger binds all of them (create_invoice_for_unbilled_delivery,
--      complete_delivery's auto-invoice, the split path, save_invoice). Credit memos are exempt:
--      they never bill delivered goods. Order-level invoices (delivery_id NULL) need no rule here:
--      create_invoice_from_order already refuses an order-level invoice once the order has any
--      active delivery, and every recorded delivery is a completed one.
--
-- No existing row changes. No money moves. Reversible: drop the two triggers, their functions and
-- the table (rollback block at the end of this comment).
--
-- Rollback (only after removing any dependent frontend reads):
--   DROP TRIGGER IF EXISTS trg_guard_invoice_delivery_billed_outside_crx ON public.invoices;
--   DROP FUNCTION IF EXISTS public.guard_invoice_delivery_billed_outside_crx();
--   DROP TABLE IF EXISTS public.delivery_external_billings;
--   DROP FUNCTION IF EXISTS public.guard_delivery_external_billing();
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.delivery_external_billings (
  delivery_id uuid PRIMARY KEY REFERENCES public.deliveries(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  recorded_by uuid REFERENCES public.profiles(id),
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

  SELECT d.order_id, d.status, d.deleted_at
    INTO v_order_id, v_status, v_deleted_at
    FROM public.deliveries d
   WHERE d.id = NEW.delivery_id;

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
  IF NEW.delivery_id IS NULL OR NEW.invoice_type = 'credit_memo' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.delivery_external_billings b WHERE b.delivery_id = NEW.delivery_id
  ) THEN
    RAISE EXCEPTION 'DELIVERY_BILLED_OUTSIDE_CRX: this delivery was billed outside CRX, so CRX will not invoice it again'
      USING DETAIL = format('delivery_id=%s', NEW.delivery_id);
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.guard_invoice_delivery_billed_outside_crx() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_invoice_delivery_billed_outside_crx() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_invoice_delivery_billed_outside_crx ON public.invoices;
CREATE TRIGGER trg_guard_invoice_delivery_billed_outside_crx
  BEFORE INSERT OR UPDATE OF delivery_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_delivery_billed_outside_crx();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('guard_delivery_external_billing', 'guard_invoice_delivery_billed_outside_crx')) <> 2 THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: expected exactly one definition of each guard function';
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
                  AND tgname = 'trg_guard_invoice_delivery_billed_outside_crx' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'EXTERNAL_BILLING_POSTFLIGHT: invoice guard trigger missing';
  END IF;
END
$postflight$;
