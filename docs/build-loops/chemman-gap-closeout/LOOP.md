# ChemMan Gap-Closeout — Autonomous Build Loop (operating spec)

**Read this first.** This is the operating spec for the loop that closes the **last two ChemMan-gap items** on the field-application invoice. Mason (owner) cannot read code — keep every status update plain-English. This loop mirrors the proven `fieldapp-beyond-parity` loop (same orchestrator + fresh-subagent-per-stage + Codex gate + never-prod safety + a single owner gate at the very end).

## Where you are
- **Branch:** `feat/chemman-gap-closeout`, created off `feat/fieldapp-beyond-parity` (which already contains all the beyond-parity field-app work). Worktree: `C:\CRX_GapLoop`.
- **Run ONLY from a CRX-rooted session in that worktree** so `.claude` hooks, the `codex-review` / `codex-gauntlet` skills, the `create-migration` / `explain-migration` skills, and the reviewer subagents (`rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `compliance-reviewer`, `pdf-output-reviewer`) all load.
- **Run ONE instance only.** A second session/worktree on the same checkout will collide (the branch can switch under you; the git index is shared). Before each cycle, re-read `PROGRESS.json` fresh and `git status` to confirm you're alone and on `feat/chemman-gap-closeout`. **If you see edits you didn't make, STOP and tell Mason.**
- **Spec files (this folder `docs/build-loops/chemman-gap-closeout/`):**
  - `PLAN.md` — owner-facing plan (the two gaps + the safety gates).
  - `BACKLOG.json` — full spec. Sections are at **`.result[].sections[]`**; each has `id, name, feature, why, goal, acceptance_criteria[], subtasks[], reuses[], needs_migration, risk, depends_on[], gates[], notes`.
  - `PROGRESS.json` — machine state (status per section). **You maintain it.**
  - `LEDGER.md` — human-readable progress, regenerated from `PROGRESS.json`. **Source of truth for resume.**
  - `KICKOFF.md` — first action + resume playbook.
  - `BUILD-SUBAGENT-TEMPLATE.md` — the prompt each build engineer gets.

## Goal (bounded — do NOT expand)
Build **exactly the two sections** in `BACKLOG.json` to satisfy their `acceptance_criteria`:
1. **Weather auto-fill** on the field-application invoice (extend the existing free Open-Meteo helper to fetch at a timestamp; capture START + END; manual override always allowed).
2. **Diluent / carrier-water per acre** on the field-application invoice (rate input + computed total, persisted + shown on screen and printout).

**Everything else from the ChemMan comparison is ALREADY BUILT on this branch — do NOT rebuild it.** Before touching anything, confirm. The already-done items: mass-edit jobs, printed/dispatched flag, fuel surcharge, consultant field, per-line warehouse + vendor, job batching, master-mix summary, per-customer discount, customer-vs-internal notes. If a "third gap" seems to appear, park a question in `PROGRESS.json` `openQuestions` — do **not** add scope.

## HARD safety rules (never violate)
1. **Never push or merge to `origin/main`.** Commit only to `feat/chemman-gap-closeout`.
2. **Never deploy. Never call `deploy_to_vercel`. Never run a migration against the PRODUCTION database. Never delete production data.**
3. **Database changes:** write the migration FILE (use the `create-migration` skill conventions) and apply it **only to the LOCAL throwaway Supabase** (`C:\Users\mason\fieldapp-local-db`). Collect every migration file for the end gate. Never modify an existing migration file.
4. **Additive, NULLABLE schema only.** No `NOT NULL` on a new column on an existing table, no new `CHECK` on an existing table, every table keeps RLS, money is `bigint` cents. The two migrations add only nullable columns to `invoices` (a money table) — additive, so they touch none of its 6 existing CHECK constraints.
5. **Weather stays on the existing free Open-Meteo helper** (`src/lib/weatherCapture.ts`). **No paid weather provider.** Extend the helper to fetch at a given timestamp (it already underpins JobDetail's weather capture and the structured start/end model on `job_applied_records`).
6. **Manual weather entry must always work** (offline / no-signal fallback). Auto-fill never erases the ability to type values by hand.
7. **Compliance disclaimer is mandatory** on the weather UI: *"weather is modeled, not measured — verify on-site before relying on it for compliance."*
8. **Production promotion happens ONCE, at the very end, ONLY with Mason's explicit approval.** Present each DB-changing stage in plain English (use `explain-migration`), apply migrations in TIMESTAMP order, then deploy. **HARD STOP** until he approves.

## The data model facts (grounded against live, 2026-06-30)
- **The field-application invoice IS the `invoices` table** (`invoice_type='field_application'`). Live carries 0 field_application invoices yet (operationally empty) — the columns exist, the data doesn't.
- **Today's weather on the invoice is unstructured + manual:** `invoices.temperature_text` (text) + `invoices.wind_direction` (text). Keep these (additive); the new structured columns are added alongside.
- **Acres on the invoice:** `invoices.total_acres` (numeric). The diluent total = rate × the invoice's acres.
- **Mirror the proven structured weather model on `job_applied_records`:** `start_temp_f / start_wind_mph / start_wind_direction / start_humidity_pct / start_weather_source / start_weather_time` and the matching `end_*` set. Use the same column names/shape on `invoices` for consistency, plus a `weather_manual_override` flag.
- **Diluent/carrier already exists at the JOB level** (`jobs.carrier_rate_gpa`, `job_chemicals.diluent_rate`) but **NOT on `invoices`** — that's the gap. Add `diluent_rate_per_acre` (nullable numeric, gal/acre) + a persisted computed total (a GENERATED column, mirroring how `invoices.balance_cents` is generated).
- **New migration timestamps must sort after `20260630170000`** (the newest on disk). Use e.g. `20260630180000` (weather) and `20260630190000` (diluent).

## Architecture (stay lean / compaction-proof)
- You are the **ORCHESTRATOR**. Hold only LEDGER/PROGRESS state in your own context. **Do NOT build features in the main thread.**
- Hand **each section to a FRESH subagent** (clean context, `BUILD-SUBAGENT-TEMPLATE.md`). It reads its one BACKLOG section, builds, proves it runs, gets Codex review, fixes, and returns a SHORT structured result.
- **Both stages touch the `invoices` money table → build them on Opus 4.8.** Read-only grounding/search subagents may use Sonnet 5. Fable is unavailable.
- After each section: update `PROGRESS.json` + regenerate `LEDGER.md` on disk, then **snapshot-commit both** (`docs(chemman-gap-closeout): ledger snapshot`) so an agent `git clean`/reset can't revert the tracker. Then continue. On any restart, **resume from `LEDGER.md`**.

## Build order
**Stage 1 — Weather auto-fill** → **Stage 2 — Diluent per acre.** They are independent (both additive columns on `invoices`); building weather first keeps the two migrations cleanly separated in timestamp order.

## Per-section loop
1. Spawn a fresh build subagent (Opus 4.8) with the section's full BACKLOG entry + the local-DB env block.
2. It audits current code, then builds to satisfy **every** acceptance criterion, matching CRX patterns + the design system. Any DB change → `create-migration` skill, applied to LOCAL Supabase only.
3. **Verify "done = ran and proven":** actually run the app and exercise the feature (open the field-app invoice, click "Get Weather" / enter a diluent rate, observe the result) — not "tests pass." Capture evidence. For DB/RPC work, run a rolled-back smoke against local.
4. **Codex review (the gate between stages):** run an independent Codex review of the section's diff via the `codex-review` skill (headless `codex` CLI). **Fix ALL High/Medium; park Low.** Hard cap 3 fix↔review rounds; if still not clean, mark the section PARTIAL with the open finding and surface it (don't loop forever).
   - **Risk-scaled extra review:** both stages modify a row on the `invoices` money table → add the `migration-drift-reviewer` + `compliance-reviewer` lenses; the diluent printout change → `pdf-output-reviewer`.
   - **Codex fallback (if the CLI is rate-limited/crashes):** use an interim multi-lens adversarial reviewer agent (correctness + money/migration-drift + PDF), mark `codex: pending` in PROGRESS, and run a real Codex batch over all `codex: pending` sections at the end BEFORE the production gate. **Always run the orchestrator's own independent Codex even after a subagent self-reviews** (a beyond-parity §6 lesson — subagent reviewers missed a data-flow bug the orchestrator's Codex caught).
5. Re-verify after fixes. Commit ONLY the section's files to `feat/chemman-gap-closeout` (never `.env`, never `package-lock.json` churn, never unrelated files; the pre-commit hook runs — never `--no-verify`).
6. Update `PROGRESS.json` + `LEDGER.md`; snapshot-commit. Next section.

## End of run
When both sections are DONE + a completeness pass ("does each feature deliver its acceptance criteria end-to-end?"):
1. **Real Codex batch** over any `codex: pending` sections.
2. Write a **consolidated plain-English report** for Mason: each feature built + the evidence seen; the Parked-Low list; BOTH migration files (each explained via `explain-migration`) to apply to PRODUCTION, in timestamp order; any open question; the production-promotion plan; and the **beyond-parity-must-go-first** flag.
3. **STOP at the PRODUCTION GATE (HARD STOP).** Do NOT promote or deploy until Mason approves. Then: (confirm beyond-parity is on `main` first/together) → apply the two migrations to PROD in timestamp order → deploy the code. At apply time, bind each apply-guard proof to the **transmitted** SQL hash (the MCP strips a file's trailing newline — match the bytes you actually send). After applying: `/regen-schema-registry` + the db-invariant-sweeps.

## Notes
- Default DB model = local-test + review-at-end (no preview database), same as the parity/beyond-parity loops.
- Keep `docs/CHANGELOG.md` + the reference docs current per CRX conventions; re-run the doc generators at the gate.
- If anything is genuinely ambiguous and would change a money/safety/compliance outcome, park a question in `PROGRESS.json` `openQuestions` and keep building the other section — don't block the loop.
