-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix Phase 1 / Packet 6 wire). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review. CONFIRMED by Mason 2026-07-02:
-- allow 'wire' + standardize the payment-method vocabulary; keep 'direct_deposit' on the
-- commission screen so nothing breaks.
--
-- WHAT: standardize payment methods to {check, ach, cash, credit_card, wire, other}:
--       (1) the dead 'payments' table's CHECK bans 'wire' — rewrite it to the 6-value set;
--       (2) the three LIVE payment tables (allocation_sets, vendor_payments, commission_payments)
--           have NO method CHECK — add one now while they are empty/tiny (zero-backfill moment);
--       (3) commission_payments also allows 'direct_deposit' (its UI offers it — keep it working).
-- WHY:  'wire' was only ever banned on the orphaned 'payments' table; the live customer-AR path
--        (allocate_payment -> allocation_sets) already accepts anything. Locking the live tables
--        to one shared vocabulary prevents future free-typed method typos. Grounding: existing
--        live method values are only 'check' (8 commission + 2 vendor), a subset of the new sets.
-- SCOPE: 1 DROP+ADD CHECK (payments, NOT NULL col) + 3 ADD CHECK (nullable cols -> allow NULL).
--        Does NOT drop the dead 'payments' table (still read by close_accounting_period /
--        get_customer_statement / get_monthly_summary — a separate de-dup project; drops are
--        irreversible). record_invoice_payment stays dormant (no UI caller).
--
-- SMOKE (2026-07-02, live tx aborted via RAISE — NOTHING persisted): all 4 method CHECKs
--   created (constraints=4); payments CHECK now allows 'wire' (payments_allows_wire=1); the
--   existing live method values (only 'check': 8 commission + 2 vendor) pass every new CHECK.
-- CODEX: <PENDING — /codex-review this session>
-- ============================================================================

-- (1) Dead 'payments' table: replace its method CHECK with the 6-value superset (adds 'wire').
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method = ANY (ARRAY['check','ach','cash','credit_card','wire','other']));

-- (2) allocation_sets (live customer-AR path; nullable method; currently 0 rows).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.allocation_sets'::regclass AND conname='allocation_sets_payment_method_check') THEN
    ALTER TABLE public.allocation_sets
      ADD CONSTRAINT allocation_sets_payment_method_check
      CHECK (payment_method IS NULL OR payment_method = ANY (ARRAY['check','ach','cash','credit_card','wire','other']));
  END IF;
END $$;

-- (3) vendor_payments (nullable method; existing values = 'check' only, subset-safe).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.vendor_payments'::regclass AND conname='vendor_payments_payment_method_check') THEN
    ALTER TABLE public.vendor_payments
      ADD CONSTRAINT vendor_payments_payment_method_check
      CHECK (payment_method IS NULL OR payment_method = ANY (ARRAY['check','ach','cash','credit_card','wire','other']));
  END IF;
END $$;

-- (4) commission_payments (nullable; existing = 'check'; its UI also offers 'direct_deposit' — keep it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.commission_payments'::regclass AND conname='commission_payments_payment_method_check') THEN
    ALTER TABLE public.commission_payments
      ADD CONSTRAINT commission_payments_payment_method_check
      CHECK (payment_method IS NULL OR payment_method = ANY (ARRAY['check','ach','cash','credit_card','wire','other','direct_deposit']));
  END IF;
END $$;
