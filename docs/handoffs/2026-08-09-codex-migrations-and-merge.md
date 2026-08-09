# Handoff — Codex takes over: apply five migrations, then merge PR #354

**From:** Claude (cloud session, no Codex CLI, no local machine)
**To:** Codex, running locally with Mason present
**Date:** 2026-08-09
**Branch:** `claude/phone-to-local-sessions-dmqc57` @ `01e2f50d`
**PR:** https://github.com/masonwells1/CRX_Manager_V1.0/pull/354

---

## STATUS UPDATE — 2026-08-09, local session (read this first)

A local Claude session picked this up. What actually happened, and where this
plan was wrong:

- **Step 0 (backup) — DONE.** `backups/2026-08-09/`: 156 tables, 9,927 rows,
  27.7 MB, manifest written, `backups/LATEST-OK.json` stamped. Row counts were
  verified table-by-table against live counts (OK 156 / MISMATCH 0 / MISSING 0),
  and full numeric precision survives in the raw text.
- **Step 1 (Codex adversarial gate) — RAN, and it returned BLOCKING** with three
  P1 findings against this very document. All three were independently verified
  as real:
  1. The head SHA in this handoff was already stale.
  2. Step 2's snapshot-refresh command was wrong (the wrapper owns the proof, and
     `write-codex-push-proof.mjs` — not a hand-run `codex exec` — is the only
     sanctioned producer of the push proof).
  3. Mason's per-migration OK was sequenced **after** the apply, not before.
  4. (P2) All five migrations sat **below** the live applied high-water.
- **The ordering block was genuine.** Live ledger row
  `20260809130108_team_note_completion_rpc_and_assignment_notify` applied at
  13:01 UTC on 2026-08-09 from a concurrent session — and it has **no file
  anywhere in this repository**. That lifted the high-water above all five
  `20260808*` files, and `.claude/hooks/migration-ordering-lib.mjs` correctly
  refused them. The loophole was probed and closed: `migration-apply-guard.mjs`
  deliberately re-attaches `<version>_<name>`, so the block cannot be dodged by
  a name-mapping gap, and it was **not** dodged with a stale snapshot or the
  `intentional-replay` marker (these are first-time applies, not replays).
- **Remedy applied (Mason approved in chat):** all five were re-issued forward
  with `git mv` to `20260809170500`–`20260809170900`, relative order preserved,
  executable SQL byte-identical, provenance header added, stale `20260808*`
  files removed in the same commit. Same remedy as `migration-history.md`
  row 808 → live row 811. They are indexed as history rows 857–861.
- **Every migration premise was re-verified against live** rather than taken on
  trust: the actor guard is genuinely missing, `authenticated` genuinely holds
  TRUNCATE on `inventory`, `payments` genuinely holds zero rows, the rounding
  function/triggers genuinely do not exist, `cancel_order` genuinely leaves
  `quantity_remaining` stranded, and `_cancel_order_impl_20260714` exists. Both
  `CREATE OR REPLACE` migrations reproduce the current live bodies, so there is
  no clobber risk.
- **All 27 live invariant predicates ran:** 26 CLEAN, 1 violation —
  `fin-money-whole-cents` at exactly 49 rows (3 `commissions` + 46
  `order_items`), which is the documented, deliberately-unrepaired set below.
- **Still outstanding:** the live apply of the five, then step 3 (merge #354).

---

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

The ordering matters: file 5 re-emits the function and trigger that file 4
creates, so it must apply after it.

**Filenames updated 2026-08-09** — see the status block at the top. The SQL is
byte-identical to the reviewed originals; only the timestamps moved forward.

| Order | File | What it does |
|---|---|---|
| 1 | `20260809170500_restore_batch_apply_prepayments_actor_guard.sql` | Restores an actor guard that an out-of-order replay reverted |
| 2 | `20260809170600_cancel_order_zeroes_quantity_remaining.sql` | Zeroes stranded `quantity_remaining` on full cancel (stock release already worked) |
| 3 | `20260809170700_revoke_inventory_truncate_and_mark_payments_dead.sql` | Revokes TRUNCATE on inventory; marks a dead payments path |
| 4 | `20260809170800_round_money_to_whole_cents.sql` | Rounds stored money to whole cents |
| 5 | `20260809170900_round_line_profit_with_revenue.sql` | Rounds `order_items.profit` alongside `total_price` |

Per-migration procedure:

1. `/migration-review <file>` before each apply.
2. **Get Mason's in-chat OK BEFORE the apply, not after.** This is an interactive
   session, not an armed hands-free run, so the 2026-07-13 autopilot exception
   does **not** apply. (Corrected 2026-08-09 — this document originally had the
   approval step sequenced after the apply.)
3. Apply via the Supabase MCP `apply_migration` against `rhyzpcqhnizqbxphqdkr`.
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
  repair statement is deliberately commented out inside `20260809170800`. Running
  it restates live money and is its own decision. Do not uncomment it as part of
  applying that migration.

## Two open questions for Mason

1. **Header-vs-lines penny drift.** `trg_recalc_order_totals` derives
   `orders.total_profit` independently — `ROUND(SUM(total_price) − SUM(cost_per_unit
   × total_units_needed), 2)` — and never reads `order_items.profit`. The cost side
   is never rounded per line. So `20260809170900` narrows the drift but cannot
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
