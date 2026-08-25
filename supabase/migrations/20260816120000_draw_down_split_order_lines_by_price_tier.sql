-- =============================================================================
-- Draw-down: split the order into one line per booked price tier
-- =============================================================================
--
-- PLAIN ENGLISH
-- -------------
-- When a booking (quote) lists the same product more than once at different
-- prices -- say 1,000 units at $1.00 and 2,000 units at $1.01 -- drawing that
-- booking down used to collapse both onto ONE order line priced at the
-- weighted average, $1.00666...  That average is not a real price: it is not a
-- whole number of cents.
--
-- Two bad outcomes followed from that:
--
--   1. The draw FAILS today.  order_items_price_per_unit_cent_scale_chk and the
--      below-cost trigger both require a whole-cent unit price, so the insert is
--      rejected with INVALID_UNIT_PRICE_CENTS and the customer's order cannot be
--      created at all.
--   2. The "obvious" fix -- rounding that average to $1.01 -- is WORSE than the
--      failure, because the rounded unit price is then multiplied by the
--      quantity.  The error is not one cent; it is up to half a cent TIMES THE
--      QUANTITY.  On the example above, an exact $3,020.00 becomes $3,030.00.
--      That total feeds order revenue, profit, commissions and the audit log.
--      An earlier candidate migration took that approach; the adversarial
--      review gate blocked it and it was abandoned.  Do not reintroduce it.
--
-- This migration removes the average entirely.  Each booked price tier becomes
-- its own order line, carrying the quote's own price -- which is already
-- guaranteed to be a whole number of cents by
-- quote_items_price_per_unit_cent_scale_chk.  Nothing is rounded at the unit
-- level, so nothing can be scaled up by quantity.
--
-- The UNIT price is therefore exact by construction.  The line EXTENSION is a
-- separate question, and an earlier draft of this header overstated it as
-- "money is exact by construction rather than exact by rounding" full stop.
-- That is true only while quantities are whole.  They are not: the draw
-- quantity box and the quote-line quantity boxes are all step="any", so
-- price x quantity can legitimately land on a fraction of a cent and must be
-- rounded somewhere.  The 2026-08-16 push-proof found the first version of this
-- migration rounding EACH DRAW in isolation (CRX-MONEY-TIER-ROUND-001, High),
-- which let the residual accumulate across partial draws -- billing $1.02 on a
-- $1.00 booking drawn in four fractional pieces.
--
-- What is now guaranteed is narrower and true: each tier's lines are rounded
-- against that tier's RUNNING TOTAL, so however a tier is drawn down -- one
-- draw or twenty, whole or fractional -- the lines still billing the customer
-- sum to exactly ROUND(tier_price x units_billed_at_that_tier, 2).  No residual
-- accumulates and the result does not depend on how the draw was split up.
--
-- Nor does it depend on which draws were later REVERSED.  A second push-proof
-- finding (CRX-MONEY-LIFECYCLE-001, High) showed that re-basing on surviving
-- UNITS was not enough: after a void, the surviving lines no longer hold the
-- amount that formula assumes they hold, and voiding the first of two identical
-- draws billed a different total than voiding the second.  The running total is
-- therefore re-based on the cents ACTUALLY standing against the tier, which is
-- path-independent through voids and cancellations and additionally self-heals
-- a tier that older per-draw rounding had already mis-billed.  See the
-- telescoping comment at v_line_total for the arithmetic.
--
-- WHAT ELSE THIS FIXES
-- --------------------
-- The old code also averaged the COST across tiers and rounded that average to
-- whole cents before multiplying by quantity -- the same defect, on the cost
-- side, already live.  Each tier now carries its own exact snapshot cost from
-- quote_items.cost_at_quote_cents (already stored as integer cents), so the
-- cost basis is exact too, and the order line's profit, the order header, the
-- commission basis and the cost_at_time_cents stamp all agree on one value.
--
-- That agreement is not free, and the third push-proof finding
-- (CRX-MONEY-PROFIT-001, High) is what pins it down.  order_items.profit is
-- owned by the canonical trigger from 20260809230500, which discards any
-- supplied profit and recomputes it PER LINE.  So the cost figure this function
-- accumulates into the header has to be computed the trigger's way, not
-- cumulatively; otherwise the header quietly disagrees with the very lines it
-- summarises.  The consequence, stated plainly: the REVENUE side is exact to
-- the cent, while the COST side still carries the ordinary per-line rounding
-- residual on fractional quantities -- identical to every other order path in
-- the system.  Removing that too would mean changing the shared trigger for all
-- order lines, and is deliberately out of scope here.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- Inventory pre-booking, the inventory_transactions entry, hold consumption and
-- the quote_product_draws ledger stay PER PRODUCT and still move the full drawn
-- quantity exactly once.  They are deliberately left outside the new per-tier
-- loop.  The JSON returned to the app also keeps its existing per-product shape
-- ('product_id', 'product_name', 'drawn', 'remaining'), so no frontend change is
-- required.
--
-- HOW UNITS ARE ALLOCATED ACROSS TIERS
-- ------------------------------------
-- A TIER IS ONE BOOKED QUOTE LINE, not a (price, cost) bucket.  Two lines at
-- the same price stay two tiers, in the customer's own document order (section
-- position, then line position, then the line id as a deterministic tiebreak).
--
-- A tier counts as used up to the extent that ORDER LINES WHICH STILL BILL THE
-- CUSTOMER NAME IT.  Every line this body writes stamps
-- order_items.quote_item_id, so attribution is an identity lookup rather than a
-- price-and-cost guess.  The split is a running cursor over what is left, never
-- a division, so the allocated quantities sum to the requested quantity
-- EXACTLY.  A fail-closed assertion (DRAW_ALLOCATION_MISMATCH) refuses the
-- whole draw if they ever do not.
--
-- Lines written before this migration carry no stamp.  Revising a quote does
-- NOT clear the stamps on its drawn lines: save_quote rebuilds a quote by
-- deleting and reinserting its sections, and this migration makes
-- order_items_quote_item_id_fkey DEFERRABLE INITIALLY DEFERRED while keeping
-- ON DELETE NO ACTION, so the link may be transiently broken inside that one
-- transaction and is re-checked at COMMIT -- by which time save_quote has
-- reinserted the same quote_items ids.  (See the FK block near the end of
-- this file for the reuse path it rests on, and for the one narrow shape
-- that still fails closed.)  Genuinely unstamped units walk off the FRONT of
-- the tier list, and DRAW_MIXED_TIER_UNMATCHED_LINE refuses the draw outright
-- the moment the product carries more than one distinct (price, cost) -- so
-- the front-walk only ever runs where it cannot change what the customer is
-- billed.
--
-- Acres are per-line, not prorated.  Each emitted line takes the share of ITS
-- OWN booked line's acreage that the draw takes of ITS OWN units, so a line is
-- never written at an acres-per-unit rate it was not booked at.  The earlier
-- form divided one whole-draw figure by units and, on a product booked at two
-- different rates, invented a third rate on both lines -- a figure that reaches
-- the customer, since complete_delivery copies acres into invoice_items.
-- Acres are an agronomic reference figure, not money; the money lines sum
-- EXACTLY (see the allocation assertion above).
--
-- BEHAVIOUR CHANGE WORTH KNOWING
-- ------------------------------
-- Below-cost detection gets sharper.  Previously an average price above cost
-- could hide one tier that was genuinely below cost; each tier is now checked on
-- its own.  A draw with a below-cost tier will therefore now correctly require
-- admin below-cost approval through the draw_down_quote wrapper.  That is the
-- intended behaviour, not a regression.
--
-- SAFETY
-- ------
-- Read-only preflight pins the live function body (md5
-- 87bf7adcdc63d94684676da5ab09bfde) and refuses to run if a second overload of
-- the same name exists, so this fails closed if anything else has redefined it
-- since this migration was written.  No business rows are written, moved or
-- deleted by this migration.  It replaces one function body and adds one
-- validated CHECK constraint to public.quote_items; validation READS every
-- existing row of that table and holds ACCESS EXCLUSIVE on it until commit, so
-- the apply is not free of a lock footprint and must not be sized as if it
-- were.  See the lock_timeout note at the lock block below.
-- CREATE OR REPLACE preserves the existing owner and the deliberate
-- postgres-only EXECUTE grant established by 20260812115237; the REVOKE below
-- re-states that posture defensively rather than relying on inheritance.
--
-- No explicit BEGIN/COMMIT: the applier wraps each migration in its own
-- transaction, and the surrounding migrations in this series do the same. An
-- explicit COMMIT here would end that outer transaction early and leave the
-- postflight running outside it.
-- =============================================================================

-- --- Serialize the cutover against in-flight legacy draws ---------------------
-- The preflight below scans for evidence of draws taken under the old averaging
-- body, and this migration then replaces that body. Those two steps are not
-- atomic with respect to a concurrent draw: one that started before the scan
-- can commit after it, so the scan would miss it and the new body would inherit
-- exactly the untrustworthy average the preflight exists to refuse (Codex
-- review 2026-08-16, CRX-MONEY-001).
--
-- Every draw path writes public.quote_product_draws -- the ON CONFLICT upsert
-- further down this file -- so locking that one table serializes the whole draw
-- operation. SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE that
-- INSERT/UPDATE takes, but not with plain SELECT, so readers are unaffected.
-- The applier wraps this migration in a single transaction (see the note
-- above), so the lock is held until the new body is in place. A draw that has
-- not yet reached its ledger write blocks there until this migration commits,
-- and a draw that committed before the lock is visible to the scan.
--
-- A table lock alone does NOT close the window, and earlier revisions of this
-- comment said so and left it open (Codex review 2026-08-16, CRX-MIG-CUTOVER-001
-- and CRX-MONEY-CUTOVER-001). It cannot drain a draw that is ALREADY RUNNING:
-- that call is executing the old body out of its own session plan cache, keeps
-- executing it after the replacement commits, and its uncommitted rows are
-- invisible to the scan. So a legacy averaged draw could land just after the
-- scan believed itself authoritative.
--
-- That window is now ELIMINATED, by the advisory lock taken immediately below
-- together with the cutover barrier shipped in 20260816110000. That migration
-- rewrote public.draw_down_quote -- the only entry point that can reach this
-- implementation -- so that every draw first calls
-- pg_try_advisory_xact_lock_shared(20260816, 1) and refuses outright, writing
-- nothing, if the key is held exclusively. Taking the same key EXCLUSIVE here
-- gives three cases, exhaustive over every draw PLANNED after 20260816110000
-- committed:
--
--   * a draw that took SHARE before this request holds it to commit, so this
--     migration blocks until that draw has committed and the preflight scan
--     below sees its rows;
--   * a draw arriving while this migration holds EXCLUSIVE is refused and
--     records nothing;
--   * a draw arriving after this migration commits finds the key free and is
--     planned fresh, so it runs the new body.
--
-- A draw already EXECUTING the pre-barrier wrapper when 20260816110000
-- committed falls outside all three: CREATE OR REPLACE FUNCTION does not
-- interrupt a running call, so it takes no key. The preflight below closes that
-- separately, by refusing to run while any other client-backend transaction
-- older than this one is still open (CRX-MONEY-CUTOVER-002). With that gate
-- there is no interval in which the old body can commit a row this scan did not
-- see -- but it holds only if the two migrations are applied as two SEPARATELY
-- COMMITTED calls. Bundled into one transaction the barrier never becomes
-- visible to any other session, every concurrent draw runs unbarriered, and the
-- catalog assertions below would still pass by reading this transaction's own
-- uncommitted catalog. That is not left to the operator: the preflight compares
-- pg_proc.xmin on the wrapper row against this transaction's own id and raises
-- DRAW_DOWN_CUTOVER_BARRIER_UNCOMMITTED if the barrier was installed here,
-- so a bundled apply fails and rolls back instead of silently proceeding.
--
-- The barrier deliberately does NOT wait: measured on PostgreSQL 17.10, a
-- session with a warm plan cache that blocks on a waiting advisory lock across
-- the replacement resumes and still runs the OLD body, because a backend does
-- not re-check plan invalidations mid-command. Waiting would have made the race
-- reliable instead of rare. See the header of 20260816110000.
--
-- Lock ordering: advisory key first, table lock second, on both sides. The
-- barrier takes the advisory lock as the first statement in the wrapper, before
-- any table is touched, and this migration does the same, so no cycle and no
-- deadlock is possible between a draw and this cutover.
--
-- The preflight below refuses to run at all unless the barrier is live, so this
-- file cannot be applied out of order.
--
-- Two runtime nets remain underneath, for legacy draws taken before the barrier
-- shipped rather than during the cutover. DRAW_MIXED_TIER_UNMATCHED_LINE
-- refuses the next draw on a mixed-tier booking carrying a billed line matching
-- no tier -- the trace a legacy averaged draw normally leaves. An average CAN
-- land exactly on a real tier key and slip past that. DRAW_TIER_OVERCONSUMED is
-- only a PARTIAL second layer: it fires when the quantity attributed to the
-- coincidentally-matched tier EXCEEDS the units booked at that tier, and stays
-- silent when the draw fits inside it. Worked example -- the same one
-- 20260816110000's header uses -- 100 units each at three prices, the average
-- landing exactly on the middle price, and a legacy draw of 50 units: the draw
-- matches the middle tier, 50 is well under its 100 booked units, nothing is
-- over-consumed, and BOTH nets pass. That case is closed by the barrier and the
-- quiet gate alone. Do not read these two nets as an independent proof of the
-- cutover; they are defence in depth for legacy rows
-- (RLS/security review 2026-08-16, HIGH).
--
-- Live evidence recorded further down this header (below, not above) is that no
-- quote carries more than one price tier for the same product today. Re-verify
-- that read-only immediately before applying.
-- Fail fast rather than freeze the app (RLS/security review 2026-08-16, MED).
-- This transaction takes SIX blocking acquisitions, not three (both gate
-- reviewers, 2026-08-19 -- the earlier count predated the order_items lock and
-- the FK swap):
--   1. the cutover advisory key below;
--   2. SHARE ROW EXCLUSIVE on quote_items;
--   3. SHARE ROW EXCLUSIVE on order_items;
--   4. SHARE ROW EXCLUSIVE on quote_product_draws (which queues every other
--      writer of that table, including void/cancel reversals);
--   5. much later, at the CHECK constraint, an upgrade to ACCESS EXCLUSIVE on
--      quote_items, which blocks all READS of the quote builder's main table
--      until commit;
--   6. at the FK swap, an upgrade to ACCESS EXCLUSIVE on order_items.
-- Note what 3 costs: order_items is held at SHARE ROW EXCLUSIVE from that point
-- THROUGH COMMIT, including both validation scans, so every order write in the
-- system queues -- order creation, delivery, invoicing, bulk import -- not just
-- draw-down. Readers are untouched throughout, so the quote pages keep loading.
-- With no lock_timeout a blocked apply waits forever and takes those writers
-- down with it.
--
-- 15s bounds EACH lock acquisition, not the apply as a whole: worst case is six
-- separate 15s waits, so roughly 90s before the apply gives up, and even a
-- FAILING apply queues quote_items readers behind its pending ACCESS
-- EXCLUSIVE request for up to that last 15s. The number is also unmeasured --
-- chosen as comfortably longer than a real draw so the intended hand-off below
-- still works, not derived from a timing run. Wrong either way it fails closed:
-- too short aborts an apply that changed nothing, too long only lengthens the
-- window before that same abort (RLS/security review 2026-08-16, LOW).
--
-- The draw-refusal window is longer than the function replace. This transaction
-- holds the cutover key EXCLUSIVE from the statement below through COMMIT, and
-- that span includes building the quote_items CHECK constraint near the end of
-- this file -- so every draw is refused with DRAW_DOWN_CUTOVER_IN_PROGRESS for
-- the constraint's validation scan too, not just for the function swap.
-- Accepted rather than split into a third migration: another file would add a
-- third ordered apply to an already delicate two-file sequence, and the refusal
-- is instant, writes nothing and is retryable
-- (RLS/security review 2026-08-16, MED).
SET LOCAL lock_timeout = '15s';

SELECT pg_advisory_xact_lock(20260816, 1);

-- QUOTE LINES ARE PINNED FROM HERE, NOT FROM THE ADD CONSTRAINT NEAR THE END
-- (Codex review 2026-08-16, P2 3792960744).
--
-- Two things in this file read quote_items and then act on what they read: the
-- premigration mixed-tier scan just below, which decides whether the whole
-- apply is safe at all, and the CHECK constraint at the end, whose ACCESS
-- EXCLUSIVE lock used to be the FIRST time this table was pinned -- roughly
-- 1,100 lines later.
--
-- The advisory-key handshake does not close that window. It shields
-- draw_down_quote, which takes the same key (20260816110000:240) and refuses
-- with DRAW_DOWN_CUTOVER_IN_PROGRESS while this transaction holds it. It does
-- NOT shield save_quote, which takes that key nowhere -- verified by reading
-- 20260816110000 end to end: the barrier migration alters draw_down_quote and
-- nothing else. So a quote could be revised mid-apply, and the scan's verdict
-- would already be stale by the time the constraint went on: a booking that
-- read single-tier when it was scanned could commit a second price tier
-- moments later, and the apply would proceed on the strength of a fact that
-- had stopped being true.
--
-- SHARE ROW EXCLUSIVE, not ACCESS EXCLUSIVE, and the difference is deliberate:
-- it blocks WRITERS (save_quote included) while leaving every reader alone, so
-- quote pages keep loading for the seconds this apply takes. It is also
-- self-conflicting, so exactly one session can hold it, which is what makes the
-- later upgrade to ACCESS EXCLUSIVE for the constraint deadlock-free rather
-- than merely lucky.
--
-- ORDER MATTERS, and an earlier version of this file got it wrong. The rule is
-- to acquire in the same relative order every writer reaches these tables, so
-- contention is head-on rather than crossing -- crossing is the shape that
-- deadlocks.
--
--   * save_quote reaches the quote's own lines and never touches order rows.
--   * the draw path reaches order_items FIRST (its INSERT) and
--     quote_product_draws SECOND (its ledger write).
--
-- So the correct order is quote_items -> order_items -> quote_product_draws.
--
-- The earlier order took quote_product_draws second and order_items last, which
-- crosses the draw path: a pre-barrier draw already holding ROW EXCLUSIVE on
-- order_items and about to write quote_product_draws would deadlock against
-- this apply holding quote_product_draws and waiting for order_items. Neither
-- the advisory key nor DRAW_DOWN_CUTOVER_NOT_QUIET prevents that -- the key is
-- not taken by a pre-barrier draw, and the quiet gate lives in the preflight
-- DO block BELOW these locks, so it has not run yet. Both gate reviewers found
-- this independently on 2026-08-19; the header's old "no cycle and no deadlock
-- is possible" claim was false. If it does contend, lock_timeout aborts this
-- apply at 15s having changed nothing, and it is safe to re-run.
LOCK TABLE public.quote_items IN SHARE ROW EXCLUSIVE MODE;
-- order_items before quote_product_draws, per the rule above. The FK swap
-- further down needs ACCESS EXCLUSIVE on this table; holding the
-- self-conflicting SHARE ROW EXCLUSIVE from here means that upgrade waits only
-- on readers, never on another writer that could itself be waiting on us.
-- Taking it earlier only lengthens that hold, which does not weaken the
-- property.
LOCK TABLE public.order_items IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.quote_product_draws IN SHARE ROW EXCLUSIVE MODE;

-- --- Preflight: refuse to run against an unexpected body ----------------------
DO $preflight$
DECLARE
  v_md5 text;
  v_overloads integer;
  v_legacy integer;
  v_wrapper_src text;
  v_wrapper_overloads integer;
  v_stats_visible boolean;
  v_inflight integer;
  v_oldest interval;
  v_barrier_same_txn boolean;
  v_prepared integer;
BEGIN
  -- Everything in this file depends on it running inside ONE transaction: the
  -- advisory-key handshake with 20260816110000, the 15s abort, and the
  -- all-or-nothing rollback. Outside a transaction block SET LOCAL is a no-op
  -- that emits only a WARNING and pg_advisory_xact_lock releases at statement
  -- end, so the entire cutover mechanism would silently evaporate while every
  -- catalog assertion below still passed. current_setting reads back '0' in
  -- that case, which makes this a direct test of the assumption rather than the
  -- prose claim it replaces (migration-drift review 2026-08-16, MED).
  IF current_setting('lock_timeout') <> '15s' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_NOT_IN_TRANSACTION: lock_timeout reads %, not 15s, so the SET LOCAL above did not take effect and this migration is not running inside a single transaction. The advisory-lock cutover handshake would do nothing. Apply through a client that wraps each migration in one transaction -- nothing has been changed.', current_setting('lock_timeout');
  END IF;

  -- Identify the target unambiguously. proname + pronargs alone would still be
  -- ambiguous if a same-name overload with four differently-typed arguments
  -- existed, so assert first that exactly one function carries this name.
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_IMPL_OVERLOADED: expected exactly 1 function named public._draw_down_quote_below_cost_impl_20260810, found % -- reconcile before applying', v_overloads;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810'
    AND p.pronargs = 4;

  IF v_md5 IS NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_IMPL_MISSING: public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text) not found; 20260812115237 must be applied first';
  END IF;

  IF v_md5 <> '87bf7adcdc63d94684676da5ab09bfde' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_IMPL_DRIFTED: expected body md5 87bf7adcdc63d94684676da5ab09bfde, found %; another migration has redefined this function -- reconcile before applying', v_md5;
  END IF;

  -- The restore path is replaced further down for the same reason the FK is
  -- deferred, so it gets the same drift discipline: pin the body this file was
  -- written against and refuse to overwrite anything else.
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'RESTORE_IMPL_OVERLOADED: expected exactly 1 function named public._restore_quote_version_owner_impl, found % -- reconcile before applying', v_overloads;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl'
    AND p.pronargs = 4;

  IF v_md5 IS NULL THEN
    RAISE EXCEPTION
      'RESTORE_IMPL_MISSING: public._restore_quote_version_owner_impl(uuid, uuid, uuid, text) not found; 20260812115236 must be applied first';
  END IF;

  IF v_md5 <> 'd8408e3b19b536f1210e51da3970272e' THEN
    RAISE EXCEPTION
      'RESTORE_IMPL_DRIFTED: expected body md5 d8408e3b19b536f1210e51da3970272e, found %; another migration has redefined the restore path -- reconcile before applying, because this file reproduces that body byte-for-byte with one statement added', v_md5;
  END IF;

  -- The cutover barrier must already be live (20260816110000). The advisory
  -- lock taken above is only half of a handshake: it serializes this migration
  -- against draws that TAKE the same key, and a draw entry point without the
  -- barrier takes nothing, so it would sail straight past. Asserting the
  -- barrier here is what makes the ordering a proof gate rather than a hope,
  -- and answers Codex review 2026-08-16 CRX-MONEY-CUTOVER-001, which required a
  -- deterministic barrier rather than an operational "apply when quiet"
  -- instruction.
  --
  -- Checked structurally rather than by body md5 on purpose: 20260816110000
  -- already pins the pre-barrier body it replaces, and a second md5 pin here
  -- would break this file every time the wrapper legitimately changes for an
  -- unrelated reason, which is a refusal that teaches people to delete the
  -- guard.
  SELECT count(*) INTO v_wrapper_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote';

  IF v_wrapper_overloads <> 1 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_WRAPPER_OVERLOADED: expected exactly 1 function named public.draw_down_quote, found % -- an unbarriered overload could still reach the old body', v_wrapper_overloads;
  END IF;

  SELECT p.prosrc INTO v_wrapper_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote'
    AND p.pronargs = 5;

  IF v_wrapper_src IS NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_BARRIER_MISSING: public.draw_down_quote(uuid, jsonb, uuid, text, text) not found; migration 20260816110000 must be applied before this one';
  END IF;

  IF position('pg_try_advisory_xact_lock_shared' IN v_wrapper_src) = 0
     OR position('DRAW_DOWN_CUTOVER_IN_PROGRESS' IN v_wrapper_src) = 0 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_BARRIER_MISSING: the live draw_down_quote wrapper does not carry the fail-fast cutover barrier; apply migration 20260816110000 first, then re-run this one';
  END IF;

  -- Order matters as much as presence: a barrier that runs after the forwarded
  -- call is not a barrier. Both operands are proven nonzero immediately above,
  -- so this comparison cannot be satisfied by a missing string.
  IF position('pg_try_advisory_xact_lock_shared' IN v_wrapper_src)
     > position('_draw_down_quote_below_cost_impl_20260810' IN v_wrapper_src) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_BARRIER_MISORDERED: the live draw_down_quote wrapper takes the cutover barrier after forwarding to the draw-down implementation, so the barrier cannot hold this cutover -- reconcile before applying';
  END IF;

  -- The barrier must already be COMMITTED, not merely present in this
  -- transaction's own snapshot. If 20260816110000 and this migration are
  -- bundled into one transaction, every check above still passes -- they read
  -- this transaction's uncommitted catalog -- while no other session ever sees
  -- the barrier, so every concurrent draw runs unbarriered for the whole apply.
  -- That is the worst case the two headers warn about, and prose is not a
  -- guard. pg_proc.xmin is the transaction that wrote the wrapper row; if it
  -- equals this transaction's id, the barrier was installed here and has not
  -- been committed. Refuse.
  SELECT p.xmin = pg_current_xact_id()::xid INTO v_barrier_same_txn
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote'
    AND p.pronargs = 5;

  -- IS NOT FALSE, not a bare truth test: SELECT ... INTO leaves the variable
  -- NULL if no row matched, and a bare IF would read that blindness as "not
  -- bundled" and continue. The row's existence is proven above, so this is
  -- unreachable today, but it matches the fail-closed form this file uses
  -- everywhere else (migration-drift review 2026-08-16, LOW).
  --
  -- Known narrow gap, recorded rather than papered over: pg_current_xact_id()
  -- returns the TOP-LEVEL transaction id. If the barrier's CREATE OR REPLACE
  -- ran inside a savepoint or a PL/pgSQL block with an EXCEPTION handler, xmin
  -- holds a subtransaction id that never equals it, and a genuinely bundled
  -- apply would slip through. PostgreSQL exposes no in-transaction "is this xid
  -- mine or my subtransaction's" test, so this is close to the best achievable;
  -- the direct top-level path that apply_migration uses is caught correctly.
  IF v_barrier_same_txn IS NOT FALSE THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_BARRIER_UNCOMMITTED: migration 20260816110000 was applied inside THIS transaction, so no other session can see the barrier and concurrent draws are running unbarriered. Apply 20260816110000 as its own committed migration first, then apply this one separately -- nothing has been changed.';
  END IF;

  -- CRX-MONEY-CUTOVER-002 (RLS/security review 2026-08-16, HIGH). The barrier
  -- installed by 20260816110000 binds every draw PLANNED after that migration
  -- commits. It cannot bind a backend that was ALREADY EXECUTING the
  -- pre-barrier wrapper when the barrier landed: CREATE OR REPLACE FUNCTION
  -- neither interrupts nor drains a running call, and that backend took no
  -- advisory key at all. If it has not yet reached its INSERT INTO
  -- quote_product_draws -- which is late in the body, after the tier loop and
  -- the order_items inserts -- the SHARE ROW EXCLUSIVE lock above finds nothing
  -- to conflict with, the scan below cannot see its uncommitted rows, and it
  -- then commits an averaged line against a booking this migration has already
  -- declared clean. That is exactly the case both runtime nets miss when the
  -- average lands on a real tier and fits inside it.
  --
  -- The dangerous set is precisely: transactions that began before
  -- 20260816110000 committed and are still open. This transaction necessarily
  -- began after that commit, so "any other client-backend transaction older
  -- than mine" is a strict superset of it -- and needs no record of when the
  -- barrier actually committed, which is unobtainable from inside the
  -- transaction that installs it. Deliberately conservative: an unrelated
  -- long-running session also refuses the apply. That costs a retry at a
  -- quieter moment. The alternative costs money.
  --
  -- Fail closed on blindness first. A role without pg_read_all_stats sees NULL
  -- xact_start for other users' backends, so the count below would read zero
  -- for the wrong reason and this whole gate would pass vacuously. Verified
  -- read-only on 2026-08-16 that the applying role (postgres) is a member of
  -- pg_monitor on this project, so this branch is satisfiable, not a wall.
  SELECT current_setting('is_superuser') = 'on'
         OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
    INTO v_stats_visible;

  IF NOT v_stats_visible THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_STATS_BLIND: role % cannot read other backends'' transaction times, so this migration cannot prove no pre-barrier draw is still in flight. Apply as a role holding pg_monitor (or pg_read_all_stats) -- nothing has been changed.', current_user;
  END IF;

  -- Deliberately NO "xact_start <= now()" filter. now() is fixed at THIS
  -- transaction's start, so that filter would mean "began before me", which is
  -- a superset of the dangerous set only if this transaction began after the
  -- barrier committed. Nothing enforces that: if this apply opens and then
  -- waits on the advisory key or the table lock (up to 15s each) while
  -- 20260816110000 commits in another session, a pre-barrier backend starting
  -- inside that gap sorts after now() and goes uncounted. Counting every other
  -- open client-backend transaction drops the assumption entirely and is
  -- strictly more conservative. clock_timestamp() rather than now() for the
  -- reported age, so a backend younger than this transaction reports a positive
  -- age instead of a negative one (RLS/security review 2026-08-16, MED).
  SELECT count(*), max(clock_timestamp() - a.xact_start)
    INTO v_inflight, v_oldest
  FROM pg_stat_activity a
  WHERE a.datname = current_database()
    AND a.pid <> pg_backend_pid()
    AND a.backend_type = 'client backend'
    AND a.xact_start IS NOT NULL;

  IF v_inflight > 0 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_NOT_QUIET: % other client transaction(s) are open in this database (oldest has been running %). Any of them may still be executing the pre-barrier draw code, whose uncommitted rows this migration cannot see. Wait for them to finish, then re-apply -- nothing has been changed.', v_inflight, v_oldest;
  END IF;

  -- backend_type = 'client backend' above covers PostgREST and pg_cron (whose
  -- job runner connects over libpq and reports as a client backend). It does
  -- NOT cover prepared (two-phase) transactions, which never appear in
  -- pg_stat_activity at all and could hold uncommitted pre-barrier draw rows
  -- invisibly. This project does not use two-phase commit; refuse rather than
  -- assume that stays true (RLS/security review 2026-08-16, MED).
  SELECT count(*) INTO v_prepared
  FROM pg_prepared_xacts
  WHERE database = current_database();

  IF v_prepared > 0 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_PREPARED_XACT: % prepared (two-phase) transaction(s) exist in this database. They are invisible to pg_stat_activity, so this migration cannot prove none of them holds an uncommitted pre-barrier draw. Resolve or roll them back, then re-apply -- nothing has been changed.', v_prepared;
  END IF;

  -- Apply-time guard for pre-migration draws on a mixed-price booking (money
  -- review 2026-08-16, CRX-MONEY-001).
  --
  -- The old code collapsed every tier of a product into ONE quantity-weighted
  -- average price and billed the draw at that average. It left no record of
  -- WHICH tiers those units came from, and the average does not determine it:
  -- the same average is produced by many different tier consumptions. The new
  -- body has to reconstruct the remaining tiers from what was billed, and on a
  -- booking drawn under the old code that reconstruction is guesswork.
  --
  -- Two distinct ways it goes wrong, both silent:
  --
  --   1. The averaged price matches NO tier, so the line falls through to the
  --      legacy skip and is retired off the FRONT of the list. That conserves
  --      quantity but not money -- the average consumed the tiers
  --      proportionally, so retiring the cheapest units first leaves the dearer
  --      tiers to bill. 100 units at $1.00 plus 100 at $2.00 is a $300.00
  --      booking; a draw of 50 at the $1.50 average bills $75.00, then the
  --      remaining 150 skip 50 off the $1.00 tier and bill $250.00 -- $325.00
  --      in total, a $25.00 overbill.
  --
  --   2. The averaged price COINCIDENTALLY equals a real tier (Codex review
  --      2026-08-16). 100 units each at $1.00, $2.00 and $3.00 at one cost is a
  --      $600.00 booking; a draw of 250 at the exact $2.00 average matches the
  --      middle tier, so the LEFT JOIN below subtracts all 250 from a tier
  --      holding 100 and GREATEST(...,0) clamps the 150-unit excess away
  --      instead of carrying it forward. The remaining 50 ledger units then
  --      bill from the $1.00 tier and the booking closes at $550.00 -- a
  --      $50.00 underbill.
  --
  -- Case 2 is why this guard does NOT test whether the billed line matches a
  -- tier: that test passes precisely when the coincidence happens. Any
  -- pre-migration draw against a multi-tier product is untrustworthy, so the
  -- guard refuses on the draw existing at all. It looks at both the draw ledger
  -- and surviving booking-draw order lines, because a draw can be recorded in
  -- quote_product_draws while its order was later voided.
  --
  -- DRAW_ALLOCATION_MISMATCH does not catch either case: it proves the
  -- requested QUANTITY was allocated, never that the right monetary tiers were
  -- consumed.
  --
  -- Measured read-only against live on 2026-08-15 and again on 2026-08-16: no
  -- quote carries more than one price tier for the same product, so this is a
  -- no-op today. A measurement is not an apply-time guarantee, though -- the
  -- CURRENT live code still accepts a mixed-price booking whenever its weighted
  -- average lands on a whole cent ($1.00 and $2.00 average to exactly $1.50) --
  -- so an affected booking can be created and drawn between review and apply.
  -- This turns that race from a silent mispricing into a refusal to apply.
  --
  -- Deliberately NOT fixed by inferring the historical allocation. The average
  -- does not carry the information needed to invert it, so any inference would
  -- be a guess written into customer money. Failing closed and letting a human
  -- price the one stranded booking is the smaller risk.
  --
  -- Deliberately NOT scoped by quote status (Codex review 2026-08-16,
  -- CRX-MONEY-001). An earlier draft scanned only 'sent' and 'revised' -- the
  -- two statuses a draw is allowed from -- reasoning that a booking which
  -- cannot be drawn today cannot be mispriced by this path. That reasoning is
  -- wrong, because "drawable" is not a stable property of a booking. Drawing
  -- one to completion flips it to 'accepted', and every void/cancel reversal
  -- path flips 'accepted' back to 'sent' as soon as a partial cancel, cancel or
  -- void leaves it no longer fully drawn (20260610185806, 20260613191323,
  -- 20260616142001, 20260620130000, 20260721014858).
  --
  -- So a booking drawn to completion under the averaging code would have passed
  -- a status-scoped preflight, reopened later, and had its remainder allocated
  -- by the new body with no record of which tiers the average consumed -- the
  -- same misbill described above, just deferred. Quantity still conserves, so
  -- DRAW_ALLOCATION_MISMATCH would not catch it either.
  --
  -- The predicate that actually matters is the stable one: this product on this
  -- booking carries more than one tier AND already carries draw evidence. A
  -- booking that is genuinely finished and can never reopen will also be
  -- refused, which is a false refusal a human clears once -- the fail-closed
  -- direction, and the correct trade against writing a guess into customer
  -- money.
  --
  -- Soft deletion is not a scope either, and for the same reason (Codex review
  -- 2026-08-16, CRX-LIFECYCLE-001). quotes.deleted_at can be set straight back
  -- to NULL by any admin, or by the owning sales rep, under the live
  -- quotes_update policy -- USING/WITH CHECK
  -- (is_admin() OR (is_sales_rep() AND created_by = auth.uid())), verified
  -- read-only 2026-08-16 -- and no trigger on quotes stands in the way. A
  -- soft-deleted booking carrying legacy draw evidence can therefore be
  -- restored after this migration ships and walk straight into the state the
  -- preflight exists to prevent. The scan covers deleted quotes too.
  --
  -- The tier key is the (price, cost) PAIR, matching the tiers CTE below. Two
  -- lines at the same price but different snapshot costs are different tiers.
  SELECT count(*) INTO v_legacy
  FROM (
    SELECT q.id AS quote_id, qi.product_id AS product_id
    FROM quotes q
    JOIN quote_items qi ON qi.quote_id = q.id
    WHERE COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY q.id, qi.product_id
    HAVING count(DISTINCT (qi.price_per_unit, qi.cost_at_quote_cents)) > 1
  ) mixed
  WHERE EXISTS (
          SELECT 1
          FROM quote_product_draws d
          WHERE d.quote_id = mixed.quote_id
            AND d.product_id = mixed.product_id
            AND COALESCE(d.quantity_drawn, 0) > 0
        )
     OR EXISTS (
          SELECT 1
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.quote_id = mixed.quote_id
            AND o.booking_draw IS TRUE
            AND o.status <> 'voided'
            AND oi.product_id = mixed.product_id
        );

  IF v_legacy > 0 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_PREMIGRATION_MIXED_TIER_DRAW: % still-drawable booking/product pair(s) carry more than one price tier AND were already drawn under the weighted-average code. Which tiers those units consumed is not recoverable from the average, so splitting the lines now would misbill the remainder. Reprice or close those bookings, then re-apply.', v_legacy;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote record;
  v_customer record;
  v_draw jsonb;
  v_product_id uuid;
  v_product_name text;
  v_qty numeric;
  v_booked numeric;
  v_drawn numeric;
  v_remaining numeric;
  v_total_acres numeric;
  v_unit_size text;
  v_inv record;
  v_net_position numeric;
  v_order_id uuid;
  v_order_number text;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_line_total numeric;
  v_line_cost numeric;
  v_shortfalls text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_hold record;
  v_to_consume numeric;
  v_fully_drawn boolean;
  v_line_count integer := 0;
  v_result jsonb;
  v_existing jsonb;
  -- LAYER2<<< job reservations consumed against this quote (§6.5)
  v_job_drawn numeric;
  -- >>>LAYER2
  -- TIERSPLIT<<< one order line per booked price tier (replaces the weighted
  -- average that could not be expressed in whole cents)
  v_tier record;
  v_tier_units numeric;
  v_tier_cost_unit numeric;
  v_tier_acres numeric;
  v_unmatched numeric;
  v_over numeric := 0;
  v_tier_count integer;
  v_skip numeric;
  v_take numeric;
  v_alloc_left numeric;
  -- >>>TIERSPLIT
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Lock the quote: serializes concurrent draws on the same booking.
  --
  -- deleted_at IS NULL is REQUIRED here (adversarial review 2026-08-16,
  -- CRX-RLS-001). Quotes are soft-deleted by stamping deleted_at only --
  -- src/pages/Quotes.tsx leaves status untouched -- so a deleted booking still
  -- reads as 'sent' and would sail past the BOOKING_CLOSED guard below. Without
  -- this predicate a deleted booking stays drawable by anyone holding its id,
  -- minting order lines, commissions, inventory reservations and ledger rows
  -- against a booking the business considers gone. The pre-existing body
  -- (20260702172000) omitted it; this migration closes that hole.
  --
  -- Cross-representative access is DELIBERATE, not an oversight: any active
  -- admin or sales_rep may draw any booking (owner decision, re-confirmed
  -- 2026-08-16), so reps can cover for one another. Do not add a created_by or
  -- customer-assignment predicate here without a fresh owner decision.
  SELECT * INTO v_quote
  FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency check AFTER the lock (2026-06-10 HIGH fix): the row lock
  -- serializes same-key duplicates so the non-atomic check/save pair cannot
  -- both pass. Kept BEFORE the status guard so a retry of the final draw
  -- (which flips status to 'accepted') returns the cached result rather than
  -- BOOKING_CLOSED.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: quote % is % — only sent or revised quotes can be drawn down', v_quote.quote_number, v_quote.status;
  END IF;

  IF p_draws IS NULL OR jsonb_typeof(p_draws) <> 'array' OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_draws) d
    WHERE (d->>'product_id') IS NOT NULL AND COALESCE((d->>'quantity')::numeric, 0) > 0
  ) THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  v_order_number := generate_order_number();
  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, 0, 0, 0, 0, current_date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;
  -- A3<<< mark this order as a booking draw so void_order/cancel_order know
  -- to reverse the quote_product_draws ledger (20260610190000). Kept as a
  -- separate statement (not folded into the INSERT) so the body above stays
  -- byte-identical to the live baseline.
  UPDATE orders SET booking_draw = true WHERE id = v_order_id;
  -- >>>A3

  FOR v_draw IN SELECT * FROM jsonb_array_elements(p_draws) LOOP
    v_product_id := (v_draw->>'product_id')::uuid;
    v_qty := COALESCE((v_draw->>'quantity')::numeric, 0);
    IF v_product_id IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND (qi.cost_at_quote_cents IS NULL OR qi.cost_at_quote_cents <= 0)
    ) THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;

    -- TIERSPLIT / CRX-MONEY-002: refuse a draw whose booking carries a negative
    -- or non-finite quantity for this product.
    --
    -- v_booked below sums EVERY quote line for the product, negatives included,
    -- while the tier pool further down takes only lines with
    -- total_units_needed > 0. The averaging code this replaces read one
    -- weighted price over the same negative-inclusive set, so a negative line
    -- pulled the billed price DOWN. The split cannot do that, because a
    -- negative line has no tier to be billed at. A booking of 100 units at
    -- 2.00 and -50 units at 4.00 is worth nothing and still reports 50 units
    -- drawable: the old code billed those 50 at the 0.00 average, while the
    -- split would take all 50 from the 2.00 tier and invoice 100.00 against a
    -- booking worth 0.00. The conservation assertion cannot catch it -- the
    -- excluded negative line makes the tier pool LARGER than the balance, never
    -- smaller, and that assertion only fires when the pool is too small.
    --
    -- Nothing legitimate writes a negative: every quantity is either entered as
    -- a count or computed as acres x rate. Verified read-only against
    -- production on 2026-08-16 that no quote line holds a negative or
    -- non-finite quantity, and the CHECK added at the end of this migration
    -- makes that permanent. This body still refuses rather than trusting the
    -- constraint, because a constraint can be dropped and this path prices
    -- customer money.
    --
    -- NaN is caught by the finiteness half rather than the sign half:
    -- PostgreSQL orders NaN above every number, so NaN >= 0 is TRUE and only
    -- NaN < 'Infinity' rejects it. (Codex adversarial review 2026-08-16.)
    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND qi.total_units_needed IS NOT NULL
        AND NOT (qi.total_units_needed >= 0 AND qi.total_units_needed < 'Infinity'::numeric)
    ) THEN
      RAISE EXCEPTION
        'BOOKING_QUANTITY_INVALID: % is booked on this quote with a negative or non-finite quantity, so the booking has no honest value to draw against; correct the quote first',
        COALESCE((SELECT product_name FROM products WHERE id = v_product_id), v_product_id::text);
    END IF;

    -- Per-product booking balance (locked quote => stable within this txn).
    -- TIERSPLIT: the weighted-average price and cost that used to be computed
    -- here are gone. They were the whole defect: an average of whole-cent tier
    -- prices is generally NOT a whole-cent price, and neither rounding it nor
    -- carrying it forward is safe. Per-tier figures are read below instead.
    SELECT
      SUM(COALESCE(qi.total_units_needed, 0)),
      SUM(COALESCE(qi.acres, 0)),
      MIN(qi.unit_size)
    INTO v_booked, v_total_acres, v_unit_size
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id AND qi.product_id = v_product_id;

    SELECT product_name INTO v_product_name FROM products WHERE id = v_product_id;

    IF v_booked IS NULL OR v_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: % is not booked on this quote', COALESCE(v_product_name, v_product_id::text);
    END IF;

    -- TIERSPLIT: a booked line with no price has no tier to be drawn at. The
    -- old averaging code silently skipped such a line inside SUM() and spread
    -- its quantity across the other tiers' prices; the split would instead
    -- write an order line with a NULL unit price, whose total_price and profit
    -- both come out NULL and quietly poison the order header. Refuse the draw
    -- with a specific error naming the product so the quote can be corrected.
    -- A zero price is deliberately still allowed: free goods are a real thing
    -- and the below-cost approval gate is the control for that, not this check.
    --
    -- UNREACHABLE TODAY, kept deliberately (drift review 2026-08-16, L1 /
    -- RLS review N1): quote_items.price_per_unit is NOT NULL live, so this
    -- cannot fire against the current schema. Read the paragraph above as the
    -- reason this guard exists, not as a description of a live failure mode.
    -- It is a cheap fail-closed backstop if that NOT NULL is ever relaxed --
    -- unlike the cost half of the tier key, which IS nullable today and does
    -- get a live guard (COST_BASIS_REQUIRED, just below).
    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND qi.price_per_unit IS NULL
    ) THEN
      RAISE EXCEPTION
        'BOOKED_PRICE_REQUIRED: % has a booked line with no unit price; set a price on the quote before drawing it down',
        COALESCE(v_product_name, v_product_id::text);
    END IF;

    SELECT quantity_drawn INTO v_drawn
    FROM quote_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_drawn := COALESCE(v_drawn, 0);
    -- LAYER2<<< job reservations also consume the booking (§6.5): subtract live
    -- job draws so demand a job already reserved can't be re-drawn to an order
    -- (no double-fulfilment via transfer_job_to_invoice + a later order draw).
    SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_job_drawn
    FROM job_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_remaining := GREATEST(v_booked - v_drawn - v_job_drawn, 0);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: %: requested %, only % remaining (booked %, already drawn %)',
        COALESCE(v_product_name, v_product_id::text), v_qty, v_remaining, v_booked, (v_drawn + v_job_drawn);
    END IF;
    -- >>>LAYER2  (baseline: v_remaining := GREATEST(v_booked - v_drawn, 0); and
    -- the message's last arg was v_drawn — text is unchanged, only the value.)

    -- TIERSPLIT<<< emit one order line per booked price tier.
    -- Acres are NOT prorated from a whole-draw figure any more. Each emitted
    -- line takes the share of its OWN booked line's acreage that the draw takes
    -- of that line's OWN units -- see the long note at the write site (Codex
    -- review 2026-08-16, P2 3793063419). v_total_acres is still read above for
    -- the booking-level checks; it no longer feeds the per-line figure.

    -- WHICH TIERS ARE ALREADY USED UP.
    --
    -- An earlier draft of this migration answered that by counting how many
    -- units had been drawn in total (quote_product_draws.quantity_drawn plus
    -- live job reservations) and walking that many units down the tier list.
    -- That is unsound, and the reason is worth stating plainly because it is
    -- the defect this block exists to avoid:
    --
    --   Those totals go DOWN as well as up. void_order/cancel_order subtract
    --   from quantity_drawn (20260610185806), and job_product_draws rows are
    --   deleted outright when a job is cancelled or re-reserved. A running
    --   total that moves backwards is not a position in an ordered list. Draw
    --   tier A, draw tier B, then void the FIRST order, and the total falls
    --   back to one tier's worth -- so the next draw is priced from tier B a
    --   second time. Tier A is never sold, tier B is sold twice, and 200 units
    --   quoted at 100 x $1.00 + 100 x $2.00 bill $400 instead of $300.
    --
    -- So attribution is derived instead from the order lines that ACTUALLY
    -- still bill the customer, keyed on WHICH QUOTE LINE each was drawn from.
    -- Every line this body writes stamps order_items.quote_item_id, so a tier
    -- is consumed exactly to the extent that live lines name it.
    --
    -- WHY AN IDENTITY AND NOT THE TIER KEY (Codex review 2026-08-16, P1
    -- 3792521137 / 3792687211). The previous version keyed attribution on the
    -- pair (price_per_unit, cost_at_time_cents) carried by each order line.
    -- That key is neither unique nor immutable, and both failures cost money.
    --
    -- NOT UNIQUE: two quote lines at the same price and cost collapsed into one
    -- tier, so a booking reading 100 @ A, 100 @ B, 100 @ A billed the two A
    -- lines as a single 200-unit block sitting at the FRONT of the list. The
    -- customer's own document order was not what got drawn.
    --
    -- NOT IMMUTABLE (drift review 2026-08-16, H2 and M1). The cost half of the
    -- key moves in three distinct ways, and the earlier version of this comment
    -- named only the first:
    --
    --   1. _enforce_below_cost_line fires BEFORE INSERT OR UPDATE OF
    --      product_id, price_per_unit, total_units_needed on order_items
    --      (20260812115237:561-564) and, when the declared operation is one of
    --      create_direct_order / bulk_import_order / update_order_items /
    --      price_order, overwrites cost_at_time_cents with TODAY's catalog cost
    --      (:484-490). That rewrite is gated on the declared OPERATION, not on
    --      which column changed, so an edit to ANY of those three watched
    --      columns triggers it -- and an edit to the price rewrites BOTH halves
    --      of the tier key at once, not just the cost half.
    --   2. trg_resnapshot_order_item_cost (20260812115235:97-104) fires BEFORE
    --      UPDATE ON order_items WHEN (NEW.product_id IS DISTINCT FROM
    --      OLD.product_id) and re-snapshots cost_at_time_cents to today's
    --      catalog cost. Unlike vector 1 it is NOT gated by the four-operation
    --      list -- but it IS narrower than the trigger definition alone
    --      suggests (drift review 2026-08-16, L2): its body
    --      (20260812115235:71-92) only rewrites the snapshot when the caller
    --      left it alone (NEW.cost_at_time_cents IS NOT DISTINCT FROM OLD) and
    --      NEW.product_id IS NOT NULL, and it COALESCEs back to the old
    --      snapshot when the new product's current_cost is NULL. So it cannot
    --      clobber a cost the caller set deliberately, and it never erases one.
    --      A product swap also moves the line out of the original product's
    --      attribution set entirely, since both queries below filter on
    --      oi.product_id = v_product_id.
    --   3. A direct UPDATE order_items SET cost_at_time_cents = ... fires no
    --      trigger at all. order_items carries five triggers in the migration
    --      tree and NONE of them watches cost_at_time_cents (drift review
    --      2026-08-16, L3 -- an earlier draft of this list named only three and
    --      read as exhaustive): the below-cost trigger watches product_id /
    --      price_per_unit / total_units_needed, guard_order_item_delivery_
    --      lineage watches order_id / product_id (20260721014858:734-737), the
    --      money-rounding trigger watches total_price / profit / cost_per_unit
    --      / total_units_needed (20260809230500:263-267), the resnapshot
    --      trigger in vector 2 watches product_id, and the INSERT-time snapshot
    --      trigger is INSERT-only. Repair migrations do exactly this.
    --
    -- Under the OLD key any of these orphaned a billed line from its tier. That
    -- failure was fail-CLOSED -- the tiers stopped summing to the drawn
    -- quantity, so the conservation assert refused the whole draw with
    -- DRAW_ALLOCATION_MISMATCH rather than mis-pricing or double-selling --
    -- but it refused LEGITIMATE draws until an admin intervened.
    --
    -- Keying on quote_items.id retires all three. It is a primary key: no
    -- trigger writes it, no repair migration re-snapshots it, and it does not
    -- collapse two lines into one. The vectors above are recorded because they
    -- are still true of the COLUMNS -- an admin edit still moves a line's cost
    -- snapshot, and anything else that reasons off that pair inherits the
    -- problem -- but they no longer reach tier attribution.
    --
    -- WHAT THE STAMP SURVIVES, and what still gets past it:
    -- save_quote DELETEs quote_sections on every revision, cascading to
    -- quote_items, and reinserts them. The deferred FK installed near the end
    -- of this file moves the referential check to COMMIT, and save_quote reuses
    -- the same quote_items id on both of its paths, so an ordinary revision
    -- leaves every stamp intact. A stamp can no longer be ORPHANED at all: the
    -- FK is still NO ACTION, so a save that failed to bring an id back would
    -- abort the whole transaction rather than commit a dangling reference.
    --
    -- What still lands unattributed is narrower, and both cases are covered the
    -- same way: lines written before this migration, which carry no stamp; and
    -- lines whose quote line survives but is no longer a TIER, because its
    -- total_units_needed was edited to 0. Those fall into v_unmatched below,
    -- walk off the FRONT of the list, and are REFUSED outright by
    -- DRAW_MIXED_TIER_UNMATCHED_LINE the moment the product carries more than
    -- one distinct (price, cost). So the front-walk only ever runs where every
    -- tier row shares one price and one cost, and at a single price which
    -- identically-priced line a unit came off cannot change the bill.
    --
    -- Cancelled/voided are the two reversal states in orders_status_check
    -- ('confirmed','partially_fulfilled','fulfilled','cancelled','voided'),
    -- and they reverse DIFFERENT amounts, so they are treated differently:
    --
    --   void_order   subtracts the FULL quantity from quantity_drawn
    --                (20260610185806:493-505). A voided order therefore holds
    --                no booking balance at all, so its lines drop out entirely
    --                and the whole tier returns to the pool.
    --   cancel_order subtracts only the UNDELIVERED portion
    --                (20260610185806:807-820). Delivered units stay drawn and
    --                stay billed, so they must keep holding their tier -- only
    --                the undelivered remainder returns to the pool.
    --
    -- In practice a cancel of a partially delivered order does not land in
    -- 'cancelled' at all: cancel_order routes 'partially_fulfilled' orders to
    -- _close_undelivered_order_remainder_20260718 (20260721014858:1358), which
    -- shrinks total_units_needed to quantity_delivered (:1139) and ends at
    -- 'fulfilled' (:1151) -- so those orders stay in this set at exactly their
    -- surviving quantity via the ELSE branch. The 'cancelled' CASE below is
    -- therefore a no-op on current data (verified read-only against live
    -- 2026-08-16: zero cancelled, confirmed, or voided orders carry delivered
    -- units, and zero quote/product pairs bill more units than are drawn). It
    -- is written anyway because no CHECK constraint enforces that invariant,
    -- and if it ever slipped, excluding cancelled lines outright would free a
    -- tier that is still being billed and re-sell it.
    --
    -- Soft-deleted ORDERS (orders.deleted_at -- order_items has no such column)
    -- are deliberately NOT excluded: a soft delete does not reverse
    -- quantity_drawn, so dropping those lines here would desync attribution from
    -- the balance guard above.
    --
    -- Job reservations DO consume a tier, and are taken off the front with the
    -- legacy lines below. They hold booking balance (already subtracted from
    -- v_remaining above) but they write no order_items row, so nothing in the
    -- `billed` set can see them. Leaving them out would hand the tier they are
    -- holding back to the next order -- the same unit sold twice, once on the
    -- job and once on the order.
    --
    -- Which tier a job should consume is a business choice, not a technical
    -- one. Job chemicals are billed at their own price
    -- (job_chemicals.price_per_unit_cents, 20260713060000:312,547), so the job
    -- document's total does not change either way; what changes is which tiers
    -- are left for the customer's later orders. Front-of-list is chosen here
    -- because it is the same convention the legacy averaged code implicitly
    -- used, it conserves quantity, and it is the only option that cannot
    -- re-sell a tier. If Mason wants job draws to consume the LAST tier
    -- instead (leaving the cheaper tiers for orders), that is a one-line change
    -- to the ORDER BY this skip walks -- it is not a correctness fix.
    --
    -- No live data depends on this today: verified read-only 2026-08-16 that
    -- job_product_draws is empty and no quote has more than one price tier for
    -- the same product.
    --
    -- Legacy lines drawn under the old weighted-average code carry an averaged
    -- price that matches no tier key. They are counted here and taken off the
    -- FRONT of the tier list, which is the position the averaged code
    -- implicitly assumed. It conserves quantity and degrades to a no-op once
    -- there are none. (Verified read-only against live 2026-08-15: no quote
    -- has more than one price tier for the same product, so no such line
    -- exists today -- this is a defensive path, not a live migration concern.)
    SELECT COALESCE(SUM(
             CASE WHEN o.status = 'cancelled'
                  THEN COALESCE(oi.quantity_delivered, 0)
                  ELSE COALESCE(oi.total_units_needed, 0)
             END), 0)
    INTO v_unmatched
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.quote_id = p_quote_id
      AND o.booking_draw IS TRUE
      AND o.status <> 'voided'
      AND oi.product_id = v_product_id
      -- "This billed line names no tier row that still exists." The mirror
      -- half of the LEFT JOIN further down, which is now keyed on the same
      -- identity (Codex review 2026-08-16, P1 3792521137 / 3792687211).
      --
      -- Two populations fall in here, and both want the same treatment:
      --
      --   1. quote_item_id IS NULL -- written by the pre-cutover body, which
      --      stamped nothing. `qi.id = NULL` is never true, so these are caught
      --      with no special case.
      --   2. quote_item_id names a line that survives but is no longer a tier
      --      (its total_units_needed was edited to 0 or below).
      --
      -- A third population -- "quote_item_id names a quote line that no longer
      -- exists" -- was listed here while the FK was ON DELETE SET NULL, and is
      -- now unreachable. The FK is NO ACTION DEFERRABLE INITIALLY DEFERRED, so
      -- a revision that failed to bring an id back aborts at COMMIT instead of
      -- committing an orphan. Nothing can leave a stamp pointing at a deleted
      -- quote line. This test still tolerates it (the NOT EXISTS simply
      -- matches), so the code stays correct if that ever changes -- but no live
      -- route produces it.
      --
      -- All three are counted into v_unmatched, walked off the FRONT of the
      -- document-ordered tier list by v_skip, and -- crucially -- refused
      -- outright by DRAW_MIXED_TIER_UNMATCHED_LINE below whenever the product
      -- carries more than one distinct (price, cost). That refusal is what
      -- makes the front-walk sound rather than a guess: it only ever runs on a
      -- product whose every tier row carries ONE price and ONE cost, and at a
      -- single price it cannot matter which identically-priced line a unit came
      -- off. Where the stamp is missing the fallback is therefore "match on
      -- today's price and cost", and where even that is ambiguous the draw
      -- stops instead of guessing.
      --
      -- The old form of this test compared (price_per_unit, cost_at_time_cents)
      -- with IS NOT DISTINCT FROM on both halves, mirroring the old join. That
      -- discipline is retired with the key it protected: quote_items.id is a
      -- NOT NULL primary key, so `=` is total here and the NULL-vs-NULL hazard
      -- is gone. What must still be mirrored is the PARTITION -- a billed line
      -- has to be counted by exactly one of this test and that join, or the
      -- same units are billed twice or freed while still billed. If either side
      -- is edited, edit both.
      --
      -- One asymmetry with the tiers CTE is deliberate and worth naming (drift
      -- review 2026-08-16, L6): tiers additionally INNER JOINs quote_sections
      -- for its ordering columns, and this NOT EXISTS does not. That cannot
      -- drop a row, because quote_items.section_id is NOT NULL and REFERENCES
      -- quote_sections(id) ON DELETE CASCADE (20260206172436:176), so the join
      -- is total. The partition is exact -- but it leans on that foreign key,
      -- so if it is ever dropped this test must join quote_sections too.
      AND NOT EXISTS (
        SELECT 1
        FROM quote_items qi
        WHERE qi.id = oi.quote_item_id
          AND qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          AND COALESCE(qi.total_units_needed, 0) > 0
      );

    -- Fail closed on a mixed-tier booking whose billed lines no longer name a
    -- tier that exists. Consuming those units off the FRONT of the list, as the
    -- block above does, is only sound when they really did come off the front.
    -- That holds for the legacy averaged body, which priced a whole product at
    -- one figure, and it holds for any product whose tier rows all share one
    -- price and one cost. It does NOT hold on a genuinely mixed booking.
    --
    -- The stamp makes this rarer than it was but does not remove it, and the
    -- guard is deliberately kept exactly as fail-closed as before (this is the
    -- "keep every existing refusal" half of the 2026-08-16 provenance rework).
    -- Two live routes still land here:
    --
    --   1. Lines drawn before this migration, which carry no stamp at all.
    --   2. A quote line that survives a revision but is edited down to zero
    --      units, so it stops being a tier while lines billed against it are
    --      still standing.
    --
    -- A revision ORPHANING a stamp is no longer one of them: the deferred FK
    -- keeps the id alive across save_quote's delete-and-reinsert, and refuses
    -- to commit if it ever did not.
    --
    -- Worked example (Codex review 2026-08-16, CRX-MONEY-TIER-001, restated for
    -- the stamp): book 100 units at $1.00 and 100 at $2.00; draw the $1.00 tier
    -- in full and 50 of the $2.00 tier; void the $1.00 order, which returns
    -- that tier to the pool; revise the quote so the surviving line's stamp
    -- names a quote line that no longer exists; draw the remaining 150. Without
    -- this refusal the orphaned 50 units come off the front and the booking
    -- bills $350.00 against a $300.00 order. DRAW_ALLOCATION_MISMATCH below
    -- cannot see it: that assertion fires only when the pool is too SMALL to
    -- absorb the draw, never when it is too large.
    --
    -- This same refusal is the net under the cutover race described at the top
    -- of this file. A legacy averaged draw that commits just after the preflight
    -- scan leaves precisely this trace -- billed units naming no live tier --
    -- so the next draw on that booking stops loudly instead of quietly
    -- misbilling the remainder.
    --
    -- Still counted on (price, cost), NOT on the number of tier ROWS, and that
    -- is the point rather than a leftover: two quote lines at the SAME price
    -- and cost are now two separate tier rows, but which of them an unstamped
    -- unit came off cannot change what the customer is billed. Counting rows
    -- here would refuse a perfectly determinate draw -- e.g. the same product
    -- booked into two fields at one price, drawn once before this migration.
    -- Distinct (price, cost) is exactly the condition under which the
    -- front-walk stops being money-exact.
    SELECT count(DISTINCT (qi.price_per_unit, qi.cost_at_quote_cents))
    INTO v_tier_count
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id = v_product_id
      AND COALESCE(qi.total_units_needed, 0) > 0;

    IF COALESCE(v_tier_count, 0) > 1 AND COALESCE(v_unmatched, 0) > 0 THEN
      RAISE EXCEPTION
        'DRAW_MIXED_TIER_UNMATCHED_LINE: % unit(s) already billed against this booking for % do not name any of its % booked price tiers, so which tiers those units consumed is not known. Drawing more could bill the same units twice. Void and re-book the order(s) holding those units, or undo the quote revision that changed those lines, then re-try.',
        v_unmatched, COALESCE(v_product_name, v_product_id::text), v_tier_count;
    END IF;

    -- Job reservations consume from the front alongside the legacy lines.
    v_skip := COALESCE(v_unmatched, 0) + COALESCE(v_job_drawn, 0);
    v_over := 0;

    v_alloc_left := v_qty;

    FOR v_tier IN
      WITH tiers AS (
        SELECT
          -- IMMUTABLE TIER PROVENANCE (Codex review 2026-08-16, P1 x2 --
          -- 3792521137 and 3792687211). A "tier" is now ONE QUOTE LINE, not a
          -- (price, cost) bucket aggregated across lines.
          --
          -- The old GROUP BY (price, cost) merged every quote line sharing a
          -- key into a single tier, and that merge caused two distinct money
          -- defects that no amount of downstream patching could reach:
          --
          --   1. INTERLEAVING. A booking reading 100 @ A, 100 @ B, 100 @ A
          --      collapsed to A=200, B=100, and the merged A sorted to A's
          --      FIRST document position. A 150-unit draw then billed all 150
          --      at A, where consuming the document top-down owes 100 A and
          --      50 B. The customer was billed the wrong tier's price.
          --   2. ROUNDING BOUNDARY. Merging two lines moved the cumulative
          --      rounding basis off the boundary save_quote booked them at.
          --      Two 0.5-unit lines at $1.01 book 0.51 + 0.51 = $1.02; merged
          --      into one 1.0-unit tier they extend to $1.01, underbilling a
          --      cent per merged pair.
          --
          -- Keying on qi.id fixes both at the source: lines never merge, each
          -- keeps its own document position, and each rounds against its own
          -- booked extension. It also gives every line written below a real
          -- quote_item_id to stamp, which is what lets the next draw match
          -- billed lines back EXACTLY instead of guessing by (price, cost).
          qi.id                  AS quote_item_id,
          qi.price_per_unit      AS price,
          qi.cost_at_quote_cents AS cost_cents,
          COALESCE(qi.total_units_needed, 0) AS units,
          -- Per-LINE now, not per-(price,cost)-bucket. The write site below
          -- still takes COALESCE(v_tier.unit_size, v_unit_size), so a line
          -- with no pack size falls back to the product-level value exactly as
          -- before (RLS review 2026-08-16, M1).
          qi.unit_size           AS unit_size,
          -- Per-LINE booked acreage, replacing the by-quantity proration the
          -- write site used to do (Codex review 2026-08-16, P2 3793063419).
          -- Splitting one draw's acres in proportion to units is wrong the
          -- moment two lines carry different rates: 100u/100ac + 100u/10ac
          -- drew two 55-acre lines, a figure neither line was booked at, and
          -- complete_delivery copies acres into invoice_items. With the line's
          -- own identity in hand its own booked acreage is simply available.
          qi.acres               AS line_acres,
          COALESCE(qi.total_units_needed, 0) AS line_units,
          -- Document order is (section position, then line position within the
          -- section). quote_items.sort_order restarts per section, so ordering
          -- on it alone ties two lines that sit in different sections and falls
          -- through to price -- which is not the order the customer sees.
          -- Both columns are NOT NULL live, so no COALESCE is needed.
          --
          -- No longer an aggregate at all. The earlier version had to take
          -- element 1 of an array_agg to keep (section, line) an atomic pair
          -- while collapsing many lines into one tier; one row per line makes
          -- the genuine document position directly available, so the class of
          -- bug that fix defended against cannot arise here.
          qs.sort_order          AS section_ord,
          qi.sort_order          AS ord
        FROM quote_items qi
        JOIN quote_sections qs ON qs.id = qi.section_id
        WHERE qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          -- > 0, whereas v_booked above sums over ALL of the product's quote
          -- lines with no such filter (drift review 2026-08-16, L5). A
          -- zero-unit line is harmless either way. A NEGATIVE one -- which no
          -- CHECK currently forbids on quote_items.total_units_needed -- makes
          -- the two disagree, and it is worth being precise about WHICH guard
          -- covers that, because the first version of this comment named the
          -- wrong one (RLS review 2026-08-16, M2).
          --
          -- The negative line SUBTRACTS from v_booked and is excluded from the
          -- tiers, so the tier pool comes out LARGER than the balance, never
          -- smaller: sum(tiers) >= v_booked >= v_remaining >= v_qty. The
          -- allocation assertion below fires only when the pool is too SMALL to
          -- absorb the draw, so it cannot fire on this case at all. What
          -- actually holds the line is the v_remaining balance guard further
          -- up, which caps the draw at booked-minus-drawn using the reduced
          -- v_booked -- so the customer is never billed for more units than the
          -- (negative-inclusive) booking supports, and every unit billed still
          -- comes from a real positive tier at that tier's own price.
          AND COALESCE(qi.total_units_needed, 0) > 0
      ),
      -- Units still billed to the customer. Voided orders drop out entirely;
      -- cancelled orders keep only their delivered units. Same rule as v_skip
      -- above -- see the long comment there for why the two reversal states
      -- differ.
      --
      -- KEYED BY PROVENANCE (Codex review 2026-08-16, P1 3792521137 /
      -- 3792687211). Every line this body writes carries the id of the quote
      -- line it was drawn from, so it can be matched back EXACTLY. Lines
      -- written by the OLD body carry NULL there and are handled separately
      -- below, by the same front-walk v_skip has always used.
      --
      -- SPLIT AGAIN BY PRICE (Mason's rule, 2026-08-19). Changing the price on
      -- a partly-drawn booking must not rewrite what the customer was already
      -- billed: already-drawn units KEEP the price they were billed at, and
      -- only the units still owing use the new price. A genuine early-price
      -- error is corrected with a credit memo, not by silently rebilling
      -- delivered product.
      --
      -- So each tier's history divides in two, on whether the order line was
      -- billed at the price the quote line carries TODAY:
      --
      --   * units_current / money -- billed at the current price. These are
      --     still "live" against this price, so they remain the telescoping
      --     rounding basis: the next draw bills the running total of the whole
      --     price band minus the cents already standing in it, which is what
      --     stops four 0.25-unit draws on a $1.01 tier from billing $1.00.
      --   * units_settled -- billed at some other price. These are FINISHED.
      --     They still consume the tier's capacity (the customer has had that
      --     product and been billed for it, so it is no longer available to
      --     draw), but they are never re-based and their money never enters
      --     the basis. Re-basing them is exactly the rebilling Mason ruled out.
      --
      -- The comparison is against ti.price -- the quote line's price_per_unit
      -- as it stands now -- not against a remembered figure, so it re-partitions
      -- correctly if the price is changed again, or changed back.
      --
      -- IS NOT DISTINCT FROM, not =, so a NULL price on a billed line lands in
      -- units_settled rather than vanishing from both halves. ti.price itself
      -- cannot be NULL here: BOOKED_PRICE_REQUIRED above refuses the draw on a
      -- booked line with units > 0 and no price, and tiers only carries lines
      -- with units > 0. Numeric equality is exact-decimal in PostgreSQL and
      -- ignores trailing-zero scale, so 1.00 and 1.0000 match as they should.
      --
      -- The JOIN to tiers is what makes ti.price reachable. It cannot change
      -- which rows are counted: the outer LEFT JOIN below already keeps only
      -- billed rows whose quote_item_id names a live tier, and every billed row
      -- that does NOT is counted by the v_unmatched front-walk instead. The
      -- partition against v_unmatched is therefore unchanged -- still exactly
      -- one side per billed line.
      billed_stamped AS (
        SELECT
          oi.quote_item_id       AS quote_item_id,
          -- Units billed at the tier's CURRENT price -- the live rounding basis.
          SUM(
            CASE WHEN oi.price_per_unit IS NOT DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN COALESCE(oi.quantity_delivered, 0)
                           ELSE COALESCE(oi.total_units_needed, 0)
                      END
                 ELSE 0
            END) AS units_current,
          -- Units billed at some OTHER price -- settled. Capacity only.
          SUM(
            CASE WHEN oi.price_per_unit IS DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN COALESCE(oi.quantity_delivered, 0)
                           ELSE COALESCE(oi.total_units_needed, 0)
                      END
                 ELSE 0
            END) AS units_settled,
          -- MONEY actually standing against this tier key AT THE CURRENT PRICE,
          -- in dollars, on the same surviving quantity units_current counts
          -- (Codex push-proof 2026-08-16, CRX-MONEY-LIFECYCLE-001, High).
          --
          -- The money and the units MUST describe the same surviving rows, so
          -- the cancelled branch is mirrored here: a cancelled order keeps only
          -- its delivered units, so it may keep only the value of those units,
          -- not the whole line's total_price. Valuing them at the line's own
          -- price_per_unit is exact -- that is the price they were billed at.
          --
          -- Settled money is deliberately absent. It is not zero and it is not
          -- forgotten: it stands on the invoice exactly as billed. It simply
          -- takes no part in the arithmetic for the units still owing, because
          -- those units are priced from a fresh basis at the new price.
          --
          -- Why this column has to exist at all: the previous version re-based
          -- the running total on surviving UNITS and assumed the surviving
          -- lines held ROUND(price * units, 2) cents. A void breaks that
          -- assumption. Two 0.25-unit draws at $0.50 write $0.13 and $0.12;
          -- void the FIRST and 0.25 surviving units carry $0.12, not $0.13, so
          -- a units-only basis re-billed $0.12 and left the customer charged
          -- $0.24 for half a unit that costs $0.25. Which of two identical
          -- draws was voided must not change the bill.
          SUM(
            CASE WHEN oi.price_per_unit IS NOT DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN ROUND(COALESCE(oi.price_per_unit, 0)
                                      * COALESCE(oi.quantity_delivered, 0), 2)
                           ELSE COALESCE(oi.total_price, 0)
                      END
                 ELSE 0
            END) AS money
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN tiers ti ON ti.quote_item_id = oi.quote_item_id
        WHERE o.quote_id = p_quote_id
          AND o.booking_draw IS TRUE
          AND o.status <> 'voided'
          AND oi.product_id = v_product_id
          AND oi.quote_item_id IS NOT NULL
        GROUP BY oi.quote_item_id
      )
      SELECT
        t.quote_item_id,
        t.price,
        t.cost_cents,
        t.unit_size,
        t.line_acres,
        t.line_units,
        -- What this tier still has available to draw. BOTH halves of the
        -- billed history are subtracted: units already billed at the current
        -- price, and units settled at an earlier price. A settled unit has been
        -- delivered and charged, so it is gone from the booking whatever price
        -- it went out at -- treating it as still available would sell the same
        -- product twice.
        --
        -- GREATEST(..., 0) clamps PER TIER (drift review 2026-08-16, L7) so a
        -- negative tier cannot silently eat a neighbour's units.
        --
        -- The clamp alone is NOT sufficient, and an earlier version of this
        -- comment wrongly said it was ("bounded on both sides regardless by the
        -- v_remaining balance guard and DRAW_ALLOCATION_MISMATCH"). Neither
        -- bound sees an over-billed tier. v_remaining works on PER-PRODUCT
        -- aggregates, and DRAW_ALLOCATION_MISMATCH fires only when the pool is
        -- too SMALL. So the excess this clamp discards was invisible. It is
        -- carried out as the "over" column below and refused after the loop
        -- (DRAW_TIER_OVERCONSUMED). See that guard for the worked example.
        GREATEST(
          t.units
            - COALESCE(b.units_current, 0)
            - COALESCE(b.units_settled, 0), 0) AS units,
        -- Units billed against this tier BEYOND what the tier now holds --
        -- exactly the quantity the clamp above throws away. Counted across both
        -- halves, for the same reason: an over-draw is an over-draw whether the
        -- excess was billed at today's price or an earlier one.
        GREATEST(
          COALESCE(b.units_current, 0)
            + COALESCE(b.units_settled, 0)
            - t.units, 0) AS over,
        -- Units already billed at this tier's CURRENT price by earlier draws.
        -- This is the rounding BASIS for the money below, not a quantity the
        -- loop spends. See the telescoping comment at v_line_total.
        --
        -- Settled units are excluded on purpose. That is the whole of Mason's
        -- rule in one expression: a unit billed at a price the quote no longer
        -- carries is finished, so it must not appear in a running total that
        -- the next draw subtracts money from. If it did, the new units would be
        -- billed the difference between the old and new price on quantity the
        -- customer has already paid for -- a silent rebill.
        --
        -- Clamped to the current-price budget the line still has, which is its
        -- booked units less what is settled. (The over-billed excess is refused
        -- separately by DRAW_TIER_OVERCONSUMED, and that guard aborts the whole
        -- transaction, so the clamp cannot ship a wrong number -- it only keeps
        -- this column from going out of range on a run that is about to roll
        -- back anyway.)
        LEAST(
          COALESCE(b.units_current, 0),
          GREATEST(t.units - COALESCE(b.units_settled, 0), 0)) AS prior,
        -- Cents already standing against this tier key AT THE CURRENT PRICE.
        -- Deliberately NOT clamped the way "prior" is: this is a statement of
        -- fact about money that has been billed, and shrinking it would
        -- re-invent the very assumption CRX-MONEY-LIFECYCLE-001 was about --
        -- that the surviving lines hold whatever the arithmetic says they
        -- should. The one case where it can exceed the tier's own extension is
        -- an over-billed tier, which DRAW_TIER_OVERCONSUMED refuses outright
        -- after the loop; the GREATEST at v_line_total keeps the interim value
        -- in range until that guard aborts the transaction.
        COALESCE(b.money, 0) AS money
      FROM tiers t
      LEFT JOIN billed_stamped b
        -- EXACT provenance, replacing the (price, cost) key this join used to
        -- carry (Codex review 2026-08-16, P1 3792521137 / 3792687211).
        --
        -- quote_items.id is a NOT NULL primary key and order_items.quote_item_id
        -- REFERENCES it, so plain `=` is total here and there is no NULL-vs-NULL
        -- question to get wrong -- billed_stamped already filters
        -- quote_item_id IS NOT NULL, and the tiers side is a primary key. The
        -- long-standing IS NOT DISTINCT FROM discipline that used to live in
        -- this comment existed only because the old key included a NULLABLE
        -- cost column; keying on an identity retires that hazard rather than
        -- managing it.
        --
        -- What DOES still have to be mirrored token for token is the partition
        -- rule: a billed line must be counted by EXACTLY ONE of this join and
        -- the v_unmatched front-walk above, or the same units are counted twice
        -- (double-charging) or zero times (re-selling a tier that is still
        -- billed). The mirror above is now the same test in the negative --
        -- "no tier row carries this line's quote_item_id" -- so the two split
        -- the set exactly. If either side is edited, edit both.
        ON b.quote_item_id = t.quote_item_id
      -- Document order, with the line's own id as a deterministic tiebreak.
      -- (section_ord, ord) is not unique-by-constraint, and an unstable order
      -- here would make WHICH tier a partial draw lands in vary between calls.
      ORDER BY t.section_ord, t.ord, t.quote_item_id
    LOOP
      -- Over-consumption is accumulated across EVERY tier, so this loop no
      -- longer EXITs at the allocation boundary -- it CONTINUEs, leaving the
      -- tiers past that point still inspected. Tier counts per product are in
      -- the single digits, so walking the tail costs nothing.
      v_over := v_over + COALESCE(v_tier.over, 0);
      IF v_alloc_left <= 0 THEN CONTINUE; END IF;

      v_tier_units := v_tier.units;

      -- Only legacy averaged units walk the list; everything else was already
      -- subtracted per tier by the LEFT JOIN above.
      IF v_skip > 0 THEN
        IF v_skip >= v_tier_units THEN
          v_skip := v_skip - v_tier_units;
          CONTINUE;
        END IF;
        v_tier_units := v_tier_units - v_skip;
        v_skip := 0;
      END IF;

      v_take := LEAST(v_tier_units, v_alloc_left);
      IF v_take <= 0 THEN CONTINUE; END IF;
      v_alloc_left := v_alloc_left - v_take;

      -- Exact whole-cent unit cost straight from the quote-time snapshot; no
      -- average, so nothing to round at the unit level. The division of integer
      -- cents by 100 is already exact -- ROUND here only pins the numeric SCALE
      -- to two places so the stored value looks like every other order path's,
      -- rather than carrying a long trailing-zero tail. It changes no value.
      -- Verified live 2026-08-15: _enforce_below_cost_line overwrites
      -- cost_per_unit/cost_at_time_cents only when the declared operation is one
      -- of create_direct_order, bulk_import_order, update_order_items or
      -- price_order. This path declares draw_down_quote, so the per-tier
      -- snapshot cost written here survives the trigger.
      v_tier_cost_unit := ROUND(v_tier.cost_cents::numeric / 100, 2);

      -- Money is rounded only AFTER extension by quantity, never before -- and,
      -- since the 2026-08-16 push-proof (CRX-MONEY-TIER-ROUND-001, High), the
      -- extension is CUMULATIVE per tier rather than per draw.
      --
      -- The earlier form was ROUND(price * take, 2) on each draw in isolation.
      -- That is exact for whole-unit draws, but draw quantities are genuinely
      -- fractional -- the draw box in QuoteBuilder is step="any", and so are the
      -- quote-line quantity boxes it draws against -- and on a fractional draw
      -- the per-draw rounding residual does not cancel. It ACCUMULATES across
      -- partial draws, so the tier ends up billed for more (or less) than its
      -- own authoritative extension. Worked case from the proof: 0.50 units at
      -- $0.50 plus 0.50 units at $1.50 books $1.00; drawn as four 0.25-unit
      -- draws the old form billed 2 x $0.13 + 2 x $0.38 = $1.02. Two cents
      -- invented out of rounding, and it grows with the number of partial draws.
      --
      -- The fix is to round the RUNNING TOTAL and subtract what is already
      -- charged. After this draw the tier has been billed for (prior + take)
      -- units, whose authoritative value is ROUND(price * (prior + take), 2).
      -- Subtract the money already standing against the tier and the remainder
      -- is what this line owes. Successive draws therefore telescope: whatever
      -- sequence of partial draws consumes a tier, the surviving lines sum to
      -- EXACTLY ROUND(price * units_billed_at_that_tier, 2), with no
      -- path-dependence and no accumulating residual. On a whole-unit draw this
      -- is identical to the old expression, so nothing changes for the ordinary
      -- case.
      --
      -- The subtrahend is v_tier.money -- the cents ACTUALLY standing on the
      -- surviving lines -- and NOT the computed ROUND(price * prior, 2). Those
      -- two agree in the ordinary case but diverge after a void, and using the
      -- computed figure made the final bill depend on WHICH of two identical
      -- draws had been reversed (Codex push-proof 2026-08-16,
      -- CRX-MONEY-LIFECYCLE-001, High). Reading the real money instead makes
      -- every path self-correcting, and it also repairs, on the next draw
      -- against that tier, a tier that legacy per-draw rounding had already
      -- over- or under-billed.
      --
      -- prior and money are keyed on the tier each line was WRITTEN at, not on
      -- units-drawn-from-the-product. Legacy averaged lines carry a DIFFERENT
      -- price and so land under a different key; they are handled by v_skip and
      -- correctly contribute 0 here, because this tier has genuinely not been
      -- billed for them.
      --
      -- GREATEST(..., 0): on an already over-billed tier the remainder can come
      -- out negative -- a credit. This path does not issue one. Refunding a
      -- historical over-charge belongs in a credit memo against the order that
      -- carries it, not silently inside an unrelated draw line, and a negative
      -- total_price would be refused by the whole-cent money CHECKs anyway. The
      -- clamp writes 0 and the over-charge stands, visible, on the line that
      -- created it. It hides nothing that is not already surfaced: the quantity
      -- form of the same condition is carried out as "over" and refused after
      -- the loop by DRAW_TIER_OVERCONSUMED.
      v_line_total := GREATEST(
                        ROUND(v_tier.price * (v_tier.prior + v_take), 2)
                        - v_tier.money, 0);

      -- COST is deliberately NOT telescoped. This asymmetry is load-bearing
      -- (Codex push-proof 2026-08-16, CRX-MONEY-PROFIT-001, High).
      --
      -- order_items.profit is not the caller's to choose. The canonical trigger
      -- from 20260809230500 overwrites any supplied profit with total_price -
      -- ROUND(cost_per_unit * total_units_needed, 2) -- a PER-LINE, explicitly
      -- non-cumulative cost. A cumulative v_line_cost therefore never reaches
      -- the stored line profit at all; it only desynchronises the order header
      -- and the commission basis from the lines they are meant to summarise.
      -- Measured shape: a $1.50 sale at $0.50 cost drawn as two 0.25-unit draws
      -- stores line profits of $0.25 + $0.24 = $0.49 under a header claiming
      -- $0.50.
      --
      -- So the cost basis is computed with the SAME expression the trigger
      -- uses, and the header below accumulates exactly the per-line figures the
      -- trigger will go on to store. Header, lines, and commission basis then
      -- agree by construction -- the invariant the 2026-08-09 decision exists
      -- to hold. The cost side keeps the per-draw rounding residual that the
      -- revenue side now sheds: a sub-cent artefact on internal margin, and the
      -- same one every other order path already carries. Shedding it there too
      -- means changing the shared canonical trigger for ALL order lines, which
      -- is a wider, separate change and is deliberately not made here.
      v_line_cost  := ROUND(v_tier_cost_unit * v_take, 2);

      -- ACRES COME FROM THE LINE'S OWN BOOKED RATE (Codex review 2026-08-16,
      -- P2 3793063419), not from prorating one whole-draw figure by units.
      --
      -- The previous form computed a single v_draw_acres for the product --
      -- ROUND(total_acres * qty / booked, 2) -- and handed it out in proportion
      -- to each tier's units. That is only right when every booked line for the
      -- product carries the same acres-per-unit. The moment two lines differ it
      -- invents a rate neither line was booked at: 100 units over 100 acres
      -- plus 100 units over 10 acres, drawn in full, wrote 55 acres on each of
      -- the two lines. Nothing on the booking says 55, and the figure does not
      -- stay internal -- complete_delivery copies order_items.acres straight
      -- into invoice_items, so it reaches the customer's paperwork.
      --
      -- With the quote line's own identity in hand its own booked acreage and
      -- its own booked quantity are directly available, so the line simply gets
      -- the share of ITS OWN acres that this draw takes of ITS OWN units. The
      -- two lines above now correctly read 100 and 10.
      --
      -- line_units is guaranteed > 0 by the tiers CTE filter, so the division
      -- is safe; the guard is written anyway because the filter and this
      -- division live 300 lines apart. A line booked with no acreage stays
      -- NULL rather than becoming a zero -- 0 acres and "not recorded" are
      -- different statements on a customer's order line.
      --
      -- No residual-absorbing last line any more, because there is no longer a
      -- whole-draw total the parts have to add back up to: each line's acreage
      -- is now an independent statement about its own booked line, and the only
      -- rounding is the single ROUND on that line's own figure. On a one-tier
      -- draw this is arithmetically identical to what the single-line version
      -- wrote (v_booked and v_total_acres collapse to that line's own values,
      -- and v_take = v_qty), so nothing changes for the ordinary case.
      v_tier_acres := CASE
        WHEN v_tier.line_acres IS NULL OR COALESCE(v_tier.line_units, 0) <= 0
          THEN NULL
        ELSE ROUND(v_tier.line_acres * v_take / v_tier.line_units, 2)
      END;

      -- Disclosed behaviour change (drift review 2026-08-16, NIT2): this is a
      -- single counter across the WHOLE draw, so the sort_order written below
      -- runs 1..M over every line of every product, where the single-line
      -- version wrote 1..N with one line per product. On a one-tier draw the
      -- numbering is unchanged; on a multi-tier draw the customer's order shows
      -- more lines and therefore higher line numbers. Deliberate -- lines are
      -- emitted product by product and tier by tier in document order, so a
      -- single ascending counter preserves that order exactly, whereas a
      -- per-product counter would repeat numbers across products.
      v_line_count := v_line_count + 1;

      INSERT INTO order_items (order_id, product_id, product_name,
        price_per_unit, cost_per_unit, acres,
        total_units_needed, unit_size, total_price, profit, net_margin,
        quantity_delivered, quantity_remaining, sort_order, notes,
        cost_at_time_cents, -- SNAPSHOT
        quote_item_id       -- PROVENANCE
        )
      VALUES (v_order_id, v_product_id, COALESCE(v_product_name, ''),
        v_tier.price, v_tier_cost_unit, v_tier_acres,
        v_take, COALESCE(v_tier.unit_size, v_unit_size), v_line_total,
        v_line_total - v_line_cost,
        CASE WHEN v_tier.price > 0
          THEN ROUND(((v_tier.price - v_tier_cost_unit) / v_tier.price) * 100, 2)
          ELSE 0 END,
        0, v_take, v_line_count,
        'Drawn from booking ' || v_quote.quote_number,
        -- SNAPSHOT: a partial draw is a conversion too. This tier's own
        -- quote-time cost, already integer cents, is stamped here so the line
        -- profit, the order header, the commission basis and the reports all
        -- share ONE value. Without the stamp the row inserts with a NULL
        -- cost_at_time_cents and trg_snapshot_order_item_cost writes TODAY's
        -- catalog cost, splitting the reports from the order totals. Unknown
        -- historical cost is rejected above; it must never be converted into a
        -- real zero-cost order line.
        v_tier.cost_cents,
        -- PROVENANCE: which booked quote line this order line was drawn from
        -- (Codex review 2026-08-16, P1 3792521137 / 3792687211). This is the
        -- root fix the rest of this body is built on -- the tier attribution
        -- above reads exactly this column back on the NEXT draw, so a line that
        -- fails to stamp here would be re-attributed by the front-walk and
        -- could re-sell its tier.
        --
        -- The column already existed on order_items and is already written by
        -- the FULL-conversion path (convert_quote_to_order); only this partial
        -- path left it NULL. Nothing downstream has to change to accept it:
        -- src/types/index.ts already declares quote_item_id as string | null,
        -- and every existing consumer already handles the NULL that legacy rows
        -- carry. Filling it strictly ADDS information.
        --
        -- The postflight assertion at the end of this migration re-reads the
        -- installed source and refuses the whole apply if this stamp is not
        -- present, so the body cannot ship with the attribution reading a
        -- column the writes never populate.
        v_tier.quote_item_id);

      v_total_price := v_total_price + v_line_total;
      v_total_cost := v_total_cost + v_line_cost;
    END LOOP;

    -- Fail closed when a tier is billed for more units than it now holds. That
    -- means the units already drawn can no longer be attributed to the tiers as
    -- they stand, so any further split is a guess.
    --
    -- This is reachable through a SUPPORTED workflow, not just a hand-edit
    -- (Codex review 2026-08-16, second HIGH). Revising a booking is allowed by
    -- save_quote's drawn-product guard on the PER-PRODUCT aggregate alone --
    -- 20260812115236:844 groups by product_id and compares total booked against
    -- total drawn, with no tier attribution preserved. So: book 200 units at
    -- one price, draw 150 of them, then revise the booking to 100 units at a
    -- lower price plus 100 at the original one. Booked (200) still covers drawn
    -- (150), so the revision saves. The 150 billed units still match the
    -- original tier, which now holds only 100 -- the clamp above silently
    -- discarded that 50-unit overhang, the remaining 50 units were drawn from
    -- the cheaper tier, and the booking billed more than its revised total.
    -- v_remaining could not catch it (per-product aggregate) and
    -- DRAW_ALLOCATION_MISMATCH could not catch it (the pool was large enough).
    --
    -- This guard is also the net under the coincidental-average case of the
    -- cutover race described at the top of this file: a late legacy averaged
    -- draw whose average happens to equal a real tier key escapes the unmatched
    -- -line guard, but it is attributed wholly to that one tier while it
    -- actually consumed several, so it over-bills that tier and stops here.
    --
    -- This migration now carries the provenance an earlier draft of this
    -- comment described as out of scope: every line written below stamps
    -- order_items.quote_item_id, so both scenarios are normally caught EARLIER
    -- and more precisely than here. In the revision case the stamps SURVIVE:
    -- the deferred FK installed further down lets save_quote delete and
    -- reinsert the same quote_items ids inside one transaction, so the next
    -- draw resolves attribution by identity and never reaches this net at
    -- all; in the cutover-race case a late legacy line carries no stamp and
    -- is caught the same way.
    --
    -- This refusal stays as the net beneath both, for the residue the stamp
    -- cannot reach: a product whose tiers all share ONE (price, cost) -- which
    -- the unmatched-line guard deliberately lets through as unbillable-either
    -- -way -- can still be resized below what it has already billed. It is
    -- deliberately stricter than strictly necessary rather than looser.
    IF v_over > 0 THEN
      RAISE EXCEPTION
        'DRAW_TIER_OVERCONSUMED: % unit(s) already billed against this booking for % exceed what its price tiers now hold, so which tiers the earlier draws consumed can no longer be determined. This usually follows a booking revision that repriced or resized a tier after part of it was drawn. Restore the tier quantities that were in place when those units were drawn, or void and re-book the affected orders, then re-try.',
        v_over, COALESCE(v_product_name, v_product_id::text);
    END IF;

    -- Fail closed: the split must conserve quantity exactly. If the booked tiers
    -- could not absorb the requested quantity, refuse the entire draw rather
    -- than book an order that under-bills the customer.
    IF v_alloc_left <> 0 THEN
      RAISE EXCEPTION
        'DRAW_ALLOCATION_MISMATCH: % of % units for % could not be matched to a booked price tier. This usually means an existing order for this product was edited after it was drawn, which rewrites the cost snapshot the tier is recognised by. Check recent edits to orders for this quote before re-trying.',
        v_alloc_left, v_qty, COALESCE(v_product_name, v_product_id::text);
    END IF;
    -- >>>TIERSPLIT

    -- Inventory: warn (never block) on net position, then prebook the draw.
    -- Deliberately PER PRODUCT and outside the tier loop: the full drawn
    -- quantity moves exactly once no matter how many price tiers it spans.
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty || ', net position is 0 (no inventory record)');
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_product_id, 'Main Warehouse', 0, v_qty, 0, v_unit_size);
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_shortfalls := array_append(v_shortfalls,
          COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_qty, updated_at = now()
      WHERE product_id = v_product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_product_id, 'booked', v_qty, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number || ' (draw from quote ' || v_quote.quote_number || ')');

    -- Move the drawn quantity out of this quote's active holds (FIFO).
    -- Net Free = available − holds − prebooked stays constant: the quantity
    -- leaves the hold bucket and enters the prebooked bucket.
    v_to_consume := v_qty;
    FOR v_hold IN
      SELECT id, quantity FROM inventory_holds
      WHERE source_id = p_quote_id AND product_id = v_product_id AND is_active = true
      ORDER BY created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_to_consume <= 0;
      IF v_hold.quantity <= v_to_consume THEN
        UPDATE inventory_holds SET quantity = 0, is_active = false, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := v_to_consume - v_hold.quantity;
      ELSE
        UPDATE inventory_holds SET quantity = quantity - v_to_consume, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := 0;
      END IF;
    END LOOP;

    -- Ledger: record the draw
    INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
    VALUES (p_quote_id, v_product_id, v_qty)
    ON CONFLICT (quote_id, product_id)
    DO UPDATE SET quantity_drawn = quote_product_draws.quantity_drawn + EXCLUDED.quantity_drawn,
                  updated_at = now();

    -- Per-product summary for the caller. Shape unchanged on purpose: the app
    -- reads this and must not have to learn about the tier split.
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product_id,
      'product_name', v_product_name,
      'drawn', v_qty,
      'remaining', v_remaining - v_qty);
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE WHEN v_total_price > 0 THEN ROUND((v_total_profit / v_total_price) * 100, 2) ELSE 0 END;
  UPDATE orders SET total_price = v_total_price, total_cost = v_total_cost,
    total_profit = v_total_profit, total_margin_pct = v_total_margin_pct
  WHERE id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_total_profit,
    v_quote.commission_split, current_date
  );

  -- Fully drawn? Then the booking closes as 'accepted' (enforcer-legal from
  -- sent/revised) and the hold-release trigger clears any leftover holds.
  -- LAYER2 NOTE: this stays on ORDER draws only (quote_product_draws) by design
  -- — job draws are reversible, so letting them flip status to 'accepted' would
  -- require un-accepting on job cancel (a quote-lifecycle change out of scope).
  SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
  FROM (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b
  LEFT JOIN quote_product_draws d
    ON d.quote_id = p_quote_id AND d.product_id = b.product_id
  WHERE b.booked > 0;

  IF v_fully_drawn THEN
    UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  ELSE
    UPDATE quotes SET updated_at = now() WHERE id = p_quote_id;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_total_price,
      'booking_draw', true,
      'fully_drawn', v_fully_drawn,
      'lines', v_lines,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_total_price * 100)::bigint,
    'Drew down quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN v_fully_drawn THEN ' (booking now fully drawn)' ELSE ' (partial draw — booking stays open)' END ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from booking ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN v_fully_drawn THEN ' — booking fully drawn' ELSE ' — partial draw' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object(
    'success', true, 'status', 'created',
    'order_id', v_order_id, 'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls),
    'fully_drawn', v_fully_drawn,
    'lines', v_lines);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'draw_down_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Defensive: CREATE OR REPLACE preserves the existing ACL, so this changes
-- nothing today. It is stated explicitly so the deliberate posture set by
-- 20260812115237 -- the implementation is reachable ONLY through the
-- draw_down_quote wrapper, which is what enforces below-cost approval -- cannot
-- be lost by a future edit that recreates this function from scratch. The
-- postflight below proves the posture rather than assuming it.
REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- --- CRX-MONEY-002, durable half: make the bad value unrepresentable ---------
-- The refusal inside the function body above is the fail-closed half; this is
-- the half that stops such a row from ever being written. Verified read-only
-- against production on 2026-08-16 that no existing row violates it, so the
-- constraint is added VALIDATED rather than NOT VALID -- a NOT VALID constraint
-- would let the very rows it exists to prevent survive a later backfill.
-- NULL stays legal because a booked line may legitimately carry no quantity
-- yet; the draw path already treats NULL as zero.
-- CRX-MIG-002 (Codex adversarial review, 2026-08-16): creating only when the
-- NAME is free would silently inherit a same-named weaker rule under constraint
-- drift, and the postflight's substring test would still pass it. So the
-- "already exists" path now proves the existing constraint IS this constraint,
-- by comparing the stored expression to the exact text PostgreSQL normalizes
-- ours to, and aborts the migration otherwise. Fails closed: an unrecognised
-- rule stops the apply rather than being adopted unread.
DO $qty_check$
DECLARE
  -- Captured from pg_get_constraintdef's own output for the CHECK written
  -- below, on a throwaway database, not hand-written. Confirmed byte-identical
  -- on PostgreSQL 17.10 and 16.14 (Codex review 2026-08-16, eighth pass -- an
  -- earlier version of this comment claimed a 17 capture that had in fact only
  -- been taken on 16, so the version is now stated from a run on both). Live is
  -- 17.6, so the create path here is the one this server will normalise to.
  c_expected constant text :=
    'CHECK (((total_units_needed IS NULL) OR ((total_units_needed >= (0)::numeric) AND (total_units_needed < ''Infinity''::numeric))))';
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.quote_items'::regclass
    AND conname = 'quote_items_total_units_needed_nonneg_finite_chk';

  IF v_def IS NULL THEN
    ALTER TABLE public.quote_items
      ADD CONSTRAINT quote_items_total_units_needed_nonneg_finite_chk
      CHECK (
        total_units_needed IS NULL
        OR (total_units_needed >= 0 AND total_units_needed < 'Infinity'::numeric)
      );
  ELSIF v_def IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION
      'CONSTRAINT_NAME_DRIFT: quote_items_total_units_needed_nonneg_finite_chk already exists on quote_items with a different rule (%); refusing to skip creation and adopt an unverified constraint', v_def;
  END IF;
END;
$qty_check$;

-- --- Make the stamp survivable: defer order_items_quote_item_id_fkey --------
-- Without this the stamp introduced above BREAKS QUOTE EDITING outright.
--
-- The chain, each link read from live on 2026-08-19:
--   * save_quote (_save_quote_below_cost_impl_20260810) begins every edit with
--     DELETE FROM quote_sections WHERE quote_id = v_quote_id, then reinserts.
--   * quote_items_section_id_fkey is ON DELETE CASCADE, so that one statement
--     removes every quote_items row for the quote.
--   * order_items_quote_item_id_fkey is today plain NO ACTION and not
--     deferrable (confdeltype a, condeferrable false), so it is checked at the
--     END OF THAT DELETE STATEMENT -- before any reinsert has happened.
-- So the moment a partial draw stamps an order line, the next save of that
-- quote aborts with a raw foreign-key violation. Before this migration that is
-- nearly unreachable (one stamped line in the whole table, written by the
-- convert path); after it, EVERY partially drawn booking would become
-- un-editable. save_quote has no guard that would catch this first: its body
-- contains no reference to orders, to booking_draw, or to a QUOTE_LOCKED
-- refusal.
--
-- DEFERRABLE INITIALLY DEFERRED, keeping ON DELETE NO ACTION, is the fix. The
-- check moves from the end of that DELETE to COMMIT, and by COMMIT save_quote
-- has already reinserted the quote's lines under the SAME ids. The link is
-- therefore only transiently broken, inside one transaction, and the
-- provenance stamp SURVIVES an ordinary revision -- which is the entire point
-- of stamping it.
--
-- That rests on save_quote reusing the same quote_items id, which it does on
-- BOTH of its paths (live prosrc, read 2026-08-19):
--   * the primary path reuses an id the client echoes in the payload;
--   * the id-less fallback matches unconsumed prior lines of the same product
--     and reuses one of their ids. This is the path that actually runs today:
--     QuoteBuilder.tsx and BulkQuoteImport.tsx both send lines with no id.
-- An earlier draft of this file rejected DEFERRABLE on the belief that reuse
-- required the client to echo ids, so editing would "work or hard-fail
-- depending on which page saved the quote". That premise was wrong in both
-- halves: no current page echoes ids, and the fallback reuses without them.
--
-- STATED PRECISELY, because an earlier draft of this comment claimed more than
-- it had (drift review 2026-08-19, H2). What deferring restores is editing for
-- a partly-drawn booking with ONE line per product -- the large majority. It
-- does NOT restore editing for a booking carrying TWO lines of one product:
-- save_quote refuses that save on QUOTE_ITEM_AMBIGUOUS_COST before the FK is
-- ever reached, because QuoteBuilder sends both lines without ids. That
-- limitation is pre-existing, is not caused or removed by this file, and is the
-- separate PR named in the residual below.
--
-- ON DELETE SET NULL was that earlier choice and is now REJECTED, because
-- save_quote runs its DELETE on EVERY save of an existing quote -- including a
-- save that changes nothing. SET NULL would therefore wipe every stamp on
-- every save, which (a) resets the telescoping rounding basis and re-opens the
-- fractional overbill this migration exists to close, and (b) strands a
-- partly-drawn two-price booking behind DRAW_MIXED_TIER_UNMATCHED_LINE, whose
-- message tells the operator to undo a quote revision that SET NULL has
-- already made impossible to undo. Deferring the check keeps both doors open.
--
-- Residual, deliberately NOT closed in this migration (recorded in
-- docs/manual/KNOWN_ISSUES.md): the id-less fallback reuses the LOWEST
-- unconsumed prior id for a product, not the operator's line. On a quote
-- carrying TWO lines of one product this is normally unreachable, because
-- re-saving such a quote already fails closed on QUOTE_ITEM_AMBIGUOUS_COST.
-- The one crack is deleting one of the two lines -- that sends a single id-less
-- row, so the ambiguity test passes -- while the two lines share a cost. One
-- prior id then never returns, and if an order line was stamped with it the
-- save aborts at COMMIT on a raw foreign-key error. That is fail-closed: the
-- whole save rolls back, no money moves, and no stamp is silently lost.
-- Closing it properly means giving save_quote real line identity, which is the
-- same defect QUOTE_ITEM_AMBIGUOUS_COST already is, with its own blast radius
-- and its own PR.
--
-- SETTLED (RLS gate 2026-08-19, H1; Mason chose option A the same day).
-- save_quote was not the only path that deletes and reinserts a quote's lines.
-- _restore_quote_version_owner_impl does the same, and its reinsert omits the
-- id column entirely, so every restored line takes a fresh gen_random_uuid()
-- and no id is ever reused. Under a deferred FK that would leave every stamp
-- dangling at COMMIT and abort the restore with a raw foreign-key error, on a
-- path that works today.
--
-- Fixed in THIS FILE, in the same transaction, further down: restore REFUSES
-- when it cannot honour the stamps, raising QUOTE_RESTORE_BLOCKED_BY_DRAW
-- before it touches anything.
--
-- Releasing the stamps instead was the FIRST draft (option A) and it was
-- REFUTED, so do not reintroduce it: releasing discards the telescoping
-- rounding basis and can bill $1.02 against a $1.01 booking, and its UPDATE on
-- order_items fires trg_recalc_order_totals under the quote lock -- the
-- deadlock this same rework just removed. A postflight below fails the apply if
-- 'SET quote_item_id = NULL' ever comes back. See the restore block for the
-- full argument.
--
-- Same drift discipline as the CHECK above: adopt nothing unread. If the FK is
-- already the deferred rule this is a no-op; anything else stops the apply. ON
-- DELETE SET NULL in particular is NOT adopted silently -- it is the retired
-- design, and finding it live would mean something other than this file put it
-- there.
DO $fk_deferred$
DECLARE
  -- Compared STRUCTURALLY, on catalog columns, not on pg_get_constraintdef
  -- text. That rendering schema-qualifies the referenced table only when it is
  -- outside the CURRENT search_path, so a text match would silently turn into
  -- a false FK_RULE_DRIFT abort under an apply session with a different
  -- search_path. This file pins search_path only inside the function body, not
  -- for the session, so the difference is real. Catalog columns do not move.
  --   confdeltype   'a' = NO ACTION, 'n' = SET NULL
  --   confupdtype   'a' = NO ACTION on update
  --   confmatchtype 's' = MATCH SIMPLE
  --   condeferrable / condeferred are checked separately from the shape below,
  --   because deferrability is precisely what this block changes.
  -- Every value below was read from live on 2026-08-19.
  v_deltype "char";
  v_deferrable boolean;
  v_deferred boolean;
  v_shape_ok boolean;
  v_def text;
BEGIN
  SELECT c.confdeltype,
         c.condeferrable,
         c.condeferred,
         (c.confupdtype = 'a'
          AND c.confmatchtype = 's'
          AND c.convalidated IS TRUE
          AND c.confrelid = 'public.quote_items'::regclass
          AND array_length(c.conkey, 1) = 1
          AND array_length(c.confkey, 1) = 1
          AND (SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'quote_item_id'
          AND (SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) = 'id'),
         pg_get_constraintdef(c.oid)
  INTO v_deltype, v_deferrable, v_deferred, v_shape_ok, v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.order_items'::regclass
    AND c.conname = 'order_items_quote_item_id_fkey'
    AND c.contype = 'f';

  IF v_deltype IS NULL THEN
    RAISE EXCEPTION
      'FK_MISSING: order_items_quote_item_id_fkey does not exist as a foreign key, so the provenance stamp this migration writes would reference quote lines with nothing enforcing that they exist. Refusing to install a stamp with no referential integrity behind it.';
  ELSIF NOT v_shape_ok THEN
    RAISE EXCEPTION
      'FK_RULE_DRIFT: order_items_quote_item_id_fkey is (%), which is not the single-column, validated quote_item_id -> quote_items(id) reference this migration was written against; refusing to replace an unverified constraint', v_def;
  ELSIF v_deltype = 'a' AND v_deferrable IS TRUE AND v_deferred IS TRUE THEN
    -- Already exactly the rule this block installs.
    NULL;
  ELSIF v_deltype = 'a' AND v_deferrable IS FALSE THEN
    ALTER TABLE public.order_items
      DROP CONSTRAINT order_items_quote_item_id_fkey;
    -- Re-added VALIDATED, not NOT VALID: idx_order_items_quote_item already
    -- exists, the table is small, and a NOT VALID constraint would leave the
    -- very orphans this exists to prevent unchecked.
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_quote_item_id_fkey
      FOREIGN KEY (quote_item_id) REFERENCES public.quote_items(id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  ELSE
    RAISE EXCEPTION
      'FK_RULE_DRIFT: order_items_quote_item_id_fkey is (%), which is neither the rule this migration was written against nor the rule it installs; refusing to replace an unverified constraint', v_def;
  END IF;
END;
$fk_deferred$;

-- --- Restore REFUSES when it cannot honour the stamps ---------------------------
-- Mason's decision, 2026-08-19, option (B). Option (A) -- releasing the stamps
-- -- was built first and then refuted on the money and on the lock order; the
-- note above records why, and a postflight below forbids its return.
--
-- Found by the RLS gate against the reworked FK and confirmed against live
-- prosrc the same day: save_quote is not the only path that deletes and
-- reinserts a quote's lines. _restore_quote_version_owner_impl does the same,
-- and its reinsert omits the id column entirely, so every restored line takes a
-- fresh gen_random_uuid(). Under a deferred FK that leaves every stamp dangling
-- at COMMIT and aborts the restore with a raw foreign-key error -- turning a
-- button that works today into an opaque failure.
--
-- This lands in the SAME TRANSACTION as the FK change on purpose. The two are
-- one mechanism: deferring the constraint is what creates this obligation, so
-- shipping them apart would leave a window where restore is broken.
--
-- Same drift discipline as everything else in this file: the body below is
-- reproduced byte-exactly from the live definition (md5 d8408e3b19b536f1210e51da3970272e,
-- read 2026-08-19) with exactly ONE statement added. The preflight above pins
-- that md5 and refuses to run if live has moved, so this can never silently
-- overwrite a body someone else changed.
CREATE OR REPLACE FUNCTION public._restore_quote_version_owner_impl(p_quote_id uuid, p_version_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
  v_actor uuid;
  v_drawn_guard record; -- drawn-version guard (20260611120100)
BEGIN
  -- Strict-actor auth (function previously had NO auth check). Before idempotency.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check — operation-scoped so a key minted for a different operation
  -- can't short-circuit a legitimate restore (was: matched idempotency_key alone).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'restore_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Preserve the newer live restore safeguard from
  -- 20260812011000_restore_quote_version_whole_cent_money. This pricing
  -- migration re-emits the same owner implementation to add quote-time cost
  -- snapshots, so it must reject non-finite constrained money before the first
  -- destructive restore write rather than silently replacing that live guard.
  IF (v_snapshot->'quote'->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_price in version % is non-finite', p_version_id;
  END IF;
  IF (v_snapshot->'quote'->>'total_profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_profit in version % is non-finite', p_version_id;
  END IF;
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF (v_item->>'profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.profit in version % is non-finite', p_version_id;
      END IF;
      IF (v_item->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.total_price in version % is non-finite', p_version_id;
      END IF;
    END LOOP;
  END LOOP;

  -- PROVENANCE: refuse the restore outright if this booking has been drawn.
  --
  -- order_items.quote_item_id records which booked quote line each drawn order
  -- line was billed from. This migration makes that FK NO ACTION DEFERRABLE
  -- INITIALLY DEFERRED so an ordinary save_quote edit -- which deletes and
  -- reinserts the SAME ids -- keeps the stamp. A version RESTORE is different:
  -- it rebuilds the quote from a snapshot and mints a brand-new id for every
  -- line (the INSERT below names no id column), so the old ids never come back
  -- and every stamp would dangle at COMMIT.
  --
  -- An earlier draft RELEASED the stamps here (UPDATE ... SET quote_item_id =
  -- NULL) instead of refusing. Codex review 2026-08-19 found that silently
  -- overbills, and it was REPRODUCED on PostgreSQL 17.6: two 0.5-unit lines at
  -- $1.01, draw 0.5, restore to a single 1-unit version, draw the rest -- the
  -- customer is billed $1.02 against a booking whose own arithmetic says
  -- $1.01. Releasing the stamp discards the telescoping rounding basis, and
  -- DRAW_MIXED_TIER_UNMATCHED_LINE cannot catch it because that guard only
  -- fires when the product carries MORE THAN ONE distinct (price, cost) -- and
  -- after the restore it carries exactly one. The release also fired
  -- after_order_items_change -> trg_recalc_order_totals, which locks the order
  -- row while this function already holds the quote row, crossing the lock
  -- order that cancel/void takes.
  --
  -- So restore fails CLOSED instead.
  --
  -- SCOPE, STATED ACCURATELY -- an earlier draft of this comment called the
  -- guard "narrow: only a booking actually drawn into an order is blocked".
  -- That was wrong, and Codex review 2026-08-19 caught it. The join below is
  -- UNFILTERED by order status, so the real rule is: once a booking has EVER
  -- been drawn, it can never restore a version again -- even if every draw
  -- order was afterwards cancelled or voided, the quantity returned to
  -- quote_product_draws and the booking reopened. Those reversed order_items
  -- rows are retained for audit and still carry their stamp, so the join stays
  -- true forever.
  --
  -- That over-breadth is DELIBERATE and Mason accepted it on 2026-08-20 rather
  -- than narrow it. Narrowing means letting a reversed line past the guard,
  -- and its stamp would then dangle at COMMIT exactly as before -- so restore
  -- would have to RELEASE the stamps on those dead lines. Releasing is
  -- money-neutral for them (a voided line is filtered out of billed_stamped and
  -- v_unmatched entirely, and a cancelled line contributes only its delivered
  -- quantity, which is zero here), but it puts back an UPDATE on order_items,
  -- which fires after_order_items_change -> trg_recalc_order_totals and locks
  -- the order row under the quote lock. That is the deadlock this rework just
  -- removed. Trading a rare capability for a reintroduced lock cycle is the
  -- wrong trade, so the limitation is recorded instead of fixed.
  --
  -- Recorded in docs/manual/KNOWN_ISSUES.md and pinned by a regression case in
  -- scripts/smoke/smoke-restore-version-drawn-guard.sql, so a later narrowing
  -- has to change the recorded decision consciously rather than by accident.
  --
  -- What is unaffected: a booking never drawn restores freely, and editing the
  -- quote directly still works on ANY booking, because save_quote reuses the
  -- same line ids and the deferred FK keeps the stamps.
  --
  -- Doing this properly -- carrying the line-level billing basis across a
  -- restore so the money stays exact -- means giving restore a real identity
  -- mapping from snapshot lines to live lines. That is the same missing
  -- capability QUOTE_ITEM_AMBIGUOUS_COST is about, and it gets its own PR.
  IF EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN quote_items qi ON qi.id = oi.quote_item_id
    WHERE qi.quote_id = p_quote_id
  ) THEN
    RAISE EXCEPTION 'QUOTE_RESTORE_BLOCKED_BY_DRAW: this booking has already been drawn down into an order, so restoring an earlier version would change what the customer has already been billed. Edit the quote directly instead -- ordinary edits are still allowed and keep the billing history intact.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    -- Historical snapshots may predate the live whole-cent constraints from
    -- 20260810151000. Normalize the replay boundary so restoring one cannot
    -- fail or reintroduce fractional stored money.
    total_price = ROUND((v_snapshot->'quote'->>'total_price')::numeric, 2),
    total_cost = ROUND((v_snapshot->'quote'->>'total_cost')::numeric, 2),
    total_profit = ROUND((v_snapshot->'quote'->>'total_profit')::numeric, 2),
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- SNAPSHOT<<< arm the trusted passthrough for this transaction so the rows
  -- reinserted below carry the version's own quote-time cost. Same mechanism
  -- save_quote uses: transaction-local, so a PostgREST caller cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF NULLIF(v_item->>'current_cost', '') IS NULL
         OR (v_item->>'current_cost')::numeric <= 0 THEN
        RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_item->>'product_id';
      END IF;
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT
      )
      VALUES (
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        ROUND((v_item->>'profit')::numeric, 2),
        ROUND((v_item->>'total_price')::numeric, 2),
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit',
        -- SNAPSHOT: the version stored the cost this quote was priced with.
        -- Without it the BEFORE INSERT trigger stamps todays catalog cost, and
        -- the next ordinary save preserves that stamp and recomputes the line
        -- from it, silently repricing the restored version.
        --
        -- A version without a positive historical basis is rejected above.
        -- Unknown money must not become a real zero-cost quote line.
        ROUND((v_item->>'current_cost')::numeric * 100)::bigint
      );
    END LOOP;
  END LOOP;

  -- SNAPSHOT<<< disarm immediately once the reinsert loop closes.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);
  -- >>>SNAPSHOT

  -- BEGIN drawn-version guard (20260611120100)
  -- Codex round-2 MED (2026-06-11): a restore must never under-book the drawn
  -- ledger (quote_product_draws deliberately survives the section delete +
  -- re-insert above). Validates the FINAL persisted quote_items — the same
  -- invariant, token, and block shape as save_quote's drawn-product guard
  -- (20260610184230). A violation rolls back the entire restore atomically,
  -- including the section DELETE.
  -- LAYER2<<< drawn guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1).
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — it removes %, which already has % drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below its already-drawn % (restored total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-version guard (20260611120100)

  -- BEGIN planned-hold + job-reservation sync (20260611132115 + Layer2 A3.12)
  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the
  -- planned reservation (booked − drawn) to match the restored state.
  -- LAYER2-CHAN (push-gate #C): a restore that changes booked quantity must ALSO
  -- re-sync the quote's ACTIVE jobs (draws + shed holds), exactly as save_quote now
  -- does — else a restored-larger booking leaves stale job draws and reopens balance
  -- the job still needs. _sync_quote_job_reservations rebuilds the jobs THEN calls
  -- _sync_planned_holds itself (strict superset). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(p_quote_id, v_actor);
  -- END planned-hold + job-reservation sync

  -- Save idempotency key (result stored as a valid jsonb object — was a bare ::text UUID).
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', jsonb_build_object('quote_id', p_quote_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$function$;

-- CREATE OR REPLACE preserves the restricted live ACL, but restate the deny
-- here so a fresh or rehearsed database cannot inherit PostgreSQL's default
-- PUBLIC EXECUTE grant for this mutating SECURITY DEFINER helper.
REVOKE EXECUTE ON FUNCTION public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)
  FROM anon, PUBLIC;

-- --- Postflight: prove the shape and the security posture --------------------
DO $postflight$
DECLARE
  v_restore_src text;
  v_restore_secdef boolean;
  v_restore_config text[];
  v_secdef boolean;
  v_config text[];
  v_src text;
  v_bad_grantee text;
  v_overloads integer;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: expected exactly 1 function named public._draw_down_quote_below_cost_impl_20260810, found % -- a second overload would make the wrapper''s target ambiguous', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
  INTO v_secdef, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810'
    AND p.pronargs = 4;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation function is missing after replace';
  END IF;

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation lost SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation lost its pinned search_path (found %)', v_config;
  END IF;

  -- A NAME TRIPWIRE, not a behaviour check (drift review 2026-08-16, L5 -- the
  -- earlier wording claimed more than this does). It catches the one identifier
  -- the abandoned averaging candidate used, so a straight revert to that body
  -- is refused; a weighted average reintroduced under any other variable name
  -- would pass it. The real guards against that defect are structural: there is
  -- no averaging anywhere in the body, and DRAW_ALLOCATION_MISMATCH (asserted
  -- present just below) fails the draw closed if the per-tier quantities ever
  -- stop summing to the requested quantity.
  IF position('wavg_price' IN v_src) > 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: a weighted-average unit price is back in the body';
  END IF;

  IF position('DRAW_ALLOCATION_MISMATCH' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the quantity-conservation assertion is missing';
  END IF;

  IF position('DRAW_MIXED_TIER_UNMATCHED_LINE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the unmatched-billed-line refusal is missing';
  END IF;

  IF position('DRAW_TIER_OVERCONSUMED' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the over-consumed-tier refusal is missing';
  END IF;

  -- PROVENANCE TRIPWIRES (Codex review 2026-08-16, P1 3792521137 / 3792687211).
  --
  -- These two are a PAIR and neither is sufficient alone. Tier attribution
  -- reads order_items.quote_item_id back on the next draw; the writes stamp it.
  -- Ship the read without the write and every line looks unattributed, so the
  -- front-walk consumes tiers that are still billed -- selling the same units
  -- twice. Ship the write without the read and the body is silently back to
  -- matching on the mutable, non-unique (price, cost) pair this rework exists
  -- to retire. So both halves are asserted against the source actually
  -- installed, not against what this file intended to install.
  --
  -- Both are NAME tripwires, with the same honest limit as the wavg_price check
  -- above: they prove the identifiers are present, not that the logic around
  -- them is right. What proves the logic is DRAW_ALLOCATION_MISMATCH, which
  -- fails the draw closed whenever the per-tier quantities stop summing to the
  -- requested quantity.
  IF position('billed_stamped' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: tier attribution no longer reads order_items.quote_item_id -- it would be back to matching billed lines on the mutable (price, cost) pair';
  END IF;

  IF position('v_tier.quote_item_id' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw no longer stamps order_items.quote_item_id -- tier attribution would be reading a column the writes never populate, and every new line would fall through to the front-walk';
  END IF;

  -- PRICE-PARTITION TRIPWIRE (Mason's rule, 2026-08-19).
  --
  -- The two names above prove the body still reads and writes the provenance
  -- stamp. This one proves it still SPLITS that history by price. Drop the
  -- split and every previously billed unit silently re-enters the telescoping
  -- basis, so changing the price on a partly-drawn booking would rebill units
  -- the customer has already been charged for -- the exact outcome Mason ruled
  -- out in favour of a credit memo. That failure is silent: the allocation
  -- still sums, so DRAW_ALLOCATION_MISMATCH would not catch it.
  --
  -- Same honest limit as the tripwires above: this proves the identifiers are
  -- present, not that the arithmetic around them is right.
  -- Matched on the PREDICATE, not on the two column names alone: those names
  -- also occur in this body's own comments, so a name-only test would pass on a
  -- body that kept the prose and deleted the SQL (drift review 2026-08-19, L1).
  IF position('units_settled' IN v_src) = 0
     OR position('units_current' IN v_src) = 0
     OR position('IS NOT DISTINCT FROM ti.price' IN v_src) = 0
     OR position('IS DISTINCT FROM ti.price' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw no longer partitions a tier''s billed history by price -- units billed at a superseded price would re-enter the telescoping basis, so changing a price on a partly-drawn booking would silently rebill units the customer has already paid for';
  END IF;

  -- RESTORE REFUSAL PROOF (Mason's option B, 2026-08-19). Deferring the FK
  -- creates the obligation; this asserts the obligation was met in the same
  -- transaction. Without the refusal, restoring a version of a partially drawn
  -- booking either aborts at COMMIT on a raw foreign-key error (no guard) or
  -- silently overbills the customer (the released-stamp draft Codex refuted).
  SELECT p.prosrc INTO v_restore_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl'
    AND p.pronargs = 4;

  IF v_restore_src IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: public._restore_quote_version_owner_impl(uuid, uuid, uuid, text) is missing after replace';
  END IF;

  IF position('QUOTE_RESTORE_BLOCKED_BY_DRAW' IN v_restore_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the restore path no longer refuses a drawn booking -- with the FK deferred, restoring a version of any partially drawn booking would abort at COMMIT with a raw foreign-key violation';
  END IF;

  -- Ordering matters as much as presence: refusing AFTER the delete would be
  -- too late, because the DELETE has already destroyed the quote's lines.
  IF position('QUOTE_RESTORE_BLOCKED_BY_DRAW' IN v_restore_src)
     > position('DELETE FROM quote_sections' IN v_restore_src) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the restore path refuses a drawn booking only AFTER deleting the quote sections; it must refuse first or the destructive work is already done';
  END IF;

  -- The retired release must not come back: it is what Codex proved could
  -- overbill a customer by a cent across a restore that changes the line
  -- partition, and it also fired the order-header trigger under the quote lock.
  IF position('SET quote_item_id = NULL' IN v_restore_src) > 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the restore path still RELEASES provenance stamps (SET quote_item_id = NULL). That draft was refuted: it discards the telescoping rounding basis and can bill $1.02 against a $1.01 booking, and its UPDATE fires trg_recalc_order_totals under the quote lock';
  END IF;

  -- The replacement must not have weakened the security posture it inherited.
  SELECT p.prosecdef, p.proconfig INTO v_restore_secdef, v_restore_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl'
    AND p.pronargs = 4;

  IF v_restore_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: _restore_quote_version_owner_impl lost SECURITY DEFINER';
  END IF;

  IF v_restore_config IS NULL
     OR NOT ('search_path=public, pg_temp' = ANY (v_restore_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: _restore_quote_version_owner_impl lost its search_path pin';
  END IF;

  -- Grant posture, stated against what live ACTUALLY holds (Codex 2026-08-19,
  -- P1). An earlier draft of this block denied service_role too, copied from
  -- the draw impl. That is wrong for THIS function: live carries
  -- {postgres=X/postgres,service_role=X/postgres}, a grant 20260813080000
  -- deliberately retained, and CREATE OR REPLACE preserves ACLs -- so the
  -- assertion fired and rolled the whole migration back on every attempt. It
  -- was never caught because the rehearsal created the function fresh, with no
  -- inherited ACL, so the check passed vacuously.
  --
  -- The browser roles are what must stay out. service_role is asserted PRESENT,
  -- so an accidental REVOKE is caught too.
  SELECT string_agg(g, ', ') INTO v_bad_grantee
  FROM unnest(ARRAY['anon', 'authenticated', 'public']) AS g
  WHERE has_function_privilege(
    g, 'public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)', 'EXECUTE');

  IF v_bad_grantee IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: _restore_quote_version_owner_impl is EXECUTE-able by % -- the replacement must not have widened its grants', v_bad_grantee;
  END IF;

  IF NOT has_function_privilege(
       'service_role', 'public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: _restore_quote_version_owner_impl lost the service_role EXECUTE grant that 20260813080000 deliberately retained -- the replacement must preserve it, not revoke it';
  END IF;

  -- The stamp and the FK rule are one mechanism, not two. Both halves of the
  -- rule are asserted here:
  --   * still ON DELETE NO ACTION -- SET NULL is the retired design and would
  --     wipe every stamp on every save of the quote;
  --   * now DEFERRABLE INITIALLY DEFERRED -- left non-deferrable, save_quote
  --     raises a raw foreign-key violation on the next edit of any partially
  --     drawn quote.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.order_items'::regclass
      AND c.conname = 'order_items_quote_item_id_fkey'
      AND c.contype = 'f'
      AND c.confdeltype = 'a'
      AND c.condeferrable IS TRUE
      AND c.condeferred IS TRUE
      -- Asserted as well as the deferral, so a future edit that added NOT VALID
      -- or changed the key could not pass this gate (drift review 2026-08-19,
      -- M4; RLS review L4). The preflight checks these before replacing the
      -- constraint; the postflight was the asymmetric half.
      AND c.convalidated IS TRUE
      AND c.confupdtype = 'a'
      AND c.confmatchtype = 's'
      AND c.confrelid = 'public.quote_items'::regclass
      AND array_length(c.conkey, 1) = 1
      AND array_length(c.confkey, 1) = 1
      AND (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'quote_item_id'
      AND (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) = 'id'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: order_items_quote_item_id_fkey is not ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED -- with the draw now stamping quote_item_id, revising a partially drawn quote would either abort with a foreign-key violation (if left non-deferrable) or silently lose the stamp (if left ON DELETE SET NULL)';
  END IF;

  -- The implementation must stay unreachable from the app roles; only the
  -- draw_down_quote wrapper (which enforces below-cost approval) may reach it.
  SELECT string_agg(g, ', ') INTO v_bad_grantee
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'public']) AS g
  WHERE has_function_privilege(
    g, 'public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)', 'EXECUTE');

  IF v_bad_grantee IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation is executable by % — it must be reachable only through the draw_down_quote wrapper', v_bad_grantee;
  END IF;

  -- The mirror of the check above: the REVOKE must not have gone too far. The
  -- public draw_down_quote wrapper is SECURITY DEFINER owned by postgres, so it
  -- reaches this implementation as postgres. If postgres ever lost EXECUTE the
  -- wrapper would fail at call time, not here -- i.e. the first symptom would
  -- be a broken draw in production. Assert it now instead.
  --
  -- Weak by construction, kept deliberately (drift review 2026-08-16, L4): while
  -- postgres OWNS this function it holds EXECUTE implicitly regardless of the
  -- ACL, so this cannot fail today. It earns its place only if ownership ever
  -- moves, which is exactly the case where a too-broad REVOKE would bite. It is
  -- an ownership tripwire, not a proof that the REVOKE above was well aimed.
  IF NOT has_function_privilege(
       'postgres',
       'public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: postgres lost EXECUTE on the implementation — the draw_down_quote wrapper could no longer reach it';
  END IF;

  -- The checks above prove nobody unauthorised can reach the implementation.
  -- They do NOT prove the front door still enforces below-cost approval, which
  -- is the other half of the posture this file claims. That matters more after
  -- this change than before it: splitting per tier makes below-cost detection
  -- sharper, so draws that used to hide behind an averaged unit price will now
  -- correctly route to the admin approval gate. Assert the wrapper is still
  -- there, still SECURITY DEFINER, still search_path-pinned, and still calls
  -- the gate. Verified live 2026-08-16: exactly one such function exists,
  -- signature (uuid, jsonb, uuid, text, text) -- hence pronargs = 5, pinned the
  -- same way the preflight and the impl postflight pin their own arity rather
  -- than matching on bare name.
  -- Overload uniqueness FIRST, asserted the same way the implementation is
  -- (preflight and postflight both use count(*) = 1) rather than with the bare
  -- NOT EXISTS this check used to be (drift review 2026-08-16 L3, RLS review
  -- L1). A bare EXISTS passes happily while a second, differently-shaped
  -- draw_down_quote sits beside this one -- precisely the ambiguity the
  -- implementation's own check exists to prevent.
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: expected exactly 1 function named public.draw_down_quote, found % -- a second overload would make the front door ambiguous', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
  INTO v_secdef, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote'
    AND p.pronargs = 5;

  -- Split into one assertion per claim so a failure names the thing that broke
  -- instead of listing four possibilities, and expressed with the same
  -- `= ANY (v_config)` idiom as the implementation's search_path assert above
  -- (drift review 2026-08-16, L4): the file previously stated one identical
  -- claim two different ways, which invites a later edit to "harmonize" them
  -- and get the semantics subtly wrong.
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper is missing or no longer carries its (uuid, jsonb, uuid, text, text) signature';
  END IF;

  -- IS NOT TRUE, not NOT: the two are the same on a boolean and differ on NULL,
  -- where `NOT NULL` is NULL and the IF quietly takes the false branch (drift
  -- review 2026-08-16 L1, RLS review L1 -- both caught the same half-finished
  -- harmonization). Unreachable today, since pg_proc.prosecdef is NOT NULL and
  -- the v_src IS NULL check above already raises when the row is absent, but
  -- the fail-closed form should not depend on that ordering surviving an edit.
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper is no longer SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper lost its search_path pin';
  END IF;

  IF position('_begin_below_cost_money_write' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper no longer calls the below-cost approval gate';
  END IF;

  -- The wrapper is the FRONT DOOR, so its grants matter more than the
  -- implementation's, not less (RLS review 2026-08-16, M3). The scan above
  -- proves the implementation is unreachable; without this one the file proved
  -- only half the posture it claims to prove, and an anon-executable
  -- draw_down_quote -- a B9-class exposure -- would pass this postflight
  -- untouched. The on-disk baseline is correct today (20260812115237:877
  -- REVOKEs from PUBLIC and anon, :882 GRANTs to authenticated and
  -- service_role); this asserts it rather than trusting it. anon only: an
  -- authenticated grant is required for the app to work at all, and postgres
  -- and the owner are legitimately privileged.
  IF has_function_privilege(
       'anon', 'public.draw_down_quote(uuid, jsonb, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: draw_down_quote is executable by anon — the front door must require an authenticated session';
  END IF;

  RAISE NOTICE 'DRAW_DOWN_TIER_SPLIT_OK: order lines now split per booked price tier; no averaged unit price remains';
END;
$postflight$;

-- --- Postflight: prove the CRX-MONEY-002 constraint landed and is enforcing --
DO $qty_postflight$
DECLARE
  c_expected constant text :=
    'CHECK (((total_units_needed IS NULL) OR ((total_units_needed >= (0)::numeric) AND (total_units_needed < ''Infinity''::numeric))))';
  v_validated boolean;
  v_def text;
BEGIN
  SELECT c.convalidated, pg_get_constraintdef(c.oid)
  INTO v_validated, v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.quote_items'::regclass
    AND c.conname = 'quote_items_total_units_needed_nonneg_finite_chk';

  IF v_validated IS NULL THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: quote_items_total_units_needed_nonneg_finite_chk is absent, so a negative or non-finite booked quantity is still writable';
  END IF;

  IF NOT v_validated THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: quote_items_total_units_needed_nonneg_finite_chk exists but is NOT VALID, so it does not cover the rows already on the table';
  END IF;

  -- Existence is not enforcement. A substring test is not enough either: a
  -- weaker same-named rule can contain both '>= (0)' and 'Infinity' and still
  -- admit the values this exists to stop (CRX-MIG-002). So assert the stored
  -- expression is exactly the one whose rejection behaviour was proven. That it
  -- REJECTS is proven on a throwaway database rather than by probing this one:
  -- an INSERT probe here would trip the table's NOT NULL columns before ever
  -- reaching the CHECK.
  IF v_def IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: quote_items_total_units_needed_nonneg_finite_chk is present but its rule (%) is not the expression proven to reject negative and non-finite quantities', v_def;
  END IF;
END;
$qty_postflight$;
