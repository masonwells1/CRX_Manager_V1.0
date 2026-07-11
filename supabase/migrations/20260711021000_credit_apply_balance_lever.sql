-- Credit-memo apply — Migration 1 of 5: the balance lever
-- =========================================================
-- Adds a fifth ingredient to invoices.balance_cents so an existing credit memo can be
-- APPLIED to an existing open invoice (net-zero on customer AR; moves the shorted invoice
-- to paid and consumes the credit). Design + Codex BLOCKER review:
--   docs/audits/credit-memo-apply-design-2026-07-08.md
--   docs/audits/credit-memo-apply-CODEX-REVIEW-2026-07-08.md   (blockers #1, #2, #8)
--
-- SAFE-TO-REDEFINE facts verified live 2026-07-10 (project rhyzpcqhnizqbxphqdkr):
--   * 0 credit_memo invoices, ~0 posted invoices  → no data to migrate, no live-data risk.
--   * balance_cents pg_depend inventory: ONLY invoices_balance_non_negative depends on it
--     (0 dependent views, 0 dependent indexes, 0 rules, no trigger fires OF balance_cents).
--     Dropping the column auto-drops that CHECK; we recreate it below.
--   * credit_applied_cents defaults 0 and the formula is type-aware, so EVERY existing row's
--     balance_cents is byte-identical after the redefine (asserted transactionally below).
--
-- Codex #2: use ONE NON-NEGATIVE column on both row types and make the FORMULA type-aware
-- (a signed column could silently change AR with no constraint to catch a wrong sign).

SET LOCAL lock_timeout = '5s';

-- Snapshot every current balance BEFORE the redefine so we can prove value-preservation.
CREATE TEMP TABLE _bal_before ON COMMIT DROP AS
  SELECT id, balance_cents FROM public.invoices;

-- 1. The new lever. Non-negative on BOTH row types (Codex #2, #8).
ALTER TABLE public.invoices
  ADD COLUMN credit_applied_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_credit_applied_non_negative
  CHECK (credit_applied_cents >= 0);

-- 2. Redefine the generated balance column, type-aware.
--    DROP auto-removes the dependent invoices_balance_non_negative CHECK (no CASCADE needed;
--    it is a column-internal dependency). Verified there is nothing else to cascade to.
ALTER TABLE public.invoices DROP COLUMN balance_cents;

ALTER TABLE public.invoices
  ADD COLUMN balance_cents bigint
  GENERATED ALWAYS AS (
    (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)
    + CASE WHEN invoice_type = 'credit_memo'
             THEN credit_applied_cents      -- consume the memo: negative balance rises toward 0
             ELSE -credit_applied_cents END  -- reduce a real invoice: balance falls toward 0
  ) STORED;

-- 3. Recreate the CHECK dropped with the column (credit-memo exemption preserved),
--    and add the sign/type guards from Codex #2.
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_balance_non_negative
  CHECK ((invoice_type = 'credit_memo') OR (balance_cents >= 0));

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_credit_memo_balance_nonpositive
  CHECK ((invoice_type <> 'credit_memo') OR (balance_cents <= 0));

-- Codex MED: force a credit memo's TOTAL to be non-positive. The existing
-- invoices_total_non_negative only EXEMPTS credit memos (it never bounds them the other way),
-- so a malformed positive-total memo was schema-valid. 0 credit memos exist live and
-- issue_return_credit always writes a negative total (void sets it to 0), so no row violates this.
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_credit_memo_total_nonpositive
  CHECK ((invoice_type <> 'credit_memo') OR (total_amount_cents <= 0));

ANALYZE public.invoices;

-- 4. Prove the redefine changed no existing balance and dropped/added no rows.
DO $$
DECLARE
  v_before  bigint;
  v_after   bigint;
  v_drift   bigint;
BEGIN
  SELECT count(*) INTO v_before FROM _bal_before;
  SELECT count(*) INTO v_after  FROM public.invoices;
  IF v_before <> v_after THEN
    RAISE EXCEPTION 'ROWCOUNT_DRIFT after balance_cents redefine: % -> %', v_before, v_after;
  END IF;

  SELECT count(*) INTO v_drift
    FROM public.invoices i
    JOIN _bal_before b USING (id)
   WHERE i.balance_cents IS DISTINCT FROM b.balance_cents;
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'BALANCE_DRIFT: % row(s) changed balance_cents across the redefine', v_drift;
  END IF;
END $$;

COMMENT ON COLUMN public.invoices.credit_applied_cents IS
  'Non-negative credit-memo application lever. On a credit_memo it is the total applied out '
  '(raises the negative balance toward 0); on a real invoice it is the total credit received '
  '(lowers the balance). Written ONLY by apply_credit_memo_to_invoice / '
  'reverse_credit_memo_application. Reconciles to SUM of unreversed credit_memo_applications.';
