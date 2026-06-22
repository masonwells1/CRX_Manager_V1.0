# STATE — B1 Lot Capture & Trace build loop

> The loop reads this at the start of every turn and updates it after every phase. Status values: `PENDING` · `IN-PROGRESS` · `DONE` · `BLOCKED` · `AWAITING-OWNER-APPROVAL`.
> Keep the log append-only; never delete history (record what happened so a resume/owner can trust it).

**Overall status:** PENDING (not started)
**Branch:** feat/application-lot-capture (create off latest origin/main in Phase 0)
**Started:** —
**Last updated:** —

## Phase checklist
| Phase | Status | Commit SHA | Codex verdict | Notes |
|---|---|---|---|---|
| 0 — Setup & grounding | PENDING | — | n/a | branch + codex check + registry refresh + SOW re-ground |
| 1 — DB migration (table + 3 RPCs + blend propagation) | PENDING | — | — | prove via dev branch or rolled-back smoke; NOT applied live |
| 2 — Types (`src/types/index.ts`) | PENDING | — | — | |
| 3 — UI: lots-applied editor | PENDING | — | — | multi-lot per product + suggestions + override |
| 4 — UI: lot-trace lookup page | PENDING | — | — | LotTrace.tsx + route + nav |
| 5 — Wire-up, tests, docs | PENDING | — | — | blend auto-propagation; doc-drift = 0 |
| 6 — Final gate + handoff | PENDING | — | — | apply-guard proof + HANDOFF.md; then STOP |

## Run log (append-only)
- (loop appends one line per phase: timestamp · phase · what happened · proof method · review outcome)

## Open issues for the owner (only if a phase is BLOCKED)
- (none yet)

## Hard gates NOT crossed by the loop (handled at handoff, owner approval required)
- [ ] apply migration to live DB
- [ ] regen schema registry (post-apply)
- [ ] post-apply smoke-chain + db-sweeps
- [ ] merge feat/application-lot-capture → main
- [ ] deploy (Vercel) + live UI proof
- [ ] owner in-app smoke
