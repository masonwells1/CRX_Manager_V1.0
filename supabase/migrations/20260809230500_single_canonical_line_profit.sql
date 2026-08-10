-- One canonical profit calculation for an order and its lines.
--
-- Closes the KNOWN RESIDUAL declared in the header of 20260809170900 and the
-- BLOCKING finding Codex returned against PR #354 head 3219db58: the order
-- header and the sum of its own line items can compute two different profits
-- for the same order, silently.
--
-- MEASURED ON LIVE BEFORE WRITING THIS (2026-08-09, rhyzpcqhnizqbxphqdkr,
-- read-only). Not a hypothetical:
--   * 62 orders carry line items. 11 of them disagree between
--     orders.total_profit and SUM(order_items.profit).
--   * Only 6 of the 11 are rounding-scale (1-2 cents). The other 5 range from
--     dimes to four figures — orders of magnitude beyond anything a rounding
--     rule can produce, and the largest single gap is most of that order's
--     profit.
--   * Exact per-order and total dollar figures are deliberately NOT recorded in
--     this file: this repository is public. They are in the access-controlled
--     session record, per the same convention as
--     docs/manual/KNOWN_ISSUES.md.
--
-- ROOT CAUSE — it is not rounding, and it is not a cost that moved.
--   The header is DERIVED. trg_recalc_order_totals recomputes it from the lines
--   on every line write. The per-line `profit` column is DERIVED BY NOBODY: it
--   is whatever the writing function last stored, and nothing refreshes it.
--   On the 11 disagreeing orders, 38 of 59 lines hold a profit that exactly
--   equals price - cost x units, and 21 do not. Every one of those 59 lines
--   also carries cost_at_time_cents, and it is IDENTICAL to the current
--   cost_per_unit on all 59 — so "the product cost changed after the sale" is
--   ruled out. The line values were simply never rewritten.
--   The write paths differ: price_order and _update_order_items_impl compute
--   profit correctly, while _convert_quote_to_order_owner_impl COPIES
--   quote_items.profit verbatim onto the order line. A stale quote figure is
--   inherited by the line while the header recomputes from cost — which is
--   exactly the shape of the large gaps.
--
-- THE FIX — round once, at the line, then only ever add whole cents.
--   1. order_items.profit becomes DERIVED, in the database, on every write:
--        profit := ROUND(total_price, 2)
--                  - ROUND(cost_per_unit * total_units_needed, 2)
--      Whatever a caller passes for `profit` is overwritten. There is no longer
--      a way for a write path to store a profit that disagrees with its own
--      price and cost.
--   2. trg_recalc_order_totals rounds BOTH sides PER LINE before summing,
--      instead of summing raw values and rounding once at the end.
--   Those two together make the agreement exact by algebra, not by luck. The
--   trigger computes the header as
--        total_profit = SUM(rounded line price) - SUM(rounded line cost)
--   and each line stores exactly (rounded line price - rounded line cost), so
--        SUM(order_items.profit) = orders.total_profit
--   with no residual at all.
--   VERIFIED ON LIVE DATA BEFORE WRITING: evaluating both sides across all 62
--   orders with line items gives zero orders where they differ.
--
--   PRECISE SCOPE OF THAT "EXACT" CLAIM — both reviewers were right to push on
--   it, and it is narrower than it first looks.
--     (a) It is a claim about total_PROFIT only. It is NOT a claim that
--         orders.total_price always equals SUM(rounded line price): the
--         order-edit RPC overwrites total_price with the RAW line sum straight
--         after the trigger runs. See out-of-scope note (4).
--     (b) It holds for every line whose STORED profit is the derived value. It
--         does not retroactively fix the 37 lines that are already stale; those
--         are section 3.
--   Rounding the PRICE side per line as well (an earlier draft rounded only the
--   cost side) is what keeps the profit identity exact even on an order that
--   still contains one of the 46 legacy fractional-cent total_price rows, so no
--   penny-scale residual survives.
--
--   Note what this deliberately does NOT do: the header does not start reading
--   order_items.profit. It keeps deriving from price and cost, which are the
--   durable inputs. That matters — if the header summed the stored line profits
--   instead, then editing one line on an order whose OTHER lines are still
--   stale would drag the (currently correct) header down to the stale figure.
--   Deriving both sides from the same rounded inputs gets exact agreement
--   without ever letting a stale cache reach the header.
--
-- THIS REVERSES A POSITION STATED IN 20260809170900. Do not skip this.
--   That file argued: "profit is NOT re-derived from the rounded total_price,
--   because profit is (price - cost) x quantity, not a function of revenue —
--   deriving it from rounded revenue would silently change margin figures
--   rather than just their precision."
--   That reasoning is now overridden on purpose. total_price IS price x units,
--   so (price - cost) x units and total_price - (cost x units) are the same
--   quantity; deriving from the rounded inputs moves any single line by at most
--   one cent, and buys exact additivity between a line and its header. Mason
--   chose exact additivity on 2026-08-09 after being shown the measured
--   live disagreement above. net_margin remains a PERCENTAGE and is still
--   deliberately untouched — see out-of-scope note (3).
--
-- FORWARD-LOOKING ONLY, ON PURPOSE.
--   Nothing below the trigger definitions writes a row. Applying this file
--   moves no live money. The one-time repair of the 37 already-stale lines is
--   at the bottom, COMMENTED OUT, with its exact consequences — running it is a
--   separate authorisation, exactly like the fractional-cent repair held back in
--   20260809170800.
--
-- NOT STANDALONE-CORRECT — carried forward from 20260809170900, which carried
--   the same warning. This file re-creates trg_order_items_round_money but NOT
--   trg_commissions_round_money, and _round_money_to_whole_cents handles both
--   tables. Applied against a database that never ran 20260809170800, it would
--   silently leave commissions.commission_amount unrounded. That is fine here:
--   20260809170800 and 20260809170900 are both applied live (high-water
--   20260809205423). It matters for a from-scratch rebuild, where migrations
--   must run in timestamp order.
--
-- DOWNSTREAM CONSUMERS OF orders.total_profit.
--   _insert_commissions_for_order and the pending-commission recompute in
--   20260617115903 both size commission liability from orders.total_profit.
--   Per-line rounding can shift a future header by cents, so newly created and
--   recomputed PENDING commissions shift by cents too. Nothing already paid is
--   touched, and applying this file restates nothing: no header is rewritten
--   until that order's next line write.
--
-- OUT OF SCOPE, FLAGGED NOT FIXED (1): trg_recalc_order_totals is SECURITY
--   DEFINER and holds EXECUTE for `authenticated` and `service_role` on live
--   (postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres).
--   A `RETURNS trigger` function cannot be called directly and is not exposed
--   through PostgREST, so the ordinary API surface cannot reach it — but "not
--   exploitable" is too strong a claim: a role holding both EXECUTE and CREATE
--   could attach it as a trigger on its own table and drive the
--   definer-privileged UPDATE against a chosen order_id. The blast radius is
--   recomputing a header to its correct derived value, not writing arbitrary
--   numbers. Not fixed here because 20260728231350 deliberately ASSERTS that
--   `authenticated` retains EXECUTE on that whole function set; revoking it
--   contradicts a settled migration and needs its own review. CREATE OR REPLACE
--   below preserves the ACL rather than silently changing it.
--   One honest edge in the "correct derived value" wording above: for an order
--   with ZERO line items the function writes 0 to all four header columns, so
--   the driveable effect is not strictly "recompute to the right number" — it
--   can zero the header of an order that has no lines. Still not arbitrary-value
--   writing, and unchanged from the live behaviour.
--
-- OUT OF SCOPE, FLAGGED NOT FIXED (2): two live functions write
--   order_items.profit with the old formula, and the BEFORE trigger now
--   overwrites both with the derived value:
--     * bulk_import_order (20260806023048) ends by allocating the old
--       header-vs-lines residual onto the last line with an UPDATE that sets
--       `profit = profit + <residual>`. Under the new invariant that residual is
--       provably zero, so no money moves.
--     * _update_order_items_impl (20260617123503:212, :229, :259) computes
--       profit as (price_per_unit - cost_per_unit) x units. That is the same
--       quantity the trigger derives, so the two agree to within the rounding.
--   In both cases no money moves, but the statements become decoration, and
--   decoration on a money path misleads the next reader. Removing them means
--   editing two large live functions and belongs in its own change.
--
-- OUT OF SCOPE, FLAGGED NOT FIXED (3): order_items.net_margin is a percentage
--   and stays caller-written, so a line's margin % can disagree with its
--   derived profit. This is broader than the convert-from-quote lines this
--   migration exists to correct: _update_order_items_impl writes net_margin from
--   price_per_unit/cost_per_unit at 20260617123503:213-215, :230-232 and :260,
--   so the ordinary ORDER-EDIT path can produce the same disagreement. Deriving
--   net_margin is a display-accuracy change, not a money change, and is left for
--   a follow-up.
--
-- OUT OF SCOPE, FLAGGED NOT FIXED (4): orders.total_price is overwritten with
--   the RAW line sum immediately after this trigger runs. _update_order_items_impl
--   (20260617123503:274-275) does
--     SELECT COALESCE(SUM(total_price), 0) INTO v_new_total FROM order_items ...;
--     UPDATE orders SET total_price = v_new_total ... ;
--   That write is on `orders`, so no trigger re-fires and the value stands. On an
--   order still holding one of the 46 legacy fractional-cent lines, the header's
--   total_price therefore ends up as the raw sum rather than the sum of rounded
--   line prices, and total_price - total_cost no longer equals total_profit.
--   This PRE-DATES this migration and is not a regression introduced here — but
--   it is why the exactness claim at the top is scoped to total_PROFIT only.
--   total_profit and total_cost are not clobbered, so SUM(order_items.profit) =
--   orders.total_profit holds regardless. Deleting those two lines (the AFTER
--   trigger has owned that column since 20260209200000) is the right fix and
--   belongs in its own migration alongside note (2).

-- ---------------------------------------------------------------------------
-- 1. order_items.profit becomes derived, not stored-by-the-caller.
-- ---------------------------------------------------------------------------
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

    -- DERIVED, not merely rounded (changed 2026-08-09; see this file's header).
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
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._round_money_to_whole_cents() IS
  'Canonical money point for the numeric-dollar columns. Rounds '
  'order_items.total_price and commissions.commission_amount to whole cents '
  '(2dp, half-up), and DERIVES order_items.profit as rounded line revenue minus '
  'rounded line cost so that the sum of a header''s lines equals the header '
  'exactly. net_margin is a percentage and is deliberately excluded. Added '
  '2026-08-08; profit made derived 2026-08-09 per Mason''s decision after live '
  'measurement showed header-vs-lines disagreement across 11 orders.';

-- Re-asserted defensively. CREATE OR REPLACE preserves the ACL 20260809170800
-- set, so on the normal path this is a genuine no-op. It is here so the REVOKE
-- can never be separated from the CREATE by a future edit to either file. This
-- database carries ALTER DEFAULT PRIVILEGES granting anon EXECUTE on every new
-- public function, and PostgreSQL grants PUBLIC EXECUTE by default.
REVOKE ALL ON FUNCTION public._round_money_to_whole_cents() FROM PUBLIC, anon, authenticated, service_role;

-- The trigger must now also fire when a COST input changes, not just a money
-- output: profit is derived from cost_per_unit and total_units_needed, so an
-- UPDATE touching only those would otherwise leave a stale profit behind —
-- reintroducing the exact bug this migration exists to remove.
--
-- WIDENS THE SIDE EFFECT ALREADY ACCEPTED IN 20260809170900. That file noted
-- that firing on `profit` means an unrelated profit write also rounds a
-- historical row's fractional total_price, repairing one of the 46 rows the
-- 20260809170800 repair statement is deliberately holding back. Adding
-- cost_per_unit and total_units_needed widens the set of writes that can do
-- that. Accepted on the same grounds: the value such a row lands on is the one
-- Mason already decided (2dp half-up), and the alternative — a second trigger
-- with a disjoint column scope — reintroduces the second rounding point that
-- 20260809170800 was written to eliminate.
--
-- SECOND CONSEQUENCE OF THE WIDENING: the derivation keys off cost_per_unit,
-- which is mutable, not off the immutable cost_at_time_cents snapshot. So a
-- cost correction on a delivered or invoiced line now restates that LINE's
-- historical profit, where previously only the header moved. That is consistent
-- with what the header has always done, but it is the first time the line
-- follows it.
--
-- TRIGGER FIRING ORDER, checked rather than assumed: PostgreSQL fires
-- same-timing triggers in name order, so trg_order_items_round_money runs
-- before trg_snapshot_order_item_cost. That would matter if the snapshot
-- trigger wrote cost_per_unit — it writes only cost_at_time_cents, so the
-- derivation is unaffected. guard_order_item_delivery_lineage is BEFORE UPDATE
-- OF order_id, product_id, disjoint from this trigger's column list.
DROP TRIGGER IF EXISTS trg_order_items_round_money ON public.order_items;
CREATE TRIGGER trg_order_items_round_money
  BEFORE INSERT OR UPDATE OF total_price, profit, cost_per_unit, total_units_needed
  ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public._round_money_to_whole_cents();

-- ---------------------------------------------------------------------------
-- 2. The header sums per-line whole-cent values instead of raw ones.
-- ---------------------------------------------------------------------------
-- The body below is reproduced explicitly from the CURRENT LIVE definition.
-- PROVEN, not assumed: `pg_proc.prosrc` was read read-only from
-- rhyzpcqhnizqbxphqdkr on 2026-08-09 (body md5 4a156b2f0a519ec188bfd0afb1a709f7,
-- prosecdef = true, proconfig = {"search_path=public, pg_temp"}) and compared
-- line by line against what is written here. Every line matches except the two
-- SEMANTIC deltas below, plus one added comment block inside the body (comments
-- live in prosrc, so a byte-diff will show three differences, not two):
--
--   live: COALESCE(SUM(total_price), 0)
--   here: COALESCE(SUM(ROUND(total_price, 2)), 0)
--
--   live: COALESCE(SUM(COALESCE(cost_per_unit, 0) * total_units_needed), 0)
--   here: COALESCE(SUM(ROUND(COALESCE(cost_per_unit, 0)
--                            * COALESCE(total_units_needed, 0), 2)), 0)
--
-- The added COALESCE on total_units_needed is behaviour-neutral — the column is
-- NOT NULL WITH DEFAULT — and is spelled out here because an earlier draft of
-- this header described "one change" while making two.
--
-- Summing raw per-line values and rounding once at the end is what made the
-- header disagree with the sum of the lines' own rounded values. Rounding per
-- line on both sides is the whole fix on this side.
--
-- SECURITY DEFINER and SET search_path are carried over unchanged; live
-- proconfig is {"search_path=public, pg_temp"}. (The defining migration
-- 20260311200000 says `SET search_path = public`; the bulk hardening migration
-- 20260332800000 added pg_temp to every SECURITY DEFINER function afterwards,
-- which is why live and that file differ. Live is the authority here.) The ACL
-- is untouched — see out-of-scope note (1).
CREATE OR REPLACE FUNCTION public.trg_recalc_order_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_total_price numeric;
  v_total_cost numeric;
  v_total_profit numeric;
  v_margin_pct numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  -- Both sides summed from PER-LINE whole-cent values, matching how each line
  -- derives its own profit. The result: v_total_profit == SUM(order_items.profit)
  -- for the same order, exactly, for every line whose stored profit is the
  -- derived value. Verified across all 62 live orders with line items before
  -- this was written.
  SELECT
    COALESCE(SUM(ROUND(total_price, 2)), 0),
    COALESCE(SUM(ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)), 0)
  INTO v_total_price, v_total_cost
  FROM order_items
  WHERE order_id = v_order_id;

  v_total_profit := v_total_price - v_total_cost;
  v_margin_pct := CASE WHEN v_total_price > 0
    THEN ROUND((v_total_profit / v_total_price) * 100, 2)
    ELSE 0
  END;

  UPDATE orders SET
    total_price = ROUND(v_total_price, 2),
    total_cost = ROUND(v_total_cost, 2),
    total_profit = ROUND(v_total_profit, 2),
    total_margin_pct = v_margin_pct,
    -- REMOVED: balance_due = ... (AR tracked via invoices.balance_cents)
    updated_at = now()
  WHERE id = v_order_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

COMMENT ON FUNCTION public.trg_recalc_order_totals() IS
  'Recomputes orders.total_price/total_cost/total_profit/total_margin_pct from '
  'the order''s lines on every line write. Both sides are summed from per-line '
  'whole-cent values (2026-08-09), so the header profit equals SUM(order_items.'
  'profit) exactly rather than approximately.';

-- Belt-and-braces re-assertion of the identical statement 20260728231350:79
-- already applied. It is a verified NO-OP on live: the ACL read on 2026-08-09 is
-- postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres, so
-- neither PUBLIC nor anon holds anything to revoke, and revoking FROM PUBLIC,
-- anon cannot strip a named-role grant.
--
-- Be honest about what it does and does not buy. An earlier draft justified it
-- as protecting a from-scratch rebuild; that rationale was wrong and the RLS
-- reviewer caught it. trg_recalc_order_totals is first created much earlier in
-- timestamp order (20260209200000, rewritten by 20260311200000), no migration
-- ever DROPs it, and CREATE OR REPLACE preserves an existing ACL — so on an
-- ordered rebuild 20260728231350's revoke survives and is not lost. The real
-- value here is narrower: it keeps the revoke adjacent to the function
-- definition, so a future edit to this body cannot silently ship without it.
-- It deliberately does NOT touch the authenticated/service_role grants parked in
-- out-of-scope note (1).
REVOKE EXECUTE ON FUNCTION public.trg_recalc_order_totals() FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 3. ONE-TIME REPAIR OF THE ALREADY-STALE LINES — NOT RUN. NEEDS ITS OWN OK.
-- ---------------------------------------------------------------------------
-- Everything above is forward-looking. It stops new drift; it does not fix the
-- 37 lines that are already wrong. Those stay wrong until the statement below
-- is deliberately uncommented and applied.
--
-- SCOPE, measured live 2026-08-09 (read-only):
--   * 288 order_items rows exist. 37 of them, across 17 orders, hold a `profit`
--     that differs from the derived value. The other 251 are already correct
--     and the UPDATE's WHERE clause skips them.
--   * The 11 orders with a visible header-vs-lines gap are a subset of those 17.
--
-- WHAT MOVES, AND WHAT DOES NOT:
--   * No order's total_profit changes materially. The header is already
--     computed from price and cost and is already right; the repair corrects
--     the LINES UP TO MEET IT. On the worst order the lines currently sum to
--     roughly half of that order's header profit; after the repair they sum to
--     the header exactly. Per-product profit reporting is understating that
--     order by four figures today. Exact per-order amounts are in the
--     access-controlled session record, not in this public repository.
--   * Headers move only by the per-line rounding change in section 2 — cents.
--
-- THE CONSEQUENCE THAT MUST BE STATED BEFORE ANYONE RUNS THIS:
--   11 of the 37 lines carry a fractional-cent total_price. Writing to those
--   rows fires trg_order_items_round_money, which rounds total_price as well.
--   So this repair silently repairs 11 of the 46 fractional order_items rows
--   that 20260809170800 is deliberately holding back — they land on the value
--   Mason already chose (2dp half-up), but they are repaired here rather than
--   together with the other 35 in one authorised, auditable act.
--   The 3 fractional `commissions` rows, including the largest PENDING
--   PAYOUT, are NOT touched by this statement under any circumstances: it does
--   not write to the commissions table, and trg_commissions_round_money stays
--   scoped to UPDATE OF commission_amount.
--
-- Do NOT widen this WHERE clause to also catch fractional total_price rows
-- whose profit is already correct. That would pull more of the 46 held-back
-- rows into a repair nobody authorised.
--
-- Take a backup first. Supabase Free has no point-in-time recovery.
--
-- UPDATE public.order_items
--    SET profit = ROUND(total_price, 2)
--                 - ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2)
--  WHERE total_price IS NOT NULL
--    AND profit IS DISTINCT FROM
--        ROUND(total_price, 2)
--        - ROUND(COALESCE(cost_per_unit, 0) * COALESCE(total_units_needed, 0), 2);
--
-- The AFTER trigger after_order_items_change fires per row and recomputes each
-- affected order's header, so no separate header refresh is needed.
