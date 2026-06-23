# STATE — Field Mapping + Per-Acre Billing build loop

> The loop reads this at the start of every turn and updates it after every phase. Status: `PENDING` · `IN-PROGRESS` · `DONE` · `BLOCKED` · `AWAITING-OWNER-APPROVAL`.
> **The loop runs ONLY the first `PENDING` phase each turn, and STOPS (does not run) on `BLOCKED` / `IN-PROGRESS` / `AWAITING-OWNER-APPROVAL`.** Append-only log; never delete history.

**Overall status:** PENDING (not started — awaiting owner OK to launch)
**Worktree:** C:/CRX_FieldMapping
**Branch:** feat/field-acre-billing (off main c2f83c2f)
**Supabase dev branch ID (migration proof target — `apply_migration` ONLY here; NEVER prod `rhyzpcqhnizqbxphqdkr`):** — (set in Phase A1)
**Parallel session to avoid:** feat/as-applied-invoices (at C:/CRX_Manager) — editing the field-app invoice engine; Track B is BLOCKED on its merge
**Started:** —
**Last updated:** 2026-06-22 (harness authored; not launched)

## Phase checklist
| Phase | Status | Commit SHA | Codex verdict | Notes |
|---|---|---|---|---|
| 0 — Setup & grounding | PENDING | — | n/a | worktree + codex check + registry refresh + re-ground PHASE2 facts |
| A1 — Migration: fields two-acre columns + backfill | PENDING | — | — | measured/override/boundary_geom/acres_source + GIST + backfill; dev-branch proof |
| A2 — Migration: set_field_boundary RPC (+ override + dedupe) | PENDING | — | — | server ST_Area + band + strict-actor + idempotency; §8B smoke matrix |
| A3 — Types | PENDING | — | — | Field / ParsedImportField / FieldLocation |
| A4 — UI: FieldSetup override model | PENDING | — | — | remove 854-857 clobber; billable-override input; draw→set_field_boundary |
| A5 — Import: .zip + multi-part + dedupe | PENDING | — | — | shpjs zip branch; preserve multi-part; dedupe choice |
| A6 — Track A tests + docs | PENDING | — | — | override-survives-redraw regression; doc-drift = 0 |
| A7 — Track A handoff | PENDING | — | — | apply-guard proofs + HANDOFF.md → AWAITING-OWNER-APPROVAL → STOP |
| B0 — Re-ground vs merged as-applied code | BLOCKED | — | — | unblock after `feat/as-applied-invoices` merges to main |
| B1 — save_field_app_invoice hardening (Codex's 5 findings) | BLOCKED | — | — | 0/neg acre reject · deleted_at-aware · override cost · salesman_id · acre rounding |
| B2 — Bill tie-in (mapped acres → invoice default) | BLOCKED | — | — | :313 default + 5 threadings + server COALESCE + ZERO_APPLIED_ACRES |
| B3 — transfer_job_to_invoice convergence | BLOCKED | — | — | service-fee line + actor binding |
| B4 — Polish (recipe pricing, reconciliation view) | BLOCKED | — | — | blend_recipe_items price; applied-not-invoiced view |
| Z — Track B handoff | BLOCKED | — | — | apply-guard proofs + HANDOFF update → AWAITING-OWNER-APPROVAL |

## Run log (append-only)
- 2026-06-22 — harness authored (SCOPE/BUILD-LOOP/STATE/README) in worktree C:/CRX_FieldMapping; npm ci green; NOT launched (awaiting owner OK).

## Open issues for the owner
- Launch approval pending (this is an autonomous build that writes migrations/code on a dev branch + feature branch; parks everything for the live gate).

## Hard gates NOT crossed by the loop (handled at handoff, owner approval required)
- [ ] apply migrations to live DB
- [ ] regen schema registry (post-apply)
- [ ] post-apply smoke-chain + db-sweeps
- [ ] merge feat/field-acre-billing → main
- [ ] deploy (Vercel) + live UI proof (with Mason's real shapefile / Ops Center / FieldView exports)
- [ ] owner in-app smoke
- [ ] unblock Track B (after as-applied session merges)
