# STATE — B1 Lot Capture & Trace build loop

> The loop reads this at the start of every turn and updates it after every phase. Status values: `PENDING` · `IN-PROGRESS` · `DONE` · `BLOCKED` · `AWAITING-OWNER-APPROVAL`.
> **The loop runs ONLY the first `PENDING` phase each turn, and STOPS (does not run) on `BLOCKED`, `IN-PROGRESS`, or `AWAITING-OWNER-APPROVAL`.**
> Keep the log append-only; never delete history (record what happened so a resume/owner can trust it).

**Overall status:** IN-PROGRESS (Phase 0 DONE; Phase 1 next)
**Branch:** feat/application-lot-capture (created off origin/main @ Phase 0; tracks origin/main)
**Supabase dev branch ID (migration proof target — `apply_migration` ONLY here; NEVER prod `rhyzpcqhnizqbxphqdkr`):** — (set in Phase 1; fallback = rolled-back smoke if branching unavailable)
**Started:** 2026-06-22T18:37Z
**Last updated:** 2026-06-22T18:37Z

## Phase checklist
| Phase | Status | Commit SHA | Codex verdict | Notes |
|---|---|---|---|---|
| 0 — Setup & grounding | DONE | (env gate, no feature code) | n/a (helper) | worktree OK · codex 0.140.0 logged-in · registry refreshed → high-water 20260622165336 · SOW re-grounded vs live · codex design-critique folded in |
| 1 — DB migration (table + 3 RPCs + blend propagation) | PENDING | — | — | prove via dev branch or rolled-back smoke; NOT applied live |
| 2 — Types (`src/types/index.ts`) | PENDING | — | — | |
| 3 — UI: lots-applied editor | PENDING | — | — | multi-lot per product + suggestions + override |
| 4 — UI: lot-trace lookup page | PENDING | — | — | LotTrace.tsx + route + nav |
| 5 — Wire-up, tests, docs | PENDING | — | — | blend auto-propagation; doc-drift = 0 |
| 6 — Final gate + handoff | PENDING | — | — | apply-guard proof + HANDOFF.md; then STOP |

## Run log (append-only)
- (loop appends one line per phase: timestamp · phase · what happened · proof method · review outcome)
- 2026-06-22T18:37Z · Phase 0 · Worktree confirmed (`.claude/worktrees/youthful-roentgen-b5d48a`, NOT main checkout), clean, branch `feat/application-lot-capture` off origin/main, `npm ci` done. Codex CLI 0.140.0 logged-in (gate available). Schema registry refreshed via live MCP introspection (Q1–Q5) + `regenerate-schema-registry.mjs --from-introspection` → high-water 20260620240000→20260622165336, only real delta `blend_recipe_items.price_per_unit_cents` (no status/gen-col/table drift). Re-grounded vs live: `application_records` (source_id NOT NULL, product_data jsonb), `application_record_fields` (no updated_at), `receiving_records.lot_number` (text null, no updated_at), `blend_ticket_products.lot_number` (text null, **product_id nullable**) — all match SOW. Captured verbatim live body of `create_application_record_from_blend_ticket` (single overload, oid 77976, idempotency op `create_app_record_from_bt`, returns uuid[]) + `application_records` RLS policies (insert admin/sales, update/delete admin, select admin/sales/applicator-own). Codex helper design-critique PASS with refinements folded into Phase 1 (idempotency-before-DELETE, parent FOR UPDATE, source_receiving_record_id ON DELETE SET NULL, filter null product_id/blank lot in blend insert, btrim+case-insensitive, trace from application_record_lots not receiving, dedupe blend dup lines). Proof method: env gate (no feature code).

## Open issues for the owner (only if a phase is BLOCKED)
- (none yet)

## Hard gates NOT crossed by the loop (handled at handoff, owner approval required)
- [ ] apply migration to live DB
- [ ] regen schema registry (post-apply)
- [ ] post-apply smoke-chain + db-sweeps
- [ ] merge feat/application-lot-capture → main
- [ ] deploy (Vercel) + live UI proof
- [ ] owner in-app smoke
