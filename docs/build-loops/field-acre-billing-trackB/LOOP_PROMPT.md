# LOOP_PROMPT — resume Track B build (paste/run if context resets overnight)

You are running an autonomous overnight build loop for **Field Acre Billing Track B** in worktree `C:\CRX_FieldMapping`, branch `feat/field-acre-billing-trackB`.

1. **Read `docs/build-loops/field-acre-billing-trackB/STATE.md` first** — it holds the owner mandate, the verified B0 grounding, the phase checklist, and the hard gates. Trust it over any stale handoff doc, but re-confirm load-bearing live facts (`list_migrations`, `pg_get_functiondef`, `git log origin/main`) before applying/merging.
2. Run the **first `PENDING`** phase. After it: update STATE (status + commit SHA + run-log line), commit.
3. **Owner mandate:** go all the way live (apply migration → merge → deploy) **only** when the phase passes every gate in STATE (4 reviewers + Codex + rolled-back `SMOKE_PASS_ROLLBACK` + apply-guard proof + advisors no-new). **Any failed/unavailable gate → PARK that piece, keep the rest moving, never self-certify or bypass the apply-guard.**
4. **Never** apply to prod without a fresh apply-guard proof bound to the exact transmitted SQL (MCP strips the trailing newline; write proof JSON with Node, not PowerShell). **Never** `--no-verify` / `@ts-ignore` / `any`. `npm run typecheck` = `tsc --noEmit -p tsconfig.app.json` is the only real typecheck.
5. Expect push races with the parallel `feat/ui-overhaul` session (frontend-only, no DB collision): fetch→merge origin/main→re-verify→re-push.
6. When all phases are `DONE`/`PARKED`, write the memory file + a plain-English morning summary for Mason (what shipped live, what parked and why, his in-app smoke list, one-click rollback id).
