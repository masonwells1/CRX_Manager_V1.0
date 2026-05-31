# Codex Review Prompt — Independent Verification of the 2026-05-25 Ultra-Review

**For:** Codex (or any independent reviewer/model with repo + live-DB access).
**Repo:** https://github.com/masonwells1/CRX_Manager_V1.0 (branch `main`).
**Supabase project ref:** `rhyzpcqhnizqbxphqdkr` (read-only access only).

**Your job:** Adversarially verify the audit findings and remediation plan produced on 2026-05-25 by a different model (Claude). Confirm what's correct, **challenge what's wrong, and find what was missed.** Do not trust the prior reviewer — re-derive every conclusion from the code and, where possible, the live database. **REPORT-ONLY: do not modify code, migrations, or the database. Read-only SQL only — never INSERT/UPDATE/DELETE/DDL/migration/deploy.** Be ruthless; the prior reviewer self-graded.

## Read first
1. `docs/audits/2026-05-25-full-codebase-ultra-review.md` — the findings under review (1 P0, 6 P1, plus P2/P3).
2. `docs/audits/2026-05-25-remediation-plan.md` — the proposed fixes (drafts, NOT applied).
3. `CLAUDE.md` — project rules (Hard Red Lines, Schema Gotchas, Canonical Patterns, the per-table "Tables WITHOUT updated_at" list).
4. `docs/workflows/SAFE_DEVELOPMENT_RULES.md`.

Exclude `node_modules/` and `.claude/worktrees/` from all searches (the worktree is a stale duplicate).

## What to scrutinize

### 1. The P0 (RLS-1) — is it real, complete, and correctly severity-rated?
- Re-verify, live, that `apply_write_off`, `issue_return_credit`, and `void_order` are SECURITY DEFINER, `anon`-EXECUTE, and contain no `auth.uid()` session check: `has_function_privilege('anon', p.oid, 'EXECUTE')` + read each body.
- **Reachability:** is the anon vector actually exploitable via PostgREST with the public anon key, or is something blocking it (PostgREST `db-anon-role`, a `pgrst.db_pre_request` hook, an API gateway, network rules)? Confirm or refute — this is the crux of the P0.
- **Completeness:** enumerate ALL anon-executable SECURITY DEFINER mutators (the audit counted 215 anon-exec / 106 without `auth.uid()` / ~28 directly-callable actor-bearing). Rank by blast radius. Did the audit miss any function MORE dangerous than the three named?
- Is P0 the right severity, or higher/lower?

### 2. The remediation SQL — correct and safe to run as written?
- **M1 (broad REVOKE + re-grant):** Does revoking `EXECUTE` from `PUBLIC`+`anon` and granting to `authenticated`+`service_role` preserve every legitimate logged-in flow? Is there any function only `anon` should call (would M1 break it)? Is the `prokind='f'` filter correct (does it wrongly include/exclude aggregate/window/trigger functions)? Can the dynamic `format('%s', oid::regprocedure)` mishandle overloads, `VARIADIC`, or special identifiers?
- **M3 (auth.uid binding):** For each patched function, would `p_performed_by := auth.uid()` (and `ACTOR_MISMATCH`) break any legitimate caller that passes a *different* actor — e.g., a `service_role` batch job, a cron, or an Edge Function acting on behalf of a user? Inspect the TS callers (`src/`) and the Edge Functions (`supabase/functions/`).
- **M4 (CHECK + IMMUTABLE validator):** Is `is_valid_commission_split` genuinely IMMUTABLE and CHECK-safe? Does the regex guard prevent numeric-cast errors during constraint evaluation? Does `NOT VALID` then `VALIDATE` behave as described, and is the existing-violator pre-check correct?
- **M5 (rounding rewrite):** Does the window-function version reconcile to the base in ALL cases — 1 split, N splits, percentages not summing to 100, zero/negative profit, a single 100% split? Does it preserve the entity-recipient (`recipient_user_id`) resolution semantics exactly as the current function?
- **M6 (overload drop):** Are the 3 named dependents (the `invoices.invoice_number` column DEFAULT + `create_invoice_from_blend_ticket` + `save_field_app_invoice`) the COMPLETE dependency set? Run a fresh dependency scan. Will the `DROP` fail safely if anything still references the no-arg overload?

### 3. The P1s — validate or refute each, with evidence
COMM-1 (split rounding never reconciles), COMM-2 (`save_customer` has no server-side split validation), EDGE-1 (`reset-user-password` silent CORS fallback), EDGE-2 (deployed `reset-user-password` v11 missing the `entity_recipient` gate that's in source), MIG-1 (`next_invoice_number` overload), RLS-2 (blanket anon table DML grant). For each: **AGREE / DISAGREE** + file:line/DB evidence + your severity.

### 4. False negatives — independently re-audit the "clean" domains
The audit rated **Money/AR, Pipeline+holds, and Inventory** clean. Re-check the highest-risk invariants yourself: no GENERATED-column (`balance_cents`) writes in any UPDATE SET clause; the holds ↔ `quantity_available` symmetry (does declining/expiring a quote inflate stock?); `inventory_transactions` immutability; `post_invoice` → `check_period_open` enforcement; `safe_cents_qty` coverage of every `(*_cents * qty)::bigint`. Did the prior reviewer miss anything?

### 5. The "confirmed-fixed" claims — re-verify at least 3, don't trust
The audit asserts these 2026-05-16 findings are now fixed live: SECURITY DEFINER `pg_temp` (claims 0/223), `transfer_job_to_invoice` idempotency wired, notification RPC signatures aligned, `offlineSync` no longer drops on `{null,null}`, `send-email` v13 WAL durability, `process-blend-ticket` v19 error checks. Spot-check ≥3 against the live DB / deployed function bodies and confirm or refute.

## Output format
For each item above: **AGREE / DISAGREE / NEEDS-MORE-INFO**, with file:line or DB-object evidence and your severity (P0/P1/P2/P3/INFO). Then:
- **New findings** the audit missed (full detail + severity + proposed fix).
- **Remediation verdict:** is the plan safe to execute as written? List every migration you'd change before running, with the exact change.
- **Final call:** does anything change the audit's "HOLD — remediate RLS-1 before further deploy" verdict?
