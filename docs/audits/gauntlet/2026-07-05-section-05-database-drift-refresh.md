# CRX Live Foundation Gauntlet - Section 5 Database Drift Refresh

Date: 2026-07-05
Mode: Read-only audit of current repo code plus live Supabase database structure
Section: 5 - Database drift: migrations on disk vs schema registry vs live database catalog, CHECK constraints, overloads, generated columns, search_path

## Verdict

Production risk is HIGH for this checkout as an audit/build base: the current branch is stale relative to both `origin/main` and the live Supabase migration catalog. The live database has applied migration versions from 2026-07-04, while this checkout's migration folder stops at 2026-07-02 and its schema registry stops at 2026-07-01. Do not make schema-aware fixes from this branch until the repo is refreshed to current `main` and the schema registry is regenerated from live.

## Scope And Method

- Started with `git status --short --branch`; pre-existing uncommitted file: `.claude/schema-registry.json`.
- Read `CLAUDE.md`, `AGENTS.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/reference/gotchas.md`, `docs/workflows/CODEX_REVIEW_GAUNTLET.md`, `.claude/commands/review-workflow.md`, `.claude/skills/codex-review/SKILL.md`, `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, `docs/reference/agent-guardrails.md`, `docs/reference/database-schema.md`, `docs/reference/migration-history.md`, and `docs/reference/rpc-functions.md`.
- Inspected local migration files, local schema registry metadata, current branch relation to local `origin/main`, and live Supabase `schema_migrations` / `pg_proc` structure through read-only `supabase db query --linked` SELECTs.
- Did not inspect Sentry, Vercel, GitHub PRs, browser sessions, or production runtime telemetry.
- Did not edit app/source code, apply migrations, mutate data, commit, push, deploy, or delete anything.

## Counts

| Severity | Count |
|---|---:|
| BLOCKER | 0 |
| HIGH | 1 |
| MED | 1 |
| LOW | 0 |

## Findings

### HIGH - Current checkout is behind live database structure and `origin/main`

Evidence:

- `git rev-list --left-right --count origin/main...HEAD` returned `95 0`, meaning this branch is 95 commits behind local `origin/main` and has no commits ahead.
- Current checkout has 584 migration files; `node` inspection of `supabase/migrations` found latest disk file `20260702120000_inventory_job_demand_visibility.sql`.
- Local `origin/main` has 38 migration files not present in this checkout, including `supabase/migrations/20260704120000_a5_blend_ticket_unit_conversion.sql`, `supabase/migrations/20260704130000_p2_8_vendor_master_consolidation.sql`, and `supabase/migrations/20260704140000_a9_month_end_seed_periods.sql`.
- Live Supabase query succeeded before auth throttling:
  `select version from supabase_migrations.schema_migrations order by version desc limit 15;`
  It returned newest live versions including `20260704161532`, `20260704160103`, and `20260704155555`, all newer than this checkout's latest migration file.
- `git grep` on local `origin/main` shows the live-backed registry/documentation has moved on: `origin/main:.claude/schema-registry.json:9` has `"migrations_high_water": "20260704161532"`, and `origin/main:docs/reference/migration-history.md:988` documents live v`20260704161532` for the blend-ticket unit conversion migration.

Business risk:

An agent working from this checkout can audit or change the wrong database shape. That is especially dangerous for Section 5 because CHECK constraints, generated columns, function overloads, and SECURITY DEFINER grants are exactly the facts schema-aware hooks need to be current. The live database may already contain protections or behavior that this branch cannot see.

Suggested fix:

Refresh this worktree to current `main` or rerun the gauntlet from a current branch before doing any schema-aware work. After refresh, re-run Section 5 so the repo, schema registry, migration history, and live catalog are all compared from the same baseline.

Prevention action:

Add a gauntlet preflight guard that stops Section 5 when `HEAD` is behind `origin/main` or when live `max(schema_migrations.version)` is greater than the latest local migration prefix. The guard should print the exact behind count and newest missing live version before any findings are written.

### MED - Local schema registry is still behind migrations present in this checkout

Evidence:

- `.claude/schema-registry.json:9` has `"migrations_high_water": "20260701205341"`.
- Local migration inspection found six newer migration files already present in this checkout:
  - `20260701210000_notification_lifecycle_gate_before_idempotency.sql`
  - `20260701211000_receive_po_lock_parent.sql`
  - `20260701212000_revoke_anon_on_new_secdef_fns.sql`
  - `20260701213000_rls_initplan_and_fk_indexes.sql`
  - `20260701214000_get_fields_geojson_by_ids.sql`
  - `20260702120000_inventory_job_demand_visibility.sql`
- `git diff -- .claude/schema-registry.json` shows the pre-existing uncommitted change only moved `_meta.migrations_high_water` from `20260701002103` to `20260701205341`; it did not regenerate the rest of the registry from the newer live schema.
- The session staleness hook independently warned that schema-aware hooks were validating against a stale registry if those newer migrations had been applied live.

Business risk:

The schema-aware hooks can miss current generated columns, status CHECK values, table column lists, or no-`updated_at` tables. That can let an agent write a migration or RPC that passes local hook checks but is wrong for the live database.

Suggested fix:

After refreshing to current `main`, regenerate `.claude/schema-registry.json` from live Supabase with the normal `/regen-schema-registry` flow. Do not hand-edit only the high-water value.

Prevention action:

Add a deterministic check that compares the newest migration file prefix to `_meta.migrations_high_water` and fails schema-aware review when the registry trails disk migrations. The existing session warning is useful, but Section 5 should treat it as a hard audit gate.

## Verified Safe / Clean Evidence

- Live query succeeded for SECURITY DEFINER search path coverage:
  `select count(*) as secdef_missing_search_path ...`
  returned `secdef_missing_search_path = 0` for public SECURITY DEFINER functions.
- The six current-checkout migrations newer than the registry include explicit grant/search-path patterns where applicable:
  - `20260701210000_notification_lifecycle_gate_before_idempotency.sql` sets `search_path = public, pg_temp` and revokes anon/PUBLIC grants for both notification RPCs.
  - `20260701211000_receive_po_lock_parent.sql` preserves `receive_po_items` `SET search_path TO 'public', 'pg_temp'` and locks `FOR UPDATE OF poi, po`.
  - `20260701214000_get_fields_geojson_by_ids.sql` uses `SET search_path TO 'public', 'extensions', 'pg_temp'` and revokes anon/PUBLIC execute.
  - `20260702120000_inventory_job_demand_visibility.sql` uses `SET search_path TO 'public', 'pg_temp'` and revokes anon/PUBLIC execute.

## Visibility Limits

After the first live migration sample and the SECURITY DEFINER search-path query, parallel `supabase db query --linked` attempts triggered the linked CLI auth circuit breaker:

`FATAL: (ECIRCUITBREAKER) too many authentication failures` and `Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD`.

Because of that, this run did not prove live overload counts, live CHECK constraint parity, or live generated-column parity. I cut any finding that would have depended on those uncompleted live queries.

## Next Section Queued

Section 6 - Idempotency and double-submit safety for mutating RPCs and frontend callers.
