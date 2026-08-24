# Rolled-Back E2E Smoke Chains (C2 control, minimal slice)

## The hard rule

> **A fix is "fixed" only when its full business-chain spec passes — never an
> isolated probe.**

This directory exists because of 2026-06-09's B1: `issue_return_credit` was
declared "fixed" off a single invoice-insert probe, while the *chain*
(return → credit → statement → unapply) was still broken three more ways
(missing `returns.credited_by` column, a CHECK rejection, a 42804 cast).
8 of the 52 historical Codex findings were latent breaks in never-exercised
RPC paths that only a full chain execution surfaces
(`docs/audits/2026-06-10-error-prevention-review.md` §2 RC3, §4 C2).

Corollaries:

- **Every migration-touched RPC must have (or extend) a spec** in
  `smoke-specs.json` whose `covers` includes it, and that chain must PASS
  after apply, before the work is called done.
- An isolated statement probe ("the insert works now") is **never** evidence
  of a fix. It may be a *step* inside a chain; it is not a spec.
- New authenticated SECURITY DEFINER mutators also get the standard 4-probe
  auth set — copy `smoke-auth-probe-template.sql`.

## What lives here

| File | Role |
|------|------|
| `smoke-specs.json` | Registry: primary RPC → `{ chain, description, covers }`. `covers` lists every RPC the chain exercises, so one chain certifies several RPCs. |
| `run-smoke.mjs` | Zero-dep runner. `--list`, `--spec <rpc>`, `--area <area>` (business-area tags; see `scripts/test-areas.json` and `scripts/run-area.mjs`), `--all`. |
| `smoke-*.sql` | The chains. Each is ONE `DO` block that always ends in `RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'` — nothing ever commits. |

## Running

```bash
node scripts/smoke/run-smoke.mjs --list           # what specs exist
node scripts/smoke/run-smoke.mjs --spec receive_return   # matches keys OR covers
node scripts/smoke/run-smoke.mjs --all
```

Two modes:

1. **Claude-first (default).** Without `SUPABASE_DB_URL`, the runner prints
   each selected chain with banners and instructions. Claude executes the SQL
   as **one statement** via Supabase MCP `execute_sql` (project
   `rhyzpcqhnizqbxphqdkr`) and interprets the result.
2. **psql.** With `SUPABASE_DB_URL` set, the runner executes each chain via
   `psql -1 -f` and reports PASS/FAIL itself.

**Result contract (both modes):** the chain ALWAYS errors.

- Error text contains `SMOKE_PASS_ROLLBACK` → **PASS** (and proves the
  rollback fired — nothing persisted).
- Any other error, or no error at all → **FAIL**; report the message verbatim.

The full-gauntlet chain also proves the versioned `save_blend_ticket` contract:
normal save, exact idempotent replay, required-version rejection, OCR-processing
rejection, and stale-edit rejection both before and after an OCR commit.

## Disposable concurrency companion

Single-transaction smoke chains cannot create real lock contention. The
gauntlet migrations therefore have a separate two-session proof:

```bash
node scripts/smoke/prove-gauntlet-idempotency-concurrency.mjs
```

It loads the checked-in `check_idempotency`, inline-insert trigger, and linked
blend-ticket header/product lock definitions verbatim into a uniquely named
`crx-gauntlet-idem-proof-*` PostgreSQL container. The container has no network,
stores PostgreSQL data in tmpfs, never reads a DB URL, and is force-removed in
`finally` after success or failure. The proof races both the canonical helper
path and a legacy business-work-before-inline-ledger path, requiring one effect,
one ledger row, exact replay for the helper caller, and
`IDEMPOTENCY_CONCURRENT_REPLAY_RETRY` plus full effect rollback for the legacy
loser. It also races link-first and product-first transactions to prove the
parent-row lock serializes edits and rejects a product edit that loses to a link.
The same disposable database loads the checked-in atomic OCR commit function
and proves three real two-session losers roll back cleanly: approval-first,
link-first, and lease-change-first.

## Disposable Supplier Pricing Phase 1a proof

The live additive bootstrap, live pre-deploy zero-cost guard, and parked
enforcement cutover have a separate, production-isolated proof:

```bash
node scripts/smoke/prove-supplier-pricing-phase1a.mjs
```

The runner creates a uniquely named PostgreSQL 17 container with networking
disabled and data in tmpfs, loads a live-shaped minimal base, compiles the exact
live additive bootstrap, proves the currently deployed editor can still write
one legacy Product/history pair without double logging, compiles and exercises
the exact compatibility-safe zero-cost guard, then compiles the exact parked
cutover. It generates and edits a real `.xlsx`, parses it through the
application workbook module, and passes that payload through real PostgreSQL
preview/apply RPCs with exact Product/history verification and rollback. The
final-state proof also exercises authorization, both pricing modes, formula/tamper/
version/collision-safe identity conflicts, atomic rollback, durable idempotent
replay and cross-change-set key rejection, direct-write denial, and exactly-once
history. It also proves an ordinary rate edit can recalculate server-derived
per-acre prices while a caller still cannot write those derived values directly.
The runner force-removes the exact container in `finally`; it never
reads a Supabase URL and does not apply or alter production.

## Disposable draw-down and priced-product smoke proof

The pending draw-down price-tier migration and the quote smoke fixtures that
depend on governed product pricing share one current-schema replay:

```bash
node scripts/smoke/prove-draw-down-price-tier-real-schema.mjs
```

The runner restores the supported baseline and replays all 56 migrations in the
verified live source history. SQL copied into the container is normalized to LF
so a Windows checkout cannot manufacture false function-body drift; any skipped
migration fails closed. Before applying the parked draw-down migration, it requires
five pricing-sensitive chains to reach `SMOKE_PASS_ROLLBACK`: the auth probe,
planned-holds synchronization, draw-ledger reversal, order draw lock, and job
from quote activity-feed chain. It then mutation-tests the candidate-specific
restore guard, applies the candidate only inside the disposable container, and
requires the repaired restore chain to pass. The schema-only database is seeded
with two governed-looking priced products while the pricing trigger is disabled
for that seed alone; the trigger is restored before any chain executes. The
container has no network, never reads a Supabase URL, and is force-removed in
`finally`.

Safety notes:

- Chains run as table owner; direct fixture INSERTs bypass RLS but the RPCs
  under test still enforce their own gates (auth is simulated via
  transaction-local `request.jwt.claims` with a REAL active profile id).
- Benign side effects that survive rollback: sequence consumption (e.g.
  `cm_invoice_number_seq` in the return chain — `next_invoice_number`
  self-heals), and brief row locks. `smoke-auto-expire-draw-skip.sql` also
  transiently locks/expires real expired quotes inside its rolled-back
  transaction — run off-hours if cautious (see its header).

## Adding a chain when shipping a migration

For every RPC the migration creates or modifies:

1. **Check coverage:** `node scripts/smoke/run-smoke.mjs --spec <rpc>`.
   If a spec covers it, *extend that chain* with assertions for the new
   behavior. If not, write a new `smoke-<short-name>.sql`.
2. **Investigate live first, then write.** Read the LIVE function body
   (`pg_get_functiondef`), the fixture tables' columns
   (`information_schema.columns`), CHECK constraints (`pg_constraint`), and
   triggers (`pg_trigger`) via read-only MCP `execute_sql`. **Dry-validate
   every table/column/function reference against the live catalog before
   declaring the smoke ready** — this is the discipline that prevents the
   42703 (column-does-not-exist) class. Never write fixture SQL from memory
   or from disk migration files.
3. **Follow the house conventions** (see any existing `smoke-*.sql`):
   - single `DO` block = single transaction; terminal
     `RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'`;
   - synthetic `[SMOKE]`-prefixed fixtures with a random suffix; reference
     real rows only as FK targets (e.g. an active admin profile);
   - auth via `set_config('request.jwt.claims', json_build_object('sub',
     v_real_profile_id, 'role', 'authenticated')::text, true)` — set claims
     at the top level, not inside probe sub-blocks (local GUCs roll back with
     sub-transactions);
   - expected-failure steps wrapped in `BEGIN ... EXCEPTION` sub-blocks,
     matching error tokens with `SQLERRM LIKE 'TOKEN%'`;
   - every failure message prefixed `SMOKE_FAIL:` (setup gaps:
     `SMOKE_SETUP:`) with the actual values interpolated;
   - cover the FULL business chain, including the reversal/unapply leg and an
     idempotency replay where the RPC takes a key;
   - if a step is impossible synthetically (e.g. requires storage objects),
     say so honestly in the header and cover the longest possible prefix.
4. **Register it** in `smoke-specs.json`: key = primary RPC, `covers` = every
   RPC exercised, description = what the chain proves.
5. **Run it** (post-apply, rolled back) and require `SMOKE_PASS_ROLLBACK`
   before claiming the fix/feature works.

For the `save_field` actor-binding migration, the exact migration and rollback
chain can be proven without contacting Supabase:

```bash
node scripts/smoke/prove-save-field-actor-binding.mjs
```

For new mutators, also adapt `smoke-auth-probe-template.sql` (placeholders
documented in its header): no-auth → `AUTH_REQUIRED`, anon-key →
`AUTH_REQUIRED` + zero rows written, wrong-role → `INSUFFICIENT_ROLE`, forged
actor param → `ACTOR_MISMATCH`, plus a positive control proving the probes
failed for the right reason.

## How /ship should invoke this (wiring — reported, not yet wired)

This slice deliberately does not edit `package.json`, hooks, or
`.claude/commands/ship.md`. Suggested wiring:

- **npm script** (`package.json` → `scripts`):
  `"smoke": "node scripts/smoke/run-smoke.mjs"`
  (usage: `npm run smoke -- --spec <rpc>`).
- **/ship step (after `apply_migration` + B7 rename, before commit):** for
  every RPC named in the migration, run
  `node scripts/smoke/run-smoke.mjs --spec <rpc>`.
  - Runner exits 2 with "no spec covers" → write/extend a chain first
    (step list above) — this is a gate, not a suggestion.
  - Claude executes the printed chain(s) via MCP `execute_sql` and applies
    the PASS contract; any non-`SMOKE_PASS_ROLLBACK` error blocks the ship
    until fixed (then re-run the FULL chain — not just the failing step).
- **Codex handoff packets:** include the chain results (spec key + PASS) so
  round 1 starts from executed evidence instead of isolated-probe claims.
- Optional later hardening: a Stop/PreToolUse hook that refuses "fixed"
  claims for migration-touched RPCs without a fresh chain PASS marker —
  out of scope for this slice.
