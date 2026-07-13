# Field-App Parity Loop — PAUSED (resume playbook)

**Paused:** 2026-06-26, by Mason's request ("pause at a stopping point").
**Resume trigger:** Mason says to continue (e.g. "resume the field-app parity loop").

## Where we are
- **37 / 41 sections BUILT** — all committed, multi-lens reviewed, and recorded. Branch `feat/fieldapp-parity`; latest ledger snapshot is the most recent `docs(fieldapp-parity): ledger snapshot` commit.
- **Phases 1–4 COMPLETE** (Jobs, As-applied, Invoicing, all 8 Printouts incl. #16 Map/Logs + Attachments).
- **Phase 5 Dispatch = 3/7 done:** #35 dispatch board (dark field/tablet mode), #36 per-location dispatch + 3-step wizard (table `job_location_dispatches` + RPCs), #37 Dispatched List + reassign/undispatch.
- **Worktree is CLEAN** at the pause (no uncommitted WIP this time — unlike the first pause). Only untracked `supabase/.gitignore` + `supabase/config.toml` (harmless local artifacts).

## FIRST action on resume — build #38
Next in build order: **#38 Phone/mobile applicator field view** (TODO, needs_migration likely FALSE but verify a read gap — see below). Launch a fresh build subagent (BUILD-SUBAGENT-TEMPLATE.md). Spec:
- A phone-width, touch-friendly applicator view: clean job CARDS (NOT the wide office table), defaulting to the signed-in applicator's OWN assigned jobs. **Reuse `get_dispatched_list()` called with NO args** — an applicator caller already sees only their own dispatched rows (per #37).
- Tap a card → expand a **READ-ONLY** card showing: Customers, Locations, Chemicals/Charges, Crops, Scheduled Date. List/Map toggle; map plots the applicator's job locations (reuse CRXMap / `get_job_fields_with_geojson` from #16; local has no map tiles — list view is the provable path).
- READ-ONLY (no pricing/job-setup edits). **NOT blocked by the dispatch lifecycle-auth open question** (that's for a future "mark work done" action, not this read-only view).
- **READ-ACCESS CHECK (load-bearing):** verify a per-location-dispatched applicator can actually READ every card field as themselves — especially `job_chemicals` (the #36 additive policies covered jobs/job_fields/customers, NOT necessarily job_chemicals). If there's a gap, either add a dispatched-applicator SELECT policy on job_chemicals (mirror #36's `_is_dispatched_to_me` pattern, a small migration) OR build a SECDEF read RPC that returns the card data RLS-correctly (like get_dispatched_list / get_job_fields_with_geojson). Prove it as the applicator, not just admin.
- Verify on a phone-width viewport (cards, expand to read the 5 fields, map/list toggle).
Then the remaining Phase-5 sections in order: **#39** Filter jobs by recipe in the field (the OPTIONS 'Filter Jobs By Recipe' entry + shared `DispatchFilters.recipeId` already exist; flesh out the recipe-filter UX; for the Dispatched List add recipe to get_dispatched_list, don't reuse the hidden job-filter toolbar). **#40** Pre-notification to customer (DB; a new email_type + the send-email Edge Function gates email_type by role — the EDGE FUNCTION DEPLOY is gated and needs Mason at the production gate; #40 can PREPARE the edge change but not deploy it). **#41** Post-notification to customer (a per-job/invoice customer-facing notification log does NOT exist yet — needs its own table/log).

## Loop mechanics
- Build each PENDING section via a FRESH background subagent; it runs its own Codex gate + proves in-app vs LOCAL.
- Orchestrator then: spot-check (HEAD/tree/typecheck/migration-objects-on-local) + a multi-lens adversarial review Workflow (`C:\Users\mason\fieldapp-local-db\_review-section.cjs`, args {commit,section,n,risk:'db'|'ui'|'money',files}); fix all High/Med via a follow-on fix agent; park Low.
- Record in `PROGRESS.json` via a `_record-N.cjs` in `C:\Users\mason\fieldapp-local-db\`; regen `LEDGER.md` via `_gen-ledger.cjs`; **snapshot-commit PROGRESS.json + LEDGER.md after each section** (`docs(fieldapp-parity): ledger snapshot`) so an agent git-clean can't revert the unstaged ledger to a stale HEAD. (Recovery scripts `_record-9..37.cjs` exist if it ever drifts.)
- Build sequentially (Phase-5 sections share DispatchBoard.tsx).

## HARD safety rules (still in force)
Never push origin/main; commit only to `feat/fieldapp-parity`. Never deploy, never run a migration against PROD, never delete prod data. Migrations apply to LOCAL throwaway only. Production promotion happens ONCE at the very end, ONLY with Mason's explicit approval. Money rules unknown → build OFF/blank, never invent a billing rule. Weather stays on free Open-Meteo.

## END-OF-RUN tasks (before the production gate)
1. **Real Codex batch** over the earlier risky money/migration commits that only got the interim multi-lens review (codex `pending`/`partial` in PROGRESS.json): #1, #6, #18, #24, #25, #27, #28, #32, #33 + the #12 hardening `1f1b564`. Address any High/Med. (#9-#16 + #35-#37 already had real Codex.)
2. **Add the hard-guard test** parked under #12: a pgTAP/SQL-assertion (or `scripts/db-invariant-sweeps`) regression test for `_enforce_billed_job_immutability` (non-admin soft-delete + billed-field rewrite on an invoiced job RAISE; exempt paths pass).
3. **Harden #12/#13 NUL keys** (parked #14 Low): switch chemicalSummaryReportData/projectedUseReportData product+unit keys from space/'|' to a NUL delimiter.
4. **Doc-sync** (counts drifted ~28: migrations 517→545 on disk, pages, RPCs, tables): `/update-docs` + `node scripts/regenerate-agents-md.mjs` + `regenerate-schema-registry.mjs`; reconcile the docs/reference/*.md counts + CLAUDE.md Snapshot.
5. **PROD-GATE storage smoke (#16):** after the job_attachments bucket migration applies to prod, one real authenticated upload + signed-URL download + oversized/disallowed-type reject (confirm the prod storage-api populates owner_id; map render needs VITE_MAPBOX_TOKEN).
6. **Consolidated plain-English report** for Mason, then the **PRODUCTION GATE** (HARD STOP — needs Mason's explicit approval): apply ALL fieldapp-parity migrations in TIMESTAMP order to PROD *before* deploying the branch code (many frontend queries select migration-added columns). #40 pre-notification needs an edge-function deploy (gated — Mason).

## OPEN QUESTIONS for Mason (non-blocking; surface at the report)
- **Fuel-surcharge formula (#32):** built OFF by default, formula BLANK — needs his real surcharge rule to turn on.
- **Projected-use acre basis (#13):** uses Σ field acres (`acres_to_treat`) + the not-yet-applied portion — confirm vs the job header `total_acres` / full-scheduled-acres.
- **Dispatch lifecycle-auth (#36; gates how #38 works for an applicator DOING the work):** should an applicator dispatched only a LOCATION (or a crew member) be allowed to start/complete the job? Today only the whole-job applicator can. #38 itself is read-only so it's NOT blocked, but the "applicator marks the work done on mobile" capability needs this decision. (Codex follow-up task_ca5cb456.)
- See `PROGRESS.json` per-section `openQuestions` + the LEDGER "Parked-Low" list for the rest.

**Source of truth for resume = `LEDGER.md` (regenerated from `PROGRESS.json`) + this file.**
