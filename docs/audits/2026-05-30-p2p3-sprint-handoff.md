# P2/P3 Sprint Handoff — branch `fix/review-2026-05-30-p2p3`

**Date:** 2026-05-30
**Author:** Claude Code (autonomous P2/P3 sprint, follow-on to the 2026-05-28 14-domain review)
**Branch:** `fix/review-2026-05-30-p2p3` (pushed to origin) — created from `449b20e` (the P2-D commit on main)
**Companion:** `docs/audits/2026-05-28-full-codebase-review-plan.md` §5 (the findings this sprint closed)

> ⚠️ **All DB migrations in this sprint are ALREADY APPLIED LIVE + verified** (project `rhyzpcqhnizqbxphqdkr`). The branch is the *code/doc* record; the live DB is current. To finish landing, **merge this branch into `main`** (see "Merge plan" below).

---

## Concurrent-session note (important context)

A **second Claude session was active in the main `C:\CRX_Manager` checkout** during this sprint (it edited `companyInfo.ts` — resolving the remit-to address to **9100 E 2000th Ave, Annapolis, IL 62413**, Mason-confirmed; ran a whole-codebase audit; advanced `main` to `a71f9e0`; applied the parked `20260529220000_gate_admin_only_financial_report_rpcs` migration live as stamp `20260530121737`). To avoid corrupting each other's work, this sprint's P2-E onward was done in an **isolated git worktree**. P2-D (`449b20e`) was committed to `main` before the worktree was created.

**Consequence:** doc counts (CLAUDE.md migrations/tables/RPCs, migration-history) and a few files (`invoicePdf.ts`, `CLAUDE.md`, `migration-history.md`) were edited by BOTH sessions → expect merge conflicts; resolve by taking the union (both sets of changes are real).

---

## What landed (all applied live + committed on this branch)

### Migrations (live-verified; md5-confirmed verbatim-from-live bodies + the scoped change)
| Live stamp | Name | What |
|---|---|---|
| `20260530121534` | `delivery_items_parent_lock_trigger` (P2-D, on main) | BEFORE INS/UPD/DEL trigger blocking `delivery_items` writes when parent `deliveries.status IN ('in_progress','completed')`; `complete_delivery` sets the `app.admin_override` hatch. Smoke-tested: completed write blocked, scheduled allowed. |
| `20260530183926` | `returns_rpc_role_actor_guard` (P2-E) | Added canonical auth + strict-actor (`AUTH_REQUIRED`/`ACTOR_MISMATCH`) + `role IN ('admin','sales_rep')` gate to `approve_return` + `receive_return` (were SECDEF-but-ungated). Smoke-tested: service-role → `AUTH_REQUIRED`. |
| `20260530191823` (+ `20260530192441` fix) | `batch_rpc_idempotency` (P2-3) | Canonical idempotency for `batch_apply_all_prepayments` + `batch_void_invoices`. **Plus a bundled bugfix (Mason-approved):** `batch_apply_all_prepayments` was silently broken in prod — inserted `entity_id=NULL` into `financial_audit_log` (NOT NULL) so "Apply all prepayments" failed on every click (0 audit rows ever). Fixed to `entity_type='batch'`, `entity_id=v_actor`. (An initial `entity_type='system'` violated the entity_type CHECK — caught by a post-apply smoke test — corrected to `'batch'` and re-applied as the `192441` stamp.) |
| `20260530194520` | `save_blend_ticket_canonical_return` (P2-H) | `save_blend_ticket` return `{status:'saved'}` → canonical `{success:true, ticket_id, ticket_number}`. Migration-only (caller uses `assertRpcResult` generically). |

Each migration: both reviewers (`rls-security-reviewer` + `migration-drift-reviewer`) returned 0 BLOCKER/0 HIGH; orchestrator independently verified live (overload counts = 1, md5 fidelity, functional smoke tests).

### Frontend (committed on this branch)
- **P2-B/C:** wrapped every jspdf-autotable callback (`didDrawPage`/`didDrawCell`/`didParseCell`) in try/catch across 7 PDF builders so a callback throw no longer aborts the whole document; added a page-space guard to `statementPdf.drawRemittanceStub` (addPage when content would overlap, for customers with 8+ invoices). Reviewed by `pdf-output-reviewer` (clean).
- **P2-I:** replaced `ApplicationServiceDetail.tsx`'s local `parseDollarsToCents` (parseFloat) with the hardened canonical `lib/parseCents` import.
- **P3:** lazy-loaded `CustomerDetail`'s `MapContainer`+`FieldMarkers` (the ~1.68 MB vendor-mapbox chunk is now a separate lazy chunk, not in the page's initial bundle — build-verified); removed dead `compressImages` (plural) export + test; hid 3 non-functional TODO stub buttons (FieldApplicationInvoice "Print", FieldAppChemicalEntry "Select Recipe"/"Save As Recipe").

---

## NOT done — needs Mason / deferred

1. **Edge-function Sentry DSN boot validation** (P3/D11): add `validateSentryDsnOrThrow()` at module boot to `create-user`, `reset-user-password`, `send-email`. **NOT done** — this requires 3 live Edge Function deploys, and `SENTRY_DSN` env presence can't be verified via MCP; a blind deploy with the DSN unset would crash the functions at boot. **Action:** confirm `SENTRY_DSN` is set for the functions, then add the boot call + deploy via `/deploy-edge-function` (which smoke-tests).
2. **`pdfjs-dist` removal (D13): REFUTED — do not remove.** The review claimed zero `src/` consumers; in fact `src/lib/documentOCR.ts` imports it (`import * as pdfjsLib from 'pdfjs-dist'` + worker) for PDF OCR. Kept.
3. **REVOKE anon EXECUTE on the 9 benign number-generator reads** (P3, optional): not done — "leaks nothing," very low value; skipped to avoid a full migration cycle for zero security gain.
4. **Strict-actor follow-up:** `batch_apply_all_prepayments`, `batch_void_invoices`, and `save_blend_ticket` all use the permissive `COALESCE(p_performed_by, auth.uid())` / `p_performed_by` actor pattern (attribution-only, gated by a role check). Pre-existing; candidate for a future strict-actor sweep (confirm `src/` callers pass `profile.id` first).
5. **Pre-existing PDF double-footer:** short statements footer the last page twice (table `didDrawPage` + the final `drawPageFooter()`). Out of scope for P2-B/C; flagged for a future fix.
6. **Visual print test (P2-C):** have Mason print one statement for a customer with 8+ open invoices to confirm the remittance stub lands cleanly on a fresh final page.

---

## Merge plan

1. Settle the other session's work on `main` first (it left files staged mid-commit).
2. Merge `fix/review-2026-05-30-p2p3` → `main` (or open a PR). Resolve conflicts by **union** on `CLAUDE.md`, `docs/reference/migration-history.md`, and `invoicePdf.ts` (both sessions' edits are real).
3. The DB is already live — no `apply_migration` needed on merge. Just reconcile the doc counts to the true post-merge migration-file count.
4. Note the two live-only stamps with consolidated/renamed disk files: `20260530192441` (the P2-3 entity_type correction, consolidated into the `20260530191823` file) and `20260530121737` (the other session's gate migration).
