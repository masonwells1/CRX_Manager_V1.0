-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARKED MIGRATION — NOT YET APPLIED. Awaiting Mason's approval.            ║
-- ║ Nightly Debug Mission · Cycle 2 · 2026-06-15                              ║
-- ║ Finding: payment:allocate_payment:no-sum-le-total-guard                    ║
-- ║ Severity: HIGH (latent — silent AR overstatement via non-UI callers)      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHAT'S WRONG (verified live, project rhyzpcqhnizqbxphqdkr):
--   allocate_payment validates each allocation only against its OWN invoice balance
--   (v_alloc_cents > v_inv.balance_cents) but NEVER checks that the running total
--   v_sum_allocated stays <= the actual payment p_total_cents. After the loop:
--       v_prepay_cents := p_total_cents - v_sum_allocated;
--       IF v_prepay_cents > 0 THEN <create prepay> END IF;
--   If allocations across multiple invoices sum to MORE than the check amount, every
--   per-invoice check still passes, v_prepay_cents goes negative, prepay creation is
--   silently skipped, and the function RETURNS SUCCESS — invoices marked paid beyond the
--   cash actually received (AR understated, cash overstated, no error).
--   The only total guard lives in React (PaymentAllocation.tsx:252). offlineSync.ts:161
--   replays allocate_payment with raw queued params and bypasses it entirely.
--
-- THE FIX (ADDITIVE — deliberately does NOT reproduce the 6 KB allocate_payment body,
--          avoiding byte-drift risk; covers EVERY writer, not just allocate_payment):
--   A BEFORE INSERT/UPDATE trigger on allocation_sets that rejects
--   total_allocated_cents > total_payment_cents with a machine-readable token.
--   allocate_payment sets total_allocated_cents := v_sum_allocated via
--   `UPDATE allocation_sets ...`, so the trigger fires there and aborts the whole
--   transaction (rolling back the over-payments already written to invoices in the loop).
--   No false positives: void_invoice only DECREASES total_allocated_cents (recompute from
--   remaining allocations); void_payment never touches it.
--
-- VALIDATION:
--   • Function + trigger compiled against the live schema inside a rolled-back transaction
--     (DO block + final RAISE) — succeeded (sentinel VALIDATION_OK).
--   • Live census: allocation_sets has 0 rows, 0 rows violating the invariant, and NO
--     existing triggers — safe to add with no backfill conflict.
--
-- FRONTEND FOLLOW-UP (optional, separate green change): add ALLOCATIONS_EXCEED_PAYMENT to
--   RpcErrorCodes in src/lib/db.ts and surface a friendly toast on hasRpcCode().
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_enforce_allocation_not_over_payment ON public.allocation_sets;
--   DROP FUNCTION IF EXISTS public._enforce_allocation_not_over_payment();

CREATE OR REPLACE FUNCTION public._enforce_allocation_not_over_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.total_allocated_cents IS NOT NULL
     AND NEW.total_payment_cents IS NOT NULL
     AND NEW.total_allocated_cents > NEW.total_payment_cents THEN
    RAISE EXCEPTION 'ALLOCATIONS_EXCEED_PAYMENT: allocated % exceeds payment % (allocation_set %)',
      NEW.total_allocated_cents, NEW.total_payment_cents, NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_allocation_not_over_payment ON public.allocation_sets;
CREATE TRIGGER trg_enforce_allocation_not_over_payment
  BEFORE INSERT OR UPDATE OF total_allocated_cents, total_payment_cents ON public.allocation_sets
  FOR EACH ROW EXECUTE FUNCTION public._enforce_allocation_not_over_payment();
