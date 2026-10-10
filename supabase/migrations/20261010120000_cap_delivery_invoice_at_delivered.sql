-- STATUS: NOT APPLIED.
-- A delivery invoice can bill only what its delivery delivered.
--
-- Why (Sol exact-SHA review of PR #889, 2026-10-10, HIGH): an invoice created for one delivery
-- (invoices.delivery_id set, by create_invoice_for_unbilled_delivery, complete_delivery's per-delivery
-- invoice or create_quick_delivery) stays editable while it is a draft or unposted. save_invoice
-- rebuilds its lines (_save_invoice_lineage_unaware_impl_20260827 deletes and re-inserts them; its
-- only quantity check is > 0), and _save_invoice_scoped_impl locks the product, unit and order line of
-- an order-linked line but not its quantity, and accepts new lines with no order link. So an admin,
-- or a sales rep on their own customer, could raise a quantity or add another product, billing goods
-- this delivery never carried — goods that may already be billed on another delivery's invoice or
-- billed outside CRX (delivery_external_billings). Posting did not re-check either.
--
-- What this file does (schema only; no row changes; no money moves):
--   1. _delivery_invoice_overbilling(invoice_id) returns NULL when the invoice is within its delivery,
--      or the reason it is not. It applies only to an ACTIVE delivery invoice: delivery_id set, not a
--      credit memo, not soft-deleted, not voided/cancelled. Rules:
--        * every line names a product (a delivery invoice bills delivered goods, nothing else;
--          checked live 2026-10-10: no invoice line anywhere lacks a product, and the invoice editor
--          only adds product lines) and has a quantity of zero or more;
--        * a line linked to an order line must be for an order line this delivery carried, with the
--          same product;
--        * per order line, and per product, the quantity billed across ALL active invoices for this
--          delivery is at most what the delivery allows: quantity_delivered once the delivery is
--          completed; the scheduled quantity (GREATEST of quantity and quantity_delivered) while it
--          is still scheduled or in progress — create_quick_delivery bills the planned amount up
--          front, and complete_delivery cuts a draft invoice down to what was delivered; zero once
--          the delivery is cancelled, voided or deleted (cancel_delivery and void_delivery cancel its
--          draft invoices, so this only bites an invoice somebody reactivates).
--      Quantities are compared in the delivery's own units: every writer copies the delivery line's
--      quantity into the invoice line unchanged, and the unit label is not part of the match (live
--      labels vary in spelling only, e.g. "Gal"/"Gallon").
--   2. enforce_delivery_invoice_within_delivered: the trigger function that raises
--      DELIVERY_INVOICE_EXCEEDS_DELIVERED with that reason.
--   3. Two DEFERRABLE INITIALLY DEFERRED constraint triggers, checked when the transaction commits
--      (save_invoice deletes and re-inserts every line and restores their order links later in the
--      same transaction, so a per-statement check would see half-built states):
--        * zz_cap_delivery_invoice_items: AFTER INSERT OR UPDATE OF invoice_id, product_id,
--          order_item_id, quantity ON invoice_items. Removing a line never adds billing, so DELETE is
--          not watched; other column updates (complete_delivery's tote_number copy) are not watched.
--        * zz_cap_delivery_invoice_header: AFTER UPDATE OF delivery_id, invoice_type, deleted_at,
--          status ON invoices, only when the invoice becomes something that bills this delivery
--          again: a new delivery or type, a restore from soft-delete, an un-void, or POSTING
--          (draft/unposted -> posted). Paid/overdue marking and voiding are never re-checked, so
--          existing posted invoices keep working.
--      To serialize with a concurrent delivery change, the check takes a FOR SHARE lock on the
--      delivery row at commit.
--   The preflight refuses to install if any active delivery invoice already breaks the rule
--   (checked live 2026-10-10: 12 active delivery invoices on 12 deliveries, none over).
--
-- Not covered here (unchanged behavior): order-level invoices (delivery_id NULL) — every delivery
-- invoice writer refuses to bill a delivery an order-level invoice already covers; unit prices; and a
-- delivery shortened after its invoice was POSTED (complete_delivery only adjusts drafts) — the
-- monthly integrity report's delivery-invoice quantity check flags that.
--
-- Rollback (new reviewed migration):
--   DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_items ON public.invoice_items;
--   DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_header ON public.invoices;
--   DROP FUNCTION IF EXISTS public.enforce_delivery_invoice_within_delivered();
--   DROP FUNCTION IF EXISTS public._delivery_invoice_overbilling(uuid);
-- ORDERING: after 20261007150200.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._delivery_invoice_overbilling(p_invoice_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice record;
  v_delivery record;
  v_bad record;
BEGIN
  SELECT i.id, i.invoice_number, i.delivery_id, i.invoice_type, i.status, i.deleted_at
    INTO v_invoice
    FROM public.invoices i
   WHERE i.id = p_invoice_id;
  IF NOT FOUND
     OR v_invoice.delivery_id IS NULL
     OR v_invoice.invoice_type = 'credit_memo'
     OR v_invoice.deleted_at IS NOT NULL
     OR v_invoice.status IN ('voided', 'cancelled') THEN
    RETURN NULL;
  END IF;

  SELECT d.id, d.delivery_number, d.status, d.deleted_at
    INTO v_delivery
    FROM public.deliveries d
   WHERE d.id = v_invoice.delivery_id;
  IF NOT FOUND THEN
    RETURN format('invoice %s names a delivery that does not exist', v_invoice.invoice_number);
  END IF;

  SELECT ii.quantity INTO v_bad
    FROM public.invoice_items ii
   WHERE ii.invoice_id = v_invoice.id AND (ii.product_id IS NULL OR ii.quantity IS NULL OR ii.quantity < 0)
   LIMIT 1;
  IF FOUND THEN
    RETURN format('invoice %s has a line with no product or a negative quantity; a delivery invoice bills only the products delivery %s delivered',
                  v_invoice.invoice_number, v_delivery.delivery_number);
  END IF;

  -- An order-linked line must be an order line this delivery carried, for the same product.
  SELECT COALESCE(ii.description, p.product_name) AS label INTO v_bad
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id
   WHERE ii.invoice_id = v_invoice.id
     AND ii.order_item_id IS NOT NULL
     AND ii.quantity > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_delivery.id
          AND di.order_item_id = ii.order_item_id
          AND di.product_id = ii.product_id)
   LIMIT 1;
  IF FOUND THEN
    RETURN format('invoice %s bills %s from an order line delivery %s did not carry',
                  v_invoice.invoice_number, v_bad.label, v_delivery.delivery_number);
  END IF;

  -- Quantity caps, across every active invoice for this delivery.
  WITH allowed AS (
    SELECT di.order_item_id, di.product_id,
           SUM(CASE
                 WHEN v_delivery.deleted_at IS NOT NULL OR v_delivery.status IN ('cancelled', 'voided') THEN 0
                 WHEN v_delivery.status = 'completed' THEN COALESCE(di.quantity_delivered, 0)
                 ELSE GREATEST(COALESCE(di.quantity, 0), COALESCE(di.quantity_delivered, 0))
               END) AS qty
      FROM public.delivery_items di
     WHERE di.delivery_id = v_delivery.id
     GROUP BY di.order_item_id, di.product_id
  ), billed AS (
    SELECT ii.order_item_id, ii.product_id, ii.quantity, ii.description
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
     WHERE i.delivery_id = v_delivery.id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('voided', 'cancelled')
  ), over_line AS (
    SELECT b.product_id, SUM(b.quantity) AS billed_qty,
           (SELECT COALESCE(SUM(a.qty), 0) FROM allowed a WHERE a.order_item_id = b.order_item_id) AS allowed_qty
      FROM billed b
     WHERE b.order_item_id IS NOT NULL
     GROUP BY b.order_item_id, b.product_id
  ), over_product AS (
    SELECT b.product_id, SUM(b.quantity) AS billed_qty,
           (SELECT COALESCE(SUM(a.qty), 0) FROM allowed a WHERE a.product_id = b.product_id) AS allowed_qty
      FROM billed b
     GROUP BY b.product_id
  )
  SELECT COALESCE(p.product_name, o.product_id::text) AS label, o.billed_qty, o.allowed_qty INTO v_bad
    FROM (SELECT * FROM over_line UNION ALL SELECT * FROM over_product) o
    LEFT JOIN public.products p ON p.id = o.product_id
   WHERE o.billed_qty > o.allowed_qty
   ORDER BY 1
   LIMIT 1;
  IF FOUND THEN
    RETURN format('invoice %s bills %s of %s, but delivery %s allows %s',
                  v_invoice.invoice_number, v_bad.billed_qty, v_bad.label,
                  v_delivery.delivery_number, v_bad.allowed_qty);
  END IF;

  RETURN NULL;
END;
$function$;

ALTER FUNCTION public._delivery_invoice_overbilling(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._delivery_invoice_overbilling(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_delivery_invoice_within_delivered()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid;
  v_delivery_id uuid;
  v_reason text;
BEGIN
  -- Separate branches: PL/pgSQL resolves every NEW field named in one expression, and an invoices
  -- row has no invoice_id.
  IF TG_TABLE_NAME = 'invoice_items' THEN
    v_invoice_id := NEW.invoice_id;
  ELSE
    v_invoice_id := NEW.id;
  END IF;

  SELECT i.delivery_id INTO v_delivery_id FROM public.invoices i WHERE i.id = v_invoice_id;
  IF v_delivery_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Hold the delivery steady while checking: a concurrent completion, cancel or void waits for
  -- this commit, and one that committed first is seen.
  PERFORM 1 FROM public.deliveries d WHERE d.id = v_delivery_id FOR SHARE;

  v_reason := public._delivery_invoice_overbilling(v_invoice_id);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_EXCEEDS_DELIVERED: %', v_reason
      USING DETAIL = format('invoice_id=%s delivery_id=%s', v_invoice_id, v_delivery_id);
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.enforce_delivery_invoice_within_delivered() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_delivery_invoice_within_delivered() FROM PUBLIC, anon, authenticated, service_role;

DO $preflight$
DECLARE
  v_reasons text;
BEGIN
  SELECT string_agg(r, '; ') INTO v_reasons
    FROM (SELECT public._delivery_invoice_overbilling(i.id) AS r
            FROM public.invoices i
           WHERE i.delivery_id IS NOT NULL
           ORDER BY i.invoice_number) x
   WHERE r IS NOT NULL;
  IF v_reasons IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_PREFLIGHT: active delivery invoices already bill beyond their delivery: %', v_reasons;
  END IF;
END
$preflight$;

DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_items ON public.invoice_items;
CREATE CONSTRAINT TRIGGER zz_cap_delivery_invoice_items
  AFTER INSERT OR UPDATE OF invoice_id, product_id, order_item_id, quantity ON public.invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_delivery_invoice_within_delivered();

DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_header ON public.invoices;
CREATE CONSTRAINT TRIGGER zz_cap_delivery_invoice_header
  AFTER UPDATE OF delivery_id, invoice_type, deleted_at, status ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.delivery_id IS NOT NULL
        AND NEW.invoice_type <> 'credit_memo'
        AND NEW.deleted_at IS NULL
        AND NEW.status NOT IN ('voided', 'cancelled')
        AND (NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
             OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
             OR OLD.deleted_at IS NOT NULL
             OR OLD.status IN ('voided', 'cancelled')
             OR (NEW.status = 'posted' AND OLD.status IN ('draft', 'unposted'))))
  EXECUTE FUNCTION public.enforce_delivery_invoice_within_delivered();

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgname IN ('zz_cap_delivery_invoice_items', 'zz_cap_delivery_invoice_header')
         AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_POSTFLIGHT: both deferred triggers must be installed and enabled';
  END IF;
  IF has_function_privilege('authenticated', 'public._delivery_invoice_overbilling(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._delivery_invoice_overbilling(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_delivery_invoice_within_delivered()', 'EXECUTE') THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_POSTFLIGHT: an API role can execute a cap helper';
  END IF;
END
$postflight$;
