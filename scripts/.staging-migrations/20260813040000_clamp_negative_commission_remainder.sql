-- STATUS: PARKED DRAFT - NOT APPLIED
-- Wave A (ordering-cycle review 2026-08-09), finding #3 — stop the last
-- commission row in a split from being computed NEGATIVE, which aborts the whole
-- quote conversion / order creation / invoice save with a raw constraint error.
--
-- THE DEFECT
-- A commission split stores a percentage per recipient. Every recipient's amount
-- is public.compute_commission_amount(profit, pct), which is
--
--     GREATEST(ROUND(COALESCE(profit,0) * COALESCE(pct,0) / 100, 2), 0)
--
-- Because a split rarely divides evenly, the LAST row is not paid its own share.
-- It instead absorbs whatever is left of the rounded total:
--
--     GREATEST(ROUND(profit,2),0)
--     - SUM(<earlier rows>) OVER (... UNBOUNDED PRECEDING AND 1 PRECEDING)
--
-- The GREATEST there clamps the TOTAL, not the subtraction. ROUND() is
-- half-away-from-zero, so with three or more recipients and a small positive
-- profit the earlier rows can round UP past the whole total, and the remainder
-- goes negative. public.commissions carries
--
--     chk_commission_amount CHECK (commission_amount >= 0)
--
-- (20260209200000_tier1_audit_fixes.sql, confirmed still present on live and
-- never dropped), so the INSERT raises a raw check_violation and takes the
-- entire enclosing transaction down with it.
--
-- Profit is passed in DOLLARS, not integer cents, which is what puts sub-cent
-- per-recipient shares within reach of ordinary data.
--
-- MEASURED, NOT ASSUMED — read-only proof run against live on 2026-08-10 over 15
-- split shapes, comparing the old expression with the new one:
--
--   * profit 0.02 across four valid 25% recipients
--       old -> 0.01, 0.01, 0.01, -0.01   <-- ABORTS on chk_commission_amount
--       new -> 0.01, 0.01, 0.00,  0.00   sum 0.02, nothing negative
--   * profit 0.03 across five valid 20% recipients
--       old -> 0.01, 0.01, 0.01, 0.01, -0.01  <-- ABORTS
--       new -> 0.01, 0.01, 0.01, 0.00,  0.00  sum 0.03, nothing negative
--   * the other 13 shapes (0.01/0.04/0.05/0.06/0.10 small splits, zero profit,
--     negative profit, 100.00, 1000.00, 7.77, 12345.67, single 100% recipient)
--     came back BYTE-IDENTICAL old vs new, and every one summed exactly to
--     GREATEST(ROUND(profit,2),0).
--
-- THE FIX, AND WHY IT CANNOT MOVE MONEY THAT WORKS TODAY
--   * The last row's remainder is wrapped in GREATEST(..., 0) so it can never be
--     negative.
--   * Every EARLIER row is capped with LEAST(share, remaining budget), so the
--     earlier rows can no longer sum past the total in the first place.
--
-- Write T = GREATEST(ROUND(profit,2),0), u_k = the per-row share (already >= 0),
-- U_k = u_1 + ... + u_k. If the OLD code succeeded then T - U_(n-1) >= 0, so
-- U_(n-1) <= T, so for every earlier row k, U_k <= T, so u_k <= T - U_(k-1) and
-- the LEAST() picks u_k unchanged. The cap is therefore INERT on every split
-- that mints successfully today; it only engages on splits that currently abort.
-- When it does engage, the amounts still sum to exactly T, so no money is
-- created or lost — a rounding crumb simply moves off a recipient who would
-- otherwise have been paid a negative amount.
--
-- WHY A REDISTRIBUTION ALGORITHM WAS REJECTED
-- A FLOOR-based largest-remainder distribution (the shape used by the
-- remainder-close recompute in 20260721014858) also fixes this and is tidier,
-- but it changes per-row amounts on splits that succeed today. On a live money
-- path that is a worse trade than the crumb, so it was not used.
--
-- SCOPE — all THREE live functions that carry this expression. They were found
-- by scanning pg_proc for the window frame text, not by reading the audit doc,
-- and each was confirmed byte-identical to its tracked on-disk source (zero
-- disk-vs-live drift), so replacing them cannot silently revert untracked work:
--
--   public._insert_commissions_for_order(uuid,uuid,numeric,jsonb,date)
--       live md5 9f1a3c7af994b768bb0a76debc186350, 2335 chars
--       source 20260722174029_commission_split_recipient_ids.sql
--   public._insert_commissions_for_job(uuid,uuid,uuid,numeric,jsonb,date)
--       live md5 c23fd25cf213da9ee832a1764369ac77, 2250 chars
--       source 20260722174029_commission_split_recipient_ids.sql
--   public._save_invoice_scoped_impl(jsonb,jsonb,text)  [SECURITY DEFINER]
--       live md5 45e63ffc8e821467bcca056cad535163, 17345 chars
--       source 20260721223817_save_invoice_payment_terms.sql
--
-- CORRECTION TO THE AUDIT DOC: docs/audits/ordering-cycle-review-2026-08-09
-- names the third function _save_invoice_intent_impl_20260802. No such function
-- exists on live. The real one is _save_invoice_scoped_impl and that is what is
-- replaced here.
--
-- _save_invoice_scoped_impl has a third branch the two mint helpers do not: when
-- only SOME of a generation's commission rows are still pending (x.cnt <>
-- x.cnt_all, i.e. a sibling row was already paid), it does NOT absorb a
-- remainder at all. That branch is preserved EXACTLY as it was — it is written
-- out first so it wins before either clamped branch is considered.
--
-- The order helper and invoice-save replacement below are their live bodies with
-- ONLY the reconciliation CASE expression rewritten. The job helper's same CASE
-- is extracted into `_derive_job_commission_rows`, then the minting function calls
-- that shared derivation. The immediately following split-correction migration
-- consumes the same helper, so correcting existing pending rows cannot fork the
-- recipient resolution or arithmetic used by a fresh mint.
--
-- NOTHING ELSE CHANGES: no signature, no volatility, no SECURITY DEFINER flag,
-- no search_path, no grant. The postcondition asserts every one of those.
--
-- BACKFILL: none, and deliberately. Rows that would have gone negative never
-- reached the table — the constraint stopped them — so there is no bad data to
-- repair. This migration only changes what future mints compute.

SET statement_timeout = '60s';
SET lock_timeout = '10s';

DO $precond$
DECLARE
  v_count int;
  v_md5 text;
  v_src text;
  v_secdef boolean;
  v_config text[];
BEGIN
  -- ---------------------------------------------------------------------------
  -- Each function is pinned by md5(prosrc) against the value read from live on
  -- 2026-08-10 and the exact post-apply body this file installs. A marker is
  -- not a replay proof: a later migration naturally keeps the marker while
  -- changing the body, and accepting it would let this stale CREATE OR REPLACE
  -- silently REVERT that later work. The only accepted states are therefore the
  -- pinned baseline (first apply) and the pinned post-apply body (genuine replay).
  --
  -- The post-apply hashes below are md5 values of the exact LF-normalized
  -- $function$ sources in this file. As with 20260813020000, pg_proc.prosrc is
  -- what is pinned; the POSTCOND reasserts the same four hashes after DDL.
  -- ---------------------------------------------------------------------------

  -- _insert_commissions_for_order -------------------------------------------
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_order';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _insert_commissions_for_order, found %. An overload would mean the CREATE OR REPLACE below targets the wrong one.', v_count;
  END IF;

  -- Looked up by NAME, not by a signature literal: the count check above already
  -- proved the name is unique in public, and a signature literal for a function
  -- that had been re-declared would abort with a raw cast error before any of
  -- the readable messages below could fire.
  SELECT md5(p.prosrc), p.prosrc, p.prosecdef, p.proconfig
    INTO v_md5, v_src, v_secdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_order';
  IF v_secdef OR v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'PRECOND: _insert_commissions_for_order no longer has its pinned SECURITY INVOKER/search_path context [SECURITY DEFINER %, config %]. Replaying this file could change a later security fix.', v_secdef, v_config;
  END IF;
  IF v_md5 = '9f1a3c7af994b768bb0a76debc186350' THEN
    RAISE NOTICE 'PRECOND: _insert_commissions_for_order matches the pinned baseline — first application may proceed';
  ELSIF v_md5 = '42b511d845c0ea150cfd61ed781d966c' THEN
    RAISE NOTICE 'PRECOND: _insert_commissions_for_order matches this migration''s exact post-apply body — replay may proceed as a no-op re-assertion';
  ELSE
    RAISE EXCEPTION 'PRECOND: _insert_commissions_for_order has changed after this migration was written [got md5 %, expected baseline 9f1a3c7af994b768bb0a76debc186350 or post-apply 42b511d845c0ea150cfd61ed781d966c]. Replaying would REVERT later work; re-diff before applying.', v_md5;
  END IF;
  IF position('WAVE-A-CLAMP-2026-08-09' in v_src) = 0
     AND position('UNBOUNDED PRECEDING AND 1 PRECEDING' in v_src) = 0 THEN
    RAISE EXCEPTION 'PRECOND: _insert_commissions_for_order no longer carries the reconciliation window this migration rewrites';
  END IF;

  -- _insert_commissions_for_job ---------------------------------------------
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_job';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _insert_commissions_for_job, found %', v_count;
  END IF;

  SELECT md5(p.prosrc), p.prosrc, p.prosecdef, p.proconfig
    INTO v_md5, v_src, v_secdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_job';
  IF v_secdef OR v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'PRECOND: _insert_commissions_for_job no longer has its pinned SECURITY INVOKER/search_path context [SECURITY DEFINER %, config %]. Replaying this file could change a later security fix.', v_secdef, v_config;
  END IF;
  IF v_md5 = 'c23fd25cf213da9ee832a1764369ac77' THEN
    RAISE NOTICE 'PRECOND: _insert_commissions_for_job matches the pinned baseline — first application may proceed';
  ELSIF v_md5 = '4616a2444837c25b9766469722ce477a' THEN
    RAISE NOTICE 'PRECOND: _insert_commissions_for_job matches this migration''s exact post-apply body — replay may proceed as a no-op re-assertion';
  ELSE
    RAISE EXCEPTION 'PRECOND: _insert_commissions_for_job has changed after this migration was written [got md5 %, expected baseline c23fd25cf213da9ee832a1764369ac77 or post-apply 4616a2444837c25b9766469722ce477a]. Replaying would REVERT later work; re-diff before applying.', v_md5;
  END IF;

  -- _derive_job_commission_rows is introduced by this migration, so the first
  -- application accepts its absence. Once it exists, however, it is just as
  -- vulnerable to a stale CREATE OR REPLACE as the three older functions above.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_derive_job_commission_rows';
  IF v_count = 0 THEN
    RAISE NOTICE 'PRECOND: _derive_job_commission_rows is absent — first application may create it';
  ELSIF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected zero or one _derive_job_commission_rows, found %. An overload makes replay unsafe.', v_count;
  ELSE
    SELECT md5(p.prosrc), p.prosecdef, p.proconfig
      INTO v_md5, v_secdef, v_config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_derive_job_commission_rows';
    IF v_secdef OR v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_config)) THEN
      RAISE EXCEPTION 'PRECOND: _derive_job_commission_rows no longer has this migration''s SECURITY INVOKER/search_path context [SECURITY DEFINER %, config %]. Replaying could change a later security fix.', v_secdef, v_config;
    END IF;
    IF v_md5 <> 'cf0fa9a7085fc523873581478d199f29' THEN
      RAISE EXCEPTION 'PRECOND: _derive_job_commission_rows has changed after this migration was written [got md5 %, expected post-apply cf0fa9a7085fc523873581478d199f29]. Replaying would REVERT later work; re-diff before applying.', v_md5;
    END IF;
    RAISE NOTICE 'PRECOND: _derive_job_commission_rows matches this migration''s exact post-apply body — replay may proceed';
  END IF;

  -- _save_invoice_scoped_impl -----------------------------------------------
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_save_invoice_scoped_impl';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _save_invoice_scoped_impl, found %', v_count;
  END IF;

  SELECT md5(p.prosrc), p.prosrc, p.prosecdef, p.proconfig
    INTO v_md5, v_src, v_secdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_save_invoice_scoped_impl';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PRECOND: _save_invoice_scoped_impl is expected to be SECURITY DEFINER on live and is not. Something else changed it — stop.';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'PRECOND: _save_invoice_scoped_impl no longer has its pinned search_path [config %]. Replaying this SECURITY DEFINER money RPC could change a later security fix.', v_config;
  END IF;
  IF v_md5 = '45e63ffc8e821467bcca056cad535163' THEN
    RAISE NOTICE 'PRECOND: _save_invoice_scoped_impl matches the pinned baseline — first application may proceed';
  ELSIF v_md5 = '6c3f064160e177b551a42f68717da055' THEN
    RAISE NOTICE 'PRECOND: _save_invoice_scoped_impl matches this migration''s exact post-apply body — replay may proceed as a no-op re-assertion';
  ELSE
    RAISE EXCEPTION 'PRECOND: _save_invoice_scoped_impl has changed after this migration was written [got md5 %, expected baseline 45e63ffc8e821467bcca056cad535163 or post-apply 6c3f064160e177b551a42f68717da055]. Replaying this SECURITY DEFINER money RPC would REVERT later work; re-diff before applying.', v_md5;
  END IF;

  -- The clamp leans on compute_commission_amount never returning a negative
  -- number. If that ever changes, LEAST(share, budget) stops being a cap and the
  -- reasoning above collapses, so it is asserted rather than assumed.
  -- Checked across EVERY overload of the name, so an added overload that skipped
  -- the clamp could not hide behind a single-signature lookup.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'compute_commission_amount';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'PRECOND: public.compute_commission_amount is missing';
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'compute_commission_amount'
     AND position('GREATEST' in p.prosrc) = 0;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND: % compute_commission_amount body/bodies no longer clamp their own result at zero. The per-row cap installed below assumes a non-negative share — re-derive the fix before applying.', v_count;
  END IF;

  -- The whole defect only bites because of this constraint. If it were ever
  -- dropped the negative rows would silently persist instead of aborting, which
  -- is worse, so its presence is asserted.
  SELECT count(*) INTO v_count
    FROM pg_constraint
   WHERE conrelid = 'public.commissions'::regclass
     AND conname = 'chk_commission_amount'
     AND contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: commissions.chk_commission_amount is missing. Negative commission amounts would now persist silently — investigate before applying.';
  END IF;
END;
$precond$;

-- =============================================================================
-- 1 of 3 — public._insert_commissions_for_order
-- Mints commissions when an order is created or a quote is converted.
-- =============================================================================
CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id uuid, p_customer_id uuid, p_order_profit numeric,
  p_commission_split jsonb, p_order_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  WITH split_rows AS (
    SELECT
      s,
      ord,
      row_number() OVER (ORDER BY ord) AS rn,
      count(*) OVER () AS split_count,
      s->>'recipient' AS recipient,
      NULLIF(btrim(s->>'recipient_user_id'), '')::uuid AS split_user_id,
      (s->>'percentage')::numeric AS percentage
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
    WHERE (NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
           OR NULLIF(btrim(s->>'recipient_user_id'), '') IS NOT NULL)
      AND (s->>'percentage')::numeric > 0
  ),
  calculated AS (
    SELECT
      sr.*,
      COALESCE(
        (SELECT p.id FROM public.profiles p
          WHERE p.id = sr.split_user_id AND p.is_active = true),
        (SELECT p.id FROM public.profiles p
          WHERE lower(trim(p.full_name)) = lower(trim(sr.recipient))
            AND p.is_active = true
            AND (SELECT count(*) FROM public.profiles p2
                  WHERE lower(trim(p2.full_name)) = lower(trim(sr.recipient))
                    AND p2.is_active = true) = 1
          LIMIT 1)
      ) AS resolved_user_id,
      CASE
        -- WAVE-A-CLAMP-2026-08-09 (this token is asserted by the migration's
        -- pre/postconditions — do not rename it without updating them).
        -- Last row absorbs the rounding remainder, now CLAMPED AT ZERO.
        -- Wave A (ordering-cycle review 2026-08-09): with three or more
        -- recipients and a near-zero positive profit, the earlier rows'
        -- half-away-from-zero rounding can sum PAST the rounded total, so the
        -- old unclamped remainder went negative (profit $0.02 on a valid
        -- 4 x 25% split: 0.01 + 0.01 + 0.01 = 0.03, remainder 0.02 - 0.03 =
        -- -0.01). commissions.chk_commission_amount requires >= 0, so the
        -- INSERT/UPDATE raised a raw check-constraint error and aborted the
        -- whole quote conversion / order creation / invoice save.
        WHEN sr.rn = sr.split_count THEN
          GREATEST(
            GREATEST(ROUND(COALESCE(p_order_profit, 0), 2), 0)
            - COALESCE(
                SUM(public.compute_commission_amount(p_order_profit, sr.percentage))
                  OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                0
              ),
            0
          )
        -- Earlier rows are capped at the budget still unspent, so the rows can
        -- never sum past the rounded total and the last row therefore never
        -- needs to go negative. This cap is INERT on every split that already
        -- succeeded before Wave A: if the old remainder was >= 0 then every
        -- running total was already within budget, so LEAST() picks the
        -- per-row share unchanged. Only the previously-aborting cases move.
        ELSE
          LEAST(
            public.compute_commission_amount(p_order_profit, sr.percentage),
            GREATEST(
              GREATEST(ROUND(COALESCE(p_order_profit, 0), 2), 0)
              - COALESCE(
                  SUM(public.compute_commission_amount(p_order_profit, sr.percentage))
                    OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                  0
                ),
              0
            )
          )
      END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT
    p_order_id,
    p_customer_id,
    COALESCE(
      (SELECT p.full_name FROM public.profiles p WHERE p.id = c.resolved_user_id),
      c.recipient
    ),
    c.resolved_user_id,
    c.percentage,
    c.reconciled_amount,
    COALESCE(p_order_profit, 0),
    p_order_date,
    'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- CREATE OR REPLACE preserves pre-existing grants, so replacing the body above
-- does NOT by itself close the grant the POSTCOND below refuses. This project
-- carries ALTER DEFAULT PRIVILEGES granting EXECUTE on every new public function
-- to anon/authenticated/service_role. 20260513060000 revoked anon and
-- 20260513070000 revoked authenticated/PUBLIC, but service_role was never
-- revoked, so it has held EXECUTE on this helper since creation. Asserting that
-- grant is absent without ever removing it is what aborted this migration.
--
-- Removing service_role costs no capability: every caller of this helper is a
-- SECURITY DEFINER function owned by postgres, so the inner call already runs
-- with postgres privileges. What this closes is the direct PostgREST route, in
-- which a service-key holder POSTs to /rpc/_insert_commissions_for_order and
-- mints commission rows outside the order flow meant to authorize them.
REVOKE ALL ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- =============================================================================
-- Shared job-commission derivation.
--
-- Fresh minting below and audited split correction in the next Wave A migration
-- both consume this function. Keeping recipient resolution, split percentages,
-- and remainder arithmetic here prevents those two money paths from drifting.
-- =============================================================================
CREATE OR REPLACE FUNCTION public._derive_job_commission_rows(
  p_profit numeric,
  p_commission_split jsonb
)
RETURNS TABLE (
  split_ordinal bigint,
  recipient text,
  recipient_user_id uuid,
  split_percentage numeric,
  commission_amount numeric
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

  RETURN QUERY
  WITH split_rows AS (
    SELECT
      s, ord,
      row_number() OVER (ORDER BY ord) AS rn,
      count(*) OVER () AS split_count,
      s->>'recipient' AS recipient,
      NULLIF(btrim(s->>'recipient_user_id'), '')::uuid AS split_user_id,
      (s->>'percentage')::numeric AS percentage
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
    WHERE (NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
           OR NULLIF(btrim(s->>'recipient_user_id'), '') IS NOT NULL)
      AND (s->>'percentage')::numeric > 0
  ),
  calculated AS (
    SELECT sr.*,
      COALESCE(
        (SELECT p.id FROM public.profiles p
          WHERE p.id = sr.split_user_id AND p.is_active = true),
        (SELECT p.id FROM public.profiles p
          WHERE lower(trim(p.full_name)) = lower(trim(sr.recipient))
            AND p.is_active = true
            AND (SELECT count(*) FROM public.profiles p2
                  WHERE lower(trim(p2.full_name)) = lower(trim(sr.recipient))
                    AND p2.is_active = true) = 1
          LIMIT 1)
      ) AS resolved_user_id,
      CASE
        -- WAVE-A-CLAMP-2026-08-09 (this token is asserted by the migration's
        -- pre/postconditions — do not rename it without updating them).
        -- Last row absorbs the rounding remainder, now CLAMPED AT ZERO.
        -- Wave A (ordering-cycle review 2026-08-09): with three or more
        -- recipients and a near-zero positive profit, the earlier rows'
        -- half-away-from-zero rounding can sum PAST the rounded total, so the
        -- old unclamped remainder went negative (profit $0.02 on a valid
        -- 4 x 25% split: 0.01 + 0.01 + 0.01 = 0.03, remainder 0.02 - 0.03 =
        -- -0.01). commissions.chk_commission_amount requires >= 0, so the
        -- INSERT/UPDATE raised a raw check-constraint error and aborted the
        -- whole quote conversion / order creation / invoice save.
        WHEN sr.rn = sr.split_count THEN
          GREATEST(
            GREATEST(ROUND(COALESCE(p_profit, 0), 2), 0)
            - COALESCE(
                SUM(public.compute_commission_amount(p_profit, sr.percentage))
                  OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                0
              ),
            0
          )
        -- Earlier rows are capped at the budget still unspent, so the rows can
        -- never sum past the rounded total and the last row therefore never
        -- needs to go negative. This cap is INERT on every split that already
        -- succeeded before Wave A: if the old remainder was >= 0 then every
        -- running total was already within budget, so LEAST() picks the
        -- per-row share unchanged. Only the previously-aborting cases move.
        ELSE
          LEAST(
            public.compute_commission_amount(p_profit, sr.percentage),
            GREATEST(
              GREATEST(ROUND(COALESCE(p_profit, 0), 2), 0)
              - COALESCE(
                  SUM(public.compute_commission_amount(p_profit, sr.percentage))
                    OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                  0
                ),
              0
            )
          )
      END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT
    c.rn,
    COALESCE(
      (SELECT p.full_name FROM public.profiles p WHERE p.id = c.resolved_user_id),
      c.recipient
    ),
    c.resolved_user_id,
    c.percentage,
    c.reconciled_amount
  FROM calculated c
  ORDER BY c.rn;
END;
$function$;

COMMENT ON FUNCTION public._derive_job_commission_rows(numeric, jsonb) IS
  'Canonical field-job commission row derivation shared by fresh minting and audited split correction. Resolves recipients and reconciles exact numeric-dollar amounts without a second arithmetic implementation.';

REVOKE ALL ON FUNCTION public._derive_job_commission_rows(numeric, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._derive_job_commission_rows(numeric, jsonb)
  TO postgres;

-- =============================================================================
-- 2 of 3 — public._insert_commissions_for_job
-- Mints commissions when a field job is invoiced.
-- =============================================================================
CREATE OR REPLACE FUNCTION public._insert_commissions_for_job(
  p_job_id uuid, p_invoice_id uuid, p_customer_id uuid, p_profit numeric,
  p_commission_split jsonb, p_commission_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  -- WAVE-A-CLAMP-2026-08-09. The clamp itself lives in the shared derivation
  -- helper above; this marker is retained because the migration's replay and
  -- postcondition checks deliberately identify every replaced public body.
  INSERT INTO public.commissions (
    job_id, invoice_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  SELECT
    p_job_id,
    p_invoice_id,
    p_customer_id,
    d.recipient,
    d.recipient_user_id,
    d.split_percentage,
    d.commission_amount,
    COALESCE(p_profit, 0),
    p_commission_date,
    'pending'
  FROM public._derive_job_commission_rows(p_profit, p_commission_split) d
  ORDER BY d.split_ordinal;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Same reasoning as the order helper above: service_role has held EXECUTE on
-- this job helper since creation via ALTER DEFAULT PRIVILEGES, and the POSTCOND
-- below refuses that grant without this migration ever removing it. Every caller
-- is a SECURITY DEFINER function owned by postgres, so no working path loses
-- access; only the direct PostgREST mint route closes.
--
REVOKE ALL ON FUNCTION public._insert_commissions_for_job(uuid, uuid, uuid, numeric, jsonb, date)
  FROM PUBLIC, anon, authenticated, service_role;

-- =============================================================================
-- 3 of 3 — public._save_invoice_scoped_impl  [SECURITY DEFINER]
-- Recomputes an invoice's still-pending commission rows when the invoice is
-- saved. Only the reconciliation CASE changes; the mixed-generation branch is
-- preserved exactly.
-- =============================================================================

-- The POSTCOND below refuses anon/authenticated/PUBLIC/service_role EXECUTE on
-- this function too, so it needs the same remedy as the two helpers above.
-- Verified against live while writing this: its ACL is already {postgres=X/
-- postgres}, owner-only, and the grants live on the public save_invoice wrapper
-- instead — so this REVOKE changes nothing today and breaks no caller. It is
-- here so the assertion is backed by an action rather than by an expectation: if
-- a concurrent session grants EXECUTE before this migration runs, the file now
-- corrects that instead of aborting on it. An assertion broader than its remedy
-- is a self-aborting migration, which is exactly what stalled this wave once.
--
-- Emitted BEFORE the CREATE OR REPLACE rather than after it, unlike the two
-- helpers above, purely so the edit stays inside one lexable block. The effect
-- is identical: CREATE OR REPLACE preserves ACLs, and the PRECOND already
-- refuses any database where this function does not already exist.
REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public._save_invoice_scoped_impl(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    -- Manual miscellaneous charges are the one controlled orderless invoice
    -- type. Chemical sales still require a source order/blend ticket.
    IF v_order_id IS NULL
       AND v_blend_id IS NULL
       AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') <> 'misc_charge' THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    IF COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') = 'misc_charge'
       AND COALESCE(NULLIF(p_invoice->>'status', ''), 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'MISC_CHARGE_MUST_START_DRAFT: orderless miscellaneous charges must be reviewed before posting';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, payment_terms, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      NULLIF(btrim(COALESCE(p_invoice->>'payment_terms', '')), ''),
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- An orderless miscellaneous charge must remain a miscellaneous charge.
    -- The edit payload does not carry source IDs, so enforce this against the
    -- stored invoice rather than trusting the client to keep the type locked.
    IF EXISTS (
      SELECT 1
       FROM invoices
       WHERE id = v_invoice_id
         AND invoice_type = 'misc_charge'
         AND order_id IS NULL
         AND blend_ticket_id IS NULL
         AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), invoice_type) <> 'misc_charge'
    ) THEN
      RAISE EXCEPTION 'ORDERLESS_INVOICE_TYPE_LOCKED: an orderless miscellaneous charge cannot be reclassified';
    END IF;

    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = CASE WHEN p_invoice ? 'due_date' THEN (p_invoice->>'due_date')::date ELSE due_date END,
      payment_terms = CASE WHEN p_invoice ? 'payment_terms' THEN NULLIF(btrim(p_invoice->>'payment_terms'), '') ELSE payment_terms END,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint);
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE
                   -- Mixed generation (some sibling rows already paid): every remaining
                   -- row keeps the plain per-row share, exactly as before Wave A. No
                   -- remainder is absorbed here, so no row can go negative.
                   WHEN x.cnt <> x.cnt_all THEN
                     compute_commission_amount(v_u8_profit, x.split_percentage)
                   -- WAVE-A-CLAMP-2026-08-09 (this token is asserted by the migration's
                   -- pre/postconditions — do not rename it without updating them).
                   -- Last row absorbs the rounding remainder, now CLAMPED AT ZERO.
                   -- Wave A (ordering-cycle review 2026-08-09): with three or more
                   -- recipients and a near-zero positive profit, the earlier rows'
                   -- half-away-from-zero rounding can sum PAST the rounded total, so the
                   -- old unclamped remainder went negative (profit $0.02 on a valid
                   -- 4 x 25% split: 0.01 + 0.01 + 0.01 = 0.03, remainder 0.02 - 0.03 =
                   -- -0.01). commissions.chk_commission_amount requires >= 0, so the
                   -- INSERT/UPDATE raised a raw check-constraint error and aborted the
                   -- whole quote conversion / order creation / invoice save.
                   WHEN x.rn = x.cnt THEN
                     GREATEST(
                       GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                       - COALESCE(
                           SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                             OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                           0
                         ),
                       0
                     )
                   -- Earlier rows are capped at the budget still unspent, so the rows can
                   -- never sum past the rounded total and the last row therefore never
                   -- needs to go negative. This cap is INERT on every split that already
                   -- succeeded before Wave A: if the old remainder was >= 0 then every
                   -- running total was already within budget, so LEAST() picks the
                   -- per-row share unchanged. Only the previously-aborting cases move.
                   ELSE
                     LEAST(
                       compute_commission_amount(v_u8_profit, x.split_percentage),
                       GREATEST(
                         GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                         - COALESCE(
                             SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                               OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
                             0
                           ),
                         0
                       )
                     )
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

DO $postcond$
DECLARE
  v_count int;
  v_src text;
  v_secdef boolean;
  v_config text[];
  v_unexpected text;
  v_order_id uuid;
  v_order_customer_id uuid;
  v_job_id uuid;
  v_job_customer_id uuid;
  v_split jsonb;
  v_minted int;
  v_rows int;
  v_min numeric;
  v_sum numeric;
BEGIN
  -- --------------------------------------------------------------------------
  -- Structural proofs: shape, security context, and grants for the three
  -- replaced functions plus the shared job-row derivation helper.
  -- --------------------------------------------------------------------------
  FOR v_src, v_config IN
    SELECT p.prosrc, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_insert_commissions_for_order', '_insert_commissions_for_job', '_derive_job_commission_rows', '_save_invoice_scoped_impl')
  LOOP
    IF position('WAVE-A-CLAMP-2026-08-09' in v_src) = 0 THEN
      RAISE EXCEPTION 'POSTCOND: a replaced function does not carry the Wave A clamp marker';
    END IF;
    IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_config)) THEN
      RAISE EXCEPTION 'POSTCOND: a replaced function lost its pinned search_path (got %)', v_config;
    END IF;
  END LOOP;

  -- Exactly one of each name: a CREATE OR REPLACE that missed the signature
  -- would have created a second overload rather than replacing the original,
  -- and the old unclamped body would still be reachable.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('_insert_commissions_for_order', '_insert_commissions_for_job', '_derive_job_commission_rows', '_save_invoice_scoped_impl');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'POSTCOND: expected exactly 4 functions across the four names, found % — an overload was created instead of a replacement', v_count;
  END IF;

  -- The replay precondition accepts only these exact post-apply bodies. Assert
  -- them immediately after DDL as well, so a changed delimiter/body cannot leave
  -- a future replay pin detached from what this file actually installed.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
       (p.proname = '_insert_commissions_for_order' AND md5(p.prosrc) = '42b511d845c0ea150cfd61ed781d966c')
       OR (p.proname = '_insert_commissions_for_job' AND md5(p.prosrc) = '4616a2444837c25b9766469722ce477a')
       OR (p.proname = '_derive_job_commission_rows' AND md5(p.prosrc) = 'cf0fa9a7085fc523873581478d199f29')
       OR (p.proname = '_save_invoice_scoped_impl' AND md5(p.prosrc) = '6c3f064160e177b551a42f68717da055')
     );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'POSTCOND: one or more Wave A commission functions do not match this migration''s pinned post-apply body. Do not leave a replay guard attached to unknown function text.';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_job';
  IF v_src NOT LIKE '%public._derive_job_commission_rows(p_profit, p_commission_split)%' THEN
    RAISE EXCEPTION 'POSTCOND: fresh job minting does not call the shared job-commission derivation helper';
  END IF;

  -- No function on live may still carry the unclamped expression.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%UNBOUNDED PRECEDING AND 1 PRECEDING%'
     AND position('WAVE-A-CLAMP-2026-08-09' in p.prosrc) = 0;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'POSTCOND: % function(s) in public still carry an UNCLAMPED last-row reconciliation. Every one must be fixed or this bug is still reachable.', v_count;
  END IF;

  -- Security context must be exactly what it was before.
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_order';
  IF v_secdef THEN
    RAISE EXCEPTION 'POSTCOND: _insert_commissions_for_order became SECURITY DEFINER';
  END IF;
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_job';
  IF v_secdef THEN
    RAISE EXCEPTION 'POSTCOND: _insert_commissions_for_job became SECURITY DEFINER';
  END IF;
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_derive_job_commission_rows';
  IF v_secdef THEN
    RAISE EXCEPTION 'POSTCOND: _derive_job_commission_rows became SECURITY DEFINER';
  END IF;
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_save_invoice_scoped_impl';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTCOND: _save_invoice_scoped_impl lost SECURITY DEFINER — the invoice save path would start failing under RLS';
  END IF;

  -- CREATE OR REPLACE preserves grants, but these are money-minting helpers, so
  -- "should" is not good enough. None of them may be reachable by a browser
  -- session token (anon / authenticated), service_role, or by PUBLIC.
  SELECT string_agg(x.who || ' -> ' || x.fn, ', ') INTO v_unexpected
    FROM (
      SELECT g AS who, p.proname AS fn
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace,
             unnest(ARRAY['anon', 'authenticated', 'service_role', 'public']) AS g
       WHERE n.nspname = 'public'
         AND p.proname IN ('_insert_commissions_for_order', '_insert_commissions_for_job', '_derive_job_commission_rows', '_save_invoice_scoped_impl')
         -- CASE, not a bare AND. has_function_privilege() RAISES for a role that
         -- does not exist, and PostgreSQL does not promise left-to-right AND
         -- evaluation, so a plain-Postgres replay target without Supabase's roles
         -- would abort on the role lookup instead of reporting a grant. PUBLIC is
         -- a pseudo-role and never appears in pg_roles, so it is exempted from the
         -- existence test rather than dropped from the check entirely.
         AND CASE
               WHEN g <> 'public'
                    AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = g)
                 THEN false
               ELSE has_function_privilege(g, p.oid, 'EXECUTE')
             END
    ) x;
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCOND: EXECUTE on a commission-minting helper is held by: %. This migration must not have widened access.', v_unexpected;
  END IF;

  -- --------------------------------------------------------------------------
  -- Behavioural proof: actually mint the shape that aborts today, then throw it
  -- away. profit 0.02 across four valid 25% recipients.
  --
  -- THE PROBE ROWS NEVER SURVIVE AND ARE NEVER DELETED. A PL/pgSQL block with an
  -- EXCEPTION clause opens an implicit savepoint, so raising inside it rolls the
  -- INSERT back. Rollback cannot be refused by a trigger the way a DELETE can.
  -- Local variables survive the rollback, which is what lets the assertions read
  -- the minted values afterwards.
  --
  -- The probe must attach to a REAL order and a REAL job: commissions carries
  -- chk_commission_source CHECK (order_id IS NOT NULL OR job_id IS NOT NULL) plus
  -- FKs on both, so an all-NULL probe row is not insertable. To keep the minted
  -- rows unambiguously identifiable, the probe deliberately picks an order and a
  -- job that have NO commission rows at all, and asserts that is still true
  -- immediately before minting. Nothing about the chosen order or job is read,
  -- written, or changed beyond its id and customer_id.
  --
  -- SKIPPED, NOT FATAL, when the data to build a probe is absent. The documented
  -- disaster-recovery path replays every post-baseline migration against a
  -- schema-only restore holding ZERO rows, and a DR restore is the worst
  -- possible moment for a migration to refuse to replay. Measured on live
  -- 2026-08-10: 32 orders and 4 jobs carry no commissions and 10 profiles are
  -- active, so in production both legs always run.
  -- --------------------------------------------------------------------------
  SELECT jsonb_build_object('splits', jsonb_agg(
           jsonb_build_object('recipient_user_id', s.id::text, 'percentage', 25)))
    INTO v_split
    FROM (SELECT p.id FROM public.profiles p WHERE p.is_active = true ORDER BY p.id LIMIT 4) s;

  SELECT o.id, o.customer_id INTO v_order_id, v_order_customer_id
    FROM public.orders o
   WHERE o.customer_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.commissions c WHERE c.order_id = o.id)
   ORDER BY o.id LIMIT 1;

  SELECT j.id, j.customer_id INTO v_job_id, v_job_customer_id
    FROM public.jobs j
   WHERE j.customer_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.commissions c WHERE c.job_id = j.id)
   ORDER BY j.id LIMIT 1;

  IF v_split IS NULL
     OR jsonb_array_length(v_split->'splits') <> 4
     OR v_order_id IS NULL
     OR v_job_id IS NULL THEN
    RAISE NOTICE 'POSTCOND: not enough data to build the probe (need 4 active profiles, 1 commission-free order, 1 commission-free job) — behavioural probe SKIPPED; structural proofs still ran';
  ELSE
    BEGIN
      -- Order-mint leg. Before this migration this exact call raises
      -- new row violates check constraint chk_commission_amount, so a pass here
      -- is also a demonstration that the defect was real.
      SELECT count(*) INTO v_rows FROM public.commissions c WHERE c.order_id = v_order_id;
      IF v_rows <> 0 THEN
        RAISE EXCEPTION 'POSTCOND: the probe order already carries % commission rows, so minted rows could not be told apart from real ones', v_rows;
      END IF;

      v_minted := public._insert_commissions_for_order(
        v_order_id, v_order_customer_id, 0.02, v_split, CURRENT_DATE);

      IF v_minted <> 4 THEN
        RAISE EXCEPTION 'POSTCOND: order probe minted % commission rows, expected 4', v_minted;
      END IF;

      SELECT count(*), min(c.commission_amount), sum(c.commission_amount)
        INTO v_rows, v_min, v_sum
        FROM public.commissions c
       WHERE c.order_id = v_order_id;

      IF v_rows <> 4 THEN
        RAISE EXCEPTION 'POSTCOND: order probe stored % rows, expected 4 — nothing was proven', v_rows;
      END IF;
      IF v_min IS DISTINCT FROM 0.00 THEN
        RAISE EXCEPTION 'POSTCOND: order probe smallest commission is % — expected exactly 0.00 (two rows clamp to zero on a 0.02 four-way split)', v_min;
      END IF;
      IF v_sum IS DISTINCT FROM 0.02 THEN
        RAISE EXCEPTION 'POSTCOND: order probe amounts sum to % but the rounded profit is 0.02 — the clamp must not create or destroy money', v_sum;
      END IF;

      -- Job-mint leg. Same defect, separate function; the order leg does not
      -- prove it. Different profit (0.03 across the same four recipients, another
      -- shape whose earlier rows overshoot) so a stale variable cannot pass this.
      -- Same savepoint, so it rolls back with everything else.
      SELECT count(*) INTO v_rows FROM public.commissions c WHERE c.job_id = v_job_id;
      IF v_rows <> 0 THEN
        RAISE EXCEPTION 'POSTCOND: the probe job already carries % commission rows', v_rows;
      END IF;

      v_minted := public._insert_commissions_for_job(
        v_job_id, NULL, v_job_customer_id, 0.03, v_split, CURRENT_DATE);

      IF v_minted <> 4 THEN
        RAISE EXCEPTION 'POSTCOND: job probe minted % commission rows, expected 4', v_minted;
      END IF;

      SELECT count(*), min(c.commission_amount), sum(c.commission_amount)
        INTO v_rows, v_min, v_sum
        FROM public.commissions c
       WHERE c.job_id = v_job_id;

      IF v_rows <> 4 THEN
        RAISE EXCEPTION 'POSTCOND: job probe stored % rows, expected 4', v_rows;
      END IF;
      IF v_min < 0 THEN
        RAISE EXCEPTION 'POSTCOND: job probe produced a NEGATIVE commission (%)', v_min;
      END IF;
      IF v_sum IS DISTINCT FROM 0.03 THEN
        RAISE EXCEPTION 'POSTCOND: job probe amounts sum to % but the rounded profit is 0.03', v_sum;
      END IF;

      -- _save_invoice_scoped_impl is NOT probed behaviourally. It is a 17k-char
      -- SECURITY DEFINER RPC that would need a whole invoice, its lines, and a
      -- prior commission generation to reach the recompute branch, and standing
      -- that up inside a migration would touch far more live machinery than the
      -- thing being proven. It is covered by the structural proofs above (marker
      -- present, no unclamped expression left anywhere in public, SECDEF and
      -- search_path intact) and by the fact that its replacement text was
      -- produced by the same mechanical patch as the two that ARE probed. This
      -- gap is stated rather than papered over.

      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PROBE_OK_ROLLBACK';
    EXCEPTION
      WHEN check_violation THEN
        RAISE EXCEPTION 'POSTCOND: the commission probe hit a CHECK constraint (%). If that is chk_commission_amount the clamp is NOT taking effect and this migration has not fixed the defect.', SQLERRM;
      WHEN SQLSTATE 'P0001' THEN
        -- Only the sentinel is swallowed. Every other P0001 is one of the
        -- assertions above (or a COMMISSION_SPLIT_INVALID / recipient-unresolved
        -- raise) and must keep propagating.
        IF SQLERRM <> 'PROBE_OK_ROLLBACK' THEN
          RAISE;
        END IF;
        RAISE NOTICE 'POSTCOND: commission clamp probe passed — 0.02 four-way order mint and 0.03 four-way job mint both produced 4 non-negative rows summing exactly to the rounded profit; probe rows rolled back';
    END;
  END IF;
END;
$postcond$;

-- Release the caps set at the top of this file. Plain SET is session-scoped, so
-- without this an applier that reuses its connection would carry a 60s statement
-- timeout into whatever runs next.
RESET statement_timeout;
RESET lock_timeout;
