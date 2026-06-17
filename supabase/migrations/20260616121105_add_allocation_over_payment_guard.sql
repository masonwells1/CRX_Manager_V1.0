-- Fix (HIGH): allocate_payment validates each allocation only against its own invoice balance,
-- never that the SUM of allocations stays <= the actual payment (p_total_cents). On over-allocation
-- v_prepay_cents goes negative, prepay creation is silently skipped, and the RPC returns success —
-- invoices marked paid beyond the cash received. The only total guard lives in React
-- (PaymentAllocation.tsx); offlineSync.ts replays allocate_payment with raw params and bypasses it.
--
-- Fix (ADDITIVE — no reproduction of the 6 KB allocate_payment): a BEFORE INSERT/UPDATE trigger on
-- allocation_sets that rejects total_allocated_cents > total_payment_cents with a machine-readable
-- token. allocate_payment sets total_allocated_cents via `UPDATE allocation_sets`, so the trigger
-- fires there and aborts the whole transaction. Covers every writer. No false positives:
-- void_invoice only DECREASES total_allocated_cents; void_payment never touches it.
-- Source: nightly-debug (PARKED-02), Codex-reviewed. Live census: 0 allocation_sets rows, 0
-- violations, no existing triggers on the table.
-- Rollback:
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
