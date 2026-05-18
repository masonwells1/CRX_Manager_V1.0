-- 20260513000000 — Rebate claim atomic RPCs (audit #33)
-- rls-check: exempt
--   The new table `rebate_claim_counters` is a system counter accessed ONLY by
--   the SECURITY DEFINER RPC `create_rebate_claim`. RLS is enabled and zero
--   policies exist, which correctly denies all direct access from authenticated
--   or anon roles. The RPC bypasses RLS via SECURITY DEFINER.
-- idempotency-body-check: exempt
--   `create_rebate_claim` and `transition_rebate_claim` use the canonical
--   `check_idempotency`/`save_idempotency` helpers (defined in
--   20260210000000_tier3_idempotency_and_triggers.sql). Per CLAUDE.md,
--   helper-based idempotency is the preferred pattern and requires this marker
--   to bypass the literal-string body check.
--
-- Closes audit finding #33 (rebate claim race condition).
--
-- Three problems being fixed:
--   1. Claim number generation race — frontend used `count(*) + 1`. Two concurrent
--      callers could read the same count and INSERT identical claim_numbers. There
--      was no UNIQUE constraint to catch the collision.
--   2. Status transition race — frontend issued naked `.update()` with no row lock
--      and no state-machine validation. Two admins clicking "Approve" simultaneously
--      could both succeed; pending could jump straight to paid.
--   3. paid_amount_cents was never written — the UI's "Mark Paid" only set status,
--      so the "Rebates Received" stat fell back to claim_amount_cents.
--
-- Approach:
--   - UNIQUE constraint on rebate_claims.claim_number.
--   - Per-year counter table updated via INSERT ... ON CONFLICT DO UPDATE for atomicity.
--   - create_rebate_claim() RPC owns claim_number generation under the counter row's
--     row-lock, plus idempotency.
--   - transition_rebate_claim() RPC validates state machine, takes SELECT FOR UPDATE
--     on the claim row, and accepts an optional paid_amount_cents (defaults to
--     claim_amount_cents if not provided, preserving prior behavior).
--   - Both RPCs are SECURITY DEFINER with `SET search_path = public, pg_temp`,
--     and check role explicitly since SECURITY DEFINER bypasses RLS.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. UNIQUE constraint on claim_number
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.rebate_claims'::regclass
       AND conname = 'rebate_claims_claim_number_key'
  ) THEN
    ALTER TABLE public.rebate_claims
      ADD CONSTRAINT rebate_claims_claim_number_key UNIQUE (claim_number);
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Per-year counter table for atomic claim_number generation
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.rebate_claim_counters (
  year       int PRIMARY KEY,
  next_value int NOT NULL DEFAULT 1
);

ALTER TABLE public.rebate_claim_counters ENABLE ROW LEVEL SECURITY;

-- Policies intentionally omitted — see file-level rls-check exempt note above.
-- Direct access is denied by RLS; the SECURITY DEFINER RPC is the only writer.

-- Seed counter from existing data (idempotent — DO UPDATE clamps to MAX+1 if
-- somehow the table already had higher values inserted between migrations).
INSERT INTO public.rebate_claim_counters (year, next_value)
SELECT EXTRACT(YEAR FROM created_at)::int AS year,
       MAX(
         COALESCE(
           NULLIF(regexp_replace(claim_number, '^RC-\d{4}-', ''), '')::int,
           0
         )
       ) + 1 AS next_value
FROM public.rebate_claims
WHERE claim_number ~ '^RC-\d{4}-\d+$'
GROUP BY EXTRACT(YEAR FROM created_at)::int
ON CONFLICT (year) DO UPDATE
SET next_value = GREATEST(public.rebate_claim_counters.next_value, EXCLUDED.next_value);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. create_rebate_claim() — atomic insert with generated claim_number
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_rebate_claim(
  p_program_id          uuid,
  p_quantity            numeric,
  p_claim_amount_cents  bigint,
  p_order_id            uuid    DEFAULT NULL,
  p_customer_id         uuid    DEFAULT NULL,
  p_product_id          uuid    DEFAULT NULL,
  p_notes               text    DEFAULT NULL,
  p_idempotency_key     text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_year        int := EXTRACT(YEAR FROM current_date)::int;
  v_seq         int;
  v_claim_no    text;
  v_claim_id    uuid;
  v_existing    jsonb;
  v_result      jsonb;
BEGIN
  -- Auth + role gate (SECURITY DEFINER bypasses RLS so re-check explicitly).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  -- Required-field validation (matches RLS WITH CHECK + table NOT NULLs).
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'PROGRAM_REQUIRED'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'QUANTITY_INVALID'; END IF;
  IF p_claim_amount_cents IS NULL OR p_claim_amount_cents <= 0 THEN
    RAISE EXCEPTION 'CLAIM_AMOUNT_INVALID';
  END IF;

  -- Idempotency check (helper pattern; see file header marker).
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_rebate_claim');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Atomic per-year counter increment.
  -- The ON CONFLICT DO UPDATE clause holds the row lock on the counter row for
  -- the duration of this statement, so concurrent callers serialize cleanly.
  INSERT INTO public.rebate_claim_counters (year, next_value)
  VALUES (v_year, 2)
  ON CONFLICT (year) DO UPDATE
    SET next_value = public.rebate_claim_counters.next_value + 1
  RETURNING next_value - 1 INTO v_seq;

  v_claim_no := format('RC-%s-%s', v_year, lpad(v_seq::text, 4, '0'));

  INSERT INTO public.rebate_claims (
    program_id, order_id, customer_id, product_id,
    claim_number, quantity, claim_amount_cents, notes, status,
    created_by
  ) VALUES (
    p_program_id, p_order_id, p_customer_id, p_product_id,
    v_claim_no, p_quantity, p_claim_amount_cents, p_notes, 'pending',
    v_actor
  )
  RETURNING id INTO v_claim_id;

  v_result := jsonb_build_object(
    'success',      true,
    'claim_id',     v_claim_id,
    'claim_number', v_claim_no
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_rebate_claim', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_rebate_claim(uuid, numeric, bigint, uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rebate_claim(uuid, numeric, bigint, uuid, uuid, uuid, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. transition_rebate_claim() — state-machine transition under row lock
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Valid transitions:
--   pending   → submitted | rejected
--   submitted → approved  | rejected
--   approved  → paid
--
-- Sets the appropriate timestamp column. For 'paid', uses
-- p_paid_amount_cents if provided, else falls back to claim_amount_cents.

CREATE OR REPLACE FUNCTION public.transition_rebate_claim(
  p_claim_id            uuid,
  p_new_status          text,
  p_paid_amount_cents   bigint  DEFAULT NULL,
  p_manufacturer_ref    text    DEFAULT NULL,
  p_idempotency_key     text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_claim       public.rebate_claims%ROWTYPE;
  v_existing    jsonb;
  v_result      jsonb;
  v_paid_cents  bigint;
  v_today       date := current_date;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_claim_id IS NULL THEN RAISE EXCEPTION 'CLAIM_ID_REQUIRED'; END IF;
  IF p_new_status IS NULL THEN RAISE EXCEPTION 'STATUS_REQUIRED'; END IF;

  -- Idempotency check (helper pattern; see file header marker).
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transition_rebate_claim');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Lock the claim row before reading/validating to avoid lost-update races.
  SELECT * INTO v_claim
    FROM public.rebate_claims
   WHERE id = p_claim_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;

  -- State machine.
  IF v_claim.status = 'pending' AND p_new_status IN ('submitted', 'rejected') THEN
    NULL;
  ELSIF v_claim.status = 'submitted' AND p_new_status IN ('approved', 'rejected') THEN
    NULL;
  ELSIF v_claim.status = 'approved' AND p_new_status = 'paid' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', v_claim.status, p_new_status;
  END IF;

  -- Apply the transition.
  IF p_new_status = 'submitted' THEN
    UPDATE public.rebate_claims
       SET status = 'submitted',
           submitted_date = v_today,
           updated_at = now()
     WHERE id = p_claim_id;

  ELSIF p_new_status = 'approved' THEN
    UPDATE public.rebate_claims
       SET status = 'approved',
           approved_date = v_today,
           updated_at = now()
     WHERE id = p_claim_id;

  ELSIF p_new_status = 'paid' THEN
    v_paid_cents := COALESCE(p_paid_amount_cents, v_claim.claim_amount_cents);
    IF v_paid_cents <= 0 THEN RAISE EXCEPTION 'PAID_AMOUNT_INVALID'; END IF;

    UPDATE public.rebate_claims
       SET status = 'paid',
           paid_date = v_today,
           paid_amount_cents = v_paid_cents,
           manufacturer_ref = COALESCE(p_manufacturer_ref, manufacturer_ref),
           updated_at = now()
     WHERE id = p_claim_id;

  ELSIF p_new_status = 'rejected' THEN
    UPDATE public.rebate_claims
       SET status = 'rejected',
           updated_at = now()
     WHERE id = p_claim_id;
  END IF;

  v_result := jsonb_build_object(
    'success',     true,
    'claim_id',    p_claim_id,
    'old_status',  v_claim.status,
    'new_status',  p_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transition_rebate_claim', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_rebate_claim(uuid, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_rebate_claim(uuid, text, bigint, text, text) TO authenticated;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — separate statement so failures abort the apply.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.rebate_claims'::regclass
       AND conname = 'rebate_claims_claim_number_key'
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'verify failed: rebate_claims_claim_number_key UNIQUE missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'rebate_claim_counters' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'verify failed: rebate_claim_counters missing or RLS disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'create_rebate_claim'
       AND pg_get_function_identity_arguments(oid)
           = 'p_program_id uuid, p_quantity numeric, p_claim_amount_cents bigint, p_order_id uuid, p_customer_id uuid, p_product_id uuid, p_notes text, p_idempotency_key text'
  ) THEN
    RAISE EXCEPTION 'verify failed: create_rebate_claim signature mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'transition_rebate_claim'
       AND pg_get_function_identity_arguments(oid)
           = 'p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint, p_manufacturer_ref text, p_idempotency_key text'
  ) THEN
    RAISE EXCEPTION 'verify failed: transition_rebate_claim signature mismatch';
  END IF;
END$$;
