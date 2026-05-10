-- ============================================================================
-- Audit fix sprint PR-22 (partial) — AP polish bundle
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-22)
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr).
-- ⚠️ DEPENDS ON PR-04 being applied first (UNIQUE constraint references
-- vendor_bills.deleted_at and the void columns added in PR-04).
--
-- Scope of this migration (3 of 6 plan items):
--   ✅ #4 — CHECK + UNIQUE constraints
--          - vendor_bills: total_cents = subtotal_cents + COALESCE(adjustment_cents, 0)
--          - vendor_payments: UNIQUE (vendor_bill_id, payment_method, reference_number)
--                             WHERE reference_number IS NOT NULL AND voided_at IS NULL
--   ✅ #5 — Drop pointless p_idempotency_key from get_ap_aging (read RPC)
--   ✅ #6 — Validate p_subtotal_cents > 0 in create_vendor_bill via a trigger
--          (instead of re-CREATE-OR-REPLACE'ing the whole 150-line PR-04 body
--          here, which would risk transcription drift). The trigger approach
--          is canonical for invariants of this kind and survives future
--          re-creates of the RPC.
--
-- Deferred to a future PR (PR-22b):
--   ⏸ #1 — PO cancel/delete: check linked vendor bills (requires modifying
--          cancel_purchase_order + delete_purchase_order; the latter was
--          touched in PR-10 and re-modifying here means transcribing its
--          full body)
--   ⏸ #2 — PO-to-bill amount soft warn (>5% off PO total) — requires
--          modifying create_vendor_bill (PR-04's body)
--   ⏸ #3 — PO-to-bill vendor consistency check — same
--
-- All three deferred items modify create_vendor_bill / cancel_purchase_order
-- bodies. Mason can address them in a follow-up PR after PR-04 + PR-10
-- are applied to live, where the live bodies are the source of truth.
-- ============================================================================

-- ─── #4a — vendor_bills total = subtotal + adjustment ─────────────────────

ALTER TABLE public.vendor_bills
  DROP CONSTRAINT IF EXISTS vendor_bills_total_check;

ALTER TABLE public.vendor_bills
  ADD CONSTRAINT vendor_bills_total_check
  CHECK (total_cents = subtotal_cents + COALESCE(adjustment_cents, 0));

-- ─── #4b — vendor_payments UNIQUE on (bill, method, reference) ────────────
-- Prevents duplicate payment rows when an admin double-clicks Record Payment
-- and the idempotency key didn't catch it (e.g., key reset between clicks).
-- Partial: only when reference_number is supplied AND payment is active.

DROP INDEX IF EXISTS idx_vendor_payments_unique_active_ref;
CREATE UNIQUE INDEX idx_vendor_payments_unique_active_ref
  ON public.vendor_payments (vendor_bill_id, payment_method, reference_number)
  WHERE reference_number IS NOT NULL AND voided_at IS NULL;

-- ─── #5 — Drop pointless idempotency key on get_ap_aging ──────────────────
-- Read-only RPC; the param has been ignored since creation. Frontend
-- (AccountsPayable.tsx) doesn't pass it, so dropping is non-breaking.

DROP FUNCTION IF EXISTS public.get_ap_aging(date, text);

CREATE OR REPLACE FUNCTION public.get_ap_aging(p_as_of_date date DEFAULT CURRENT_DATE)
RETURNS TABLE(
  vendor_id uuid,
  vendor_name text,
  current_amount bigint,
  days_31_60 bigint,
  days_61_90 bigint,
  over_90 bigint,
  total_outstanding bigint,
  bill_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id AS vendor_id,
    v.name AS vendor_name,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) <= 30 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS current_amount,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 31 AND 60 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_31_60,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 61 AND 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_61_90,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) > 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS over_90,
    COALESCE(SUM(vb.balance_cents), 0)::bigint AS total_outstanding,
    COUNT(vb.id)::integer AS bill_count
  FROM vendors v
  LEFT JOIN vendor_bills vb ON vb.vendor_id = v.id
    AND vb.status IN ('unpaid', 'partially_paid')
    AND vb.deleted_at IS NULL
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$$;

-- ─── #6 — vendor_bills positive subtotal trigger ──────────────────────────
-- Defense-in-depth: enforces subtotal > 0 at the table level, so any future
-- path that creates a vendor_bill (RPC, direct insert, future bulk-import)
-- gets the check. The PR-04 body checks this in create_vendor_bill, but
-- this guards against drift if create_vendor_bill is rewritten later
-- without preserving the validation.

CREATE OR REPLACE FUNCTION public.vendor_bills_positive_subtotal_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.subtotal_cents IS NULL OR NEW.subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: vendor_bill subtotal must be positive (got %)', NEW.subtotal_cents;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_bills_positive_subtotal ON public.vendor_bills;
CREATE TRIGGER trg_vendor_bills_positive_subtotal
  BEFORE INSERT OR UPDATE OF subtotal_cents ON public.vendor_bills
  FOR EACH ROW
  EXECUTE FUNCTION public.vendor_bills_positive_subtotal_trigger();

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_check_exists boolean;
  v_index_exists boolean;
  v_old_overload_count integer;
  v_new_overload_count integer;
  v_trigger_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vendor_bills'::regclass AND conname = 'vendor_bills_total_check'
  ) INTO v_check_exists;
  IF NOT v_check_exists THEN
    RAISE EXCEPTION 'PR-22 verification: vendor_bills_total_check constraint not added';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_vendor_payments_unique_active_ref'
  ) INTO v_index_exists;
  IF NOT v_index_exists THEN
    RAISE EXCEPTION 'PR-22 verification: idx_vendor_payments_unique_active_ref not created';
  END IF;

  SELECT count(*) INTO v_old_overload_count
  FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='get_ap_aging'
    AND pg_get_function_identity_arguments(oid) LIKE '%p_idempotency_key%';
  IF v_old_overload_count > 0 THEN
    RAISE EXCEPTION 'PR-22 verification: get_ap_aging old overload with p_idempotency_key still exists';
  END IF;

  SELECT count(*) INTO v_new_overload_count
  FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='get_ap_aging';
  IF v_new_overload_count <> 1 THEN
    RAISE EXCEPTION 'PR-22 verification: expected 1 get_ap_aging overload, found %', v_new_overload_count;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_vendor_bills_positive_subtotal'
      AND tgrelid = 'public.vendor_bills'::regclass
  ) INTO v_trigger_exists;
  IF NOT v_trigger_exists THEN
    RAISE EXCEPTION 'PR-22 verification: trg_vendor_bills_positive_subtotal not created';
  END IF;

  RAISE NOTICE 'PR-22 verification passed: 3 of 6 polish items applied; #1, #2, #3 deferred.';
END;
$$;
