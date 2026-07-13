-- Fix E (Codex Sol BLOCK #1 on 20260713060000): the split-sum constraint trigger
-- summed split_pct WITHOUT serializing concurrent transactions on the same field.
-- Two simultaneous first-time inserts for different customers on ONE field could
-- each see only its own committed-so-far row and both pass, leaving the field at
-- 200% (a silent over-billing hole). Fix: take a per-field advisory xact lock
-- before the sum. The second committer blocks until the first releases at commit,
-- then its fresh per-statement READ COMMITTED snapshot sees the first's rows and
-- the sum is correct. Fields are locked in id order to avoid multi-field deadlocks.
-- Only the trigger FUNCTION changes; the CONSTRAINT TRIGGER already points at it.

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
  FOR v_field_id IN
    SELECT DISTINCT affected.field_id
    FROM (
      VALUES
        (CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.field_id END),
        (CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.field_id END)
    ) AS affected(field_id)
    WHERE affected.field_id IS NOT NULL
    ORDER BY 1              -- consistent lock-acquisition order (deadlock avoidance)
  LOOP
    -- Serialize the constraint check for THIS field across transactions. A second
    -- committer blocks here until the first releases the lock at commit; the SUM
    -- below then runs on a fresh READ COMMITTED snapshot that includes the first
    -- committer's rows, so two concurrent inserts can no longer both pass at 200%.
    PERFORM pg_advisory_xact_lock(hashtext('field_billing_defaults_sum:' || v_field_id::text)::bigint);

    SELECT count(*), COALESCE(sum(fbd.split_pct), 0)
      INTO v_row_count, v_split_sum
    FROM public.field_billing_defaults fbd
    WHERE fbd.field_id = v_field_id;

    -- Match the transfer_job_to_invoice / create_split_invoices_from_order tolerance
    -- band (99.99–100.01). split_pct is numeric(9,6), so a legitimate even 3-way split
    -- (33.333333 * 3 = 99.999999) must be accepted here exactly as the RPC accepts it.
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
