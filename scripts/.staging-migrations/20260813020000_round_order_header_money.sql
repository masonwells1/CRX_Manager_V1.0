-- STATUS: PARKED DRAFT - NOT APPLIED
-- Wave A (ordering-cycle review 2026-08-09) — round the order header's price and
-- cost at the canonical point, then derive profit from those rounded components,
-- so whole-cent CHECKs and the commission basis stay exact.
--
-- THE DEFECT
-- 20260810151000 added validated CHECK constraints requiring whole cents on
-- orders.total_cost and orders.total_profit. Nothing guarantees that the values
-- written into those columns are whole cents, so any writer that computes a
-- sub-cent header aborts its whole RPC with a raw `violates check constraint`
-- error instead of doing its job.
--
-- WHAT CHANGED SINCE THIS FILE WAS FIRST WRITTEN — read this before judging the
-- severity, because the original example is no longer the live one.
--
-- Drafted 2026-08-09, this header cited create_order_from_blend_ticket, which at
-- the time accumulated `v_total_price + (v_price * v_qty_conv)` over a
-- unit-converted (routinely fractional) quantity and wrote the raw sum straight
-- into the header with no ROUND. A concurrent session has since rewritten that
-- function as part of the blend-ticket whole-cent fix. Read from live pg_proc on
-- 2026-08-13 (md5 344532c6522cce26857ce4ffd9597125, 12146 chars): it now inserts
-- the header with literal zeros in all four money columns and lets the
-- order_items triggers populate them, and it no longer UPDATEs orders anywhere.
-- The blend-ticket example in the original draft is therefore FIXED and is
-- retained above only as the illustration of the class of bug.
--
-- SEVERITY — the class is live, the original example is not.
--   * The blend-ticket path: closed by the sibling fix. Also still unexercised —
--     blend_tickets and blend_ticket_products both held 0 rows on live, which is
--     why 20260810151000 validated cleanly in the first place.
--   * _update_order_items_impl: STILL OPEN, and it is the ordinary "edit an
--     order's lines" path rather than an unused one. It ends with an unrounded
--     header write of the raw line sum; the exact live body is quoted in SCOPE
--     below, together with the live counts of the rows it can affect. This is the
--     writer that makes this migration change stored values.
--   * Any future writer: uncovered by construction until something intercepts
--     the column itself, which is what this migration installs.
--
-- WHY A TRIGGER RATHER THAN FIXING THE WRITER
-- Two reasons, and the second is decisive.
--
--   1. The same reason 20260809170800 gave for order_items: a trigger is the one
--      place every writer must pass through, including future ones and direct
--      frontend writes. Chasing individual writers is a bigger diff with a worse
--      guarantee.
--
--   2. The order-header writers CANNOT all be safely rewritten right now,
--      because their live bodies drift from the migration trail. When this file
--      was drafted, create_order_from_blend_ticket was the example: its live body
--      matched none of the 8 on-disk definitions, and a CREATE OR REPLACE
--      written against the newest disk copy would have silently reverted
--      untracked live behaviour. That particular function has since been
--      rewritten by a sibling session (live md5 on 2026-08-13:
--      344532c6522cce26857ce4ffd9597125, 12146 chars), so the numbers in the
--      original note are stale — but the same drift is still recorded for
--      _update_order_items_impl in docs/reference/migration-history.md, and
--      _update_order_items_impl is now the writer that matters here. The
--      reasoning survives the example changing under it, which is itself the
--      argument: a fix that depends on any one body's text keeps going stale,
--      and this one does not.
--
-- The trigger closes the defect WITHOUT needing to read or trust any of those
-- bodies.
--
-- SCOPE
--   * Rounds orders.total_price and orders.total_cost first, then DERIVES
--     orders.total_profit from those rounded components. total_cost and
--     total_profit carry whole-cent CHECKs; total_price does not, but it is the
--     revenue side of the identity and therefore must be rounded at the same
--     boundary.
--   * This is deliberately the same rule as the canonical order-item trigger in
--     20260809230500_single_canonical_line_profit.sql: stored profit is an
--     output of rounded revenue minus rounded cost, never a third independent
--     caller input. Independently rounding all three can create a one-cent
--     contradiction and would make the commission basis wrong.
--   * NULL handling fails closed without inventing zero. When either component
--     is NULL there is nothing sound to derive from, so a non-NULL existing
--     total_profit is only rounded to whole cents and otherwise remains NULL.
--
--     CORRECTED CLAIM — read this before assuming total_price is inert. An
--     earlier draft of this header said the ordinary path already writes
--     total_price rounded. That is FALSE and was caught in drift review. Yes,
--     trg_recalc_order_totals writes ROUND(v_total_price, 2), but it is not the
--     last writer: _update_order_items_impl ends with an unrounded header write
--     of the raw line sum. Read from the LIVE body 2026-08-10 (13278 chars, at
--     offset 11888):
--
--         SELECT COALESCE(SUM(total_price), 0) INTO v_new_total
--           FROM order_items WHERE order_id = p_order_id;
--         UPDATE orders SET total_price = v_new_total, ... WHERE id = p_order_id;
--
--     No ROUND. It runs AFTER the order_items triggers and overwrites the
--     rounded header. So on the ordinary "edit an order's lines" path this
--     trigger DOES change what gets stored, whenever the raw line sum is itself
--     sub-cent. That is a real behaviour change and is stated here rather than
--     buried.
--
--     WHY IT IS STILL THE RIGHT DIRECTION — live counts, read 2026-08-10:
--       * order_items rows holding a sub-cent total_price ................. 35
--       * distinct orders those rows belong to ............................ 16
--       * orders whose header total_price is sub-cent ...................... 0
--       * orders whose header already differs from the exact line sum ..... 15  (of 65)
--     Two facts decide it. (1) Every one of the 65 order headers on live is
--     already whole-cent, so rounding the header preserves the invariant the
--     data actually holds; NOT rounding it would newly introduce sub-cent
--     headers the moment one of those 16 orders is edited. (2) "header equals
--     the exact line sum" is not an invariant this system maintains — it is
--     already false for 15 of 65 orders, and no predicate in
--     scripts/db-invariant-sweeps/ asserts it (fin-money-whole-cents.sql checks
--     order_items.total_price only). So rounding the header cannot break a
--     guarantee anyone relies on, and it can only move a value by less than one
--     cent, on the 16 orders listed above, and only when someone edits them.
--
--     This does NOT silently settle the deferred question from
--     20260810151000 (whether orders.total_price should carry its own
--     whole-cent CHECK). It does not add that constraint. It only stops the
--     column from drifting sub-cent going forward.
--   * PROFIT IS DERIVED, not independently rounded. The owner settled the money
--     semantics after review: once price and cost are rounded, total_profit is
--     their exact difference. A caller's third value cannot contradict the two
--     authoritative components or move the commission basis by one cent.
--   * NULL handling is fail-closed without inventing zero. If either component is
--     NULL, there is no complete identity to derive; a non-NULL total_profit is
--     rounded as the least-surprising compatibility behavior, and NULL remains
--     NULL. A future schema change that wants NULL to mean zero must make that
--     business decision explicitly rather than smuggling it into this trigger.
--   * total_margin_pct is a percentage, not money, and is excluded — matching the
--     existing exclusion of order_items.net_margin. Note this means that wherever
--     a writer computes the margin percentage from its own pre-rounding numbers,
--     that stored percentage can disagree in the last digit with the rounded
--     price and cost beside it. It is a derived display figure, and correcting it
--     remains a separate display-accuracy change.
--
-- NO-OP ON EXISTING DATA. This migration rewrites nothing. It installs a trigger
-- and touches no committed row. For total_cost and total_profit it cannot ever
-- change a stored value, because both carry VALIDATED whole-cent constraints as
-- of 20260810151000 and every committed row therefore already satisfies
-- ROUND(x,2) = x. For total_price the guarantee is narrower and is spelled out in
-- the SCOPE section above: no stored value changes at apply time, but a future
-- edit of one of the 16 identified orders will store a rounded header where it
-- would previously have stored a sub-cent one.
--
-- NON-FINITE VALUES STILL FAIL, DELIBERATELY. ROUND('NaN',2) is 'NaN' and
-- ROUND('Infinity',2) is 'Infinity', so this trigger does not launder a
-- non-finite value into a finite one — the CHECK's `> '-Infinity' AND <
-- 'Infinity'` bounds clause still rejects it. Silently converting NaN to a number
-- would be worse than failing. Rounding fixes sub-cent precision; it is not a
-- validity guard.
--
-- ONE THING IT DOES LAUNDER, disclosed rather than hidden (raised in security
-- review 2026-08-10). This is a BEFORE trigger, so it runs before CHECK
-- constraints evaluate. orders carries orders_total_price_non_negative —
-- CHECK (total_price >= 0). A total_price in the open interval (-0.005, 0) now
-- rounds to 0.00 and is ACCEPTED, where before this trigger it raised. So the
-- new trigger does make an existing guard stop firing, for that one narrow band.
-- Judged acceptable and left as-is: the magnitude is strictly under one cent, the
-- rounding is the same rounding every other money column already receives, and
-- the alternative — special-casing the sign — would mean a sub-cent negative
-- aborts the write while a sub-cent positive silently rounds, which is harder to
-- reason about than a single uniform rule. total_cost and total_profit carry no
-- non-negativity CHECK, so nothing analogous applies to them. If a negative
-- header price should be impossible at all, that belongs in a validity guard on
-- the writers, not in a rounding trigger.

-- LOCK EXPOSURE. DROP TRIGGER and CREATE TRIGGER each take ACCESS EXCLUSIVE on
-- public.orders, and the postcondition additionally writes and rolls back a probe
-- row. ACCESS EXCLUSIVE queues behind any open transaction, and every later
-- statement queues behind the waiter — so an unguarded apply during business
-- hours can freeze the orders table for as long as one stale transaction lives.
-- These caps make a contended apply fail fast and be retried, instead of
-- stalling the app.
--
-- Plain SET, NOT SET LOCAL, and this is deliberate. SET LOCAL outside a
-- transaction block emits `WARNING: SET LOCAL can only be used in transaction
-- blocks` and is silently discarded — verified empirically against
-- postgres:17 while building the replay harness for this wave. Whether the
-- applier wraps a migration file in a transaction is an implementation detail of
-- the tool, so relying on it would make this guard invisibly optional. Plain SET
-- works either way: inside a transaction it is rolled back on abort, outside one
-- it is reset explicitly at the end of this file.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- Precondition: pin the exact live body being replaced. Live md5 read from
-- pg_proc immediately before writing this file, and confirmed byte-identical to
-- 20260809230500_single_canonical_line_profit.sql after CRLF normalization — so
-- disk and live agree for THIS function and the replacement below is a true
-- superset of what is running.
DO $precond$
DECLARE
  v_count integer;
  v_md5 text;
  v_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_round_money_to_whole_cents';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 1 _round_money_to_whole_cents, found %', v_count;
  END IF;

  SELECT md5(p.prosrc), p.prosrc INTO v_md5, v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_round_money_to_whole_cents';

  -- Replay safety, WITH BOTH ENDS PINNED. A disaster-recovery restore replays this
  -- file against a dump that may ALREADY contain the post-migration body, and a
  -- lone baseline pin would then fail on a database that is in exactly the state
  -- this file wants. So the already-applied case is detected first, by looking for
  -- the orders branch that this migration is the only thing to introduce.
  --
  -- An earlier draft merely NOTICEd and carried on there. Security review on
  -- 2026-08-10 showed that is a silent-clobber path: if a LATER migration adds a
  -- fourth branch to this function, re-running this file would revert that work,
  -- and the postconditions below — which check only the three branches this file
  -- knows about — would all still pass. That is the recorded "pending-migration
  -- overlap clobber" class, and it is precisely what a body pin exists to stop.
  --
  -- So the skip branch is pinned too, to the body this file installs. The two
  -- accepted states are therefore exact and exhaustive:
  --   * baseline md5      -> first apply, proceed and replace
  --   * post-apply md5    -> genuine replay, proceed as a no-op re-assertion
  --   * anything else     -> refuse
  -- A later migration that edits ANY branch moves the body off the post-apply md5,
  -- so this file now refuses rather than reverting it. That is the intended
  -- trade: a replay that legitimately needs re-running is unaffected, and a
  -- re-run that would destroy newer work stops instead.
  IF v_src LIKE '%ELSIF TG_TABLE_NAME = ''orders'' THEN%' THEN
    IF v_md5 <> '71a66b7a69ab6984efa17ec79bc9e4a5' THEN
      RAISE EXCEPTION 'PRECOND: _round_money_to_whole_cents already carries the orders branch, so this migration has run before — but the body is NOT the one this file installs (got md5 %, expected 71a66b7a69ab6984efa17ec79bc9e4a5). A later migration has edited this function. Re-running this file would REVERT that work. Stop and re-diff.', v_md5;
    END IF;
    RAISE NOTICE 'PRECOND: _round_money_to_whole_cents already carries the orders branch and matches the post-apply body pin — this migration has run before; the CREATE OR REPLACE below is a no-op re-assertion';
  ELSIF v_md5 <> '17955b2eace3c566b23f506118770f9b' THEN
    RAISE EXCEPTION 'PRECOND: _round_money_to_whole_cents body is not the expected baseline (got md5 %) and does not already carry the orders branch. It changed after this migration was written — re-diff before applying.', v_md5;
  END IF;

  -- The constraints this migration exists to keep satisfiable must actually be
  -- present. If they were dropped, the premise changed and this should be re-read.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'orders'
      AND c.conname = 'orders_total_cost_whole_cents_chk' AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'PRECOND: orders_total_cost_whole_cents_chk is missing or not validated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'orders'
      AND c.conname = 'orders_total_profit_whole_cents_chk' AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'PRECOND: orders_total_profit_whole_cents_chk is missing or not validated';
  END IF;

  -- NO WRITER-SHAPE ASSERTION HERE, and that is deliberate. Recorded in full
  -- because two successive drafts of this file got it wrong in opposite ways.
  --
  -- Draft 1 asserted three exact assignment strings in
  -- create_order_from_blend_ticket (`total_price = v_total_price` and two
  -- matching lines). A concurrent session rewrote that function as part of the
  -- blend-ticket whole-cent fix, all three strings went false, and this migration
  -- self-aborted on a precondition that had nothing to do with its remedy.
  --
  -- Draft 2 loosened it to "the function still INSERTs into orders naming
  -- total_price/total_cost/total_profit". Read from the live body on 2026-08-13,
  -- that assertion is VACUOUS: the rewritten function inserts the header with
  -- literal zeros in all four money columns and lets the order_items triggers
  -- populate them afterwards. A predicate that passes on an insert of zeros
  -- proves nothing about rounding, so it bought friction and no safety.
  --
  -- The honest position is that this remedy does not depend on ANY function's
  -- shape, for two reasons:
  --
  --   * The trigger attaches to the orders TABLE, not to a writer. It intercepts
  --     every writer of these columns — present, future, and direct frontend
  --     writes alike. That is the whole argument for a trigger over a rewrite.
  --   * `BEFORE INSERT OR UPDATE OF (...)` fires on EVERY insert; the column list
  --     restricts the UPDATE event only. So an insert-only writer is covered
  --     unconditionally and needs nothing proven about it.
  --
  -- The writer that actually makes this migration change stored values is
  -- _update_order_items_impl, whose unrounded trailing header write is quoted in
  -- the SCOPE section above. It is deliberately NOT asserted either: pinning it
  -- would assert the CONTINUED EXISTENCE OF THE BUG, so that whoever fixes that
  -- function properly would break this migration's replay. Assert invariants, not
  -- defects.
  --
  -- What proves this migration works is the behavioural probe in the
  -- postcondition, which inserts a sub-cent header inside the migration, reads
  -- back whole-cent values, and rolls the probe row away. That is real evidence
  -- about the trigger; a prosrc LIKE was only ever evidence about prose. The
  -- preconditions kept above — the pinned _round_money_to_whole_cents body and
  -- the two validated whole-cent CHECKs — are the ones this file's remedy is
  -- genuinely built on.
END;
$precond$;

-- Compared with reviewed 20260809230500, the order_items and commissions
-- branches of the replacement function are carried forward semantically
-- unchanged. This repaired Wave A draft does change other executable SQL: its
-- precondition block no longer asserts any writer-specific shape, because the
-- table trigger covers every INSERT and every UPDATE naming these columns; the
-- postcondition's behavioral probe is the proof that rounding works. Within the
-- replacement function itself, only the ELSIF for 'orders' is new logic.
CREATE OR REPLACE FUNCTION public._round_money_to_whole_cents()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    IF NEW.total_price IS NOT NULL THEN
      NEW.total_price := ROUND(NEW.total_price, 2);
    END IF;

    -- DERIVED, not merely rounded (changed 2026-08-09; see 20260809230500).
    -- Both sides are rounded to whole cents BEFORE subtracting, so this value
    -- and the header that sums the same two rounded quantities agree exactly.
    -- Whatever the caller passed in NEW.profit is discarded: that field is no
    -- longer an input. This is what stops _convert_quote_to_order_owner_impl
    -- from carrying a stale quote_items.profit onto an order line.
    --
    -- The NULL check is defensive only. order_items.total_price is NOT NULL
    -- WITH DEFAULT 0, so no committed row can skip this branch. (An earlier
    -- draft justified it as protecting pricing_pending lines; that was wrong.
    -- An unpriced line stores the default 0, not NULL, and create_rush_order
    -- also inserts cost_per_unit = 0, so such a line derives to 0 — not to a
    -- negative.)
    --
    -- One real behaviour change on unpriced lines, disclosed rather than
    -- hidden: a pricing_pending line with total_price = 0 but a NON-zero
    -- cost_per_unit now stores a NEGATIVE line profit where the caller may have
    -- stored 0. That makes the line agree with the header, which has always
    -- subtracted that cost — so it is a display change, not a money change.
    IF NEW.total_price IS NOT NULL THEN
      NEW.profit := NEW.total_price
                    - ROUND(COALESCE(NEW.cost_per_unit, 0)
                            * COALESCE(NEW.total_units_needed, 0), 2);
    END IF;
  ELSIF TG_TABLE_NAME = 'commissions' THEN
    IF NEW.commission_amount IS NOT NULL THEN
      NEW.commission_amount := ROUND(NEW.commission_amount, 2);
    END IF;
  ELSIF TG_TABLE_NAME = 'orders' THEN
    -- NEW 2026-08-11 (Wave A). Round the two authoritative components first,
    -- then derive profit from them. This mirrors the already-live canonical
    -- order-item rule in 20260809230500_single_canonical_line_profit.sql and
    -- prevents independent rounding from creating a one-cent contradiction in
    -- the commission basis.
    IF NEW.total_price IS NOT NULL THEN
      NEW.total_price := ROUND(NEW.total_price, 2);
    END IF;
    IF NEW.total_cost IS NOT NULL THEN
      NEW.total_cost := ROUND(NEW.total_cost, 2);
    END IF;

    -- Fail closed on incomplete inputs: a NULL component gives us nothing sound
    -- to subtract. Never invent zero. Preserve a supplied/existing profit only
    -- by rounding it; if it is NULL too, leave it NULL.
    IF NEW.total_price IS NOT NULL AND NEW.total_cost IS NOT NULL THEN
      NEW.total_profit := ROUND(NEW.total_price, 2) - ROUND(NEW.total_cost, 2);
    ELSIF NEW.total_profit IS NOT NULL THEN
      NEW.total_profit := ROUND(NEW.total_profit, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._round_money_to_whole_cents() IS
  'Canonical money point for the numeric-dollar columns. Rounds '
  'order_items.total_price and commissions.commission_amount to whole cents '
  '(2dp, half-up), DERIVES order_items.profit as rounded line revenue minus '
  'rounded line cost so that the sum of a header''s lines equals the header '
  'exactly, and rounds orders.total_price / orders.total_cost before DERIVING '
  'orders.total_profit as their difference. If either component is NULL, a '
  'non-NULL profit is rounded but never derived from an invented zero. '
  'net_margin and total_margin_pct are percentages and are '
  'deliberately excluded. Added 2026-08-08; profit made derived 2026-08-09; '
  'orders branch added 2026-08-11.';

-- Re-asserted defensively. CREATE OR REPLACE preserves the ACL 20260809170800
-- set, so on the normal path this is a genuine no-op. It is here so the REVOKE
-- can never be separated from the CREATE by a future edit to either file. This
-- database carries ALTER DEFAULT PRIVILEGES granting anon EXECUTE on every new
-- public function, and PostgreSQL grants PUBLIC EXECUTE by default.
REVOKE ALL ON FUNCTION public._round_money_to_whole_cents() FROM PUBLIC, anon, authenticated, service_role;

-- BEFORE INSERT OR UPDATE OF the three header money columns. Scoping the UPDATE
-- to those columns keeps the trigger off the many order updates that touch only
-- status, notes or delivery fields.
--
-- The column list narrows the UPDATE event ONLY; every INSERT fires this trigger
-- regardless of which columns the insert names. So the scoping can only ever miss
-- an UPDATE that changes header money without naming one of these three columns,
-- which is not expressible in SQL. No assumption about any particular writer is
-- being made here — see the precondition block above for why the earlier attempts
-- to assert one were removed.
DROP TRIGGER IF EXISTS trg_orders_round_money ON public.orders;
CREATE TRIGGER trg_orders_round_money
  BEFORE INSERT OR UPDATE OF total_price, total_cost, total_profit ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public._round_money_to_whole_cents();

-- Postcondition. Assert on the catalogue, not on the source text, so an
-- ALTER FUNCTION that changed an attribute without touching the body is caught.
DO $postcond$
DECLARE
  v_count integer;
  v_config text[];
  v_src text;
  v_probe_id uuid;
  v_stored_price numeric;
  v_stored_cost numeric;
  v_stored_profit numeric;
  v_secdef boolean;
  v_unexpected text;
  v_trigger_cols text;
  v_probe_order_id uuid;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_round_money_to_whole_cents';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: expected exactly 1 _round_money_to_whole_cents, found %', v_count;
  END IF;

  SELECT p.proconfig, p.prosrc INTO v_config, v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_round_money_to_whole_cents';

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTCOND: _round_money_to_whole_cents lost its pinned search_path (got %)', v_config;
  END IF;

  -- The pre-existing branches must have survived this replacement. Losing the
  -- derived-profit branch would silently reintroduce header-vs-lines drift.
  IF v_src NOT LIKE '%ROUND(COALESCE(NEW.cost_per_unit, 0)%' THEN
    RAISE EXCEPTION 'POSTCOND: the derived order_items.profit branch was lost by this replacement';
  END IF;
  IF v_src NOT LIKE '%NEW.commission_amount := ROUND(NEW.commission_amount, 2)%' THEN
    RAISE EXCEPTION 'POSTCOND: the commissions branch was lost by this replacement';
  END IF;
  IF v_src NOT LIKE '%NEW.total_cost := ROUND(NEW.total_cost, 2)%' THEN
    RAISE EXCEPTION 'POSTCOND: the new orders branch is missing';
  END IF;
  IF v_src NOT LIKE '%NEW.total_profit := ROUND(NEW.total_price, 2) - ROUND(NEW.total_cost, 2)%' THEN
    RAISE EXCEPTION 'POSTCOND: the orders total_profit derivation is missing';
  END IF;

  -- Security shape. A trigger function must NOT be SECURITY DEFINER (it runs with
  -- the writer's rights by design), and this database's ALTER DEFAULT PRIVILEGES
  -- hands anon EXECUTE on every new public function, so the REVOKE above is
  -- verified rather than assumed. EXECUTE on a trigger function is only ever
  -- checked at CREATE TRIGGER time, so this is defense in depth — but a silent
  -- regression here is exactly the drift class that produced incidents B7-B9.
  SELECT p.prosecdef INTO v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_round_money_to_whole_cents';

  IF v_secdef THEN
    RAISE EXCEPTION 'POSTCOND: _round_money_to_whole_cents became SECURITY DEFINER';
  END IF;

  -- All FOUR grantees the REVOKE above names are verified, not just anon and
  -- PUBLIC. Security review 2026-08-10 pointed out that checking half of a
  -- four-grantee REVOKE and billing the result as drift defence leaves the other
  -- half unasserted. EXECUTE on a trigger function is checked at CREATE TRIGGER
  -- time rather than at fire time, so the practical blast radius of a stray grant
  -- is small — but "small" is a reason to assert it cheaply, not to skip it.
  -- The role-existence filter is load-bearing twice over.
  -- has_function_privilege() RAISES for a role that does not exist rather than
  -- returning false, so on a replay target lacking Supabase's roles the
  -- unguarded form aborted on a role lookup instead of reporting a grant. But
  -- PUBLIC is a pseudo-role and never appears in pg_roles, so filtering the
  -- array against pg_roles alone would silently DROP the PUBLIC grantee — the
  -- widest one — from a check whose whole point is that all four are asserted.
  --
  -- CASE, not `guard AND has_function_privilege(...)`. PostgreSQL does not
  -- promise left-to-right evaluation of AND, so the planner is free to run the
  -- privilege lookup before the pg_roles guard filters the row out — which puts
  -- the raise back exactly where the guard was meant to remove it. CASE is the
  -- documented construct with guaranteed ordering, and the guarded expression
  -- depends on `g`, so it cannot be constant-folded out of that ordering.
  SELECT string_agg(g, ', ' ORDER BY g) INTO v_unexpected
  FROM unnest(ARRAY['anon', 'public', 'authenticated', 'service_role']) AS g
  WHERE CASE
          WHEN g <> 'public'
               AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = g)
            THEN false
          ELSE EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = '_round_money_to_whole_cents'
              AND has_function_privilege(g, p.oid, 'EXECUTE')
          )
        END;

  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCOND: EXECUTE on _round_money_to_whole_cents is still held by: %. The REVOKE above names anon, authenticated, service_role and PUBLIC; every one of them must come back denied.', v_unexpected;
  END IF;

  -- The trigger must exist, be BEFORE, be per-ROW, fire on INSERT and UPDATE, and
  -- be ENABLED. A trigger disabled by ALTER TABLE ... DISABLE TRIGGER still
  -- appears in pg_trigger, so tgenabled is checked explicitly rather than assumed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'orders'
      AND t.tgname = 'trg_orders_round_money'
      AND NOT t.tgisinternal
      AND (t.tgtype & 1) <> 0    -- FOR EACH ROW (a statement-level trigger of the
                                 -- same name would satisfy every other bit here
                                 -- and never see NEW)
      AND (t.tgtype & 2) <> 0    -- BEFORE
      AND (t.tgtype & 4) <> 0    -- INSERT
      AND (t.tgtype & 16) <> 0   -- UPDATE
      AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'POSTCOND: trg_orders_round_money is missing, mistimed, statement-level, or disabled';
  END IF;

  -- The trigger's UPDATE column list is the premise of this whole file, so prove
  -- it rather than assume it. A column-scoped trigger fires only when the writer
  -- names one of these columns in its SET list; if a later edit narrowed
  -- `UPDATE OF` to, say, total_cost alone, every other assertion in this file
  -- would still pass while total_price and total_profit silently went unrounded.
  -- pg_trigger.tgattr carries the actual attnum list — tgtype does not.
  SELECT string_agg(a.attname, ',' ORDER BY a.attname) INTO v_trigger_cols
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL unnest(t.tgattr) AS ta(attnum)
  JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ta.attnum
  WHERE n.nspname = 'public' AND c.relname = 'orders'
    AND t.tgname = 'trg_orders_round_money'
    AND NOT t.tgisinternal;

  IF v_trigger_cols IS DISTINCT FROM 'total_cost,total_price,total_profit' THEN
    RAISE EXCEPTION 'POSTCOND: trg_orders_round_money is scoped to columns [%] but must be scoped to exactly total_cost, total_price, total_profit', COALESCE(v_trigger_cols, '(none — trigger is not column-scoped at all)');
  END IF;

  -- Enumerate the INSERT *and* UPDATE triggers on orders rather than only
  -- checking for ours. Two things depend on this set. (1) Firing order: BEFORE
  -- triggers fire in NAME order, and an unknown trigger sorting after ours could
  -- overwrite the rounded values. (2) The probe below relies on rollback undoing
  -- everything, which an AFTER trigger writing to another table could defeat.
  --
  -- UPDATE is enumerated alongside INSERT because the probe has an UPDATE leg as
  -- well; restricting this to INSERT would leave half the probe's safety argument
  -- unproven, so a future unscoped BEFORE UPDATE trigger sorting after ours could
  -- overwrite the rounded values while every assertion in this file still passed.
  --
  -- The five known siblings, all read from live pg_trigger on 2026-08-10:
  --   trg_stamp_commission_split_recipient_ids  BEFORE INSERT OR UPDATE OF commission_split
  --   enforce_order_status_transition           BEFORE UPDATE OF status
  --   guard_order_customer_source_lineage       BEFORE UPDATE OF customer_id
  --   guard_order_delivered_activity_cancel     BEFORE UPDATE OF status, deleted_at
  --   trg_order_status_change                   AFTER  UPDATE, unscoped, but gated
  --                                             WHEN OLD.status IS DISTINCT FROM
  --                                             NEW.status; the probe never touches
  --                                             status, so it never fires
  -- Every one is scoped away from total_cost/total_price/total_profit, so none can
  -- overwrite what this trigger rounds, and orders has no AFTER INSERT trigger at
  -- all. If the set changes, stop and re-reason rather than trusting this proof.
  SELECT string_agg(t.tgname, ', ' ORDER BY t.tgname) INTO v_unexpected
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'orders'
    AND NOT t.tgisinternal
    AND ((t.tgtype & 4) <> 0 OR (t.tgtype & 16) <> 0)   -- fires on INSERT or UPDATE
    AND t.tgname NOT IN ('trg_orders_round_money',
                         'trg_stamp_commission_split_recipient_ids',
                         'enforce_order_status_transition',
                         'guard_order_customer_source_lineage',
                         'guard_order_delivered_activity_cancel',
                         'trg_order_status_change');

  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCOND: unexpected INSERT/UPDATE trigger(s) on orders (%). The rounding order and the rollback-based probe below were both reasoned against a known trigger set — re-verify before trusting either.', v_unexpected;
  END IF;

  -- BEHAVIOURAL PROOF, not merely structural. Insert an order whose total_cost
  -- and total_profit are sub-cent — exactly the blend-ticket shape — and assert
  -- the stored values came back rounded. Without this trigger the same INSERT
  -- raises check_violation, so a pass also demonstrates the defect was real.
  --
  -- THE PROBE ROW NEVER SURVIVES, AND IS NEVER DELETED. A PL/pgSQL block with an
  -- EXCEPTION clause opens an implicit savepoint, so raising inside it rolls the
  -- INSERT back. That is deliberate: orders carries a guard_order_delete BEFORE
  -- DELETE trigger, so a DELETE-based cleanup could refuse and strand the row.
  -- Rollback cannot be refused. Local variables survive the rollback (PL/pgSQL
  -- does not restore them), which is what lets the assertions below still read
  -- the stored values. No business row is read, written, or deleted — the only
  -- existing row touched is a single customer id, read to satisfy the FK.
  --
  -- Columns are kept to the minimum: order_number and customer_id are the only
  -- NOT NULL columns without a default (verified against live pg_attribute), and
  -- status / order_date are left to their defaults so this cannot be broken by a
  -- future status CHECK change.
  --
  -- SKIPPED, NOT FATAL, when there is no customer to hang the probe row off.
  -- Live has customers, so this always runs in production. The documented
  -- disaster-recovery path replays every post-baseline migration against a
  -- schema-only restore holding ZERO rows, and a DR restore is the worst
  -- possible moment for a migration to refuse to replay. The structural proofs
  -- above do not depend on any data and still run.
  SELECT c.id INTO v_probe_id FROM public.customers c LIMIT 1;

  IF v_probe_id IS NULL THEN
    RAISE NOTICE 'POSTCOND: no customer row available to source an FK from — rounding probe SKIPPED (structural proofs still ran)';
  ELSE
    BEGIN
      INSERT INTO public.orders (
        order_number, customer_id, total_price, total_cost, total_profit
      ) VALUES (
        'PROBE-ROUND-' || substr(md5(random()::text), 1, 10),
        v_probe_id, 100.005, 33.333, 66.667
      )
      RETURNING id, total_price, total_cost, total_profit
      INTO v_probe_order_id, v_stored_price, v_stored_cost, v_stored_profit;

      -- Assertions use IS DISTINCT FROM, and FOUND is checked first. A plain
      -- `<>` against a NULL variable evaluates to NULL, which PL/pgSQL treats as
      -- false — so if the INSERT ever returned no row (a rule or a future BEFORE
      -- trigger returning NULL suppresses it), every assertion below would pass
      -- silently and this proof would prove nothing.
      IF NOT FOUND THEN
        RAISE EXCEPTION 'POSTCOND: the probe INSERT stored no row, so nothing was proven';
      END IF;

      IF v_stored_price IS DISTINCT FROM 100.01 THEN
        RAISE EXCEPTION 'POSTCOND: total_price 100.005 stored as % (expected 100.01)', v_stored_price;
      END IF;
      IF v_stored_cost IS DISTINCT FROM 33.33 THEN
        RAISE EXCEPTION 'POSTCOND: total_cost 33.333 stored as % (expected 33.33)', v_stored_cost;
      END IF;
      IF v_stored_profit IS DISTINCT FROM 66.68 THEN
        RAISE EXCEPTION 'POSTCOND: total_profit was stored as % (expected derived 100.01 - 33.33 = 66.68)', v_stored_profit;
      END IF;

      -- UPDATE leg. The production defect exists on both paths and INSERT alone
      -- does not prove UPDATE — a column-scoped trigger fires on UPDATE only when
      -- the writer names one of its columns in the SET list, and the ordinary
      -- editing path (_update_order_items_impl) writes total_price by itself.
      -- Different values from the INSERT leg, so a stale variable cannot pass this.
      -- Same savepoint, so this is rolled back with everything else.
      UPDATE public.orders
         SET total_price = 77.777, total_cost = 44.444, total_profit = 55.555
       WHERE id = v_probe_order_id
      RETURNING total_price, total_cost, total_profit
      INTO v_stored_price, v_stored_cost, v_stored_profit;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'POSTCOND: the probe UPDATE matched no row, so the UPDATE path is unproven';
      END IF;

      IF v_stored_price IS DISTINCT FROM 77.78 THEN
        RAISE EXCEPTION 'POSTCOND: on UPDATE, total_price 77.777 stored as % (expected 77.78)', v_stored_price;
      END IF;
      IF v_stored_cost IS DISTINCT FROM 44.44 THEN
        RAISE EXCEPTION 'POSTCOND: on UPDATE, total_cost 44.444 stored as % (expected 44.44)', v_stored_cost;
      END IF;
      IF v_stored_profit IS DISTINCT FROM 33.34 THEN
        RAISE EXCEPTION 'POSTCOND: on UPDATE, total_profit was stored as % (expected derived 77.78 - 44.44 = 33.34)', v_stored_profit;
      END IF;

      -- Success path: raise a sentinel purely to undo the INSERT.
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PROBE_OK_ROLLBACK';
    EXCEPTION
      WHEN check_violation THEN
        -- orders carries several CHECKs — five at this migration's apply time,
        -- seven once the sibling 20260813030000 adds its two finiteness checks.
        -- Reporting every 23514 as "the trigger did not fire" would be a confident
        -- wrong diagnosis on a money path, so the real constraint name and message
        -- are carried through instead of discarded.
        RAISE EXCEPTION 'POSTCOND: a probe write hit a CHECK constraint (%). If that is a whole-cent constraint the rounding trigger is not taking effect; if it is another constraint, this probe row needs different values.', SQLERRM;
      WHEN SQLSTATE 'P0001' THEN
        -- Only the sentinel is swallowed. Every other P0001 is one of the
        -- assertion failures above and must keep propagating.
        IF SQLERRM <> 'PROBE_OK_ROLLBACK' THEN
          RAISE;
        END IF;
        -- v_stored_* hold the UPDATE leg's values here, since the UPDATE ran last.
        -- The INSERT leg's values are not re-reported; if it had failed, one of the
        -- assertions above would have raised and this line would never be reached.
        RAISE NOTICE 'POSTCOND: rounding/derivation probe passed on INSERT (100.005/33.333/66.667 -> 100.01/33.33/66.68) and on UPDATE (77.777/44.444/55.555 -> %/%/%); probe row rolled back',
          v_stored_price, v_stored_cost, v_stored_profit;
    END;
  END IF;
END;
$postcond$;

-- Release the caps set at the top of this file. Plain SET is session-scoped, so
-- without this an applier that reuses its connection would carry a 60s statement
-- timeout into whatever runs next.
RESET statement_timeout;
RESET lock_timeout;
