-- idempotency-body-check: exempt
-- ============================================================================
-- Hard guard: money columns stored as numeric dollars must hold whole cents and
-- must be finite.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS:
--   CodeRabbit raised a Major finding on PR #354 asking for the order-profit path
--   to move to bigint cents. That was evaluated and declined -- see
--   docs/audits/2026-08-10-order-profit-bigint-cents-evaluation.md. Short version:
--   PostgreSQL numeric is exact arbitrary-precision decimal, not a binary float,
--   so the AGENTS.md "never use floating-point math for money" rule is not
--   actually violated and no wrong number could be constructed.
--
--   CodeRabbit's residual point IS fair, though: an *unqualified* numeric column
--   will happily accept a sub-cent value or NaN/Infinity, and the only thing
--   currently preventing that is a trigger (_round_money_to_whole_cents,
--   20260809230500) -- a soft guard covering just order_items and commissions.
--   This migration replaces that soft guard with a type-level one, per the
--   standing "prefer hard guards over more rules" principle, WITHOUT the
--   nine-column / 46-function / 17-file dollars-to-cents unit change.
--
-- THE PREDICATE:
--     col = ROUND(col, 2)  AND  col > '-Infinity'  AND  col < 'Infinity'
--   ROUND-equality rejects any sub-cent scale. The explicit bounds reject the two
--   infinities AND NaN.
--
--   BOTH HALVES ARE LOAD-BEARING -- do not "simplify" this to the ROUND-equality
--   clause alone. PostgreSQL numeric deliberately does NOT use IEEE NaN semantics:
--   so that numeric values can be sorted and indexed, it treats NaN as equal to
--   NaN and greater than every non-NaN value. So 'NaN' = ROUND('NaN',2) is TRUE
--   and the first clause lets NaN straight through. What actually rejects NaN is
--   col < 'Infinity', which is FALSE because NaN sorts above Infinity. The probe
--   in the post-condition block below proves this empirically at apply time.
--
--   Together that is the complete set of
--   guarantees bigint cents would have bought -- sub-cent unrepresentable,
--   non-finite unrepresentable -- enforced by the database, with zero reader or
--   writer changes anywhere, because the stored unit is still dollars.
--
-- SCOPE -- ONLY SEVEN COLUMNS:
--   Measured live 2026-08-10, rows failing the predicate today:
--     orders.total_cost                0 / 65     <- constrained here
--     orders.total_profit              0 / 65     <- constrained here
--     order_items.profit               0 / 288    <- constrained here
--     quotes.total_price               0 / 4      <- constrained here
--     quotes.total_profit              0 / 4      <- constrained here
--     quote_items.total_price          0 / 20     <- constrained here
--     quote_items.profit               0 / 20     <- constrained here
--     order_items.total_price         35 / 288    <- DEFERRED, see below
--     quotes.total_cost                2 / 4      <- DEFERRED, see below
--     commissions.commission_amount    3 / 35     <- DEFERRED, see below
--     commissions.order_profit         3 / 35     <- DEFERRED, see below
--     orders.total_price               0 / 65     <- DEFERRED, different reason
--
--   orders.total_price is clean today but is NOT constrained, because
--   _update_order_items_impl still ends with:
--       SELECT COALESCE(SUM(total_price), 0) INTO v_new_total FROM order_items ...;
--       UPDATE orders SET total_price = v_new_total ... ;
--   (verified in the LIVE function body 2026-08-10). That runs after the
--   order_items triggers and overwrites the canonical header with the RAW line
--   sum. For any order containing one of the 35 legacy sub-cent lines that sum is
--   itself sub-cent, so constraining the column would turn an ordinary order edit
--   into a hard constraint violation. The 20260809230500 header already named
--   deleting those two lines as the correct fix; that is tracked separately and
--   must land before orders.total_price can be guarded. orders.total_cost and
--   orders.total_profit have no such clobber and are safe to constrain now.
--
--   The four dirty columns are DELIBERATELY NOT constrained yet, including by
--   NOT VALID. A NOT VALID constraint still skips only the initial backfill scan
--   -- PostgreSQL re-evaluates every CHECK against the new row version on EVERY
--   UPDATE, whatever column changed. So adding one now would make each of those
--   43 legacy rows un-editable: any attempt to touch one of the 35 affected order
--   lines through the app would fail with a constraint violation, because the
--   stale sub-cent value would be re-checked. That is a live outage on ordinary
--   order editing, not a dormant guard.
--
--   The correct sequence for those four is repair-then-constrain, in one
--   migration: rewrite the 43 rows to whole cents, then ADD ... VALID. That step
--   rewrites stored money and therefore needs Mason's explicit approval on its
--   own. It is NOT bundled here.
--
-- ORDERING -- THIS FILE MUST APPLY AFTER ITS TWO COMPANIONS:
--   20260810150000 rounds the quote header on the way into orders (DELTA-E) and
--     the direct-order line money (DELTA-C). Without it, converting either of the
--     2 live draft quotes that still carry a sub-cent total_cost would hard-fail
--     against orders_total_cost_whole_cents_chk.
--   20260810150500 rounds the quote_items line money at INSERT (DELTA-B2) and the
--     quote header total_cost. quote_items has NO before-insert rounding trigger
--     the way order_items does (trg_order_items_round_money), so without DELTA-B2
--     a sub-cent client payload would abort the save instead of being normalized.
--   Filename stamps enforce this: 150000 < 150500 < 151000.
--
-- ALSO DEPENDS ON A MIGRATION NOT YET ON origin/main:
--   The measured counts below are the state AFTER 20260810025159
--   (backfill_stale_line_profit) applied live on 2026-08-10 from branch
--   claude/session-orchestration-setup-d73e6c. Pre-backfill the numbers were
--   46 dirty order_items.total_price rows, not 35, and order_items.profit was not
--   yet uniformly whole-cent. Anyone replaying this repo from origin/main alone
--   will not reproduce these counts until that branch lands.
--
-- ONE RESIDUAL PATH, MEASURED CLEAN TODAY:
--   restore_quote_version replays quote_versions.snapshot_data verbatim into
--   quotes.total_price/total_profit and quote_items.profit/total_price without
--   rounding. All 3 live snapshots satisfy the predicate (checked 2026-08-10), and
--   every future snapshot is taken from an already-rounded quote row, so no restore
--   can fail today. Flagged rather than fixed: if a pre-rounding snapshot ever
--   appears, add the same ROUND(...,2) there.
--
-- ROLLBACK: each constraint is independently droppable --
--   ALTER TABLE public.<table> DROP CONSTRAINT <name>;
--   No data is modified by this migration.
-- ============================================================================

ALTER TABLE public.orders
  ADD CONSTRAINT orders_total_cost_whole_cents_chk
  CHECK (total_cost IS NULL OR (total_cost = ROUND(total_cost, 2)
         AND total_cost > '-Infinity'::numeric AND total_cost < 'Infinity'::numeric));

ALTER TABLE public.orders
  ADD CONSTRAINT orders_total_profit_whole_cents_chk
  CHECK (total_profit IS NULL OR (total_profit = ROUND(total_profit, 2)
         AND total_profit > '-Infinity'::numeric AND total_profit < 'Infinity'::numeric));

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_profit_whole_cents_chk
  CHECK (profit IS NULL OR (profit = ROUND(profit, 2)
         AND profit > '-Infinity'::numeric AND profit < 'Infinity'::numeric));

ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_total_price_whole_cents_chk
  CHECK (total_price IS NULL OR (total_price = ROUND(total_price, 2)
         AND total_price > '-Infinity'::numeric AND total_price < 'Infinity'::numeric));

ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_total_profit_whole_cents_chk
  CHECK (total_profit IS NULL OR (total_profit = ROUND(total_profit, 2)
         AND total_profit > '-Infinity'::numeric AND total_profit < 'Infinity'::numeric));

ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_total_price_whole_cents_chk
  CHECK (total_price IS NULL OR (total_price = ROUND(total_price, 2)
         AND total_price > '-Infinity'::numeric AND total_price < 'Infinity'::numeric));

ALTER TABLE public.quote_items
  ADD CONSTRAINT quote_items_profit_whole_cents_chk
  CHECK (profit IS NULL OR (profit = ROUND(profit, 2)
         AND profit > '-Infinity'::numeric AND profit < 'Infinity'::numeric));

COMMENT ON CONSTRAINT orders_total_profit_whole_cents_chk ON public.orders IS
  'Money is stored as numeric dollars; this is the type-level whole-cent + finite guard '
  'substituted for a bigint-cents conversion (PR #354 CodeRabbit Major, declined). '
  'See docs/audits/2026-08-10-order-profit-bigint-cents-evaluation.md.';

-- ============================================================================
-- Post-conditions asserted in-migration (fail closed).
-- ============================================================================
DO $$
DECLARE
  -- Parallel arrays: constraint name and the table it MUST sit on. Matching on the
  -- name alone would be satisfied by a same-named constraint on a different table.
  v_names text[] := ARRAY[
    'orders_total_cost_whole_cents_chk',
    'orders_total_profit_whole_cents_chk',
    'order_items_profit_whole_cents_chk',
    'quotes_total_price_whole_cents_chk',
    'quotes_total_profit_whole_cents_chk',
    'quote_items_total_price_whole_cents_chk',
    'quote_items_profit_whole_cents_chk'
  ];
  v_tables text[] := ARRAY[
    'public.orders', 'public.orders', 'public.order_items',
    'public.quotes', 'public.quotes',
    'public.quote_items', 'public.quote_items'
  ];
  v_i int;
  v_bad bigint;
BEGIN
  -- All seven exist, sit on the intended table, are CHECKs, and are VALIDATED.
  -- (NOT VALID would skip the backfill scan and give a false sense that the
  -- existing rows had been proven clean.)
  FOR v_i IN 1 .. array_length(v_names, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = v_names[v_i] AND c.contype = 'c' AND c.convalidated IS TRUE
         AND c.conrelid = v_tables[v_i]::regclass
    ) THEN
      RAISE EXCEPTION 'POSTCOND: constraint % missing from %, wrong type, or NOT VALID',
        v_names[v_i], v_tables[v_i];
    END IF;
  END LOOP;

  -- The guard actually bites: a sub-cent write must be rejected. Prove it inside a
  -- savepoint on a throwaway table carrying the identical predicate, so nothing in
  -- the real tables is touched.
  CREATE TEMP TABLE _whole_cent_guard_probe (
    v numeric,
    CONSTRAINT _probe_chk CHECK (v IS NULL OR (v = ROUND(v, 2)
      AND v > '-Infinity'::numeric AND v < 'Infinity'::numeric))
  ) ON COMMIT DROP;

  INSERT INTO _whole_cent_guard_probe VALUES (10.01);  -- whole cents: must pass

  BEGIN
    INSERT INTO _whole_cent_guard_probe VALUES (10.005);
    RAISE EXCEPTION 'POSTCOND: predicate accepted a sub-cent value';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO _whole_cent_guard_probe VALUES ('NaN'::numeric);
    RAISE EXCEPTION 'POSTCOND: predicate accepted NaN';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO _whole_cent_guard_probe VALUES ('Infinity'::numeric);
    RAISE EXCEPTION 'POSTCOND: predicate accepted Infinity';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO _whole_cent_guard_probe VALUES ('-Infinity'::numeric);
    RAISE EXCEPTION 'POSTCOND: predicate accepted -Infinity';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF (SELECT count(*) FROM _whole_cent_guard_probe) <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: probe table should hold exactly the one legal row';
  END IF;

  -- No live row was modified by this migration, and none of the seven guarded
  -- columns holds a violating value. Belt-and-braces: a VALID ADD CONSTRAINT would
  -- already have aborted on a dirty row, so a non-zero count here is impossible --
  -- but it costs nothing and it covers all four tables, not just orders.
  SELECT
    (SELECT count(*) FROM public.orders
      WHERE total_cost <> ROUND(total_cost, 2) OR total_profit <> ROUND(total_profit, 2))
  + (SELECT count(*) FROM public.order_items WHERE profit <> ROUND(profit, 2))
  + (SELECT count(*) FROM public.quotes
      WHERE total_price <> ROUND(total_price, 2) OR total_profit <> ROUND(total_profit, 2))
  + (SELECT count(*) FROM public.quote_items
      WHERE total_price <> ROUND(total_price, 2) OR profit <> ROUND(profit, 2))
  INTO v_bad;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'POSTCOND: % dirty rows survived across the guarded columns', v_bad;
  END IF;

  -- The five deferred columns are intentionally still unconstrained. Constraining
  -- any of them here would break live editing -- see the SCOPE note in the header.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.connamespace = 'public'::regnamespace
       AND c.conname IN ('orders_total_price_whole_cents_chk',
                         'order_items_total_price_whole_cents_chk',
                         'quotes_total_cost_whole_cents_chk',
                         'commissions_commission_amount_whole_cents_chk',
                         'commissions_order_profit_whole_cents_chk')
  ) THEN
    RAISE EXCEPTION
      'POSTCOND: a deferred column was constrained without its repair -- that would make legacy rows un-editable';
  END IF;
END $$;
