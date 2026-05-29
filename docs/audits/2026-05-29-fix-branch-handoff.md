# Fix Branch Handoff — `fix/review-2026-05-29`

**Branch:** `fix/review-2026-05-29` (isolated git worktree)
**Date:** 2026-05-29
**Author:** Claude Code (autonomous fix sprint following the 14-domain review)
**Companion docs:** `docs/audits/2026-05-28-full-codebase-review-plan.md` (the review + findings log)

> ⚠️ **NOTHING HERE HAS BEEN APPLIED TO THE LIVE DATABASE.** The live Supabase
> project (`rhyzpcqhnizqbxphqdkr`) is shared with a parallel feature session, so
> all DB migrations were written + locally tested + reviewer-vetted but NOT
> applied. They must be applied in a **coordinated window** (after the parallel
> session's migrations land, never simultaneously). This doc is the apply runbook.

---

## What's on this branch

### Code changes (safe to merge — no live coordination needed)
| Change | Files | Status |
|--------|-------|--------|
| **P1-D** Unify PDF company address to a single source (West York, IL) | new `src/lib/companyInfo.ts` + 10 PDF modules | ✅ typecheck + build + 1926 tests green |
| **P1-B (test half)** Body-scan test that verifies covered RPCs actually *use* idempotency, not just declare the param | `src/lib/rpcContracts.test.ts` | ✅ 66 tests pass |
| **P1-E** `npm audit fix` — cleared 3 prod CVEs (dompurify via jspdf, ws + protocol-buffers-schema via mapbox-gl) | `package-lock.json` only (no major bumps) | ✅ build+test green |

### Migration files (written + reviewed; **HOLD for coordinated apply**)
| # | File | What it does |
|---|------|--------------|
| P1-A | `supabase/migrations/20260529100000_reverse_write_off_strict_actor.sql` | Replaces forgeable `COALESCE(p_performed_by, auth.uid())` in `reverse_write_off` with the canonical strict-actor block + `is_active=true` admin check. Body otherwise verbatim from live. |
| P1-B | `supabase/migrations/20260529100100_save_job_idempotency.sql` | Adds real check-at-top / save-at-end idempotency to `save_job` (was declared-but-unused → double-click created 2 jobs). Body otherwise verbatim. |
| P1-C | `supabase/migrations/20260529100200_release_holds_on_quote_cancel.sql` | Adds `'cancelled'` to both status sets in the `release_holds_on_quote_status_change` trigger so cancelling a planned quote releases its inventory holds. |

---

## Reviewer verdicts (both subagents, 2026-05-29)
- **rls-security-reviewer:** 0 BLOCKER / 0 HIGH / 0 MED — all three SAFE TO APPLY. Confirmed `SET search_path = public, pg_temp` on all, no broadened grants (CREATE OR REPLACE preserves existing grants), correct idempotency columns, NULL-safe `IS DISTINCT FROM` actor block, correct `updated_at` handling.
- **migration-drift-reviewer:** 0 BLOCKER / 0 HIGH / 2 MED (both doc-drift only). Verified verbatim-plus-scoped-change against live-reproduced sources, no column drift vs `src/types/index.ts`, no CHECK regression.

### Live confirmations done by orchestrator (read-only SQL, 2026-05-29)
- `save_job` — exactly **1** overload live, 6-arg signature matches the migration. ✅ (this was the drift reviewer's one residual ambiguity — closed)
- `reverse_write_off` — exactly **1** overload, 4-arg. ✅
- `release_holds_on_quote_status_change` — single trigger fn. ✅
- `quotes.status` CHECK includes `'cancelled'` → the transition P1-C handles is reachable. ✅ (verified earlier in the review)

---

## Apply runbook (for the coordinated DB window)

1. **Wait** until the parallel feature session has finished and applied its own migrations. Never apply simultaneously.
2. Re-run the disk-vs-live drift check (`list_migrations` vs `supabase/migrations/`) to confirm no new collisions appeared while waiting.
3. For each migration, in filename order (100000 → 100100 → 100200 — order is independent), run `/explain-migration` for Mason, then `apply_migration`.
4. **B7 guard:** Supabase MCP may stamp a *different* version than the disk filename. If it does, **rename the disk file to match the applied version** before committing, to prevent a future re-apply attempt.
5. After apply, re-run the `save_job` overload-count check (`SELECT count(*) FROM pg_proc WHERE proname='save_job'`) — must stay **1**.
6. Smoke-test: create a job (confirm single insert), cancel a planned quote (confirm holds released via `activity_feed`), reverse a write-off as admin (confirm works) and confirm a non-admin/forged-actor call is rejected with `ACTOR_MISMATCH`.
7. Update `docs/reference/migration-history.md` (+3 rows), bump the `CLAUDE.md` migration count, and regenerate the schema registry if any enum/generated-column changed (none did here).

---

## Open item that needs Mason (does NOT block merge)

- **Remit-to mailing address** (`src/lib/companyInfo.ts` `COMPANY_REMIT_ADDRESS`): the PDF *location/footer* is now unified to **West York, IL**, but the statement **remit-to PO Box** (where customers mail checks) was **intentionally left as the pre-existing `PO Box 123, Martinsville, IL 62442`** and NOT guessed — a wrong remit address loses payments. If the PO Box/ZIP moved with the company, update that one constant. (HQ city and remit PO box may legitimately differ — flagged with a TODO in the file.)

---

## Deferred follow-ups (tracked, not done this sprint)
- **P1-B batch RPCs:** `batch_apply_all_prepayments` + `batch_void_invoices` still declare `p_idempotency_key` without using it (financial batch logic — deferred from a blind rewrite since it can't be test-applied; tracked as `'gap'` in `rpcContracts.test.ts` `IDEMPOTENCY_BODY_EXEMPT`).
- **`save_job` strict-actor:** `p_performed_by` is validated as an active admin/sales_rep but not pinned to `auth.uid()`. Out of scope for the idempotency fix; candidate for a future strict-actor pass (confirm all `src/` callers pass `profile.id` first).
- **Dev-only CVEs:** 2 moderate (esbuild/vite dev server) remain — only fixable via Vite 8 (breaking); deferred per D13.
- The rest of the P2/P3 backlog from the review plan (anon-read REVOKE migration, `delivery_items` status trigger, return-RPC role checks, PDF try/catch wrapping, reconciliation.ts test coverage, the giant-component refactor) — not started this sprint.
