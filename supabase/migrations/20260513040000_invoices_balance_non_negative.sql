-- 20260513040000 — invoices.balance_cents non-negative CHECK (audit #19)
--
-- Closes audit finding #19. The original audit named this "negative balance
-- credit memos" — the codebase has no `credit_memos` table; "credit memos" are
-- `invoices` rows created by `issue_return_credit` (returns).
--
-- Existing CHECKs:
--   - invoices_total_non_negative   CHECK (total_amount_cents >= 0)
--   - invoices_paid_non_negative    CHECK (paid_amount_cents >= 0)
-- Missing:
--   - balance_cents (GENERATED ALWAYS AS total - paid - prepay_applied) had no
--     guard. Live `allocate_payment` already caps at the invoice's outstanding
--     balance, so a negative balance shouldn't happen — but defense in depth.
--     If a future code path mis-allocates and tries to over-pay, the constraint
--     rejects the write at the database boundary instead of silently persisting
--     phantom customer credit.
--
-- Live data verification (run before VALIDATE):
--   `SELECT count(*) FROM invoices WHERE balance_cents < 0` = 0
-- Therefore safe to add VALIDATED in a single step.

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_balance_non_negative CHECK (balance_cents >= 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.invoices'::regclass
       AND conname = 'invoices_balance_non_negative'
       AND contype = 'c'
       AND convalidated = true
  ) THEN
    RAISE EXCEPTION 'verify failed: invoices_balance_non_negative not present or not validated';
  END IF;
END$$;
