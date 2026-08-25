# Claude Adversarial Review — PR 361 Return-Credit COGS Reversal

**Date:** 2026-08-25
**Reviewer:** Claude (Opus 5)
**Requested by:** Mason Wells, via `docs/audits/2026-08-25-codex-to-claude-pr361-cogs-review-handoff.md` (authored by Codex)
**Nature:** read-only. No file in the candidate worktree was edited, staged, committed, or applied. No live data was mutated.

---

## 1. EXECUTION STATE

| Item | Value |
|---|---|
| Repository inspected | `C:\Users\mason\.codex\worktrees\pr361-current-rebuild\CRX_Manager` |
| Branch | `codex/pr361-current-rebuild` |
| HEAD | `0365cd8d7719a20dc270b22f0b6b42fb0b418a8b` (behind `origin/main` by 1 — `43e141ab`, unrelated) |
| Candidate migration | `supabase/migrations/20260825161340_return_credit_cogs_reversal_current.sql` |
| Candidate SHA-256 | `b3ccbbcedeba6d1abb05cc5525b87d073b929e2b66b4db367add530469b6ccbf` — **matches the handoff** |
| Staged | nothing |
| Live database | Supabase `rhyzpcqhnizqbxphqdkr`, read-only catalogue and aggregate queries only |

The handoff document lives in the Codex worktree, not in the branch I was launched into; I read it from its real path rather than assuming its contents.

---

## 2. VERDICT

**BLOCKED.**

Not for the reason six earlier rounds hunted. **I could not construct any case where this candidate over-reverses COGS** — the FIFO lot math is sound and bounded (see §6). It is blocked for two different defects: the reversal is gated on a flag that is false for most of the live catalogue, so it silently does nothing; and the inserted lines can hard-fail the entire return-credit RPC through a pre-existing trigger.

---

## 3. FINDING COUNTS

| Severity | Count |
|---|---|
| BLOCKER | 2 |
| HIGH | 1 |
| MEDIUM | 5 |
| LOW | 3 |
| NIT | 0 |

---

## 4. FINDINGS

### BLOCKER-1 — COGS reversal is gated on `restocked`, which is false for ~81% of the catalogue and has never been true in live data

**Where:** `supabase/migrations/20260825161340_return_credit_cogs_reversal_current.sql:352`

```sql
CASE
  WHEN ol.restocked THEN
    GREATEST(LEAST(ol.quantity - ol.prior_available_qty, ol.available_qty), 0)
  ELSE 0
END AS part_qty
```

**Failure scenario.** Live `_receive_return_impl_20260714` only flips `return_items.restocked` to `true` when an `inventory` row exists for that product at the exact hard-coded location string `'Main Warehouse'`:

```sql
LEFT JOIN LATERAL (SELECT id, location FROM inventory
  WHERE product_id = ri.product_id AND location = 'Main Warehouse' LIMIT 1) inv ON true
WHERE ri.return_id = p_return_id AND ri.restock = true AND ri.restocked = false
...
IF v_item.inv_id IS NOT NULL THEN  -- only this branch sets restocked
```

When that row is missing, `receive_return` counts the item as *skipped*, leaves `restocked = false`, and returns success. The candidate then assigns the entire return quantity to the zero-cost remainder branch.

**Live evidence I read myself:**

| Measure | Value |
|---|---|
| Products with **no** `'Main Warehouse'` inventory row | **487 of 604** (81%) |
| `return_items` with `restocked = true` (all time) | **0** |
| The single existing `return_item` | `restock = true, restocked = false` |
| Distinct inventory locations | 1 |

So on production data as it stands today, this migration's COGS reversal would **never fire once**. Every credit memo would get zero-cost lines and report `cogs_reversed_cents: 0`.

**Accounting consequence.** Revenue is reversed, cost is not → **gross profit is understated** on every affected credit. It is the *opposite* of the historical over-reversal bug, so it does not breach the safety goal — but it does not deliver the fix either, and it fails silently: no exception, no warning, no audit note distinguishing "correctly zero because scrapped" from "zero because a warehouse row was missing."

The deeper problem is that **the books now depend on whether an inventory row happens to exist at a hard-coded location string.** That is an inventory-data condition silently deciding an accounting outcome.

**Why the proof missed it.** The smoke fixture engineers the one path where the gate opens. `scripts/smoke/smoke-return-credit-chain.sql:173-177` inserts the `'Main Warehouse'` inventory row specifically "so `receive_return` exercises the real restock branch"; lines 597-599 then assert that **zero** return items remain `restocked = false`; line 634 explicitly resets `restock = true, restocked = true` immediately before the 6700 oracle. The `restock = true, restocked = false` case — 100% of current live returns — is never exercised against the COGS oracle.

**Smallest safe fix.** This needs Mason's decision before code (see §8). Mechanically, either:
- keep `restocked` as the gate (physically-back-in-stock is the defensible accounting trigger) and fix the silence — record the skipped-restock quantity in `financial_audit_log` and surface it in the RPC result so a zero reversal is visible; **or**
- gate on `restock` (intent) instead, accepting that scrapped goods would then also reverse cost, which is wrong.

Either way, add a smoke case with `restock = true, restocked = false` asserting the chosen behavior.

---

### BLOCKER-2 — the inserted credit lines can hard-fail `issue_return_credit` through the below-cost trigger

**Where:** migration line 410-424 (the `INSERT INTO invoice_items`) colliding with live trigger `zz_crx_below_cost_invoice_items` → `_enforce_below_cost_line`.

**Failure scenario.** The credit lines carry `product_id` (NOT NULL on `return_items`) and a **negative** `quantity`. Walking the live trigger body:

1. `v_operation := NULLIF(btrim(current_setting('app.crx_below_cost_operation', true)), '')`. I verified live that **none** of `issue_return_credit`, `_issue_return_credit_intent_impl_20260812`, or `_issue_return_credit_impl` sets this, and the candidate does not add it (it sets only `app.return_rpc`). So `v_operation` is NULL.
2. The INSERT escape hatch requires `COALESCE(NEW.quantity, 0) >= 0`. **The negative quantity defeats it.** (Live-confirmed: `hatch_requires_nonneg_qty = true`.)
3. `product_id IS NOT NULL` → `v_price_cents := NEW.unit_price_cents` (the *historical* sale price), then a `products … FOR SHARE` lookup:
   - `current_cost` NULL or ≤ 0 → **`RAISE COST_BASIS_REQUIRED`**;
   - `current_cost` not whole cents → `COST_BASIS_CENTS_REQUIRED`.
4. `IF v_price_cents >= v_cost_cents THEN RETURN NEW;` — compares the historical unit price to the product's **cost today**.
5. Otherwise `v_operation` is NULL → **`RAISE BELOW_COST_CONTEXT_REQUIRED`**.

Both raises abort the whole transaction. **The user cannot issue the credit at all.** Today `_issue_return_credit_impl` writes no `invoice_items` (live-confirmed: `mentions_cost_cents = false`, 4139 chars), so this trigger never fires on the return path. The candidate newly exposes it.

Note step 3 fires even for the **zero-cost remainder lines** — the `IF COALESCE(NEW.cost_cents,0) = 0 THEN RETURN NEW` early-out exists only in the NULL-product branch, not the product branch. Given BLOCKER-1, today *every* line would be a zero-cost remainder line, and every one still runs the products lookup.

**Live verification:** `zz_crx_below_cost_invoice_items` is present and enabled (`tgenabled='O'`, `tgtype=23` = ROW/BEFORE/INSERT/UPDATE). Its body contains `COST_BASIS_REQUIRED`, `BELOW_COST_CONTEXT_REQUIRED`, and the `v_price_cents >= v_cost_cents` early-out, and mentions **neither** `credit_memo` nor `issue_return_credit` nor `return_rpc` — there is no exemption.

**Blast radius today:** latent. 0 recognized source lines currently have `unit_price_cents < round(current_cost*100)`, and 0 have a missing cost basis. But 2 of 604 products already lack a cost basis, and `current_cost` is mutable through the governed pricing RPC — **any future cost increase above a historical sale price arms this.** For agricultural chemicals that is a matter of when, not if. It is also armed by any legitimately approved below-cost sale.

**Smallest safe fix.** Declare an operation context for this path using the thin-wrapper pattern the below-cost migration already established (`set_config('app.crx_below_cost_operation', 'issue_return_credit', true)`), *or* exempt negative-quantity `credit_memo` lines in `_enforce_below_cost_line` — a reversal of an already-approved sale is not a new pricing decision. Add a smoke case where `products.current_cost` exceeds the historical `unit_price_cents`.

---

### HIGH-1 — the documented scope claim is false; two customer-facing reports change with no definition change

**Where:** `docs/reference/migration-history.md` / handoff Q11 claim that the candidate "changes only the two invoice-line COGS reports."

The candidate changes *three function definitions*, but it also **creates `invoice_items` rows that never existed**. Every consumer of `invoice_items` changes behavior without being touched or tested. Two are customer-facing:

**`get_customer_year_end_summary`** (live body read):
```sql
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
LEFT JOIN products p ON p.id = ii.product_id
WHERE i.customer_id = p_customer_id
  AND i.season = p_season
  AND i.status = 'posted'
  AND i.deleted_at IS NULL
```
- **No `invoice_type` filter.** Credit memos are inserted as `'posted'`, so the new negative lines now flow into the customer's per-product year-end totals — `SUM(ii.quantity)`, `SUM(ii.extended_cents)`, grouped alongside `p.epa_registration`. This is a **regulatory-adjacent customer document**.
- It uses `status = 'posted'` only — a **narrower** predicate than the newly aligned three-state union. This directly answers handoff Q7: yes, a related narrower predicate remains.

**`get_detailed_statement_data`** (live body read): builds each invoice's item array from `invoice_items` with no filter, emitting `quantity`, `unit_price_cents`, `total_cost_cents` (= `extended_cents`). Customer statements will now render negative-quantity line items on credit memos where today they render none. PDF layout for negative quantities is unverified.

Whether these changes are *desirable* is arguable — reducing a customer's reported applied product totals after a restocked return is defensible. But they are **unreviewed, untested, and contradicted by the written scope claim.**

**Fix:** correct the scope statement in `docs/reference/migration-history.md` to say the change alters every `invoice_items` consumer, and decide explicitly whether `get_customer_year_end_summary` and `get_detailed_statement_data` should exclude `invoice_type = 'credit_memo'`.

---

### MEDIUM-1 — return credit on a cancelled/voided/deleted order now fails

Live trigger `trg_guard_terminal_order_invoice_items` → `guard_terminal_order_invoice_items` raises `ORDER_INVOICE_TERMINAL` on any `invoice_items` INSERT whose invoice joins an order that is `cancelled`/`voided` or soft-deleted. The credit memo carries `order_id`, so the candidate newly routes return credits into this guard. Today the header-only credit succeeds. Reachability regression; no accounting error.

### MEDIUM-2 — new lock ordering and a NOWAIT abort path

`_issue_return_credit_impl` locks `returns` (line 188 `FOR UPDATE`) then `order_items` (line 233 `PERFORM 1 … ORDER BY id FOR UPDATE`). The per-row terminal-order trigger then takes `FOR UPDATE OF o NOWAIT` on `orders`. A concurrent order cancel/void surfaces `ORDER_LIFECYCLE_BUSY_RETRY` to the user. The `order_items` lock itself is correct and well-chosen — `ORDER BY id` gives deterministic ordering and Postgres places `LockRows` above the `Sort`, so rows lock in id order. No corruption; a retry-able user-visible failure.

### MEDIUM-3 — `get_bottom_line_pnl` config change beyond status alignment

Preflight (line 89) asserts the live config is `search_path=public`; postflight (line 690) asserts `search_path=""`. The candidate changes the function's search path, which is a real change not listed in the intended behavior. It is **safe** — the function is `SECURITY INVOKER` (`NOT p.prosecdef` asserted both sides) and the body is fully schema-qualified (`public.invoices`, `public.invoice_items`, `public.commissions`), with only `pg_catalog` builtins otherwise. Worth stating as deliberate hardening rather than leaving it as an unexplained delta.

### MEDIUM-4 — cross-period asymmetry between source lots and the date-ranged reports

`source_lots` (line 267-303) applies no date filter; both reports are date-ranged. A credit memo dated in period N reverses cost recognized in period N-1, so a single-period P&L can show reversed cost that period never counted. This is inherent to credit-memo accounting and revenue already behaves this way today, so it is not a new defect — but it is the literal reading of "reverse cost the reports never counted" and should be stated rather than assumed away.

### MEDIUM-5 — credit-memo `total_cost_cents` is rounded; the reports are not

Line 425: `ROUND(COALESCE(SUM(ii.cost_cents * ii.quantity), 0))::bigint`. Both reports sum `ii.cost_cents * ii.quantity` **unrounded** as `numeric`. With a fractional return quantity the stored `invoices.total_cost_cents` can differ from the reported figure by under a cent. Low impact — `get_field_profitability` excludes credit memos — but the two numbers are not identical by construction, and the Hard Rules favour exactness.

### LOW-1 — migration comment overstates precision

Line ~245: "The one identity-pinned source-free legacy return remains header-only." Nothing is identity-pinned. The behavior falls out of `WHERE ri.order_item_id IS NOT NULL` (line 259) and applies to **any** future source-free return item, not one pinned row.

### LOW-2 — the new vitest file proves no behavior

`src/lib/returnCreditCogsMigration.test.ts` (43 lines) is entirely `toContain` string matching against the migration text and `migration-history.md`. It is a reasonable documentation guard, but it must not be counted as behavioral coverage — it would pass against a migration whose SQL was semantically wrong.

### LOW-3 — the mutation proof does not execute the grouped-lot mutant

`scripts/smoke/verify-return-credit-real-schema.mjs:331-340` runs the smoke against the **pre-candidate** implementation and requires `SMOKE_FAIL: RETURN_COGS_EXPECTED_6700`. That is a genuine mutation gate and it does prevent a vacuously-passing smoke. But the pre-candidate is header-only, so it fails at `0`, not at `6600`. **No grouped-lot mutant is ever executed** — the 6600 claim is analytic, not proven by run.

---

## 5. DEFENSIVE HARDENING / STYLE (not correctness defects)

- **Unit compatibility is correct but unasserted.** It holds only because `_create_return_intent_impl_20260812` copies `return_items.unit := coalesce(order_items.unit_size, 'ea')`. Given CRX's chem-unit history, a defensive assertion that the source lot's `unit_size` matches `rs.unit` would convert an invisible dependency into a loud failure.
- **`part_order = 2147483647`** as the zero-cost sentinel works but is a magic number; a boolean `is_remainder` sort key would read better.
- **`prior_lots` matches prior credits by `cost_cents` alone.** Correct (prior credit rows record cost, not lot identity), but a comment stating *why* lot identity is not recoverable would save the next reviewer the derivation.
- **No `invoice_type` guard on the zero-cost remainder branch** — harmless today, but the branch is where a future edit is most likely to leak.

---

## 6. ANSWERS TO THE TWELVE REVIEW QUESTIONS

Legend: **[V]** = I verified this myself this session; **[I]** = inherited from the handoff and not independently re-run.

**Q1 — Can repeated/noncontiguous costs, prior credits, partial quantities, deletion, or status cause the wrong lot or over-reversal?**
**No. [V]** I worked the algebra through several adversarial shapes. Prior credits are distributed FIFO *within each cost bucket* (`PARTITION BY sl.id, sl.line_cost_cents`, lines 305-315), and the current return then consumes what remains FIFO by `(source_invoice_date, source_item_created_at, source_item_id)` after fully-consumed lots are filtered out (`WHERE al.available_qty > 0`, line 347). Worked example — lots `3@100`, `2@200`, `4@100` with 5 already credited at cost 100: bucket-FIFO leaves `0`, `2@200`, `2@100`; a further return of 3 correctly takes `2@200 + 1@100`. A grouped-by-cost implementation would not. Deletion and non-recognized status only *remove* lots, which under-reverses.

**Q2 — Do prior credits consume eligible source lots once and only once, without double- or cross-sale consumption?**
**Yes. [V]** `prior_lots` (lines 285-302) is scoped by `ii.order_item_id = rs.order_item_id AND ii.product_id = rs.product_id`, so consumption cannot cross to another sale line. It is `GROUP BY rs.id, ii.cost_cents`, giving at most one row per (return item, cost) — the `LEFT JOIN` at line 316-318 cannot fan out. Zero-cost remainder rows from prior credits are excluded by `ii.cost_cents > 0`, which is right: they consumed no lot. A voided or deleted prior credit memo drops out of `prior_lots` **and** out of the reports simultaneously, so the two stay consistent.

**Q3 — Are source lots and prior credited quantities in compatible units and signs?**
**Yes, by upstream construction. [V]** `_create_return_intent_impl_20260812` (live body read) sets `return_items.unit := coalesce(order_items.unit_size,'ea')` and `unit_price_cents := round(order_items.price_per_unit * 100)`, and raises `RETURN_QUANTITY_MUST_BE_POSITIVE` for `quantity <= 0`. Invoice lines descend from the same order line. Signs are handled correctly: `SUM(-ii.quantity)` on negative prior lines, `-rp.part_qty` on insert. NULL quantity is impossible (`invoice_items.quantity` is `numeric NOT NULL`, `return_items.quantity` is `numeric NOT NULL DEFAULT 0`). The dependency is real but **unasserted** — see §5.

**Q4 — Does the zero-cost remainder stay zero through the inserted lines and both reports?**
**Yes. [V]** The remainder branch (lines 377-388) hard-codes `0::bigint AS line_cost_cents`, inserted into `cost_cents`. Both reports multiply `cost_cents * quantity`, so `0 × anything = 0`. `invoice_items.cost_cents` is `bigint NOT NULL` (live-confirmed), so no NULL can substitute.

**Q5 — Are cent rounding and sign conventions exact at every boundary?**
**Yes for revenue; one sub-cent gap for the stored total. [V]** Cumulative-difference allocation (lines 400-406) telescopes exactly: the final part's `cumulative_qty` equals `quantity`, so `ROUND(extended × qty/qty) = extended_cents` and the parts sum to the header `-v_total` exactly. `NULLIF(sp.quantity, 0)` cannot yield NULL because return quantities are always positive (Q3). All arithmetic is `numeric`, never float. The remainder sorts last via `part_order = 2147483647`, so rounding residue lands on the zero-cost part. The one gap is MEDIUM-5: `v_credit_cogs_cents` rounds while the reports do not.

**Q6 — Does the production call chain reach the replaced implementation? Verify hashes, owner, security, search_path, grants.**
**Chain: yes [V]. Hashes: partially [V].** Live `issue_return_credit` → `_issue_return_credit_intent_impl_20260812` → `_issue_return_credit_impl` is confirmed, and live `_issue_return_credit_impl` is header-only (4139 chars, `cost_cents` absent) — the defect is real and latent exactly as the handoff states. The preflight pins both outer links by body hash *and* by owner/`prosecdef`/`provolatile`/`proconfig`/grants (lines 47-79), which is the right shape: replacing a disconnected helper cannot pass. Postflight re-pins all five functions plus the new body hash. **Caveat:** the live-data guard blocks `sha256()` in my session, so I could **not** independently recompute the four pinned hashes against live. I verified the *structural* facts each hash is meant to protect (exactly one overload each, correct owner/security/search_path/grants, expected status sets) and found no drift. The hashes themselves are **[I]**.

**Q7 — Are all three recognized statuses applied consistently? Any narrower or wider predicate left?**
**Consistent within the three touched functions; one narrower predicate remains outside them. [V]** Live `get_bottom_line_pnl` = `posted` only; live `get_monthly_summary` = `posted, overdue`; live `get_field_profitability` **already** uses the three-state union — so Mason's decision aligns the two laggards with an existing report rather than inventing a new convention. Good. But **`get_customer_year_end_summary` still uses `status = 'posted'` alone** while now consuming the new credit-memo lines (HIGH-1). Source eligibility (line 302) is a strict subset of the report predicate — it additionally excludes `credit_memo` — which is the safe direction and cannot pick up cost the reports do not count.

**Q8 — Could the report changes alter AR, commission, date, deletion, or credit-memo treatment beyond status alignment?**
**AR/commission/date/deletion: no. Credit-memo treatment: yes, and beyond the two reports. [V]** `ar_balance_cents` keeps `balance_cents > 0`; adding `paid` contributes nothing (paid invoices have zero balance), and credit memos have negative balances, so AR is unmoved. Commissions still key off `commissions.order_date`, untouched. Date and `deleted_at` predicates are unchanged. `voided_count` still keys on `status = 'voided'`; note `invoices_status_check` also permits `'cancelled'`, which neither the old nor new definition counts — pre-existing, not introduced. The real answer to this question is HIGH-1: credit-memo treatment changes in reports whose **definitions were not touched at all**, because the change is in the data, not the SQL. Also MEDIUM-3 (search_path).

**Q9 — Does the mutation proof genuinely distinguish the grouped-lot bug?**
**The oracle does; the executed mutant does not. [V]** The fixture is genuinely discriminating: item 2 carries `1@$5` (paid, `date-2`), `2@$6` (overdue, `date-1`), `3@$5` (posted, `date`); returning 5 must take `1@$5 + 2@$6 + 2@$5 = 2700`, and with item 1's `8@$5 = 4000` gives **6700**, whereas collapsing both `$5` lots ahead of the intervening `$6` lot gives `2000 + 600 + 4000 = 6600`. The arithmetic is correct and the scenario is well chosen. **But** `verify-return-credit-real-schema.mjs:331-340` only executes the *header-only pre-candidate*, which fails at `0`. No grouped implementation is ever run, so 6600 is asserted by reasoning, not by execution (LOW-3).

**Q10 — Do the tests prove failure of the old behavior and exercise paid/overdue, prior credits, partial/uninvoiced returns, repeated noncontiguous costs, rollback, residue, and the real live schema?**
**Mostly yes, with one decisive gap. [V]** Covered and genuinely proven: `paid` and `overdue` sources (three separate source invoices), repeated noncontiguous costs, a partial/uninvoiced remainder (2 of 10 units on item 1), old-behavior failure via the mutation gate, `SMOKE_PASS_ROLLBACK`, four explicit residue assertions, and a fresh live-schema container. **Not covered: `restock = true, restocked = false`** — the single condition that describes 100% of current live returns and 81% of the catalogue (BLOCKER-1). Also not covered: `current_cost > historical unit_price_cents` (BLOCKER-2), a cancelled/voided order (MEDIUM-1), and any assertion on the two customer-facing reports (HIGH-1). The new vitest file adds no behavioral coverage (LOW-2). Prior-credit consumption is exercised in the migration logic but I did not find a smoke case that issues two sequential credits against the same `order_item` and asserts the second one's lot selection — worth adding.

**Q11 — Are the documentation claims exactly true, including that the migration is not live and the old claim was false?**
**Two are true; one is false. [V]** *(a)* Not live — **confirmed**: live `_issue_return_credit_impl` is header-only, and live `get_bottom_line_pnl`/`get_monthly_summary` still carry the old status sets, so stamp `20260825161340` is absent. *(b)* The corrected field-profitability scope — **confirmed**: live `get_field_profitability` does read `invoices.total_cost_cents`, does scope to `invoice_type = 'field_application'`, and therefore excludes credit memos and does not consume this reversal. Correcting the earlier claim was right. *(c)* "**changes only the two invoice-line COGS reports**" — **false** (HIGH-1). The new `invoice_items` rows change `get_customer_year_end_summary` and `get_detailed_statement_data` too.

**Q12 — Any migration safety, concurrency, locking, planning, privilege, overload, or idempotency issue the proof missed?**
**Yes — three, none catastrophic. [V]** Missed: MEDIUM-1 (terminal-order guard now reachable), MEDIUM-2 (`orders` `NOWAIT` lock introduced into this path by the trigger). Verified sound: the migration is definition-only with no backfill or table rewrite, so it is fast and its rollback is definition-only; `p_idempotency_key text DEFAULT NULL` is accepted **and enforced** via `check_idempotency`/`save_idempotency` on the same `'issue_return_credit'` scope; postflight asserts exactly one overload of each of the three functions, closing the dual-overload drift class; grants are correctly asymmetric (`_impl` and intent are `service_role`-only and revoked from `anon`/`authenticated`; the public wrapper excludes `anon`); `invoices.balance_cents` is `GENERATED ALWAYS` and is correctly never written, while `total_cost_cents` is `is_generated = NEVER` so the UPDATE at line 429 is legal; `invoice_items` carries no CHECK constraint on `quantity`, so negative lines are structurally permitted; the `credit_memo` CHECK constraints (`total_amount_cents <= 0`, `balance_cents <= 0`) are satisfied by `-v_total`. The `order_items … ORDER BY id FOR UPDATE` serialization is genuinely correct.

---

## 7. WHY IT CANNOT OVER-REVERSE (the question that was actually asked)

Stated plainly, because six rounds hunted this and it deserves a direct answer:

Total cost reversed for an `order_item`, across **all** credits ever issued against it, is bounded by the cost that invoice actually recognized. Three independent bounds compose:

1. **Per-lot:** `available_qty = GREATEST(posted_qty − GREATEST(LEAST(reversed_qty − prior_posted_qty, posted_qty), 0), 0)` (lines 320-332) is clamped into `[0, posted_qty]`. No lot can yield more units than it posted.
2. **Per-return:** `part_qty = LEAST(quantity − prior_available_qty, available_qty)` clamped at 0 (lines 350-359), so the parts for one return sum to at most the returned quantity.
3. **Across returns:** `_create_return_intent_impl_20260812` raises `RETURN_QUANTITY_EXCEEDS_DELIVERED` when `prior_qty + qty > order_items.quantity_delivered`, counting every prior return not `rejected`/`cancelled`. Returned quantity can never exceed delivered quantity.

Each unit is costed at its own historical lot cost, and prior credits are subtracted before the current one allocates. Source lots are drawn only from invoices satisfying **exactly** the reports' recognized predicate, minus credit memos — a strict subset. Therefore reversed cost ≤ Σ(posted_qty × lot cost) = recognized COGS for that line.

The one qualification is MEDIUM-4: this is a *cumulative* bound, not a per-period one. Within a single date-ranged report, a credit memo can reverse cost recognized in an earlier period — which is how credit memos already behave for revenue.

---

## 8. SINGLE RECOMMENDED NEXT STEP

**Do not apply. Take BLOCKER-1 to Mason as a business question, because the answer changes the code and no amount of further review can settle it.**

The question, in plain English: *when a customer returns product that we intended to restock but our system had no warehouse record for — which is 81% of the catalogue right now — should the books take the cost back off, or leave it as an expense?*

BLOCKER-2 is mechanical and should be fixed in the same round (declare a below-cost operation context for the return-credit path, or exempt negative-quantity credit-memo lines), and HIGH-1's scope statement should be corrected at the same time. Then re-run the real-schema harness with the three missing smoke cases — `restocked = false`, `current_cost > historical unit price`, and a second sequential credit against the same `order_item`.

The FIFO accounting core of this candidate is good work and should survive the fix largely unchanged.
