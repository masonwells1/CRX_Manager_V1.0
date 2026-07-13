# Field-Application Parity — Autonomous Build Loop (KICKOFF)

**Read this first.** This is the operating spec for the autonomous loop that brings CRX-Manager's field-application side to full ChemMan parity. Mason (owner) cannot read code — keep all status updates plain-English.

## Where you are
- **Branch:** `feat/fieldapp-parity`, based on `origin/main` (`d65d15d7`) — the fully-merged base (field-map drawing + UI-overhaul-v2 + as-applied-invoices are ALL already in it).
- **Run ONLY from a CRX-rooted session in this worktree** so `.claude` hooks, the `codex-review` / `codex-gauntlet` skills, the `create-migration` / `explain-migration` skills, and the reviewer subagents load.
- **Spec files (this folder `docs/build-loops/fieldapp-parity/`):**
  - `PLAN.md` — owner-facing plan (the 41 sections, 5 phases).
  - `BACKLOG.json` — full spec. Sections are at **`.result[].sections[]`**; each has `name, why, chemman_target, acceptance_criteria[], subtasks[], needs_migration, depends_on[], notes`.
  - `LEDGER.md` — progress tracker. **You maintain it** (source of truth for resume).

## Goal (bounded)
Close the whole field-application gap vs ChemMan AND bring existing features to full ChemMan depth. "Done" = the `acceptance_criteria` in BACKLOG.json (derived from `C:\Users\mason\Documents\ChemMan-FieldApp-Capture.md`). **Do NOT invent features beyond the backlog.** SKIP aerial (flights/starts/airport strips) and Mixmate.

## HARD safety rules (never violate)
1. **Never push to `origin/main`.** Commit only to `feat/fieldapp-parity`.
2. **Never deploy to production. Never run a migration against the PRODUCTION database. Never delete production data.**
3. **Database changes:** write the migration FILE (use the `create-migration` skill conventions) and apply it **only to a LOCAL throwaway Supabase** (`supabase start` / local dev) for testing. Collect every migration file for the end gate.
4. **Production promotion happens ONCE, at the very end, ONLY with Mason's explicit approval.** Present the ~12 DB-changing sections to him one-by-one in plain English then (use `explain-migration`).
5. **Money rules you don't know (e.g. fuel-surcharge formula):** build as a setting **OFF by default, formula left blank**. Never invent a billing rule.
6. **Weather stays on the existing free Open-Meteo** (`src/lib/weatherCapture.ts`). Do not switch to a paid provider.

## Architecture (stay lean / compaction-proof)
- You are the **ORCHESTRATOR**. Keep your own context lean — hold only LEDGER state. **Do NOT build features in the main thread.**
- Hand **each section to a FRESH subagent** (clean context). It reads its one BACKLOG section, builds, tests, gets Codex review, fixes, verifies, and returns a SHORT structured result.
- After each section, update `LEDGER.md` on disk, then continue. This keeps the main thread small so auto-compact rarely triggers; on any restart, **resume from `LEDGER.md`**.

## Step 0 — fast re-audit (do this FIRST)
`origin/main` already shipped much field-app work. Before building, re-audit: for EACH of the 41 sections, check the current code and mark it in `LEDGER.md` as **DONE** (meets acceptance criteria), **PARTIAL**, or **TODO**. Only build PARTIAL + TODO. Parallelize with read-only subagents (one per area).

## Per-section loop (PARTIAL/TODO only)
Dependency order — respect each section's `depends_on`; overall: **P1 Jobs → P2 Applied/Compliance → P3 Invoicing → P4 Printouts → P5 Dispatch.**
1. Spawn a fresh build subagent with the section's full BACKLOG entry.
2. It audits current code, then builds to satisfy **every** acceptance criterion, following existing CRX patterns + design system. Any DB change → `create-migration` skill, applied to LOCAL Supabase only.
3. **Verify "done = ran and proven":** actually run the app and exercise the feature (open the page, do the action, observe the result) — not "tests pass." Capture evidence.
4. **Codex review** the section (`/codex-review` or `codex-gauntlet`). Fix ALL High/Medium findings. Park Low findings in LEDGER under "Parked-Low."
5. Re-verify after fixes. Commit to `feat/fieldapp-parity` with a clear message.
6. Update `LEDGER.md`: mark DONE, note evidence, parked-Low, and any migration file created.
7. Next section.

## End of run
When all PARTIAL/TODO sections are DONE + a final "what did we miss vs the ChemMan capture doc?" completeness pass:
- Write a **consolidated plain-English report**: each section built + evidence; the full Parked-Low list; ALL migration files created (each explained via `explain-migration`) that must apply to PRODUCTION; open questions (e.g. fuel-surcharge formula); and the production-promotion plan.
- **STOP. Present to Mason. Do NOT promote to production or deploy until he approves.** Then walk him through each migration before applying.

## Notes
- Default DB model = local-test + review-at-end (Mason chose this; no preview database). Non-DB sections still show on Vercel preview deploys as built.
- Keep CHANGELOG + docs current per CRX conventions as you go.
- If anything is genuinely ambiguous and would change a money/billing outcome, park a question in LEDGER and keep building other sections — don't block the loop.
