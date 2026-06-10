# db-invariant-sweeps (C1 control)

Standing, read-only **database-invariant sweeps** that run the "definitive predicates" against the
**live** Supabase catalog and fail if any one returns a violation that isn't justified in the
allowlist.

## Why this exists

Per `docs/audits/2026-06-10-error-prevention-review.md` (§2 RC1/RC2, §4 C1): **no deterministic gate
ever looks at the live database.** Every local SQL check (`validate-sql.sh`, the PreToolUse hooks) is
regex over *migration files* — but the finding classes that keep coming back from Codex
(anon/authenticated-executable SECURITY DEFINER mutators, forgeable `p_performed_by` authorization,
ungated-but-auth-bound mutators, stale overloads, missing `search_path`, status-literal latent breaks)
live in `pg_proc` / `proacl` / `pg_constraint` on the **live** catalog. EXECUTE grants are auto-issued
on `CREATE FUNCTION` and are invisible in migration files. Every sweep escape in the history was
findable by one catalog query — but that query only ever ran *after* Codex pushed back.

This runner makes those queries **standing executable gates** that run **before** the handoff.

## What it is

- `run-sweeps.mjs` — a zero-dependency Node runner. It **discovers** `predicates/*.sql` dynamically
  (other teams/agents can drop a new `.sql` file in and it's picked up automatically), runs each one
  read-only, subtracts `allowlist.json`, and exits non-zero on any unallowlisted violation.
- `predicates/*.sql` — one file per invariant class. Each returns **rows = violations** and must output
  a stable **`violation_key`** column (a function identity like `fn_name(arg types)`).
- `allowlist.json` — per-predicate exemptions, each with a dated justification.

### Predicates shipped

| File | Class | Expectation |
|---|---|---|
| `anon-exec-secdef.sql` | (a) every anon-executable SECDEF | only the documented RLS-helper / trigger / sequence / self-gating-report set (allowlist) |
| `ungated-secdef-mutators.sql` | (b) authenticated SECDEF that mutates and references no auth.uid()/role helper | **zero** (the round-2 definitive predicate, standing) |
| `actor-forgery.sql` | (c) actor-param role-check/COALESCE without ACTOR_MISMATCH | over-broad by design; allowlist semantic-safe |
| `auth-bound-role-ungated.sql` | (d) auth.uid()-bound mutator with no role check (the `create_direct_order` W1 variant) | **zero** |
| `secdef-searchpath.sql` | (e) SECDEF missing `search_path` | **zero** (no allowlist case) |
| `overloads.sql` | (f) public proname with >1 signature | **zero** (no allowlist case) |
| `status-literals.sql` | (g) function writes a literal outside a column's CHECK set | **zero** (regex approximation — see file header for FP/FN modes) |
| `plpgsql-check.sql` | (h) 42703/42804/missing-relation static analysis | **no-op today** — `plpgsql_check` is available but **NOT installed** on this project |

## When it runs

1. **Post-apply in `/ship`** — right after a reviewed migration is applied live, before the commit.
2. **Before EVERY Codex handoff** — so round 1 starts from a clean live catalog instead of Codex
   rediscovering a deterministic class.
3. **Weekly** — drift check against accumulated live state.

## How to run it

Two modes, auto-selected:

- **Claude mode (default / practical).** With no `SUPABASE_DB_URL`+`psql`, the runner prints each
  predicate's SQL inside a bannered block. The practical caller is **Claude Code via the Supabase MCP**:
  run each block read-only with `mcp__…__execute_sql` (project `rhyzpcqhnizqbxphqdkr`), paste the JSON
  rows back, and compare each returned `violation_key` against the allowlist for that predicate. Any
  key **not** allowlisted is a real finding.

  ```
  node scripts/db-invariant-sweeps/run-sweeps.mjs
  ```

- **psql / CI mode.** If `SUPABASE_DB_URL` is set and `psql` is on PATH, the runner executes each
  predicate itself and exits non-zero on any unallowlisted violation.

  ```
  SUPABASE_DB_URL='postgresql://…' node scripts/db-invariant-sweeps/run-sweeps.mjs
  SUPABASE_DB_URL='postgresql://…' node scripts/db-invariant-sweeps/run-sweeps.mjs --json
  ```

Other modes:

```
node scripts/db-invariant-sweeps/run-sweeps.mjs --list                 # predicates + allowlist counts
node scripts/db-invariant-sweeps/run-sweeps.mjs --explain <predicate>  # header + SQL + allowlist entries
```

> **Read-only, always.** Predicates are `SELECT`-only and the runner refuses to execute a file that
> contains a write/DDL statement (defense-in-depth). NEVER run DDL/DML against the live DB from here.

## How to add a predicate

1. Drop a new `predicates/<class>.sql` file. It is discovered automatically — no runner edit needed.
2. Start with a `--` header comment block that names: the invariant, **which historical findings it
   would have caught** (cite ids/dates from `docs/audits/2026-06-10-error-prevention-review.md`), the
   expectation (zero rows / allowlist), and any approximation/false-positive modes.
3. The query MUST be read-only and MUST output a `violation_key` column (a stable identity — function
   identity strings are the convention so the allowlist key survives across runs).
4. Run `--explain <class>` to eyeball it, then run it live via MCP. Seed `allowlist.json` for anything
   it legitimately flags today (with a justification), and **report — do not allowlist — any real hole.**

## Allowlist discipline (non-negotiable)

`allowlist.json` is `{ "entries": [ { predicate, violation_key, justification, dated } ] }`.

- Every entry needs a **dated** justification that **cites the live `pg_get_functiondef` semantics**
  proving the flag is not a real hole (e.g. "self-gates on auth.uid()", "trigger fn — anon EXECUTE
  inert", "attribution-only param, authorizes off auth.uid() — allocate_payment precedent").
- **NEVER allowlist a genuine escalation or data leak.** If a predicate flags a function with no real
  gate, fix it (a `CREATE OR REPLACE` migration through the review gate, or a `REVOKE`) or report it as
  a finding. Allowlisting a real hole defeats the entire control.
- **Re-verify** an entry whenever the underlying function is next edited — a body change can turn a
  safe disposition into a live hole while the allowlist still says "safe."
- The allowlist is itself a Codex artifact: hand Codex the allowlist **diff** to attack (per §5 of the
  review) — adjudicating exemptions is exactly what a second model is good at.

## Seeded state (2026-06-10, first live validation)

| Predicate | Flagged live | Allowlisted | Real findings |
|---|---|---|---|
| anon-exec-secdef | 53 | 53 | 0 |
| ungated-secdef-mutators | 2 | 2 | 0 |
| actor-forgery | 4 | 4 | 0 |
| auth-bound-role-ungated | 1 | 0 | **1** → `generate_rup_sales_records` (see below) |
| secdef-searchpath | 0 | 0 | 0 |
| overloads | 0 | 0 | 0 |
| status-literals | 0 | 0 | 0 |
| plpgsql-check | n/a (extension not installed) | — | — |

**Open real finding (auth-bound-role-ungated):** `generate_rup_sales_records(p_invoice_id uuid,
p_idempotency_key text)` is an `authenticated`-EXECUTE-able SECDEF that inserts `rup_sales_records`,
binds `auth.uid()` for `created_by`, but has **no role gate**. Its only legitimate caller is
`post_invoice` (which is itself gated), and there is **no UI/Edge callsite** (grep: only test files
reference it). Recommended fix: `REVOKE EXECUTE ON FUNCTION generate_rup_sales_records(...) FROM
authenticated, anon, PUBLIC; GRANT … TO service_role;` (server-internal helper) — through the
migration review gate. Low severity (insert-only, idempotent NOT-EXISTS guard, no data exfiltration,
no money/privilege impact) but it is exactly the W1 structural class predicate (d) exists to catch, so
it is reported, not allowlisted.
