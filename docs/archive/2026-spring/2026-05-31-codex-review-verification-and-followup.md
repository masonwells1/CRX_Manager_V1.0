# Verification of Codex's Pre-Push Review + Strict-Actor Follow-Up Plan — 2026-05-31

**Author:** Claude (Opus 4.8) — independent meta-review of Codex's `2026-05-31-codex-pre-push-consolidation-review.md`.
**Branch:** `consolidation/2026-05-30-pre-push`.
**Method:** Every Codex finding re-verified against the LIVE DB (`rhyzpcqhnizqbxphqdkr`, read-only) and the actual code on disk — trusting neither Codex nor the prior session's notes.

## Verdict: ACCEPT CODEX REVIEW

Codex's verdict (**SHIP-WITH-FOLLOWUPS**) is correct and independently confirmed. The consolidation is clean and can ship; the two batch-RPC HIGH findings are real, pre-existing, already-live issues (not consolidation defects) and should be the immediate next DB follow-up.

## Per-finding verification

| Codex finding | Independent evidence | Disposition |
|---|---|---|
| 1. statementPdf merge clean (no double page-break) | `src/lib/statementPdf.ts:223` calls stub with `, y`; the only stub-related `addPage` is the single in-callee guard at `:672` (`:329`/`:390` are unrelated transaction-table pagination) | **CONFIRMED** |
| 2. `192441` recovery byte-faithful + representation accepted | Live `pg_get_functiondef(batch_apply_all_prepayments)`: `entity_type 'batch'`, no `'system'`, uses `COALESCE(p_performed_by, auth.uid())`, 1 overload, SECDEF + `search_path=public, pg_temp` | **CONFIRMED** |
| 3a. HIGH forgery on `batch_apply_all_prepayments` | Live: COALESCE present, **no `ACTOR_MISMATCH`**, `anon_exec=false`, `auth_exec=true`. Disk: `192441:42` COALESCE, `:65` passes forged actor to `apply_remaining_prepayments`, `20260506180000:122` writes it to `financial_audit_log.actor_user_id` | **CONFIRMED** |
| 3b. HIGH forgery on `batch_void_invoices` (narrower) | Live: COALESCE, no mismatch check. Disk: `191823:160` COALESCE, `:161` role lookup, `:194` summary audit row uses `v_actor_role`; the per-invoice `void_invoice` derives its own actor from `auth.uid()` | **CONFIRMED** |
| 3c. `allocate_payment` "NOT same flaw" | Live: derives `v_actor := auth.uid()`, then `IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'p_performed_by does not match authenticated user'`. Does **not** use the forgeable COALESCE pattern | **CONFIRMED** (a prior Claude workflow's flag on `allocate_payment` was a **false positive**) |
| 4. disk-vs-live recent 1:1; "83 = count not set" | Recent window (≥`20260526`): 16 disk = 16 live, matched both directions. Full set diff: **41 matched, 306 disk-only, 411 live-only** (live 452 vs disk 347 distinct prefixes / 369 files) | **CONFIRMED + amplified** |
| 5a. LOW `CLAUDE.md` 365→369 | `CLAUDE.md:283` reference table said `365 migrations` | **CONFIRMED — fixed this commit** |
| 5b. LOW handoff header HEAD `c815d79` | handoff §header said `c815d79` (reviewed HEAD is `e084a48`) | **CONFIRMED — fixed this commit** |

**Minor evidence nitpicks in Codex's report (do not change any conclusion):** it cited `allocate_payment` in file `20260513110000` (real file: `20260513022308`) and described its guard as a "mismatch guard" — the guard exists but uses a non-canonical error string rather than the `ACTOR_MISMATCH` token.

## Migration disk-vs-live reality (for the record)

Only **41 of 347** distinct disk prefixes are real live versions. The disk uses synthetic sequential ordering prefixes (e.g. `20260209200000`, `20260318180000`) while live carries the actual MCP apply-time stamps. This is **pre-existing total historical decoupling**, harmless under the project's MCP-only apply workflow, but: **NEVER run `supabase db push` or `supabase db reset` against this project** — it would attempt to apply 306 phantom migrations. New migrations stay aligned via the B7 rule (rename disk file to the MCP-stamped version). The recent window (the only thing being pushed) is 1:1 clean.

## Can the consolidation ship before the follow-ups?

**Yes — SHIP-WITH-FOLLOWUPS.** The two HIGH findings are in already-live code, so the consolidation push neither introduces nor worsens them. The strict-actor fix should be the **immediate next DB follow-up**, applied via MCP after Mason's explicit approval (it is a live change, gated behind Mason's "Codex-then-live" rule and the `migration-apply-guard`).

## Proposed follow-up migration (NOT written to `supabase/migrations/`, NOT applied)

**One new migration**, `<MCP-stamp>_batch_rpc_strict_actor.sql`, doing `CREATE OR REPLACE FUNCTION` for BOTH functions. Do **NOT** edit the historical `191823`/`192441` files. Per project convention, reproduce each body **byte-faithful from live** (`pg_get_functiondef`) and make exactly this one change in each:

Replace the single line
```sql
v_actor := COALESCE(p_performed_by, auth.uid());
```
with the canonical strict-actor block (identical to `20260530020412_reverse_write_off_strict_actor`):
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```
- `batch_apply_all_prepayments`: the COALESCE is at the line after `require_admin_or_sales_rep()` / `check_rate_limit(...)` (disk ref `192441:42`). The block must sit **after** authz/rate-limit and **before** the idempotency check.
- `batch_void_invoices`: COALESCE at disk ref `191823:160`, immediately before the `SELECT role INTO v_actor_role` lookup.
- Everything else (idempotency helpers, entity_type `'batch'`, the loops, the audit INSERTs) stays byte-identical.

**Apply procedure (after Mason approves):**
1. Pull both live bodies via `pg_get_functiondef`, insert the guard, write the new migration file.
2. Run `rls-security-reviewer` + `migration-drift-reviewer` (writes the `migration-apply-guard` proof).
3. `/explain-migration` for Mason.
4. `apply_migration` via Supabase MCP; smoke-test: a service-role / forged-`p_performed_by` call must now raise `ACTOR_MISMATCH`; a normal admin call still succeeds.
5. Update `migration-history.md`, `CLAUDE.md` counts, regenerate schema registry.

## Optional defense-in-depth (Codex item, low priority)
`allocate_payment` still has `anon_execute=true` live (safe — it rejects NULL `auth.uid()` before mutating). Optional follow-up: `REVOKE EXECUTE ON FUNCTION allocate_payment(...) FROM anon, PUBLIC;` keeping `authenticated`, `service_role`. Can be folded into the same follow-up migration.

## Immediate doc fixes done this commit (safe, local only — no push/apply)
- `CLAUDE.md:283` migration-history count `365 → 369`.
- `2026-05-30-pre-push-consolidation-handoff.md` header HEAD `c815d79 → e084a48`.
