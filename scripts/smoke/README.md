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
| `run-smoke.mjs` | Zero-dep runner. `--list`, `--spec <rpc>`, `--all`. |
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

## Phase 2 per-line split calculator proof

The Phase 2 calculator has its own disposable PostgreSQL 17 proof:

```bash
node scripts/smoke/prove-per-line-split-billing-phase2.mjs --diagnose-blocked-phase1
```

It creates a uniquely named `crx-per-line-p2-proof-*` container with no network,
stores PostgreSQL data in tmpfs, loads the minimal schema plus the checked-in
Phase 1 and Phase 2 migrations, runs `smoke-per-line-split-billing-phase2.sql`,
requires the terminal `SMOKE_PASS_ROLLBACK` marker, and force-removes the exact
container in `finally`.

The proof covers feature-OFF legacy delegation; exact 50/50 and three-way
micro-percent vectors; 1¢ and signed half-cent allocation; full-precision unit
conversion with only the final money figure rounded; manual/quote/tier/service
price precedence; per-person price overrides; 100/0 service and flat-fee rows;
job/default/fallback ownership; hashes; Mode A and malformed-vector rejection;
role denial; overload count; and private-calculator privileges.

Current prerequisite blocker: Phase 1 migration `20260718120000` contains an
invalid concatenated `COMMENT ON COLUMN` statement. The default command (without
`--diagnose-blocked-phase1`) fails hard and refuses to print a green proof while
that checked-in migration is invalid. The explicit diagnostic mode recognizes and
normalizes only that exact comment in memory, labels its evidence `DIAGNOSTIC`
rather than `PROOF`, and leaves the checked-in migration untouched. A passing
diagnostic does not make Phase 1 applyable or authorize any live apply.

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
