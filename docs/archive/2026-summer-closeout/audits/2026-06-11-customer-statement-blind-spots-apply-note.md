# Apply note — `20260611131549_customer_statement_blind_spots` (CHIP task_25d25699)

**Status: APPLIED LIVE 2026-06-11 13:15 UTC. Do not re-apply.** This note exists
because the apply happened from a chip session while two other sessions were
mid-batch in the same checkout; the commit is handed off (see "Git state" below).

## What was applied

`public.get_customer_statement` — the 4 AR statement blind spots (FIN-README
Findings item 2), fixed exactly per the staged draft:

- DELTA-1: invoice branch `status IN ('posted','paid','overdue')`
- DELTA-2: `LEFT JOIN orders` + `COALESCE(o.customer_id, p.customer_id)` attribution
- DELTA-3: `payments.deleted_at IS NULL`
- DELTA-4: new `allocation_sets` branch (`entity_type='payment'`, `is_active`,
  amount = `total_allocated_cents` only — DEDUP RULE)

## Evidence chain

| Gate | Result |
|---|---|
| Pre-apply live md5 | `c3b4056129d56cf97f3739269e6571fa` — matched the draft's baseline; re-asserted in-transaction at apply |
| Review gate | rls-security-reviewer 0/0/1 (MED = comment-only `pg_get_functiondef` string; file moved via shell); migration-drift-reviewer 0/0/1 (MED = post-apply doc row, done). Proof: `.claude/session-state/migration-review-customer_statement_blind_spots.json` |
| Apply | Management API (Supabase MCP not connected in the chip session), single transaction: precondition DO + migration (incl. its self-verification DO) + `schema_migrations` insert (version `20260611131549`, MCP-parity shape, created_by mason@) |
| Post-apply | md5 `72dfc6f37df2a85d50f7ddbe465e783f`, overload=1, DELTA sentinels present, version row present |
| Smoke | `scripts/smoke/smoke-customer_statement_blind_spots.sql` → `SMOKE_PASS_ROLLBACK` (all 4 blind spots + dedup + idempotent allocate_payment replay + overdue survival + unknown-actor auth probe) |
| Predicate | `fin-ar-statement-balance.sql` (transcription updated same work unit) → **0 rows** |

## Git state at session end (handoff)

Work-unit files on disk and **staged** in the shared index, commit NOT landed in
the chip session (a concurrent session was staging its own batch mid-hook; the
chip session stood down per the one-session-per-tree race rule):

- `supabase/migrations/20260611131549_customer_statement_blind_spots.sql` (moved from `scripts/.staging-migrations/`)
- `scripts/smoke/smoke-customer_statement_blind_spots.sql`
- `scripts/db-invariant-sweeps/predicates/fin-ar-statement-balance.sql` (header now cites the stamp)
- `scripts/db-invariant-sweeps/FIN-README.md` (Findings item 2 → FIXED; 2026-06-11 re-run note)

Also updated on disk (left for the batch wrap commit — they interleave with
concurrent sessions' uncommitted entries): `docs/reference/migration-history.md`
(row 296), `docs/CHANGELOG.md` (2026-06-11 section), `scripts/smoke/smoke-specs.json`
(key `get_customer_statement`). CLAUDE.md Current State counts NOT touched
(highest-contention file; reconcile at batch wrap).

Open observation for the wrap session: FIN-README Findings item 1
(`void_payment` prepay reversal) still reads as open although
`20260611001904_void_payment_prepay_reversal.sql` exists on disk — that doc
closure belongs to the session that shipped it.
