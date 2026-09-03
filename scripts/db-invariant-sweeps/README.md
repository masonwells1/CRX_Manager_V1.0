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
  a stable **`violation_key`** column (a routine identity like `fn_name(arg types)`).
- `allowlist.json` — per-predicate exemptions, each with a dated justification.

### Predicates shipped

| File | Class | Expectation |
|---|---|---|
| `anon-exec-secdef.sql` | (a) every anon-executable SECDEF | only the documented RLS-helper / trigger / sequence / self-gating-report set (allowlist) |
| `ungated-secdef-mutators.sql` | (b) authenticated SECDEF that mutates and references no auth.uid()/role helper | **zero** (the round-2 definitive predicate, standing) |
| `actor-forgery.sql` | (c) function/procedure actor-param role-check/COALESCE/MERGE/callable or operator forwarding before an executable, uncaught ACTOR_MISMATCH refusal | over-broad by design; allowlist semantic-safe |
| `actor-forgery-fin-audit.sql` | (i) function/procedure actor param referenced inside a `financial_audit_log` INSERT before an executable, uncaught ACTOR_MISMATCH refusal (blind-spot closer for (c)) | over-broad by design; allowlist verified attribution-only |
| `auth-bound-role-ungated.sql` | (d) auth.uid()-bound mutator with no role check (the `create_direct_order` W1 variant) | **zero** |
| `secdef-searchpath.sql` | (e) SECDEF missing `search_path` | **zero** (no allowlist case) |
| `overloads.sql` | (f) public proname with >1 signature | **zero** (no allowlist case) |
| `status-literals.sql` | (g) function writes a literal outside a column's CHECK set | **zero** (regex approximation — see file header for FP/FN modes) |
| `plpgsql-check.sql` | (h) 42703/42804/missing-relation static analysis | **ACTIVE** — extension installed 2026-06-10 (`20260610192229`); first scan: **30 errors / 11 live functions** (see `docs/audits/2026-06-10-error-prevention-execution-log.md` §4 — each needs its own /ship fix; treat that list as the baseline until fixed, do NOT allowlist) |
| `commission-admin-active.sql` | commission payment admin RLS uses the active-aware `is_admin()` helper | **zero** (missing or role-only policies are violations) |
| `returns-lifecycle-rpc-owned.sql` | return lifecycle fields, creation, and line mutations stay behind canonical RPCs/triggers | **zero** (catches direct `returns` INSERT policy/grant drift and direct `return_items` mutation policy/grant drift) |
| `save-field-actor-binding.sql` | exact reviewed `save_field(uuid,jsonb,jsonb,uuid,text)` actor-binding body | **zero** (missing signature or any body drift fails closed) |
| `product-name-vs-return-policy.sql` | a product whose **name** asserts it cannot be returned is classified `return_policy = 'no_return'` | **zero** (a business-**data** predicate — emits the product **id** only, never the name or SKU; see *Output containment* below) |

The actor-forgery predicates treat grouping, casts, field/subscript access, and
reverse operands as transparent around actor-bearing symbolic operators. They
strip SQL comments, ignore notice/string text, and stop only at a recognized
strict-actor `IF ... RAISE EXCEPTION 'ACTOR_MISMATCH'` statement. Any routine
containing an exception handler stays fail-closed because that handler may catch
the refusal. A helper, operator, or financial-audit write before a valid refusal
therefore remains a finding, while ordinary forwarding after a proven early,
uncaught refusal does not. That refusal must also be **unconditional**: every
`IF`/`LOOP`/`CASE` opened before it has to be closed before it, and the refusal
statement itself may open none, so a guard buried under `IF false THEN` no
longer ends the scan. The reader counts block keywords rather than parsing
PL/pgSQL, so a `CASE` *expression* ahead of the refusal reads as an unclosed
block and costs an extra finding — it cannot hide one.
A `v_actor := auth.uid()` binding is required before
a local-actor refusal, but the scanned prefix ends at the refusal's `IF`, not at
the binding, so intervening forwarding remains visible. Positional `$n` aliases
use full PL/pgSQL declaration order, including preceding `OUT` parameters. A
refusal is trusted only when the catalog proves the actor argument is
`pg_catalog.uuid` and any local identity binding is declared `uuid`; custom
types can overload equality. Before refusal analysis, a length-preserving lexer
masks comments and ordinary, escape, Unicode, and dollar-quoted data strings.
Backslash escapes are honoured only inside `E'...'`, and only when the `E` is
not word-adjacent — in every other string a trailing backslash is data, so
`'ends with \'` closes at its own quote. Getting that wrong did not fail closed:
the lexer swallowed the closing quote, ran to the next one, and masked the
executable statements in between, silently clearing the routine. That is the
`actor_backslash_guard_forward` / `actor_word_adjacent_escape_forward` pair in
`actor-forgery-predicates.test.mjs`; both fail against the pre-fix regex.
An unterminated string, an unterminated dollar quote, and nested-comment residue
do fail closed — the routine is emitted as a finding rather than skipped.

The `save_field` predicate also has a disposable mutation proof that deliberately installs unsafe,
late-guard, comment-only, and altered bodies and requires the predicate to fail closed. Run both
that guard-of-the-guard and the rollback behavior smoke with
`npm run proof:save-field-actor`.

## Output containment (the repo is public)

`CRX_Manager_V1.0` is a **public** GitHub repository. Predicates split into two groups by what their
output contains, and the difference decides where that output may be pasted:

- **Catalog predicates** read `pg_proc` / `pg_policy` / `pg_constraint` and emit function and policy
  identities. Their output is safe to paste into a tracked file, an issue, or a PR comment.
- **Business-data predicates** read customer, invoice, quote, commission, and product rows. Several
  of them deliberately emit human-readable business detail so a finding is actionable — for example
  `fin-commission-split-sum.sql` emits a customer `farm_name` and the raw `commission_split` JSON,
  and `fin-invoice-balance-identity.sql` emits customer ids, invoice numbers, and cent amounts. That
  is correct for triage and **wrong for anywhere public**. Today the business-data predicates are
  `fin-allocations-bounded`, `fin-ar-statement-balance`, `fin-commission-split-sum`,
  `fin-invoice-balance-identity`, `fin-prepay-balance`, `fin-quote-override-survival`, and
  `product-name-vs-return-policy`.

**Never paste raw business-data sweep output into a tracked file, a commit message, an issue, or a
PR comment.** Read it in the session, act on it, and record only the `violation_key` — and only when
that key is an opaque id. `product-name-vs-return-policy` is written so its key always is one: it
projects the product id and never the name or SKU, enforced by a test that audits the projected
expressions themselves (`src/__tests__/predicate-product-name-vs-return-policy.test.ts`). The other
business-data predicates carry no such guard, so treat their whole output as private.

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
| auth-bound-role-ungated | 1 | 0 | **1 → CLOSED 2026-06-11** (`generate_rup_sales_records`, revoked — see below) |
| secdef-searchpath | 0 | 0 | 0 |
| overloads | 0 | 0 | 0 |
| status-literals | 0 | 0 | 0 |
| plpgsql-check | 30 errors / 11 functions (2026-06-10 first scan) | 0 | 30 — baseline queue in the execution log §4, fix via /ship, never allowlist |

**RESOLVED 2026-06-11 — was an open `auth-bound-role-ungated` finding:** `generate_rup_sales_records(p_invoice_id uuid,
p_idempotency_key text)` is an `authenticated`-EXECUTE-able SECDEF that inserts `rup_sales_records`,
binds `auth.uid()` for `created_by`, but has **no role gate**. Its only legitimate caller is
`post_invoice` (which is itself gated), and there is **no UI/Edge callsite** (grep: only test files
reference it). Recommended fix: `REVOKE EXECUTE ON FUNCTION generate_rup_sales_records(...) FROM
authenticated, anon, PUBLIC; GRANT … TO service_role;` (server-internal helper) — through the
migration review gate. Low severity (insert-only, idempotent NOT-EXISTS guard, no data exfiltration,
no money/privilege impact) but it is exactly the W1 structural class predicate (d) exists to catch, so
it is reported, not allowlisted. **Update — CLOSED live 2026-06-11 by migration
`20260611001248_revoke_generate_rup_sales_records`: `REVOKE EXECUTE … FROM authenticated, anon, PUBLIC`
applied, so live grants are now `service_role`/`postgres` only and the `auth-bound-role-ungated` sweep
returns 0 unallowlisted rows (re-confirmed by the 2026-06-17 sections 2-15 gauntlet, LOW-3).**

## Update 2026-06-17 — `actor-forgery-fin-audit` added; link/unlink un-allowlisted

The Live Foundation Gauntlet **Section 1** found `link_blend_ticket_to_order` /
`unlink_blend_ticket_from_order` forging the audit actor: they wrote a caller-supplied `p_performed_by`
into `financial_audit_log.actor_user_id` (+ `activity_feed.performed_by`, + the `actor_role` lookup)
with no `ACTOR_MISMATCH` guard. They had been **allowlisted** under `actor-forgery` as "attribution-only"
since 2026-06-10, which is exactly what suppressed the catch. Fixed live (migration `20260617171500`,
canonical strict-actor block) and the two stale allowlist entries **removed**, so `actor-forgery` now
actively guards them again — a revert that drops `ACTOR_MISMATCH` re-flags them (the regression fixtures
the Section 1 report asked for).

New predicate **`actor-forgery-fin-audit`** closes the blind spot predicate (c) had for *attribution-only*
writes into the immutable money ledger: predicate (c) only fires when the param sits near a `role`
derivation or `COALESCE`, so a raw `…actor_user_id, … VALUES (…, p_performed_by, …)` with no `role` word
nearby slips it. This predicate keys on the `financial_audit_log` sink itself.

Live seed 2026-06-17 — **1 flagged / 1 allowlisted / 0 real:** `create_invoice_from_delivery` (forges the
role LABEL only, not the actor identity; authorization is off `auth.uid()` and independently cleared by
predicates (b)/(d)). Allowlisted as a **hardening candidate** — the clean end-state is to apply the same
strict-actor block to it (bundle with the Section-6 gauntlet finding that it declares-but-doesn't-use the
idempotency helper), then remove the allowlist entry.
