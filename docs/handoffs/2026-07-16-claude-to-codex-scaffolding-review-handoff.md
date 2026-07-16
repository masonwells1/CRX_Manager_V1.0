# Claude → Codex handoff: Scaffolding design review + Wave 1 fixes (2026-07-16)

**From:** Claude (Fable 5) design-review session · **To:** any Codex session working in this repo
**Status at write time:** review complete; Wave 1 fixes being implemented on `claude/scaffolding-wave1-fixes`

## Why this exists

Mason is handing day-to-day work to junior operators ("vibe coders"). He directed (2026-07-16, verbatim intent): he cannot review code himself, he wants **long autonomous runs with automatic cross-model review standing in for his review**, he only wants to be asked **genuine owner questions** (business/risk/money/irreversible), never workflow questions — and agents get "a lot of free rein **as long as it is safe**". Safe = the existing hard gates hold in full (no live-migration apply without the proof gate + policy, no edge-fn deploy / data deletion / secrets without his explicit OK, branch→PR→merge only, never bypass a guard).

## What to read

`docs/audits/2026-07-16-scaffolding-design-review.md` — full findings. Method: 10 review dimensions, 41 agents, every BLOCKER/HIGH adversarially verified, top claims hand-re-verified against origin/main.

**Headline:** the guard architecture is strong; the failure mode is *staleness* — docs/skills that still describe the pre-2026-07-14 world (direct pushes, Pro-plan backups) and three documented instructions that route around the guard net (production SQL-editor apply; `supabase db push` where the bash guard only blocks the `npx` spelling; proof-file instructions a sibling hook denies).

## What Claude is fixing in Wave 1 (this branch)

1. `bash-safety-lib.mjs` db-push regex → npx-optional (+ test).
2. `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` Step 3 / Quick Reference → route through /migration-review + `apply_migration`; dashboard SQL-editor apply explicitly prohibited.
3. `create-migration` / `new-rpc` / `deploy-check` skills → same routing; remove `supabase db push` + dashboard suggestions.
4. `production-runbook.md` §4 + `incident-rollback.md` → real backup reality (FREE plan, no PITR; CRX_Backups pg_dump + `backup_snapshots` + `scripts/backup-db.mjs`).
5. `migration-apply-guard.mjs` interactive deny message → adds "get Mason's in-chat OK" step; proof instructions in `migration-review.md`/`ship.md` + deny message → point at the sanctioned `scripts/write-apply-proofs.mjs` instead of hand-writing JSON.

Deferred deliberately (Wave 2+, needs design care): Claude-side `gh pr merge` gate (port from your `production-action-guard.mjs`), removing `write-apply-proofs.mjs --codex-verdict` in favor of machine-minted verdicts, hard doc-freshness gates, loop lifecycle status, hook-manifest parity check.

## What Codex is asked to do

1. **Review the report** — challenge findings you believe are wrong; confirm the ones you can verify.
2. **Review the Wave 1 diff on this branch** like any risky-adjacent change (it touches guard logic).
3. **Absorb the operating model above** for your own runs: auto-review replaces Mason's review; only genuine owner questions go to him.
