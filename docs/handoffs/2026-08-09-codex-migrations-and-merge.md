# Handoff — Codex takes over: apply five migrations, then merge PR #354

**From:** Claude (cloud session, no Codex CLI, no local machine)
**To:** Codex, running locally with Mason present
**Date:** 2026-08-09
**Branch:** `claude/phone-to-local-sessions-dmqc57` @ `01e2f50d`
**PR:** https://github.com/masonwells1/CRX_Manager_V1.0/pull/354

## What you are taking over and why

Two things could not be finished from the cloud session:

1. **The five migrations cannot be applied here.** Money/RLS diffs require a fresh
   exact-SHA `gpt-5.6-sol` high-effort adversarial proof. The Codex CLI is not
   installed in that container, so the gate is unrunnable, not merely unrun.
2. **No database backup exists.** Supabase Free has no point-in-time recovery and
   there is no off-site dump. `/backup-db` needs a local session.

Everything else on #354 is done: three review rounds addressed, Vercel green,
merge conflict resolved, full pre-commit gate passing on every commit.

## Order of operations — do not reorder

### Step 0 — Back up the database FIRST

```
/backup-db
```

Nothing below touches production until this succeeds. Five migrations are about
to change live money-adjacent behavior with no recovery path if one goes wrong.
If the backup fails, **stop and tell Mason** — do not proceed on the theory that
the migrations look safe.

### Step 1 — Run the adversarial gate

```
/codex-review            # or /codex-gauntlet for the full loop
```

Pin `gpt-5.6-sol`, high reasoning effort, against the **exact SHA** on the branch
(`01e2f50d` unless you have pushed further). This is the hard gate for the
money/RLS diffs — it is separate from CodeRabbit, which is the broad every-PR
pass and does not replace it.

### Step 2 — Apply the five migrations, in this order

The ordering matters: `170000` builds on `150400` and must apply after it.

| Order | File | What it does |
|---|---|---|
| 1 | `20260808150100_restore_batch_apply_prepayments_actor_guard.sql` | Restores an actor guard that an out-of-order replay reverted |
| 2 | `20260808150200_cancel_order_zeroes_quantity_remaining.sql` | Cancelling an order releases reserved stock |
| 3 | `20260808150300_revoke_inventory_truncate_and_mark_payments_dead.sql` | Revokes TRUNCATE on inventory; marks a dead payments path |
| 4 | `20260808150400_round_money_to_whole_cents.sql` | Rounds stored money to whole cents |
| 5 | `20260808170000_round_line_profit_with_revenue.sql` | Rounds `order_items.profit` alongside `total_price` |

Per-migration procedure:

1. `/migration-review <file>` before each apply.
2. Apply via the Supabase MCP `apply_migration` against `rhyzpcqhnizqbxphqdkr`.
3. **Get Mason's in-chat OK for each one.** This is an interactive session, not an
   armed hands-free run, so the 2026-07-13 autopilot exception does **not** apply.
4. After each apply, recapture the ledger snapshot — the invalidate hook deletes
   it on every apply, and the next apply blocks until it is refreshed:
   ```sql
   select version, name from supabase_migrations.schema_migrations order by version;
   ```
   ```
   node scripts/refresh-applied-migrations.mjs < rows.json
   ```
5. If any migration adds a status enum, generated column, or table, run
   `/regen-schema-registry` — the `REGISTRY-STALE.flag` will tell you.

### Step 3 — Merge PR #354

Read CodeRabbit's review of the head SHA and fix anything real (nitpicks may be
dismissed with a one-line reason). Confirm Vercel is green. Then merge — that
merge deploys production. Vercel one-click rollback is the safety net.

`main` is protected; there is no direct-push path for anyone.

## Explicitly NOT authorized — needs a separate ask

- **The 49 fractional-cent rows**, including a **$5,245.195 pending payout**. The
  repair statement is deliberately commented out inside `20260808150400`. Running
  it restates live money and is its own decision. Do not uncomment it as part of
  applying that migration.

## Two open questions for Mason

1. **Header-vs-lines penny drift.** `trg_recalc_order_totals` derives
   `orders.total_profit` independently — `ROUND(SUM(total_price) − SUM(cost_per_unit
   × total_units_needed), 2)` — and never reads `order_items.profit`. The cost side
   is never rounded per line. So `20260808170000` narrows the drift but cannot
   close it. Closing it means changing where the header derives from, which moves
   live money on the order header. Mason's call; filed as an OPEN entry in
   `docs/manual/KNOWN_ISSUES.md`.
2. **Ordering-guard concurrent-checkout gap.** The guard reads a file snapshot, so
   two checkouts applying migrations concurrently can each hold a stale view. The
   real fix is querying the live ledger from the hook, which needs DB access in a
   hook. Also filed as OPEN.

## State you can trust

- Tests at last run: `migration-apply-guard` 81, `migration-ordering-lib` 18,
  `refresh-applied-migrations` 9, `agent-manifest-parity` 18 — all passing.
- Full pre-commit gate green on every commit in this branch.
- The pre-commit gate is slow — give it a **540s+ timeout** or it dies mid-build.
- `mergeable_state` was `blocked` (checks pending), not `dirty`. The merge conflict
  CodeRabbit flagged was resolved in `773d57bc`; that suggestion is stale.
