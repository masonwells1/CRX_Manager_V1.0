# Handoff Prompt — Ultracode deep audit + fix → Codex audit → gated push (recovery branch)

Paste the block below to a fresh **Opus 4.8 (1M)** session with **ultracode ON**. It is self-contained; the new session has no memory of the recovery work. It must re-verify everything before acting.

---

You are picking up the CRX Manager "overlapping-sessions recovery". A prior session built a consolidation branch; your job is a deep multi-agent (ultracode) audit-and-fix of the WHOLE change set, then a Codex cross-review packet, then STOP for Mason's approval. Treat all of the following as CLAIMS — re-verify against live Supabase (project `rhyzpcqhnizqbxphqdkr`) and current git before trusting any of it.

## Boundaries (hard)
- Work ONLY in the recovery git worktree. Do NOT edit the shared `C:\CRX_Manager` checkout — another session may be active there.
- Do NOT push, merge to `main`, deploy Vercel, or apply any Supabase migration without Mason's explicit approval. Stop before all of those.
- Never edit a migration already applied live. The one pending migration `20260613150000_planned_holds_drawn_sync` is NOT applied — validate it rolled-back only.
- Preserve, do not delete/absorb, the untracked files in the shared checkout: `qwen-repo-review.md`, `src/components/team/EntityBadge.test.tsx`, `NoteCard.test.tsx`, `QuickTaskModal.test.tsx`.
- Do NOT change the 3 blank-recipient customer commission defaults (Test Farm Alpha / Tim Jondle / Yeley Farms) — Mason supplies the names. RUP expired-license legal classification is Mason's call.

## Starting facts to re-confirm
- Recovery branch: `recovery/overlapping-sessions-2026-06-13`, worktree `C:\CRX_Recovery` (off `origin/main`, ~25 commits ahead / 0 behind; `origin/main` is an ANCESTOR → merge is a fast-forward). If the worktree is gone, recreate: `git worktree add C:\CRX_Recovery recovery/overlapping-sessions-2026-06-13`.
- It unifies: origin/main + H1 (`feat/h1-quick-wins-2026-06-10`: applicator license gates / RUP / WPS / daily-brief) + `ship/partial-quote-draw-down` (partial draw-down + June-11 sweeps) + 3 H1 fixes + a re-homed planned-holds migration.
- Live migration high-water = `20260611211058`. `20260611132115` is NOT live (superseded on the branch by `20260613150000`). Recovery's 60 recent (≥2026-06-09) migration stamps == all 59 live + the 1 re-home.
- Last validated green: typecheck 0, lint 0, build clean, `npm run test` 136 files / 1,997 passed / 70 skipped, `check:docs` PASS, `verify:deps` PASS, `validate-sql-migrations.sh` exit 0.

## Your task — run the ULTRACODE dynamic workflow over the FULL diff
Scope = everything on `recovery` that is NOT on `origin/main`: `git diff origin/main...HEAD` (code + migrations + docs). Author a Workflow (multi-phase, adversarial) that:
1. **Understand** — fan-out readers map the change set by subsystem (quote/draw-down, jobs/applicator, RUP/compliance, planned-holds migration, invoices, merged `db.ts`/`types`/`QuoteBuilder.tsx`).
2. **Review (find)** across dimensions, each finding carrying a `file:line` or live-catalog citation:
   - Correctness/logic bugs (esp. the AUTO-MERGED `src/pages/QuoteBuilder.tsx`, `src/lib/db.ts`, `src/types/index.ts` — a clean text-merge does NOT guarantee correct behavior; diff vs BOTH parents and confirm both branches' behavior survived).
   - Security/RLS: re-run the `scripts/db-invariant-sweeps` predicates via Supabase MCP `execute_sql` and compare to `allowlist.json` (any non-allowlisted `violation_key` is a real finding). Plus actor-forgery, ungated SECDEF mutators, anon-exec SECDEF, missing `search_path`.
   - Migration fidelity: `20260613150000` — confirm §0 precondition baselines still match live md5 (`save_quote 980a624c…`, `create_planned_holds 912db30f…`, `restore_quote_version 9c5aedb1…`), §5 self-verify passes, and clean-rebuild ordering is sound (it must sort AFTER `20260611211058`).
   - Money (bigint cents, no float), types drift vs live, PDF output (WPS notice), lifecycle invariants, idempotency operation-scoping.
   - The H1 fixes: #4 atomic applicator override (JobDetail `performSave` + `jobSaveHelpers.ts`), #5 WPS dirty-guard, #6 RUP wording vs `generate_rup_sales_records`.
3. **Adversarially verify** every BLOCKER/HIGH (≥2 independent skeptics, or distinct lenses) against the LIVE DB before it counts — refute or confirm. Do NOT report unverified findings.
4. **Fix** confirmed errors in the worktree. For any migration change, prove it with a rolled-back `execute_sql` smoke (CREATEs + scenarios + final `RAISE 'SMOKE_PASS_ROLLBACK'`) — `execute_sql` runs a multi-statement string in ONE transaction, so the final RAISE rolls everything back with zero prod footprint (verify this atomicity with a throwaway probe first). Re-run the planned-holds chain `scripts/smoke/smoke-planned-holds-drawn-sync.sql` and require `SMOKE_PASS_ROLLBACK`.

## After the workflow
- Re-run the full battery: `npm ci`, `verify:deps`, `lint`, `typecheck`, `build`, `test`, `check:docs`, `validate-sql-migrations.sh`, the live invariant sweeps, and the rollback smoke chains (partial draw-down, draw reversal, order lock, restore guard, planned holds, idempotency sweep, customer statements, the H1 mutating RPCs).
- Regenerate the schema registry FROM LIVE via Supabase MCP introspection (the `regenerate-schema-registry.mjs` script only stamps — it does NOT pull live data; refresh the content), then re-run `check:docs`.
- Produce a **Codex cross-review packet** via `/codex-cross-review` (or the `codex-review` CLI skill if present) covering: the re-home migration, the H1 fixes, and the auto-merge of `QuoteBuilder.tsx`/`db.ts`/`types`. Land it in `docs/audits/`. Remediate any NEEDS-WORK, re-verify, repeat until Codex is SHIP/SHIP-WITH-FOLLOWUPS.
- Commit all fixes on the recovery branch. Do a final three-way merge forecast vs `origin/main` (expect a clean fast-forward).

## Stop and report
Return a blockers-first report: per-area findings (CONFIRM/REFUTE with evidence), fixes made, full validation results with exact test counts and smoke-chain outcomes, the Codex verdict, remaining owner decisions (3 commission names + RUP classification), and a direct verdict: `SAFE TO PUSH` / `SAFE TO REVIEW` / `NOT SAFE`. Then STOP — do not push, merge, deploy, or apply until Mason approves. Recommend the exact push sequence (apply `20260613150000` via the apply gate → regen registry → push recovery→main → retire `ship/partial-quote-draw-down` + `feat/h1-quick-wins-2026-06-10`).
