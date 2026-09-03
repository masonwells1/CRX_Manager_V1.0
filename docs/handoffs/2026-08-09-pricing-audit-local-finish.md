# Handoff — finish the pricing-audit work from a local session

> **SUPERSEDED — historical record.** This document belongs to PR #350, which was **closed
> unmerged**. The below-cost work it describes did ship, but in a different shape and under different
> names: `src/components/ui/BelowCostApprovalModal.tsx`, `src/contexts/BelowCostApprovalContext.tsx`
> and `src/lib/belowCostApproval.ts` on `main`, not this branch's `BelowCostConfirmModal.tsx` /
> `belowCostRpc.ts`. Its three migrations are **applied live** as versions `20260812145628`,
> `20260812151606` and `20260812154028`. Treat every file path and symbol name below as belonging to
> an abandoned draft; verify against current source before acting on anything here.

**Written 2026-08-09** by the cloud (Claude Code on the web) session that produced PR #350 and
PR #361. That session could not merge or apply migrations; a local session with the Codex CLI can.

Read this file, then `docs/manual/KNOWN_ISSUES.md` (five new entries at the top are from this work).

---

## Why a handoff file instead of resuming the session

A web session runs in an ephemeral container and cannot be moved to a desktop CLI. Everything that
matters is in git — two pushed branches, the changelog, and the known-issues entries — so the repo
*is* the handoff. Nothing is stranded.

## Current state (verified at time of writing)

| Item | State |
|---|---|
| `claude/pricing-audit-strategy-jym8rr` | pushed, clean, head `c688318b4` |
| **PR #350** | open, **both required checks green** on `c688318b4` (Vercel + CodeRabbit) |
| `claude/return-credit-cogs-reversal` | pushed, off current `main` |
| **PR #361** | open as **draft**, deliberately parked |
| Live database | **unchanged** — no migration from this work has been applied |
| Backup | in-database snapshot 2026-08-09 07:00 UTC, 154 tables / 9,197 rows, verified |

## Why the cloud session could not finish

One root cause: `write-apply-proofs.mjs` and `write-codex-push-proof.mjs` resolve the Codex CLI
**only** from `/root/.local/share/OpenAI/Codex/bin` and deliberately refuse PATH shims and env
overrides. A web container has no such binary, so:

- `apply_migration` is denied (no proof can be minted), and
- `pr-merge-guard` denies the merge (`spawnSync gh ENOENT`; and a money/`_cents`/migration diff
  additionally needs a fresh exact-SHA Codex push proof).

Both are the guards working correctly. Nothing was worked around. See the two `KNOWN_ISSUES.md`
entries titled "live migrations cannot be applied from a remote (web) session".

---

## Do this, in order

### 1. Merge PR #350
Checks are already green. Expect the merge gate to ask for a fresh exact-SHA Codex push proof
because the diff touches `_cents`, migrations and `financial_audit_log`.

```
node scripts/write-codex-push-proof.mjs      # gate wants this for a risky diff
gh pr merge 350 --squash                     # no --auto
```

### 2. Apply the two migrations, in this order

```
supabase/migrations/20260808170100_snapshot_cost_reporting.sql
supabase/migrations/20260808170200_quote_items_cost_at_quote_snapshot.sql
```

First refresh the applied-migration snapshot (a fresh checkout never has it, and the ordering guard
abstains without it) — read-only:

```
-- via Supabase MCP execute_sql, then pipe the JSON in:
select version, name from supabase_migrations.schema_migrations order by version;
node scripts/refresh-applied-migrations.mjs < rows.json
```

The full ledger is ~946 rows and exceeds the MCP result limit — request it as a single `json_agg`
and pipe the saved tool-result file rather than paging it through the session.

**`20260808170200` is broader than when it was first reviewed.** Besides the quote cost snapshot it
now also:
- re-emits `duplicate_quote` (costs a duplicated quote on today's basis instead of copying the
  source's, so a copy no longer carries two conflicting cost bases), and
- **drops the `qitems_insert` / `qitems_update` / `qitems_delete` policies on `quote_items`**
  (Mason approved 2026-08-09). Verified before writing it: the table does not FORCE row security,
  table and all five quote RPCs are `postgres`-owned so the definer functions bypass RLS, and all
  three frontend touches of `quote_items` are reads. `SELECT` is untouched.

Run `/explain-migration` on it first if you want the plain-English version.

### 3. Immediately after applying

```
/regen-schema-registry
node scripts/db-invariant-sweeps/run-sweeps.mjs   # then run each printed query; all must return 0 rows
```

### 4. Follow-up PR: wire the Profitability tabs

`20260808170100` rewrites `get_profitability_report`, **but nothing calls it** — `Reports.tsx` still
computes the customer/product/monthly Profitability tabs from direct queries over
`orders.total_profit` / `order_items.profit`. Until this lands, **those tabs still show the stale
margins the migration exists to replace**, whatever the changelog says.

The caller was deliberately cut from #350 because it could not ship before the migration applied —
it would have called an RPC the live database did not have.

1. Switch the three sub-fetchers in `Reports.tsx` (~lines 161-239) to `get_profitability_report`.
2. Restore its `QUEUED_MIGRATION_FUNCTIONS` entry and the `rpcFixtureLiveDiff.test.ts` fixture (that
   file currently holds an empty list with a comment pointing at this deferral).
3. Verify a real date range in the UI against the same range from the RPC.

### 5. Live scenarios worth running once the schema is live

- Save a quote, change the product's catalog cost, reopen — the quote keeps its original cost.
- Add two lines of the *same* product to a new quote, save twice — the second save must not be
  refused (this was three separate lock-outs during review).
- Duplicate a quote after a cost change — the copy costs at today's basis, prices unchanged.
- Below-cost save on quote / order / invoice / bulk import — prompt appears, reason recorded, and
  the reason does **not** appear in Customer View or on any PDF.
- Rush order → Set Pricing below cost — the prompt must appear (it read the wrong cost column until
  round 26, so it never fired).
- Dashboard headline profit vs the sections beside it — they must agree.

---

## PR #361 (returns COGS) — parked on purpose

Six review rounds on one function, and **every finding was a way to reverse more cost than the
reports ever counted** — all of them inflating profit. It is now bounded on four axes from a single
lookup of the source sale line, and each return item becomes up to two credit-memo rows so a capped
total is exact rather than a rounded per-unit scaling.

It is parked because it is the one piece whose correctness could not be reasoned out from code
alone. Before applying, test against real data: a return on a partly invoiced order line; two
returns against the same line; a return whose sale invoice was voided; a return of a product that
was swapped after invoicing.

One known open finding on it: an eligible posted source line with `cost_cents = NULL` still
contributes its quantity to the cap while the cost falls back to the order snapshot, which
`get_bottom_line_pnl` never counted for that line.

---

## Deferred work, all recorded in `KNOWN_ISSUES.md`

1. **Server-side below-cost enforcement.** Every below-cost check that shipped is client-side and
   advisory — a direct RPC caller bypasses all of them. Seven RPCs need the cost validated and the
   reason written **in the same transaction as the money**. Four separate bugs during review
   (rounds 20, 26, 30, 32, 34) existed only because approval lives in the browser.
2. **`update_order_items` trusts a browser-sent cost** on a product swap. Same class as (1) — fix
   them together.
3. **Order headers recompute profit unrounded** (`after_order_items_change`), disagreeing with the
   reports by a cent on fractional lines. Pre-existing; the trigger fires on every `order_items`
   write, so it needs its own migration and a live before/after.
4. **The two invoice-basis reports disagree on which invoices count** — `get_bottom_line_pnl` counts
   `'posted'`, `get_monthly_summary` counts `'posted'`/`'overdue'`. This forced the returns reversal
   onto the conservative intersection.
5. **Per-unit cost columns cannot carry an exact extended cost.** Root cause of the drawn-booking
   cent difference and of the two-row split in #361. Fixing it means storing an extended cost per
   line — a schema change across orders, invoices and every rollup.

## Open question for Mason

Margin-target seeding across the ~600 SKUs was never answered. Recommendation: derive per-product
targets from historical selling prices rather than a flat company-wide number, since he said margins
vary product by product.

## Honest notes on the cloud session

- Roughly 41 Codex review rounds. Several times a fix was correct but the same defect sat on a
  sibling path that was not swept — rounds 37 and 39 were both repeats of an earlier class.
- Rounds 39 and 40 on the returns migration were caused by round 39's own approach, which is why the
  mechanism was replaced rather than patched again.
- Frequent pushes consumed most of the daily Vercel free-tier build allowance.
- State was announced before verification more than once (a "clean" review that wasn't, a push
  reported failed that had succeeded, a merge said to be blocked for 24h that was not). Verify
  claims in this file against the repo rather than trusting the narrative.
