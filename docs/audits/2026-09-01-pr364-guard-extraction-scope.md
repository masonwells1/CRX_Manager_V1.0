# PR #364 closed as superseded — scope for extracting the three protections `main` still lacks

Status: **PR #364 CLOSED 2026-09-01** (owner approval: Mason, in session, 2026-09-01).
Branch `claude/pr364-guard-commits-local-20260831` (tip `57d27e79105b62ee9887d59bdd1f2f58ed3c0e2d`) is **deliberately preserved**. Do not delete it — it is the only home for the three protections below.

This document is the scoping record. **Nothing here is approved to build.** It exists so the decision to build (or not) can be made later without re-deriving the analysis.

## Why #364 was closed

The migration it was named for had already shipped: `supabase/migrations/20260810025159_backfill_stale_line_profit.sql` is byte-identical on `main` and on the PR head (blob `f4f97722be903f431d1f4f30cebfe14c8d2ab3ca`), applied live 2026-08-09. The PR added zero migrations `main` lacked and was missing ten that `main` had.

Meanwhile `main` independently rebuilt the same guard file across four merged PRs — #483, #514, #502, #533 — and an independent `gpt-5.6-sol` high-effort review confirmed `main` is now **strictly stronger** than the PR branch on every protection the branch's three unmerged guard commits introduced. Those three commits (`2e23711c9`, `1692978f2`, `286a38d2a`) are superseded and need no port.

Full rationale, including the line-by-line comparison table, is in the closing comment on [PR #364](https://github.com/masonwells1/CRX_Manager_V1.0/pull/364#issuecomment-5498316505).

## The three real gaps

These are protections the branch has and current `main` does not. They were verified by two independent passes (this session's git/live inspection, and a `gpt-5.6-sol` high-effort review that was explicitly asked to refute them).

### 1. Apply-time one-shot replay enforcement

**Plain English:** some migrations are one-time data repairs. Running one a second time would re-edit rows that were already fixed. `main` keeps a registry of which migrations are one-time-only — but only *reads* it when printing a rebuild plan. Nothing stops an agent from actually applying one twice.

**What `main` does today:** `scripts/list-post-baseline-migrations.mjs` consults `one-shot-migrations.json` to decide what a replay plan prints, and warns. Plan-time only.

**What the branch adds:** enforcement at the live apply door, on first apply and repeat applies alike — plus detection of a *renamed or disguised* repeat, by comparing normalized bodies, individual write statements, and apply-time table/column effects, following invoked routines and treating unresolved or dynamic writes as unsafe.

**Also on the branch:** `scripts/write-one-shot-replay-override.mjs` — a deliberate one-time replay is authorized by an override bound to the registered migration, exact query hash, target project, a fresh canonical timestamp, and exactly one apply attempt, claimed under exclusive-create locking and consumed before the decision.

Note: the registry and the listing script are **byte-identical on both refs** (blobs `3287894098b8bc35a56007ad725bc0ec57ec540b` and `98ae7a978f65802554ac4b8232f116e7cf8331e6`). These two layers are complementary, not competing — plan-time quarantine and apply-time enforcement. Porting the override writer without its guard consumer would do nothing.

### 2. Fresh, project-bound live evidence

**Plain English:** the guard decides whether an apply is safe by looking at a snapshot of the live database. On `main` that snapshot can be up to 24 hours old, and it doesn't record *which* database it came from — so in principle a snapshot taken against one project could inform a decision about another.

**What `main` does today:** accepts a per-checkout JSON snapshot with a 24-hour freshness window, with no project binding.

**What the branch adds:** a fixed linked read on every apply, requiring the captured `project_id` to match the target and refusing ambiguous evidence. Supporting file: `scripts/supabase-linked-read.mjs` (425 lines).

### 3. Event-trigger and transitive fanout protection

**Plain English:** PostgreSQL "event triggers" fire automatically when the schema changes. `main`'s guard proves *where* a migration's SQL came from, but not *what it will set off* once it runs.

**What `main` does today:** nothing. Its only event-trigger references are an unrelated exclusion in a SQL predicate and comments.

**Live state (verified read-only 2026-09-01):** six enabled event triggers on production —

| Name | Event |
|---|---|
| `issue_graphql_placeholder` | `sql_drop` |
| `issue_pg_cron_access` | `ddl_command_end` |
| `issue_pg_graphql_access` | `ddl_command_end` |
| `issue_pg_net_access` | `ddl_command_end` |
| `pgrst_ddl_watch` | `ddl_command_end` |
| `pgrst_drop_watch` | `sql_drop` |

All six are Supabase platform catalog helpers. This matches the branch's manifest captured 2026-08-24, so that manifest is still accurate.

**What the branch adds:** three-way classification — event triggers with unproven write effects block all applies; session-dependent no-write helpers block DDL and procedural shapes but permit ordinary row DML; changes to an enabled event-trigger helper routine block independently, keyed on captured OIDs and body hashes. Commit `2e23711c9` broadened the DDL test to cover `IMPORT FOREIGN SCHEMA` and `SELECT … INTO`.

Beyond event triggers it also models transitive fanout: trigger writes, foreign-key effects, persisted rules, CHECK routines, stored views, custom operators, casts and domains, callable defaults, dynamic SQL, control conditions, and routine catalog changes.

## What it would cost

Roughly **8 core files, +9,250 / −1,100 lines** against current `main`. The bulk is `.claude/hooks/apply-time-dml-lib.mjs` (2,612 lines) — the apply-time DML analyzer the fanout and disguised-replay detection both depend on — plus `scripts/supabase-linked-read.mjs`, the integration inside the one-shot guard, the approved-set SQL validator and its tests, and the evidence freshness / project binding / attestation / OID-hash machinery.

This is **not** a small port. A much smaller "block all DDL whenever any event trigger exists" patch is possible, but that is a new, coarser design, not a faithful extraction — and it should be costed and decided on its own merits rather than presented as the same thing.

**Risk note.** This is the repo's most safety-critical code, and #364's own history (`docs/handoffs/2026-08-24-pr364-shutdown-continuation.md`, preserved on the branch) records repeated adversarial review rounds where *each* round found a new fail-open hole — optional-`INTO` `MERGE` bypass, trigger `WHEN` conditions calling mutating routines, unsupported procedural languages, `REFRESH MATERIALIZED VIEW`. Any extraction must budget for that gauntlet rather than assume one clean review pass. Per `AGENTS.md`, an exact-SHA `gpt-5.6-sol` high-effort proof is mandatory for this surface, and cannot be substituted by spark, luna, terra, or a Claude review.

## Suggested sequencing, if it is built

Three separable PRs, in this order — each independently reviewable, each leaving the guard in a valid state:

1. **Fresh project-bound live evidence** (smallest, no analyzer dependency; closes the stale/unbound-snapshot gap on its own).
2. **Apply-time one-shot enforcement**, using the registry `main` already has.
3. **Event-trigger and fanout protection**, which is where the analyzer weight lands.

Do not attempt them as one PR.

## What must NOT come across

- **The three guard commits** `2e23711c9`, `1692978f2`, `286a38d2a` — superseded; `main` is stronger. Re-applying them would be a regression.
- **The `patrol` system** (`scripts/patrol/`, `.claude/commands/patrol.md`, `.agents/skills/patrol/`) — deliberately removed from `main` in #512, "Simplify CRX harness first tranche". It survives on the branch only because the branch predates that removal.
- **`docs/handoffs/2026-08-24-pr364-shutdown-continuation.md`** — historical record; leave it on the branch.

## Provenance

- Two independent passes agreed on closing #364: this session's git and live-database inspection, and a `gpt-5.6-sol` high-effort read-only review run via `codex exec` and explicitly prompted to refute rather than confirm.
- The Sol review returned `MIXED`: it confirmed the close, and corrected an earlier claim in this session that event-trigger handling was the branch's *only* surviving value. Gaps 1 and 2 above exist because of that correction.
- The Sol review could not verify live database state from its read-only sandbox. The six event triggers were confirmed separately here via read-only Supabase queries on 2026-09-01.
- No push, merge, migration, or data mutation was performed in reaching this decision.
