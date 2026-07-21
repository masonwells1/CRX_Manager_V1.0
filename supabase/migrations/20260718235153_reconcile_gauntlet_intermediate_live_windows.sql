-- Gauntlet sections 2-6 closeout: prove that neither temporary live-function
-- window left durable business-history damage before its forward correction.
--
-- The half-open UTC bounds below are the server-assigned Supabase migration
-- ledger versions for the vulnerable definition and its correction. These
-- checks deliberately fail closed and identify every affected entity chain;
-- an operator must investigate any named row instead of silently continuing.
-- This migration performs no repair and changes no schema or business data.

DO $reconcile$
DECLARE
  v_quote_chains jsonb;
  v_invoice_voids jsonb;
  v_missing_payment_history jsonb;
BEGIN
  -- B2: the first escape hatch could reopen an accepted quote whose cancelled
  -- source order already had durable history. Every accepted -> sent call is
  -- audited by revert_quote_status, so enumerate all such calls made before
  -- the history guard replaced that definition. Any row requires manual review
  -- of both the quote and every order made from it.
  SELECT jsonb_agg(
           jsonb_build_object(
             'audit_id', fal.id,
             'reverted_at', fal.created_at,
             'quote_id', fal.entity_id,
             'quote_number', q.quote_number,
             'current_quote_status', q.status,
             'order_ids', COALESCE((
               SELECT jsonb_agg(o.id ORDER BY o.created_at, o.id)
                 FROM public.orders o
                WHERE o.quote_id = fal.entity_id
             ), '[]'::jsonb)
           )
           ORDER BY fal.created_at, fal.id
         )
    INTO v_quote_chains
    FROM public.financial_audit_log fal
    LEFT JOIN public.quotes q ON q.id = fal.entity_id
   WHERE fal.operation_type = 'quote_status_reverted'
     AND fal.entity_type = 'quote'
     AND fal.old_values->>'status' = 'accepted'
     AND fal.created_at >= timestamptz '2026-07-18 15:28:37+00'
     AND fal.created_at <  timestamptz '2026-07-18 23:21:57+00';

  IF v_quote_chains IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'GAUNTLET_B2_INTERMEDIATE_REOPEN_REVIEW_REQUIRED: ' || v_quote_chains::text;
  END IF;

  -- H3: the intermediate void_invoice body deleted inactive payment-allocation
  -- history. Its audit record states the amount deleted, so any invoice void in
  -- that exact live window with allocations_reversed_cents > 0 is an exposure.
  SELECT jsonb_agg(
           jsonb_build_object(
             'audit_id', fal.id,
             'voided_at', fal.created_at,
             'invoice_id', fal.entity_id,
             'invoice_number', i.invoice_number,
             'allocations_reversed_cents', fal.new_values->>'allocations_reversed_cents'
           )
           ORDER BY fal.created_at, fal.id
         )
    INTO v_invoice_voids
    FROM public.financial_audit_log fal
    LEFT JOIN public.invoices i ON i.id = fal.entity_id
   WHERE fal.operation_type = 'invoice_voided'
     AND fal.entity_type = 'invoice'
     AND fal.created_at >= timestamptz '2026-07-18 21:33:05+00'
     AND fal.created_at <  timestamptz '2026-07-18 22:15:05+00'
     AND COALESCE((fal.new_values->>'allocations_reversed_cents')::bigint, 0) > 0;

  IF v_invoice_voids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'GAUNTLET_H3_INTERMEDIATE_VOID_REVIEW_REQUIRED: ' || v_invoice_voids::text;
  END IF;

  -- Belt-and-suspenders reconciliation independent of the vulnerable window:
  -- a voided payment's audit row preserves its original allocated cents. An
  -- inactive payment set with fewer line-history cents than that audit amount
  -- has lost provenance and must be reviewed instead of being accepted.
  WITH latest_payment_void AS (
    SELECT DISTINCT ON (fal.entity_id)
           fal.entity_id AS allocation_set_id,
           fal.created_at AS voided_at,
           COALESCE((fal.old_values->>'total_allocated_cents')::bigint, 0) AS audited_allocated_cents
      FROM public.financial_audit_log fal
     WHERE fal.operation_type = 'payment_voided'
       AND fal.entity_type = 'allocation_set'
     ORDER BY fal.entity_id, fal.created_at DESC
  ), reconciled AS (
    SELECT aset.id AS allocation_set_id,
           lpv.voided_at,
           lpv.audited_allocated_cents,
           COALESCE(SUM(ila.amount_cents), 0)::bigint AS line_history_cents,
           COUNT(ila.id)::bigint AS line_history_count
      FROM public.allocation_sets aset
      JOIN latest_payment_void lpv ON lpv.allocation_set_id = aset.id
      LEFT JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = aset.id
     WHERE aset.entity_type = 'payment'
       AND aset.is_active = false
     GROUP BY aset.id, lpv.voided_at, lpv.audited_allocated_cents
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'allocation_set_id', allocation_set_id,
             'voided_at', voided_at,
             'audited_allocated_cents', audited_allocated_cents,
             'line_history_cents', line_history_cents,
             'line_history_count', line_history_count
           )
           ORDER BY voided_at, allocation_set_id
         )
    INTO v_missing_payment_history
    FROM reconciled
   WHERE audited_allocated_cents > 0
     AND line_history_cents <> audited_allocated_cents;

  IF v_missing_payment_history IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'GAUNTLET_H3_PAYMENT_HISTORY_REVIEW_REQUIRED: ' || v_missing_payment_history::text;
  END IF;
END;
$reconcile$;
