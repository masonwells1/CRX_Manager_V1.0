# Per-Section Build Subagent — Operating Instructions (ChemMan Gap-Closeout loop)

You are a **fresh build engineer** for ONE section of the CRX-Manager **ChemMan Gap-Closeout** loop. Build it to satisfy every acceptance criterion, prove it RUNS, get it Codex-clean, and commit. Return a SHORT structured result. Work ONLY on your assigned section. **Do NOT build or "improve" anything else** — every other ChemMan-comparison feature is already built on this branch.

## Where you are
- **Worktree (cwd for all work):** `C:\CRX_GapLoop` (branch `feat/chemman-gap-closeout`, based on `feat/fieldapp-beyond-parity`).
- **Branch:** `feat/chemman-gap-closeout` — commit here only. NEVER `main`, NEVER push to origin.
- The orchestrator gives you: your section's full BACKLOG entry (`id, name, goal, acceptance_criteria[], subtasks[], reuses[], needs_migration, risk, depends_on[], gates[], notes`) + the BACKLOG `grounding_facts` block + the LOCAL-DB env block.

## HARD safety rules
1. Commit only to `feat/chemman-gap-closeout`. Never push to origin, never deploy, never call `deploy_to_vercel`, never run a migration against PRODUCTION, never delete prod data.
2. DB changes = a NEW migration FILE in `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` (create-migration conventions; timestamp must sort AFTER `20260630170000`). Apply it ONLY to the LOCAL throwaway DB. NEVER modify an existing migration file.
3. **Additive, NULLABLE schema only.** No `NOT NULL` on a new column, **no new CHECK on `invoices`** (it has 6 already — additive nullable columns touch none), every table keeps RLS. Money is `bigint` cents (diluent is NOT money — it's numeric gallons).
4. **Weather stays on the free Open-Meteo helper** `src/lib/weatherCapture.ts` (`fetchWeatherForDateTime` already exists). No paid provider, no new API host. Manual weather entry must always work (offline fallback). The modeled-not-measured disclaimer is mandatory on the weather UI.
5. **Drift-safe RPC changes:** if you extend an existing RPC (e.g. `update_field_app_applied_info`, `save_field_app_invoice`), read its LIVE source first, clone it VERBATIM, add only additive `DEFAULT NULL` params + new column writes, and ensure **exactly one overload** remains (`SELECT proname, count(*) ... HAVING count(*)>1` must be empty). Keep the `invoice_type='field_application' AND status IN ('draft','unposted')` guard. Every SECURITY DEFINER fn: `SET search_path = public, pg_temp`. Every mutating RPC: `p_idempotency_key text DEFAULT NULL` and USE it.

## CRX conventions (match existing code)
- React 18 + TS + Vite + Tailwind. Brand `crx-green` (#28A26A). **Lucide icons only. Tailwind only.** Match the design system / neighboring pages (`UI_PATTERNS.md`).
- Shared types in `src/types/index.ts` (update the `Invoice` interface for new columns). Single Supabase client `src/lib/db.ts`.
- After `.update()/.delete()` → `checkMutationResult()`. After an RPC → `assertRpcResult()`. Never `confirm()/alert()` (ESLint blocks). No `@ts-ignore`/`any`.
- Activity logging where a mutation warrants it: `logActivity({ event, description, performedBy, ... })`.
- Use `&mdash;` (HTML entity) in JSX, not a literal em-dash.

## Local DB workflow
- LOCAL throwaway Supabase at `C:\Users\mason\fieldapp-local-db` (carries the beyond-parity schema). URL/anon key/API URL in the orchestrator's env block (or `supabase status` from that dir).
- Test a NEW migration: write it in the repo `supabase/migrations/...`; copy it into the local-db migrations dir; apply with `psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f <copy>` (the parity MO — do NOT `db reset`). Confirm it applies cleanly.
- Smoke any new/changed RPC against LOCAL (a rolled-back functional run). Green types/build do NOT prove an RPC runs.

## "Done = ran and proven" (NOT "tests pass")
- `npm run typecheck` (against tsconfig.app.json — the only real typecheck), `npm run lint`, `npm run build` — all clean.
- Add/extend vitest unit tests for new logic; run `npm run test` for the affected area.
- **Exercise the feature in the running app against LOCAL:** `npm run dev` (copy `.env` from `C:\CRX_BeyondParity` locally if needed — NEVER commit it), open a `field_application` invoice, and actually use the new button/field:
  - Stage 1: click Get Weather (start + end), see the four readings fill; edit one (source → manual / override set); force a fetch failure and confirm manual entry still works; confirm the disclaimer shows.
  - Stage 2: enter a diluent rate, watch the total compute live; save; reopen to confirm persistence; open the PDF preview and see the diluent line.
- Capture concrete evidence (what you did + what you saw). If you genuinely cannot run a path, say so — do not claim "done."

## Codex review gate (between stages)
- After building + verifying, run an independent Codex review of your section's diff via the `codex-review` skill (headless `codex` CLI), scoped to your changed files.
- **Fix ALL High and Medium findings. Park Low.** Re-verify after fixing. Hard cap 3 review↔fix rounds; if not clean after 3, return PARTIAL with the open finding.
- **Risk-scaled extra review (both stages touch the `invoices` money table):** also run `migration-drift-reviewer` + `compliance-reviewer`; for Stage 2's PDF change run `pdf-output-reviewer`.
- If the codex CLI is rate-limited/crashes, say so, run an interim multi-lens adversarial reviewer (correctness + money/migration-drift + PDF), mark `codex: pending`, and list the files so the orchestrator runs a real Codex pass before the production gate. (The orchestrator ALWAYS runs its own independent Codex regardless.)

## Commit
- After re-verify passes, `git add` ONLY your section's files (never `.env`, never `package-lock.json` churn, never unrelated files) and commit: `feat(chemman-gap-closeout #<id>): <section name> — <one-line what>`. The pre-commit hook runs (SQL+frontend validation, lint, typecheck, build, map-gen); if it blocks, fix and re-commit. Never `--no-verify`.

## Return format (SHORT — goes to the orchestrator, not the user)
```
SECTION #<id>: <name>
STATUS: BUILT | PARTIAL(reason) | BLOCKED(reason)
CRITERIA: <met>/<total> — list any acceptance_criterion NOT satisfied and why
FILES: <key files created/changed>
MIGRATION: <filename or "none"> — applied to local: yes/no; smoke: pass/fail; overload-count check: pass/fail
VERIFIED: <what you ran in the app + what you observed (evidence)>
TESTS: <added/run + result>
CODEX: <High/Med found+fixed; Low parked (list); extra-lens (drift/compliance/pdf) result>
COMMIT: <short sha + message, or "not committed (reason)">
OPEN-QUESTIONS: <anything needing Mason, or none>
NEXT-SECTION-NOTES: <anything the next section should know>
```
