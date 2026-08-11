# Should the order-profit path move to bigint cents?

**Date:** 2026-08-10 · **Scope:** read-only investigation · **Trigger:** CodeRabbit Major
finding on [PR #354](https://github.com/masonwells1/CRX_Manager_V1.0/pull/354), comment
`3745746129`, against `supabase/migrations/20260809230500_single_canonical_line_profit.sql`
lines 174-216 / 301-345.

**Recommendation: NO. Do not convert.** Add a CHECK constraint instead — it delivers
100% of what bigint cents would guarantee, at roughly 2% of the blast radius, because the
stored unit stays dollars and therefore no reader or writer changes at all.

Separately: two CodeRabbit **P1** comments filed on the same file *after* the PR #354
disposition was written describe a real money defect that a type conversion would not fix.
The defect is confirmed from live function source, and 12 of 35 order commissions carry a
basis that disagrees with the order header they were minted from — **but see §5 before
treating that count as urgent.** 11 of the 12 are penny-or-smaller residue on `pending` rows
and the only material one is `cancelled`. Worth fixing to stop future drift; not a live
money emergency.

---

## 1. What CodeRabbit actually argued

> "This migration derives and stores order line profit and aggregate totals as rounded
> `numeric` dollars. Use bigint cents for derived `order_items.profit` and
> `orders.total_profit`; local casts in this trigger do not change the canonical
> dollar-cents contract."

And on the sibling migration `20260809170900`:

> "`ROUND(..., 2)` limits decimal scale, but it does not satisfy integer-cent storage."

This is a **convention** argument, not a correctness argument. It does not name a single
wrong number, and I could not construct one. PostgreSQL `numeric` is exact
arbitrary-precision decimal; `10.01 - 5.00` is exactly `5.01` in `numeric` and exactly
`501` in bigint cents. The AGENTS.md rule ("Money is bigint cents. Never use
floating-point math") exists to keep IEEE-754 binary floats out of money. `numeric` is
not a float. The rule's *purpose* is already satisfied.

CodeRabbit's real, defensible point is narrower and worth taking seriously: unqualified
`numeric` lets a *future* writer store a sub-cent or non-finite value, and the trigger
that currently prevents that is a soft guard, not a type-level one.

## 2. Does numeric + `_round_money_to_whole_cents` already give exact additivity?

**For profit: yes, verified live.** Measured read-only against `rhyzpcqhnizqbxphqdkr` on
2026-08-10:

| Check | Result |
|---|---|
| Order lines where `profit ≠ ROUND(total_price,2) − ROUND(cost×units,2)` | **0 of 288** |
| Orders where `total_profit ≠ SUM(order_items.profit)` | **1 of 62**, gap $0.01 |
| Orders with a sub-cent header value | **0 of 65** |

The single $0.01 gap is a *stale header*, not a formula flaw: that order has had no line
written since the backfill, so `trg_recalc_order_totals` has not re-fired. The derivation
itself holds on every live row. On the profit axis the migration did what it claimed.

**For price: no — and this is unrelated to the column type.** 3 orders violate
`total_price − total_cost = total_profit`, and 2 have `total_price ≠ SUM(rounded line
prices)`. That is exactly the defect the migration's own header flags as out-of-scope note
(4): `_update_order_items_impl` (`20260617123503:274-275`) overwrites `orders.total_price`
with the **raw** line sum right after the trigger runs, on the `orders` table, so no
trigger re-fires and the raw value stands. Converting to bigint cents does not remove that
overwrite. Deleting those two lines does.

**Where the soft guard genuinely has holes.** The trigger only covers `order_items` and
`commissions`. Nothing normalizes the quote side at all:

| Table | Sub-cent rows, live |
|---|---|
| `order_items.total_price` | 35 of 288 |
| `order_items` extended cost (`cost_per_unit × total_units_needed`) | 54 of 288 |
| `quotes` header (`total_cost` / `total_profit` / `total_price`) | 2 |
| `commissions` (`commission_amount` / `order_profit`) | 3 |

## 3. Blast radius of an actual conversion

The four columns CodeRabbit named are not separable. `orders.total_profit` is derived from
`order_items.profit`, which is derived from `order_items.total_price` and
`cost_per_unit × total_units_needed`; `convert_quote_to_order` copies `quote_items` rows
verbatim into `order_items`. Converting the named four forces the whole cluster:

**Nine columns across four tables** — `orders.total_cost`, `orders.total_profit`,
`orders.total_price`, `order_items.profit`, `order_items.total_price`,
`order_items.net_margin`*, `quotes.total_cost`, `quotes.total_profit`,
`quote_items.profit` — plus, to stay coherent, `commissions.commission_amount` and
`commissions.order_profit`. (*`net_margin` is a percentage and should stay numeric; it is
listed because it is computed from the converted values.)

**Database:** 46 live functions name these columns; 101 live functions touch these tables.
Among them: `save_quote`, `create_direct_order`, `bulk_import_order`,
`convert_quote_to_order`, `update_order_items`, `trg_recalc_order_totals`,
`create_invoice_from_order`, `create_split_invoices_from_order`, `financial_dashboard_summary`,
`get_sales_detail_report`, `get_field_profitability`, `get_customer_year_end_summary`,
`get_monthly_summary`, `get_season_comparison`, `run_data_integrity_sweep`.

**Frontend:** 17 non-test files plus ~9 test files, including `src/types/index.ts`
(4+ interface blocks), `src/types/supabase.ts`, `src/lib/quoteCalc.ts`, `NewOrder.tsx`,
`QuoteBuilder.tsx`, `OrderDetail.tsx`, `FinancialDashboard.tsx`, `SalesReports.tsx`,
`Reports.tsx`, `CustomerDetail.tsx`, `BulkOrderImport.tsx`, `BulkQuoteImport.tsx`,
`FinanceSnapshotCard.tsx`.

**Why the size is the wrong way to measure the risk.** This is a **unit change**, not just
a type change. Dollars become cents. TypeScript cannot help — both are `number`. A single
missed call site does not produce a penny discrepancy; it produces a **100× money error**
that renders or bills correctly-typed nonsense. And because the trigger, the RPCs, and the
frontend must all flip together, it cannot be staged incrementally — it is one atomic
migration plus one atomic deploy, touching every money-bearing order and quote surface at
once.

**Aggravating context:** Supabase is on the free plan, so there is no point-in-time
recovery, and the session staleness check reports **no database backup exists yet**. A
100× error on live order and commission data would have no clean restore path.

## 4. Which ordering-cycle findings would a conversion subsume?

Cross-referenced against `docs/audits/ordering-cycle-review-2026-08-09/FINDINGS.md`:

| Finding | Subsumed by bigint? |
|---|---|
| [MED] `quotes.total_cost` stored unrounded (line 547) | **Half.** The missing `ROUND` is fixed; the quote-vs-order formula divergence is not. |
| [LOW] `create_direct_order` performs no cent rounding (line 761) | **Yes**, the storage half. |
| [MED/MED] NaN/Infinity accepted by `save_quote` and `create_direct_order` (lines 254, 513) | **Yes** — `'NaN'::bigint` errors, `'NaN'::numeric` does not. This is bigint's one genuine type-level win. |
| [LOW] QuoteBuilder client rounding differs from server (line 788) | No. |
| [LOW] Cent-rounding formula differs across three invoice-line paths (line 434) | No. |
| [MED] Caller-controlled cost/profit drives commission basis (line 74) | No — an authorization defect. |
| [LOW] Negative commission on tiny-profit multi-way splits (line 835) | No. |

So a conversion clears roughly **two and a half LOW/MED findings**. The commission-basis
defects — the ones that move real money — survive it entirely.

## 5. What to do instead

### Tier 1 — the money bugs, no type change (recommend doing these)

**A. Re-read `orders.total_profit` before minting commissions.** This is the live-confirmed
defect and it is what CodeRabbit's two P1 comments (`3746221706`, `3746352707`) are
describing. `convert_quote_to_order` (`20260702172500:207-210`) passes the cached
`v_quote.total_profit`, and `create_direct_order` (`20260614142939:190-193`) passes a local
unrounded accumulator — in both cases *after* the item triggers have already rewritten the
canonical header.

**Live mismatch count, correctly characterized** (re-measured live 2026-08-10 with an exact
`IS DISTINCT FROM` predicate; an earlier pass in this session used a cent-rounded comparison
and reported 10, which hid the three sub-cent rows). **12 of 35** order commissions carry
`order_profit ≠ orders.total_profit`, but that number is not evidence of live urgency. The
breakdown: **8 `pending` rows differ by exactly $0.01** and **3 `pending` rows differ by less
than a cent** — together the already-disclosed backfill residual from the sibling session on
branch `claude/session-orchestration-setup-d73e6c` (commit `a0a69a62`; its KNOWN_ISSUES entry
records that rewriting commission rows was not approved, so they were left alone). **1 row has
a materially larger gap, and it is on a `cancelled` row** (figure withheld — this repo is
public). So: the code defect is real, confirmed from live function source, and worth fixing to
stop future drift — but it is not currently costing money, and no live commission row needs an
emergency rewrite.
`bulk_import_order` already does this correctly (`20260806004644:327-345`); copy that pattern
to the two primary creation paths. This closes FINDINGS line 547 as well.

**B. `ROUND(..., 2)` on `quotes.total_cost` in `save_quote`** (2 live rows).

**C. `ROUND(..., 2)` in `create_direct_order`** on the line inserts and header accumulator
(FINDINGS line 761).

**D. Delete the `total_price` clobber** in `_update_order_items_impl` (`20260617123503:274-275`),
which the `20260809230500` header already identified as the right fix. Restores
`total_price − total_cost = total_profit` on the 3 orders that break it.

### Tier 2 — make the guard hard instead of soft (recommend; this is the answer to CodeRabbit)

Per the global "prefer hard guards over more rules" principle, add CHECK constraints to the
numeric-dollar columns (12 in scope; 7 shipped now, 5 deferred — see the sequencing note below):

```
CHECK (col IS NULL OR (col = ROUND(col, 2) AND col > '-Infinity' AND col < 'Infinity'))
```

**Correction (proven in a throwaway PostgreSQL 17 on 2026-08-10).** An earlier draft of this
section claimed `col = ROUND(col,2)` alone rejects `NaN` "because NaN compares unequal to
everything." That is wrong. PostgreSQL `numeric` deliberately does **not** use IEEE NaN
semantics: so numeric values can be sorted and tree-indexed, it treats NaN as *equal* to NaN
and *greater than* every non-NaN value. Measured: `'NaN' = ROUND('NaN',2)` → true, so the
ROUND clause lets NaN straight through; `'NaN' < 'Infinity'` → false, so the upper bound is
what actually rejects it. **Both halves of the predicate are load-bearing** and must not be
"simplified" to one. The same note is carried in the migration header so a future maintainer
hits it before touching the constraint.

With both halves present, the predicate gives the complete set of guarantees bigint cents
would give — sub-cent unrepresentable, non-finite unrepresentable — enforced by the database
rather than by a trigger, and **with zero reader or writer changes anywhere**, because the
stored unit is still dollars.

**Sequencing (corrected).** An earlier draft proposed adding the constraints `NOT VALID`
first, on the reasoning that this "guards all new writes immediately and touches no existing
row." The second half is false, and it matters. `NOT VALID` only skips the one-time backfill
scan; a CHECK constraint is still re-evaluated against the **whole new row version on every
UPDATE**, no matter which column the update touched. Measured: a `NOT VALID` constraint was
accepted over a dirty legacy row, and then an unrelated `UPDATE ... SET notes = '...'` on
that same row **errored**, while the identical edit on a clean row succeeded. Shipping
`NOT VALID` would therefore have frozen every dirty legacy record against all future edits —
a latent trap, not a safe intermediate step.

What shipped instead: constrain only the columns already measured 100% clean (7 of 12), and
have the migration itself assert that the 5 deferred columns are **not** constrained, so nobody
can quietly widen it. Those 5 columns are deferred for two different reasons. **Four hold the
43 non-conforming rows** and need a data repair first: `order_items.total_price` (35/288),
`quotes.total_cost` (2/4), `commissions.commission_amount` and `commissions.order_profit`
(3/35 each). **`orders.total_price` is currently clean** and is deferred for a behavioural
reason instead: `_update_order_items_impl` overwrites it with the raw un-rounded line sum, so
constraining it would start rejecting ordinary edits until that writer is corrected. Repairing
the 43 rows rewrites stored money and is a separate migration needing Mason's explicit OK on
its own; the constraints follow it as `VALID` from the start.

### Tier 3 — if cents are still wanted later

Do it at the reporting boundary, not the storage boundary: add `*_cents` generated columns
alongside the numeric ones and migrate readers gradually. This gets the integer-cent
contract for anything new without a flag-day unit change. I would not do this either —
after Tier 2 there is nothing left for it to buy.

## 6. Reply to CodeRabbit

The finding should be closed as **won't-fix, with a hard guard substituted**, not silently
dismissed. Suggested reason: *`numeric` is exact decimal, not floating point, so the rule's
purpose is met; the residual risk CodeRabbit correctly identifies — that unqualified
`numeric` permits sub-cent and non-finite values — is closed by a CHECK constraint that
gives the same type-level guarantee without a nine-column, 46-function, 17-file unit change
on a database with no PITR and no backup.*

## Verification status

Verified live, read-only, against `rhyzpcqhnizqbxphqdkr` on 2026-08-10: all column types,
all row and sub-cent counts, the additivity results, the 12/35 commission-basis mismatch
(with the `pending`/`cancelled` breakdown in §5), and the 46 / 101 function counts.

**Verified by execution** in a throwaway PostgreSQL 17 container on 2026-08-10 — this
supersedes the earlier "not verified" note about NaN:

1. The Tier 2 predicate bites on real tables: `10.005`, `NaN`, `Infinity` and `-Infinity` all
   rejected; legal `10.01` accepted.
2. Constraining a deferred (dirty) column genuinely fails, so deferring those 5 was necessary,
   not cautious: adding the constraint to `order_items.total_price` errored on the legacy row.
3. NaN semantics as described in §5 — `'NaN' = ROUND('NaN',2)` true, `'NaN' < 'Infinity'` false.
4. `NOT VALID` does **not** shield legacy rows from later edits (see §5 sequencing).
5. All three drafted migrations ran end-to-end with every post-condition passing, and each
   post-condition was mutation-tested: granting `anon` EXECUTE, revoking `authenticated`
   EXECUTE, and tampering the pinned `_insert_commissions_for_order` helper each made the
   migration abort as designed.

**All three migrations were applied to live production on 2026-08-10**, in the order
`20260810150000` → `20260810150500` → `20260810151000` (ledger versions `20260810152935`,
`20260810154721`, `20260810155629`), on Mason's explicit in-chat approval and each through the
full migration-apply proof gate. They replace function bodies and add CHECK constraints only:
**no live row was modified.** `.claude/schema-registry.json` was rebuilt from live
introspection in the same change (high-water now `20260810155629`). No application code has
been pushed, merged, or deployed — that is still separate.
