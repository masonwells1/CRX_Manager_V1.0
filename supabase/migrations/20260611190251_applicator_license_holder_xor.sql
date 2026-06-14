-- Codex cross-review fix (2026-06-10 H1 batch, finding #1 MEDIUM):
-- applicator_licenses_holder_check allowed BOTH customer_id AND profile_id to be
-- populated (`a IS NOT NULL OR b IS NOT NULL`). The UI always nulls the other
-- side (Compliance.tsx holder toggle), but a direct PostgREST/SQL write could
-- create a both-set row that would ambiguously count for BOTH a customer's RUP
-- compliance lookup AND a staff member's job-assignment gate.
-- Tighten to EXACTLY ONE holder (boolean XOR). All existing rows are
-- customer-only (profile_id was added 20260610185714 and no staff rows exist
-- with a customer set), so validation passes.

ALTER TABLE applicator_licenses DROP CONSTRAINT applicator_licenses_holder_check;
ALTER TABLE applicator_licenses
  ADD CONSTRAINT applicator_licenses_holder_check
  CHECK ((customer_id IS NOT NULL) <> (profile_id IS NOT NULL));

-- Verification
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'applicator_licenses'::regclass
     AND conname = 'applicator_licenses_holder_check';
  IF v_def IS NULL OR position('<>' in v_def) = 0 THEN
    RAISE EXCEPTION 'applicator_licenses_holder_check is not the XOR form: %', coalesce(v_def, 'MISSING');
  END IF;
END $$;
