-- 20260811060000_require_completed_delivery_before_invoice_post.sql
-- STATUS: PARKED DRAFT - NOT APPLIED
--
-- Wave A fix #5 of the 2026-08-09 ordering-cycle review.
-- Finding: an invoice that is tied to a delivery can be POSTED — turned into a
-- real, collectable bill — before that delivery has actually happened.
--
-- PLAIN ENGLISH
-- Mason's decision, 2026-08-11: a customer does not get hard-billed until the
-- goods have actually moved. Money taken up front is prepay credit, which is a
-- separate thing entirely and does not go through invoices at all — so gating
-- the POST does not interfere with getting paid early.
--
-- THE HOLE, exactly as it exists on production today.
-- `create_quick_delivery` writes the delivery row with status 'scheduled' and,
-- in the same call, creates its draft invoice pointing at that delivery. So a
-- draft bill exists for goods still sitting in the warehouse. Nothing between
-- that moment and posting checks whether the delivery ever happened, so the
-- office can post it and send it.
--
-- WHY THAT IS A MONEY BUG AND NOT JUST AN ORDERING PREFERENCE.
-- The draft is created at ORDERED quantity. `_complete_delivery_authorized_impl`
-- is what corrects an invoice down to the quantity actually delivered — and its
-- adjustment loop only touches invoices whose status is still 'draft'. Post
-- first and that correction silently skips the invoice: the customer is billed
-- for the full order even if half of it never left. The line-share snapshot
-- trigger `trg_snapshot_line_shares_on_post` freezes the split at post time as
-- well, so the damage is not confined to the header.
--
-- WHY THE FIX GOES HERE AND NOT IN THE ADJUSTMENT LOOP.
-- Widening that loop to also rewrite POSTED invoices would mean rewriting a bill
-- the customer has already been sent, and it would fight the snapshot trigger.
-- The honest fix is the other direction: make the early post impossible, at
-- which point the loop's draft-only restriction is correct rather than a gap.
--
-- WHY THIS ONE FUNCTION COVERS EVERY POSTING PATH.
-- `_post_invoice_impl_20260714` is the single place that flips an invoice to
-- 'posted'. Verified read-only against production 2026-08-11: exactly two
-- functions in `public` reference it — `_post_invoice_customer_scope_impl` and
-- `_post_invoice_group_customer_scope_impl` — and all three user-facing entry
-- points funnel through those:
--   post_invoice        -> _post_invoice_idem_impl_20260721
--                       -> _post_invoice_public_impl_20260718
--                       -> _post_invoice_customer_scope_impl   -> THIS
--   post_invoice_group  -> _post_invoice_group_customer_scope_impl -> THIS
--   batch_post_invoices -> loops over post_invoice                 -> THIS
-- One CREATE OR REPLACE therefore closes all three. The precondition asserts the
-- caller count so a future fourth caller cannot quietly appear outside the gate.
--
-- THE ONE FUNCTION THAT WRITES status='posted' WITHOUT GOING THROUGH HERE is
-- `_post_deleted_delivery_recovery_invoice_20260719`, and it already refuses
-- unless the delivery is 'completed'. It is not changed; the precondition
-- asserts that its own check is still in place, so the two paths cannot drift
-- apart.
--
-- WHAT THIS DELIBERATELY DOES NOT GATE, and why.
-- Only invoices that carry a `delivery_id` are gated. Three other shapes exist
-- and are left alone:
--   * Job / application / standalone invoices (no order, no delivery). There is
--     no delivery to wait for; billing is driven by the work being done.
--   * Order-level invoices with no delivery at all. This shape is created by
--     `_create_invoice_from_order_impl_20260718`, which REFUSES to run if the
--     order has any active delivery — it is the deliberate "cancel the
--     deliveries and bill the whole order by hand" escape. Gating it on order
--     status was considered and rejected: every writer of `orders.status` on
--     production is delivery-driven (`_complete_delivery_authorized_impl`,
--     `cancel_delivery`, `void_delivery`, `_close_undelivered_order_remainder`,
--     plus cancel/void order), so an order with no deliveries can never reach
--     'fulfilled'. A gate on that column would make this shape permanently
--     unpostable — a worse bug than the one being fixed. It has never been used
--     on production (0 rows on 2026-08-11) and is left for a later decision.
--   * Credit memos and finance charges, which carry neither.
--
-- WHAT CHANGES FOR THE OFFICE
-- Nothing they do today starts failing. Verified read-only 2026-08-11: all 13
-- live invoices are either delivery-linked (10) or carry neither an order nor a
-- delivery (3), and every one of those 10 already points at a delivery that is
-- 'completed' and not deleted. The gate blocks nothing that currently exists.
-- Going forward, a quick-delivery bill has to wait for the driver to mark the
-- delivery complete — which is the same click that corrects it to what actually
-- went out. If the delivery was cancelled or voided, the refusal message says to
-- void the draft rather than post it.
--
-- LOCKING, stated because it is a deliberate choice rather than an oversight.
-- The delivery row is read WITHOUT a lock. The caller already holds FOR UPDATE
-- on the invoice, and `_complete_delivery_authorized_impl` locks the delivery
-- before the invoice; taking a delivery lock here would reverse that order and
-- introduce a deadlock between posting and completing. The residual race — a
-- delivery voided in the instant between this read and the UPDATE — leaves the
-- same outcome as today, and `void_delivery` has its own handling for an invoice
-- that is already posted.
--
-- PROOF. The postcondition block below does not merely re-read the catalog. It
-- picks a real delivery-linked draft invoice, flips its delivery to 'scheduled',
-- to 'cancelled', and to soft-deleted in turn, and watches the post be refused
-- each time; then restores the delivery and watches an ordinary post SUCCEED, so
-- the gate is proven not to have broken normal billing. Everything is inside a
-- subtransaction that is rolled back, and the rollback is proven by fingerprints
-- taken over `invoices` and `deliveries` before and after. The probe forges
-- `request.jwt.claims` locally to stand in for a signed-in admin session; that
-- GUC is transaction-local and is cleared before the block ends.

SET statement_timeout = '60s';
SET lock_timeout = '10s';

DO $precond$
DECLARE
  v_count int;
  v_md5   text;
  v_names text;
BEGIN
  -- The function being replaced must exist exactly once. A second overload would
  -- mean the CREATE OR REPLACE below silently creates a THIRD, leaving an
  -- ungated copy reachable.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _post_invoice_impl_20260714, found %. Resolve the overloads before applying.', v_count;
  END IF;

  -- DRIFT GUARD. The replacement below is the live body read on 2026-08-11 with
  -- the gate inserted and nothing else touched. If the live body has changed
  -- since, applying would silently revert whatever changed. Fail closed and make
  -- a human re-derive rather than clobber someone else's fix.
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714';
  IF v_md5 = '9479af0a5477e89266e0264da44c766c' THEN
    NULL;  -- expected body
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
       AND position('WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11' in p.prosrc) > 0
  ) THEN
    RAISE NOTICE 'PRECOND: the delivery-before-billing gate is already installed — re-applying is a no-op';
  ELSE
    RAISE EXCEPTION 'PRECOND: the live body of _post_invoice_impl_20260714 has drifted [md5 % , expected 9479af0a5477e89266e0264da44c766c]. Re-read the live body, rebase this replacement onto it, and update this hash — do not apply a stale copy over someone else''s change.', v_md5;
  END IF;

  -- Every posting path must funnel through the function being gated. Two callers
  -- were verified live on 2026-08-11; a third would be a path outside the gate.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname), count(*)
    INTO v_names, v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ILIKE '%_post_invoice_impl_20260714%'
     AND p.proname <> '_post_invoice_impl_20260714';
  IF v_count <> 2
     OR v_names IS DISTINCT FROM '_post_invoice_customer_scope_impl, _post_invoice_group_customer_scope_impl' THEN
    RAISE EXCEPTION 'PRECOND: expected exactly the two known callers of _post_invoice_impl_20260714, found % [%]. A new caller may be a posting path this gate would not cover — re-derive before applying.', v_count, coalesce(v_names, 'none');
  END IF;

  -- The one path that writes status=''posted'' without going through the function
  -- being gated must keep enforcing the same rule itself, or the two drift apart.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_post_deleted_delivery_recovery_invoice_20260719'
     AND p.prosrc ~* 'status\s*(<>|!=)\s*''completed''|status\s*=\s*''completed''';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: _post_deleted_delivery_recovery_invoice_20260719 no longer checks the delivery status, so it would become an ungated posting path. Re-derive before applying.';
  END IF;

  -- Any OTHER function that writes status=''posted'' onto invoices is a path this
  -- migration does not know about. Two are expected: the function being gated and
  -- the recovery path above.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname), count(*)
    INTO v_names, v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* 'UPDATE\s+(ONLY\s+)?[a-z_."%]*\minvoices\M[^;]*\mset\M[^;]*\mstatus\s*=\s*''posted'''
     AND p.proname NOT IN ('_post_invoice_impl_20260714', '_post_deleted_delivery_recovery_invoice_20260719');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND: % other function[s] write invoices.status = posted and would bypass this gate: %. Re-derive before applying.', v_count, v_names;
  END IF;

  -- The columns the gate reads.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'deliveries'
     AND column_name IN ('status', 'deleted_at', 'delivery_number');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'PRECOND: deliveries is missing one of status/deleted_at/delivery_number [found % of 3]', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'delivery_id';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: invoices.delivery_id does not exist, so there is nothing to gate on';
  END IF;

  -- ''completed'' must still be a legal delivery status, or the gate would refuse
  -- every post.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.deliveries'::regclass
       AND c.conname = 'deliveries_status_check'
       AND pg_get_constraintdef(c.oid) LIKE '%''completed''%'
  ) THEN
    RAISE EXCEPTION 'PRECOND: deliveries_status_check no longer admits ''completed'' — this gate would refuse every delivery-linked post.';
  END IF;

  -- The retroactive-invoice path already refuses a non-completed delivery. Assert
  -- it, because this migration''s header cites it as proof that requiring
  -- completion is the established rule rather than a new restriction.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_create_invoice_for_unbilled_delivery_impl_20260718'
     AND p.prosrc ~* 'status\s*(<>|!=)\s*''completed''';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: _create_invoice_for_unbilled_delivery_impl_20260718 no longer requires a completed delivery. Re-derive this migration''s reasoning before applying.';
  END IF;

  -- How many existing drafts this gate would make temporarily unpostable. This is
  -- a NOTICE, not a failure: a quick-delivery draft waiting on its delivery is
  -- exactly the state the gate exists to hold. The applier should still see the
  -- number rather than discover it from a support call.
  SELECT count(*) INTO v_count
    FROM invoices i JOIN deliveries d ON d.id = i.delivery_id
   WHERE i.status IN ('draft', 'unposted')
     AND (d.status <> 'completed' OR d.deleted_at IS NOT NULL);
  IF v_count > 0 THEN
    RAISE NOTICE 'PRECOND: % existing draft invoice[s] point at a delivery that is not completed and will not be postable until it is. This is the intended behaviour.', v_count;
  ELSE
    RAISE NOTICE 'PRECOND: no existing draft invoice is blocked by this gate';
  END IF;
END;
$precond$;

-- ---------------------------------------------------------------------------
-- The gate. This is the live body read from production on 2026-08-11 with the
-- WAVE-A-DELIVERY-BEFORE-BILLING block inserted and NOTHING else changed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._post_invoice_impl_20260714(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_inv record; v_order_status text; v_order_pricing text; v_existing jsonb; v_terms_days integer;  -- A8: v_terms_days added
  v_del_status text; v_del_deleted timestamptz; v_del_number text;  -- fix #5
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  -- PRICING_INCOMPLETE gate (sell-side #2): never post an invoice for a still-
  -- unpriced rush order. Cleared by price_order (v2). Dormant until v1b.
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status, pricing_status INTO v_order_status, v_order_pricing FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
    IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  END IF;

  -- WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11 (Wave A fix #5).
  -- Do not turn a delivery-linked draft into a real bill until the goods have
  -- actually moved. create_quick_delivery creates the draft alongside a
  -- 'scheduled' delivery, and completing that delivery is also what corrects the
  -- invoice down to the quantity actually delivered — a correction that only
  -- runs while the invoice is still a draft. Posting first would freeze the
  -- customer at the full ordered quantity.
  -- The delivery row is read without a lock on purpose: the invoice is already
  -- locked above, and _complete_delivery_authorized_impl takes the delivery lock
  -- BEFORE the invoice, so locking here would reverse that order and deadlock.
  IF v_inv.delivery_id IS NOT NULL THEN
    SELECT d.status, d.deleted_at, d.delivery_number
      INTO v_del_status, v_del_deleted, v_del_number
      FROM deliveries d
     WHERE d.id = v_inv.delivery_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DELIVERY_MISSING: invoice % points at delivery %, which no longer exists. A bill whose delivery record is gone must not be posted.', v_inv.invoice_number, v_inv.delivery_id;
    END IF;
    IF v_del_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: delivery % for invoice % has been deleted, so nothing was delivered against this bill. Void this draft instead of posting it.', v_del_number, v_inv.invoice_number;
    END IF;
    IF v_del_status <> 'completed' THEN
      RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: delivery % for invoice % is "%", not completed. Complete the delivery first — that same step also corrects this invoice to the quantities actually delivered. If the delivery was cancelled or voided, void this draft rather than posting it.', v_del_number, v_inv.invoice_number, v_del_status;
    END IF;
  END IF;

  -- A8: derive due_date from the payment terms; default Net 30 when blank/unparseable.
  -- The invoice-level override (invoices.payment_terms — the documented per-invoice terms that
  -- the PDF prints) WINS over the customer default; fall back to customers.payment_terms when
  -- the invoice override is blank. Applied only-when-NULL in the UPDATE below so a due_date set
  -- at creation (field-app +30) is preserved, and forward-only (runs at post time).
  SELECT parse_payment_terms_days(COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms))
    INTO v_terms_days
  FROM customers c WHERE c.id = v_inv.customer_id;

  SET LOCAL app.admin_override = 'true';
  UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now(),
    due_date = COALESCE(due_date, (v_inv.invoice_date + (v_terms_days || ' days')::interval)::date)  -- A8
    WHERE id = p_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$function$;

DO $postcond$
DECLARE
  v_count       int;
  v_applier     text;
  v_admin_id    uuid;
  v_invoice_id  uuid;
  v_delivery_id uuid;
  v_fp_inv_before  text;
  v_fp_inv_after   text;
  v_fp_del_before  text;
  v_fp_del_after   text;
  v_blocked     boolean;
  v_status      text;
BEGIN
  -- Shape checks first: the gate is worthless if the function lost its elevated
  -- rights or its pinned search_path in the replace.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: _post_invoice_impl_20260714 now has % definitions rather than 1 — an ungated overload may be reachable', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp'];
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: _post_invoice_impl_20260714 lost SECURITY DEFINER or its pinned search_path';
  END IF;

  -- The gate is present, and the pre-existing behaviour it was inserted around
  -- survived the replace. These are the parts a careless re-emit would drop.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
     AND position('WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11' in p.prosrc) > 0
     AND position('DELIVERY_NOT_COMPLETED' in p.prosrc) > 0
     AND position('parse_payment_terms_days' in p.prosrc) > 0
     AND position('PRICING_INCOMPLETE' in p.prosrc) > 0
     AND position('check_period_open' in p.prosrc) > 0
     AND position('generate_rup_sales_records' in p.prosrc) > 0
     AND position('save_idempotency' in p.prosrc) > 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: the replacement is missing the new gate or dropped pre-existing behaviour (due dates, pricing gate, period check, RUP records or idempotency)';
  END IF;

  -- --------------------------------------------------------------------------
  -- Behavioural probe. Everything written below is rolled back, and the rollback
  -- is proven by the two fingerprint comparisons at the end.
  -- --------------------------------------------------------------------------
  v_applier := current_user;

  SELECT md5(coalesce(string_agg(id::text || '=' || status || '/' || coalesce(posted_at::text, 'NULL') || '/' || coalesce(due_date::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_inv_before FROM public.invoices;
  SELECT md5(coalesce(string_agg(id::text || '=' || status || '/' || coalesce(deleted_at::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_del_before FROM public.deliveries;

  SELECT id INTO v_admin_id
    FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'POSTCOND PROBE: no active admin profile exists, so posting cannot be exercised. Do not install a billing gate without watching it refuse and allow.';
  END IF;

  -- A draft invoice whose delivery is completed AND which nothing else would
  -- refuse, so a failure in the allow-arm can only be this gate.
  SELECT i.id, i.delivery_id INTO v_invoice_id, v_delivery_id
    FROM public.invoices i
    JOIN public.deliveries d ON d.id = i.delivery_id
    LEFT JOIN public.orders o ON o.id = i.order_id
   WHERE i.status = 'draft'
     AND d.status = 'completed'
     AND d.deleted_at IS NULL
     AND COALESCE(i.pricing_pending, false) = false
     AND COALESCE(o.status, 'confirmed') <> 'cancelled'
     AND COALESCE(o.pricing_status, 'priced') <> 'needs_pricing'
   ORDER BY i.id LIMIT 1;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'POSTCOND PROBE: no postable delivery-linked draft invoice exists, so neither arm of this gate can be exercised. Do not install it unproven.';
  END IF;

  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L', json_build_object('sub', v_admin_id)::text);

    -- (a) a delivery that has not happened yet must refuse the post. This is the
    -- create_quick_delivery shape and the whole reason this migration exists.
    FOREACH v_status IN ARRAY ARRAY['scheduled', 'in_progress', 'cancelled', 'voided'] LOOP
      UPDATE public.deliveries SET status = v_status WHERE id = v_delivery_id;
      v_blocked := false;
      BEGIN
        PERFORM public._post_invoice_impl_20260714(v_invoice_id);
        RAISE EXCEPTION 'POSTCOND PROBE: the gate ALLOWED a post while its delivery was "%"', v_status;
      EXCEPTION
        WHEN OTHERS THEN
          IF SQLERRM NOT LIKE 'DELIVERY_NOT_COMPLETED%' THEN RAISE; END IF;
          v_blocked := true;
      END;
      IF NOT v_blocked THEN
        RAISE EXCEPTION 'POSTCOND PROBE: the refuse path did not run for delivery status "%"', v_status;
      END IF;
    END LOOP;

    -- (b) a soft-deleted delivery must refuse even while its status still reads
    -- 'completed'. Without this arm the gate would pass a bill for a delivery the
    -- office had already retracted.
    UPDATE public.deliveries SET status = 'completed', deleted_at = now() WHERE id = v_delivery_id;
    v_blocked := false;
    BEGIN
      PERFORM public._post_invoice_impl_20260714(v_invoice_id);
      RAISE EXCEPTION 'POSTCOND PROBE: the gate ALLOWED a post against a soft-deleted delivery';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'DELIVERY_NOT_COMPLETED%' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the soft-delete refuse path did not run';
    END IF;

    -- (c) THE ALLOW ARM. Restore the delivery and post for real. A gate that only
    -- ever refuses is indistinguishable from a broken function, so ordinary
    -- billing is proven to still work before this migration is allowed to stand.
    UPDATE public.deliveries SET status = 'completed', deleted_at = NULL WHERE id = v_delivery_id;
    BEGIN
      PERFORM public._post_invoice_impl_20260714(v_invoice_id);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'POSTCOND PROBE: an ordinary post against a COMPLETED delivery failed [%]. This gate has broken normal billing — do not apply it.', SQLERRM;
    END;
    SELECT status INTO v_status FROM public.invoices WHERE id = v_invoice_id;
    IF v_status <> 'posted' THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the allowed post left the invoice at "%" rather than posted', v_status;
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PROBE_OK_ROLLBACK';
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('request.jwt.claims', '', true);
      IF SQLERRM <> 'PROBE_OK_ROLLBACK' THEN RAISE; END IF;
  END;

  IF current_user <> v_applier THEN
    RAISE EXCEPTION 'POSTCOND PROBE: the probe failed to restore role % [now %]', v_applier, current_user;
  END IF;

  -- Prove the probe left nothing behind on either table it touched.
  SELECT md5(coalesce(string_agg(id::text || '=' || status || '/' || coalesce(posted_at::text, 'NULL') || '/' || coalesce(due_date::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_inv_after FROM public.invoices;
  SELECT md5(coalesce(string_agg(id::text || '=' || status || '/' || coalesce(deleted_at::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_del_after FROM public.deliveries;
  IF v_fp_inv_after IS DISTINCT FROM v_fp_inv_before THEN
    RAISE EXCEPTION 'POSTCOND: the probe changed live invoices — the rollback did not hold [% -> %]', v_fp_inv_before, v_fp_inv_after;
  END IF;
  IF v_fp_del_after IS DISTINCT FROM v_fp_del_before THEN
    RAISE EXCEPTION 'POSTCOND: the probe changed live deliveries — the rollback did not hold [% -> %]', v_fp_del_before, v_fp_del_after;
  END IF;
END;
$postcond$;

RESET statement_timeout;
RESET lock_timeout;
