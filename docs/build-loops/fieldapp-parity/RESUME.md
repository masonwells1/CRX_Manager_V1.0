# Field-App Parity Loop — PAUSED (resume playbook)

**Paused:** 2026-06-25, by Mason's request ("pause, I'll resume when ready").
**Resume trigger:** Mason says to continue (e.g. "resume the field-app parity loop").

## Where we are
- **33 / 41 sections BUILT** — all committed, reviewed (multi-lens), and recorded. Branch `feat/fieldapp-parity`, latest ledger snapshot commit before pause.
- **Phases 1–3 COMPLETE** (Jobs, As-applied, Invoicing). **Phase 4 Printouts = 7/8 done** (#9 applicator sheet, #10 loader, #11 chem app report, #12 chem summary, #13 projected use, #14 master mix, #15 print job list).
- **#16 (Map/Logs + Attach Log Files) = IN-PROGRESS, NOT finished.** Its near-complete work was stopped mid-Codex and is preserved in a git stash.

## FIRST action on resume — finish #16
1. `cd C:\CRX_Manager\.claude\worktrees\fieldapp-parity` and **`git stash pop`** to restore #16's WIP (stash message: "WIP #16 map/logs + attachments (near-complete, stopped mid-Codex)"). If the stash is gone, rebuild #16 fresh from BACKLOG.json #16 + STEP0-AUDIT #16 (the build-agent prompt pattern is in BUILD-SUBAGENT-TEMPLATE.md).
   - WIP files: migration `supabase/migrations/20260625200000_job_attachments.sql` (already applied to LOCAL), `src/components/jobs/JobAttachments.tsx`, `src/components/jobs/JobFieldMap.tsx`, `src/lib/jobAttachments.ts`(+test), `src/lib/jobAttachmentsData.ts`(+test), edits to `src/pages/JobDetail.tsx` / `Jobs.tsx` / `src/types/index.ts` / `supabase.ts`.
   - Agent state when stopped: "build clean, re-running Codex to confirm 3 findings resolved." So it BUILT + was finishing its Codex gate.
2. Finish #16: confirm/finish Codex, fix any High/Med, then the orchestrator MUST do a **SECURITY spot-check via psql** (the high-risk part): `job_attachments` RLS + `storage.objects` policies for bucket `job-attachments` — prove cross-job/cross-user isolation + anon denied, mirroring the live `jobs` visibility predicate. Then a multi-lens review (`risk:'db'`). **CAVEAT:** the local stack has NO storage API *container* (storage schema/tables exist, but no file-bytes round-trip locally) — so the actual upload/download BYTES round-trip is a PRODUCTION-GATE verification item; prove security + table/list/scoping via psql + UI, and verify bytes at the gate.
3. Record #16 BUILT via a `_record-16.cjs` (see the pattern in `C:\Users\mason\fieldapp-local-db\_record-15.cjs`), regen LEDGER, **snapshot-commit the ledger**.

## Then — Phase 5 Dispatch (#35–41), the FINAL phase (build order tail)
#35 dispatch board (PARTIAL) · #36 per-location dispatch + 3-step wizard (DB) · #37 assigned-to + Dispatched-Jobs list · #38 phone/mobile applicator field view · #39 filter jobs by recipe in field · #40 pre-notification to customer (DB; edge-fn change needs Mason at gate) · #41 post-notification to customer. Build each via a fresh subagent (BUILD-SUBAGENT-TEMPLATE.md), spot-check + multi-lens review, fix High/Med, record + snapshot-commit, next.

## Loop mechanics (how this orchestration runs)
- Build each PENDING section via a FRESH background subagent; the agent runs its own Codex gate and proves it in-app vs LOCAL.
- Orchestrator then: spot-check (HEAD/tree/typecheck/migration on local) + a multi-lens adversarial review Workflow (`C:\Users\mason\fieldapp-local-db\_review-section.cjs`, args {commit,section,n,risk,files}); fix all High/Med (a follow-on fix agent); park Low.
- Record in `PROGRESS.json` via a `_record-N.cjs` script in `C:\Users\mason\fieldapp-local-db\`; regen `LEDGER.md` via `_gen-ledger.cjs`; **snapshot-commit PROGRESS.json+LEDGER.md after each section** (a `docs(fieldapp-parity): ledger snapshot` commit) so an agent git-clean can't revert the unstaged ledger to a stale HEAD (that happened once; recovery scripts `_record-9..15.cjs` exist).
- Build sequentially (Phase-1/4/5 sections share Jobs.tsx/JobDetail.tsx — concurrent agents clobber).

## HARD safety rules (still in force)
Never push origin/main; commit only to `feat/fieldapp-parity`. Never deploy, never run a migration against PROD, never delete prod data. Migrations apply to LOCAL throwaway only. Production promotion happens ONCE at the very end, ONLY with Mason's explicit approval. Money rules unknown → build OFF/blank, never invent a billing rule. Weather stays on free Open-Meteo.

## END-OF-RUN tasks (before the production gate)
1. **Real Codex batch** over the earlier risky money/migration commits that only got the interim multi-lens review (codex `pending`/`partial` in PROGRESS.json): #1, #6, #18, #24, #25, #27, #28, #32, #33 + the #12 billed-job-immutability hardening `1f1b564`. Address any High/Med.
2. **Add the hard-guard test** parked under #12: a pgTAP/SQL-assertion (or `scripts/db-invariant-sweeps`) regression test for `_enforce_billed_job_immutability` (non-admin soft-delete + billed-field rewrite on an invoiced job RAISE; exempt paths pass) — converts the manual proof into CI.
3. **Harden #12/#13 NUL keys** (parked #14 Low): switch chemicalSummaryReportData/projectedUseReportData product+unit keys from space/'|' to a NUL delimiter (collision safety).
4. **Doc-sync** (counts ~22 behind): `/update-docs` + `node scripts/regenerate-agents-md.mjs` + `regenerate-schema-registry.mjs`; reconcile migration-history.md / CLAUDE.md / database-schema / rpc-functions counts.
5. **Consolidated plain-English report** for Mason, then the **PRODUCTION GATE** (HARD STOP — needs Mason's explicit approval): apply ALL fieldapp-parity migrations in timestamp order to PROD *before* deploying the branch code (several frontend queries select migration-added columns). #40 pre-notification needs an edge-function change deployed (gated — Mason).

## OPEN QUESTIONS for Mason (non-blocking; surface at the report)
- **Fuel-surcharge formula (#32):** built as a setting OFF by default, formula BLANK — needs his real formula/rate to turn on.
- **Projected-use acre basis (#13):** now uses Σ field acres (`acres_to_treat`) and the not-yet-applied portion — confirm vs job header `total_acres` / full-scheduled-acres.
- See `PROGRESS.json` per-section `openQuestions` + the LEDGER "Parked-Low" list for the rest.

**Source of truth for resume = `LEDGER.md` (regenerated from `PROGRESS.json`) + this file.**
