-- ============================================================================
-- Phase 2 #23 — Change payments.order_id ON DELETE CASCADE → RESTRICT
-- ============================================================================
-- Audit finding (Phase 0 verification, 2026-05-11):
--   "payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id)
--    ON DELETE CASCADE. Deleting an order destroys its payment history."
--
-- The CASCADE was likely intended to make development cleanup easier, but in
-- production it lets an admin accidentally destroy AR evidence by deleting
-- an order. Payments should NEVER be deleted — they should be voided, which
-- preserves history.
--
-- Switching to ON DELETE RESTRICT means:
--   - DELETE FROM orders WHERE id = X with active payments will fail with
--     'update or delete on table "orders" violates foreign key constraint'.
--   - The caller must explicitly void each payment first (proper accounting).
--
-- Safety verified: zero RPCs or frontend code do `DELETE FROM orders` —
-- orders are cancelled/voided/restored via state transitions, never deleted.
-- So this constraint change is effectively a defense-in-depth backstop.
-- ============================================================================

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_order_id_fkey;

ALTER TABLE payments
  ADD CONSTRAINT payments_order_id_fkey
    FOREIGN KEY (order_id)
    REFERENCES orders(id)
    ON DELETE RESTRICT;

-- ─── Verification ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'payments_order_id_fkey'
    AND conrelid = 'public.payments'::regclass;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'phase-2-23 verification: payments_order_id_fkey not found';
  END IF;
  IF v_def NOT LIKE '%ON DELETE RESTRICT%' THEN
    RAISE EXCEPTION 'phase-2-23 verification: payments_order_id_fkey not RESTRICT — got: %', v_def;
  END IF;
  RAISE NOTICE 'phase-2-23 verification passed: payments.order_id is ON DELETE RESTRICT.';
END;
$$;
