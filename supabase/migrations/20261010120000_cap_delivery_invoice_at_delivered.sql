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
--        * a posted (posted/paid/overdue) delivery invoice needs a completed delivery: an invoice billed
--          up front (create_quick_delivery) stays a draft until the delivery is done, because
--          complete_delivery cuts only DRAFT invoices down to what was delivered;
--        * every line names a product (a delivery invoice bills delivered goods, nothing else;
--          checked live 2026-10-10: no invoice line anywhere lacks a product, and the invoice editor
--          only adds product lines) and has a quantity of zero or more;
--        * a line linked to an order line must be for an order line this delivery carried, with the
--          same product (any quantity, zero included: the link is billing lineage);
--        * per order line, and per product, the quantity billed across ALL active invoices for this
--          delivery is at most what the delivery allows: quantity_delivered once the delivery is
--          completed; the scheduled quantity (GREATEST of quantity and quantity_delivered) while it
--          is still scheduled or in progress — create_quick_delivery bills the planned amount up
--          front; zero once the delivery is cancelled, voided or deleted (cancel_delivery and
--          void_delivery cancel its draft invoices, so this only bites an invoice somebody reactivates).
--      Quantities are compared in the delivery's own units: every writer copies the delivery line's
--      quantity into the invoice line unchanged, and the unit label is not part of the match (live
--      labels vary in spelling only, e.g. "Gal"/"Gallon"). Each delivery line's allowance is rounded to
--      4 decimals, the scale of invoice_items.quantity, so a copied quantity never rounds past it
--      (delivery quantities are unscaled numeric; live has none past 4 decimals, checked 2026-10-10).
--      Rounding each line, not the total, can allow at most 0.00005 of a unit per delivery line more
--      than a sub-4-decimal recording — accepted; the other way would refuse a faithful copy.
--   2. enforce_delivery_invoice_within_delivered: the trigger function that raises
--      DELIVERY_INVOICE_EXCEEDS_DELIVERED with that reason. Before checking a write that can add
--      billing it takes the ORDER row lock that every invoice-line writer already holds, so two
--      transactions adding billing to the same delivery (even on two different invoices) check one
--      after the other and the second sees the first's committed lines — with no new lock order.
--   3. Two ordinary AFTER ... FOR EACH ROW triggers, checked at the end of the writing statement
--      (NOT deferred to commit, so a caller's EXCEPTION block — batch_post_invoices' per-invoice
--      failure list, process_offline_action's office review queue — still catches a refusal):
--        * zz_cap_delivery_invoice_items: AFTER INSERT OR UPDATE OF invoice_id, product_id,
--          order_item_id, quantity ON invoice_items. Removing a line never adds billing, so DELETE is
--          not watched; other column updates (complete_delivery's tote_number copy) are not watched.
--          Two UPDATEs that cannot add billing are always let through, so nobody is blocked from
--          fixing or finishing work: lowering a line's quantity, and setting an order-linked line to
--          exactly what its completed delivery delivered on that order line (complete_delivery's
--          partial-delivery trim — a driver finishing a short delivery is never refused). The draft
--          can then still be over its delivery because of OTHER lines; posting refuses it until fixed.
--          save_invoice's rebuild (delete every line, re-insert, then restore order links in one
--          UPDATE) is checked after each statement; none of those states bills more than the final
--          one, so the result is the same as a check at commit.
--        * zz_cap_delivery_invoice_header: AFTER UPDATE OF delivery_id, invoice_type, deleted_at,
--          status ON invoices, only when the invoice becomes something that bills this delivery
--          again: a new delivery or type, a restore from soft-delete, an un-void, or POSTING
--          (draft/unposted -> posted/paid/overdue, including an admin-override jump). Paid/overdue
--          marking of a posted invoice and voiding are never re-checked, so existing posted invoices
--          keep working.
--   The preflight locks invoices and invoice_items, then refuses to install if any active delivery
--   invoice already breaks a rule (checked live 2026-10-10: 12 active delivery invoices on 12
--   completed deliveries, none over).
--
-- Behavior changes, accepted:
--   * A delivery recorded short cannot be billed for more on its own invoice; the delivery record is
--     what the cap trusts.
--   * If a scheduled delivery loses a product after its up-front invoice was drafted (edit_delivery),
--     the draft keeps a line for an order line the delivery no longer carries. Completing the
--     delivery still works; posting that draft is refused, and since save_invoice will not drop an
--     order-linked line, the office voids it and re-creates the invoice from the delivery.
--   * consolidate_draft_invoices would also be refused here (it moves one delivery's lines onto
--     another delivery's invoice), but INVOICE_ITEM_LINEAGE_IMMUTABLE already refuses every line move
--     (20260721014858), so nothing changes for it.
-- Not covered here (unchanged behavior): order-level invoices (delivery_id NULL) are not capped —
-- every delivery-invoice writer refuses to bill a delivery an order-level invoice already covers, but
-- nothing yet refuses a manual order-level invoice made after delivery invoices (tracked in
-- KNOWN_ISSUES); unit prices, and the unit label of a manually added line; two delivery_items rows
-- for one order line on one delivery (none live, 2026-10-10; complete_delivery's trim would then be
-- checked in full rather than exempted); and a delivery whose items are changed after its invoice was posted (a posted delivery invoice now needs
-- a completed delivery, and enforce_delivery_items_parent_lock already freezes a completed delivery's
-- items) — the monthly integrity report's delivery-invoice quantity check flags any that exists.
-- The cap relies on trg_guard_invoice_terminal_order (20260721014858): a delivery invoice keeps
-- exactly its delivery's order, and neither delivery_id nor order_id can change after creation, so
-- an invoice cannot be detached from its delivery to dodge this check.
--
-- Rollback (new reviewed migration):
--   DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_items ON public.invoice_items;
--   DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_header ON public.invoices;
--   DROP FUNCTION IF EXISTS public.enforce_delivery_invoice_within_delivered();
--   DROP FUNCTION IF EXISTS public._delivery_invoice_overbilling(uuid);
-- ORDERING: after 20261007150200, which the preflight requires in the ledger (applying this first
-- would leave that owner-approved file below the high-water mark, where the apply gate refuses it).

SET LOCAL lock_timeout = '5s';

DO $ordering$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE name = '20261007150200_release_reservations_of_deleted_spring_orders'
  ) THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_PREFLIGHT: apply 20261007150200_release_reservations_of_deleted_spring_orders first';
  END IF;
END
$ordering$;

CREATE OR REPLACE FUNCTION public._delivery_invoice_overbilling(p_invoice_id uuid)
RETURNS text
LANGUAGE plpgsql
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

  IF v_invoice.status IN ('posted', 'paid', 'overdue')
     AND v_delivery.deleted_at IS NULL
     AND v_delivery.status IN ('scheduled', 'in_progress') THEN
    RETURN format('invoice %s cannot be posted before delivery %s is completed',
                  v_invoice.invoice_number, v_delivery.delivery_number);
  END IF;

  PERFORM 1
    FROM public.invoice_items ii
   WHERE ii.invoice_id = v_invoice.id AND (ii.product_id IS NULL OR ii.quantity IS NULL OR ii.quantity < 0);
  IF FOUND THEN
    RETURN format('invoice %s has a line with no product or a negative quantity; a delivery invoice bills only the products delivery %s delivered',
                  v_invoice.invoice_number, v_delivery.delivery_number);
  END IF;

  -- An order-linked line must be an order line this delivery carried, for the same product.
  SELECT COALESCE(NULLIF(btrim(ii.description), ''), p.product_name, 'a product') AS label INTO v_bad
    FROM public.invoice_items ii
    LEFT JOIN public.products p ON p.id = ii.product_id
   WHERE ii.invoice_id = v_invoice.id
     AND ii.order_item_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_delivery.id
          AND di.order_item_id = ii.order_item_id
          AND di.product_id = ii.product_id)
   ORDER BY ii.sort_order, ii.id
   LIMIT 1;
  IF FOUND THEN
    RETURN format('invoice %s bills %s from an order line delivery %s did not carry',
                  v_invoice.invoice_number, v_bad.label, v_delivery.delivery_number);
  END IF;

  -- Quantity caps, across every active invoice for this delivery.
  WITH allowed AS (
    SELECT di.order_item_id, di.product_id,
           SUM(ROUND(CASE
                 WHEN v_delivery.deleted_at IS NOT NULL OR v_delivery.status IN ('cancelled', 'voided') THEN 0
                 WHEN v_delivery.status = 'completed' THEN COALESCE(di.quantity_delivered, 0)
                 ELSE GREATEST(COALESCE(di.quantity, 0), COALESCE(di.quantity_delivered, 0))
               END, 4)) AS qty
      FROM public.delivery_items di
     WHERE di.delivery_id = v_delivery.id
     GROUP BY di.order_item_id, di.product_id
  ), billed AS (
    SELECT ii.order_item_id, ii.product_id, ii.quantity
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
   ORDER BY 1, 2
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
  v_lock boolean;
BEGIN
  -- Separate branches: PL/pgSQL resolves every NEW field named in one expression, and an invoices
  -- row has no invoice_id.
  IF TG_TABLE_NAME = 'invoice_items' THEN
    v_invoice_id := NEW.invoice_id;
  ELSE
    v_invoice_id := NEW.id;
  END IF;

  SELECT i.delivery_id INTO v_delivery_id
    FROM public.invoices i
   WHERE i.id = v_invoice_id
     AND i.invoice_type <> 'credit_memo'
     AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled');
  IF v_delivery_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Nested, not one AND chain: PL/pgSQL resolves every NEW field in an expression, and an invoices
  -- row has none of these columns.
  IF TG_TABLE_NAME = 'invoice_items' AND TG_OP = 'UPDATE' THEN
    IF NEW.invoice_id = OLD.invoice_id
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
       AND NEW.quantity >= 0 THEN
      -- Lowering a line never adds billing.
      IF NEW.quantity <= OLD.quantity THEN
        RETURN NULL;
      END IF;
      -- An order-linked line set to exactly what its completed delivery delivered on that order line
      -- (complete_delivery's partial-delivery trim).
      IF NEW.order_item_id IS NOT NULL AND NEW.quantity = (
           SELECT SUM(ROUND(COALESCE(di.quantity_delivered, 0), 4))
             FROM public.delivery_items di
             JOIN public.deliveries d ON d.id = di.delivery_id
            WHERE di.delivery_id = v_delivery_id
              AND di.order_item_id = NEW.order_item_id
              AND di.product_id = NEW.product_id
              AND d.status = 'completed'
              AND d.deleted_at IS NULL) THEN
        RETURN NULL;
      END IF;
    END IF;
  END IF;

  -- One check at a time per order (so per delivery) whenever this write can ADD billing: take the
  -- order lock every line writer already holds here (trg_guard_terminal_order_invoice_items locks it
  -- on every invoice_items write; complete_delivery takes it after the delivery), so re-taking it is
  -- free and adds no new lock order. A concurrent write to another invoice of the same delivery waits
  -- for this transaction, and the check below (a new statement, so a fresh snapshot under READ
  -- COMMITTED, the isolation every PostgREST call uses) sees whatever committed meanwhile. Posting adds no quantity — every line it counts was itself checked, under
  -- this lock, against all active invoices — and post_invoice locks the invoice before the order is
  -- ever touched, so posting skips the lock rather than invert that order. A restore, un-void or
  -- re-point brings billing back and takes it.
  IF TG_TABLE_NAME = 'invoice_items' THEN
    v_lock := true;
  ELSE
    v_lock := NOT (OLD.deleted_at IS NULL
                   AND OLD.status IN ('draft', 'unposted')
                   AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id
                   AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type);
  END IF;
  IF v_lock THEN
    -- The delivery's own order (trg_guard_invoice_terminal_order already keeps a delivery invoice on
    -- exactly that order and refuses any later change of delivery_id or order_id).
    PERFORM 1 FROM public.orders o
     WHERE o.id = (SELECT d.order_id FROM public.deliveries d WHERE d.id = v_delivery_id)
       FOR UPDATE;
  END IF;

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

-- Nothing may write an invoice or line between the check below and the triggers taking effect.
LOCK TABLE public.invoices, public.invoice_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_reasons text;
BEGIN
  SELECT string_agg(r, '; ' ORDER BY n) INTO v_reasons
    FROM (SELECT i.invoice_number AS n, public._delivery_invoice_overbilling(i.id) AS r
            FROM public.invoices i
           WHERE i.delivery_id IS NOT NULL) x
   WHERE r IS NOT NULL;
  IF v_reasons IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_PREFLIGHT: active delivery invoices already break the delivery cap: %', v_reasons;
  END IF;
END
$preflight$;

DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_items ON public.invoice_items;
CREATE TRIGGER zz_cap_delivery_invoice_items
  AFTER INSERT OR UPDATE OF invoice_id, product_id, order_item_id, quantity ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_delivery_invoice_within_delivered();

DROP TRIGGER IF EXISTS zz_cap_delivery_invoice_header ON public.invoices;
CREATE TRIGGER zz_cap_delivery_invoice_header
  AFTER UPDATE OF delivery_id, invoice_type, deleted_at, status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.delivery_id IS NOT NULL
        AND NEW.invoice_type <> 'credit_memo'
        AND NEW.deleted_at IS NULL
        AND NEW.status NOT IN ('voided', 'cancelled')
        AND (NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
             OR NEW.invoice_type IS DISTINCT FROM OLD.invoice_type
             OR OLD.deleted_at IS NOT NULL
             OR OLD.status IN ('voided', 'cancelled')
             OR (NEW.status IN ('posted', 'paid', 'overdue') AND OLD.status IN ('draft', 'unposted'))))
  EXECUTE FUNCTION public.enforce_delivery_invoice_within_delivered();

DO $postflight$
DECLARE
  v_role text;
BEGIN
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgfoid = 'public.enforce_delivery_invoice_within_delivered()'::regprocedure
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND NOT t.tgdeferrable
         AND ((t.tgname = 'zz_cap_delivery_invoice_items' AND t.tgrelid = 'public.invoice_items'::regclass)
           OR (t.tgname = 'zz_cap_delivery_invoice_header' AND t.tgrelid = 'public.invoices'::regclass))) <> 2
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgfoid = 'public.enforce_delivery_invoice_within_delivered()'::regprocedure
            AND NOT t.tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_POSTFLIGHT: exactly the two cap triggers must be installed, enabled and immediate on their tables';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, 'public._delivery_invoice_overbilling(uuid)', 'EXECUTE')
       OR has_function_privilege(v_role, 'public.enforce_delivery_invoice_within_delivered()', 'EXECUTE') THEN
      RAISE EXCEPTION 'DELIVERY_INVOICE_CAP_POSTFLIGHT: % can execute a cap helper', v_role;
    END IF;
  END LOOP;
END
$postflight$;
