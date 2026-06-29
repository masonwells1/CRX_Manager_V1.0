# Field-App Beyond-Parity — Autonomous Build Loop (operating spec)

**Read this first.** This is the operating spec for the loop that builds the six beyond-parity field-app features Mason chose. Mason (owner) cannot read code — keep every status update plain-English. This loop mirrors the **proven `fieldapp-parity` loop** (same orchestrator + fresh-subagent-per-stage + Codex gate + never-prod safety + single owner gate at the end).

## Precondition (do NOT start until true)
- **The ChemMan-parity rebuild is shipped to live `main`** (`feat/fieldapp-parity` merged → `main` → deployed). These six features build on top of that field-app. If parity is not yet on `main`, STOP and tell Mason.
- Confirm with: parity work is in `origin/main` history (e.g. the field-app invoice engine, chemical-entry UI, dispatch, the read-only Unbilled list are all present on `main`).

## Where you are
- **Branch:** `feat/fieldapp-beyond-parity`, created off the **then-current `origin/main` AFTER parity ships** (so it inherits the full parity field-app). Create a dedicated worktree for it.
- **Run ONLY from a CRX-rooted session in that worktree** so `.claude` hooks, the `codex-review` / `codex-gauntlet` skills, the `create-migration` / `explain-migration` skills, and the reviewer subagents (`rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `compliance-reviewer`, `pdf-output-reviewer`) all load.
- **Run ONE instance only.** A scheduled task or a second interactive session looping the same checkout will collide (branch can switch under you; the git index is shared). Before each cycle, re-read `PROGRESS.json` fresh and `git status` to confirm you're alone and on the right branch.
- **Spec files (this folder `docs/build-loops/fieldapp-beyond-parity/`):**
  - `PLAN.md` — owner-facing plan (6 features, 10 sections, 4 phases).
  - `BACKLOG.json` — full spec. Sections are at **`.result[].sections[]`**; each has `id, name, feature, why, goal, beyond_parity_rationale, who_it_helps, acceptance_criteria[], subtasks[], reuses[], needs_migration, risk, depends_on[], gates[], notes`.
  - `PROGRESS.json` — machine state (status per section). **You maintain it.**
  - `LEDGER.md` — human-readable progress, regenerated from `PROGRESS.json`. **Source of truth for resume.**
  - `KICKOFF.md` — first action + resume playbook.

## Goal (bounded)
Build exactly the 10 sections in `BACKLOG.json` to satisfy their `acceptance_criteria`. **Do NOT invent features beyond this backlog.** If Mason changes the open sequencing decision (drop the portal this round, or move it earlier), re-order — but don't add new scope.

## HARD safety rules (never violate)
1. **Never push to `origin/main`.** Commit only to `feat/fieldapp-beyond-parity`.
2. **Never deploy to production. Never run a migration against the PRODUCTION database. Never delete production data.**
3. **Database changes:** write the migration FILE (use the `create-migration` skill conventions) and apply it **only to the LOCAL throwaway Supabase** (`C:\Users\mason\fieldapp-local-db`, refreshed to include parity migrations). Collect every migration file for the end gate.
4. **Production promotion happens ONCE, at the very end, ONLY with Mason's explicit approval.** Present every DB-changing section to him one-by-one in plain English (use `explain-migration`), apply migrations in TIMESTAMP order, then deploy.
5. **Money rules you don't know → build OFF by default, formula blank. Never invent a billing rule.**
6. **Auto-invoice (§4) auto-DRAFTS only — it must NEVER auto-post.** Posting is always a human click.
7. **Grower portal (§7–§10):** additive RLS only — never loosen an existing internal policy to enable the portal. Customer logins are outward-facing → dedicated security review + Mason's explicit sign-off before go-live.
8. **Customer emails (§6) are office-approved one-click sends, not silent automation** while Mason is internal-only.
9. **Edge-function changes (e.g. a new email_type) are PREPARED but NOT deployed** — the deploy is owner-gated.
10. **Weather stays on the existing free Open-Meteo** (`src/lib/weatherCapture.ts`). No paid provider.

## Architecture (stay lean / compaction-proof)
- You are the **ORCHESTRATOR**. Hold only LEDGER/PROGRESS state in your own context. **Do NOT build features in the main thread.**
- Hand **each section to a FRESH subagent** (clean context, `BUILD-SUBAGENT-TEMPLATE.md`). It reads its one BACKLOG section, builds, proves it runs, gets Codex review, fixes, and returns a SHORT structured result.
- After each section: update `PROGRESS.json` + regenerate `LEDGER.md` on disk, then **snapshot-commit both** (`docs(fieldapp-beyond-parity): ledger snapshot`) so an agent `git clean`/reset can't revert the tracker. Then continue. On any restart, **resume from `LEDGER.md`**.

## Build order (respect each section's `depends_on`)
**Phase 1** §1 Label-Data Backfill → §2 Watchdog · **Phase 2** §3 Office Cockpit → §4 Auto-Invoice (MONEY) · **Phase 3** §5 Label-Rate Guardrails · **Phase 4** §6 Proof Notification → §7 Portal Auth/RLS → §8 Portal Fields/History → §9 Portal Invoices → §10 Portal Compliance docs.
- §5 must come after §1 (needs label data). §2 should land before §3 (feeds the cockpit). §4 after §3 (queue surface). §8–§10 after §7 (portal auth/RLS foundation).

## Per-section loop
1. Spawn a fresh build subagent with the section's full BACKLOG entry + the local-DB env block.
2. It audits current code, then builds to satisfy **every** acceptance criterion, matching CRX patterns + the design system. Any DB change → `create-migration` skill, applied to LOCAL Supabase only.
3. **Verify "done = ran and proven":** actually run the app and exercise the feature (open the page, do the action, observe the result) — not "tests pass." Capture evidence. For DB/RPC work, run a rolled-back smoke against local.
4. **Codex review (the gate between stages):** run an independent Codex review of the section's diff via the `codex-review` skill (headless `codex` CLI). **Fix ALL High/Medium; park Low.** Hard cap 3 fix↔review rounds; if still not clean, mark the section PARTIAL with the open finding and surface it (don't loop forever).
   - **Risk-scaled extra review:** for §4 (money) add a money-lens pass; for §7–§10 (portal) run `rls-security-reviewer` + a security-lens Codex pass and **prove RLS at runtime as a grower** (incl. a negative "grower A can't read grower B" test) before the section counts as done.
   - **Codex fallback (if the CLI is rate-limited):** use an interim multi-lens adversarial reviewer agent (correctness + security + money/RLS), mark `codex: pending` in PROGRESS, and run a real Codex batch over all `codex: pending` sections at the end BEFORE the production gate.
5. Re-verify after fixes. Commit ONLY the section's files to `feat/fieldapp-beyond-parity` (never `.env`, never unrelated files; the pre-commit hook runs — never `--no-verify`).
6. Update `PROGRESS.json` + `LEDGER.md`; snapshot-commit. Next section.

## End of run
When all sections are DONE + a completeness pass ("does each feature actually deliver its acceptance criteria end-to-end?"):
1. **Real Codex batch** over any `codex: pending` sections (and re-confirm §4 money + §7 portal-RLS with cross-model review).
2. Write a **consolidated plain-English report** for Mason: each feature built + evidence; the full Parked-Low list; ALL migration files (each explained via `explain-migration`) that must apply to PRODUCTION, in order; every open question (e.g. a billing rule, the edge-fn deploy); the production-promotion plan; and the explicit risk items (the money flow, the portal's outside-facing logins).
3. **STOP at the PRODUCTION GATE (HARD STOP).** Do NOT promote or deploy until Mason approves. Then: apply migrations to PROD in timestamp order → deploy the code → (if §6 needs it) deploy the edge function with his OK → the §1 label-data load is his review-and-approve task → portal go-live is his explicit sign-off.
   - At apply time, bind each apply-guard proof to the **transmitted** SQL hash (the MCP strips a file's trailing newline — match the bytes you actually send), per the project's apply-guard gotcha.

## Notes
- Default DB model = local-test + review-at-end (no preview database), same as the parity loop.
- Keep `docs/CHANGELOG.md` + the reference docs current per CRX conventions as you go; re-run the doc generators at the gate.
- If anything is genuinely ambiguous and would change a money/safety/privacy outcome, park a question in `PROGRESS.json` `openQuestions` and keep building other sections — don't block the loop.
