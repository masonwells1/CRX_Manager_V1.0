-- Fix G (Codex Sol BLOCK on 20260713060400): the per-field advisory lock closed the
-- same-field 200% race, but because the constraint trigger is FOR EACH ROW + DEFERRABLE
-- INITIALLY DEFERRED, per-field locks are NOT globally ordered across a multi-field
-- transaction. Two transactions touching fields (A then B) vs (B then A) could each
-- hold one and wait for the other -> PostgreSQL aborts one as a deadlock, even for
-- harmless valid edits. Replace the per-field lock with a SINGLE GLOBAL advisory lock:
-- every field_billing_defaults constraint check serializes on ONE constant key, so no
-- lock-ordering cycle can form (deadlock-free) while the same-field 200% race stays
-- closed (a waiter re-reads the true sum on a fresh READ COMMITTED statement snapshot
-- after the holder commits). Billing-split edits are rare config changes, so global
-- serialization of just this check is an acceptable, safe trade.

CREATE OR REPLACE FUNCTION public._enforce_field_billing_defaults_sum_100()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_field_id uuid;
  v_row_count bigint;
  v_split_sum numeric;
BEGIN
  -- ONE global lock (constant key) for ALL field_billing_defaults constraint checks.
  -- A single lock key cannot form a deadlock cycle; and after the holding transaction
  -- commits, the waiter's fresh per-statement READ COMMITTED snapshot in the SELECT
  -- below sees the committed rows, so two concurrent inserts can't both pass at 200%.
  PERFORM pg_advisory_xact_lock(hashtext('field_billing_defaults_sum_100')::bigint);

  FOR v_field_id IN
    SELECT DISTINCT affected.field_id
    FROM (
      VALUES
        (CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.field_id END),
        (CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.field_id END)
    ) AS affected(field_id)
    WHERE affected.field_id IS NOT NULL
  LOOP
    SELECT count(*), COALESCE(sum(fbd.split_pct), 0)
      INTO v_row_count, v_split_sum
    FROM public.field_billing_defaults fbd
    WHERE fbd.field_id = v_field_id;

    -- Tolerance band 99.99–100.01 (matches transfer_job_to_invoice /
    -- create_split_invoices_from_order); split_pct is numeric(9,6) so a legit even
    -- 3-way split (33.333333*3 = 99.999999) must be accepted.
    IF v_row_count >= 1 AND (v_split_sum < 99.99 OR v_split_sum > 100.01) THEN
      RAISE EXCEPTION
        'FIELD_BILLING_SPLIT_NOT_100: field_id % has billing split sum %, expected 100 (within 99.99–100.01)',
        v_field_id,
        v_split_sum;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._enforce_field_billing_defaults_sum_100()
  FROM PUBLIC, anon, authenticated;
