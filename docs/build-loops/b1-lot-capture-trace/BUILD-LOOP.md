# Build Loop — B1: Lot Capture & Trace (autonomous, Codex-gated)

> **What this is.** A self-running runbook for a **fresh, dedicated session** to build B1 to "ready," using **Codex as both a helper (design assist) and a reviewer (gate) on every phase**, then **stop at the human gates**. Read `SCOPE-OF-WORK.md` first. Track progress in `STATE.md` — update it after every phase so the loop is **resumable** (a crash/restart re-reads STATE and continues).

## How to run it (the loop driver)
On each turn: **read `STATE.md` → execute the *first* phase whose status is `PENDING` (in order) → on success, mark it `DONE` in `STATE.md` with the commit SHA + Codex verdict → continue.** If the next phase's status is `BLOCKED`, `IN-PROGRESS`, or `AWAITING-OWNER-APPROVAL`, **STOP and do not run it** — those states need a human (don't re-run a phase that isn't `PENDING`). Stop also when (a) a **hard gate** is reached, (b) a phase is stuck after the round cap, or (c) all phases are `DONE`. Launch it self-paced with `/loop` (see `README.md`). It runs unattended; it does not need the owner between phases — only at the final human gate.

## Codex is used TWO ways every phase
- **Helper (before/while building):** `codex exec "<question/design draft>"` — non-interactive. Ask Codex to critique the design, propose SQL/RLS, spot edge cases, sanity-check an approach *before* you commit code. Use its suggestions as input, not gospel — you still own the decision.
- **Reviewer (after committing the phase):** **`git fetch origin` first**, then `/codex-review` scoped to **`origin/main`** (review against the freshly-fetched remote / the verified merge-base, never a possibly-stale local `main` — a stale base manufactures false drift). The project skill runs `codex review` non-interactively, writes findings to `.claude/session-state/codex-review-latest.txt`, returns a verdict (SHIP / SHIP-WITH-FOLLOWUPS / NEEDS-WORK). Act on BLOCKER/HIGH via the fix loop; re-review until SHIP. **Commit before reviewing** — never `codex review --uncommitted` (it stashes your tree). If the CLI/auth is down, STOP and hand off (`/codex-cross-review` packet) — never skip the gate.

## Per-phase recipe (apply to every build phase)
1. **Helper pass** — `codex exec` to pressure-test the design for this phase; fold in what's sound.
2. **Build** — implement just this phase. Honor the `AGENTS.md` CRX Hard Rules + canonical patterns (money=cents, RLS on every table, `checkMutationResult`/`assertRpcResult`, idempotency, strict-actor, `search_path`, lazy pages, Lucide, single db client). The PreToolUse hooks will block bad writes — treat a block as a real defect.
3. **Prove it runs** (Step-2.5 discipline — "done = ran and proven," not "tests pass"). Preferred: a **Supabase dev branch** — `create_branch` → **record its branch ID in `STATE.md`** → `apply_migration` *only* against that recorded non-prod branch ID → exercise → discard. **Target-lock (mandatory):** never call `apply_migration` unless the target is that recorded non-prod dev-branch ID; if you cannot positively confirm the target is the dev branch, **ABORT** — the prod project is `rhyzpcqhnizqbxphqdkr` and the loop never applies there. **Fallback** if branching is unavailable: **SQL-only smoke inside `BEGIN … ROLLBACK`** (ends in `SMOKE_PASS_ROLLBACK`) + component tests with mocked RPCs — **never** a browser/PostgREST/UI mutation against prod to "prove" anything.
4. **Verify** — the narrowest useful subset of `npm run typecheck / lint / build / test`.
5. **Subagent review** — dispatch the scoped reviewers (`rls-security-reviewer` + `migration-drift-reviewer` for SQL; `typescript-types-drift-reviewer` for types/migrations; `compliance-reviewer` always for `src/`+migrations). Confirm each finding against the cited line.
6. **Commit on the feature branch** (never `--no-verify`).
7. **Codex review gate** — `/codex-review --base main`; fix confirmed BLOCKER/HIGH and re-review to SHIP.
8. **Learning capture** — for any confirmed BLOCKER/HIGH, add a regression test that fails on the pre-fix code (strongest), or route to a hook/lint/sweep.
9. **Push the FEATURE branch to origin** (backup/resilience — `git push -u origin feat/application-lot-capture`; a feature branch, NOT main — allowed). Note: Vercel may build a **preview deployment** for the branch — that is non-prod (a throwaway preview URL, not croprxsolutions.app) and is fine/expected; only a push or merge to `main` is a prod deploy and stays gated. Update `STATE.md`.
10. **Round cap:** max **3** fix→re-review rounds per phase. If the same finding survives two rounds, or round 3 still has an open BLOCKER/HIGH, STOP and write both positions to `STATE.md` for the owner — do not thrash.

---

## Phases

### Phase 0 — Setup & grounding  *(no feature code; environment gate)*
- **Work in an isolated worktree** (NOT the main checkout `C:/CRX_Manager`). Either you were launched in a fresh worktree already — confirm with `git rev-parse --show-toplevel` (must NOT be `C:/CRX_Manager`) and a clean `git status` — or create one: `git fetch origin && git worktree add -b feat/application-lot-capture ../crx-b1-lot origin/main`, then `cd` into `../crx-b1-lot`. Run `npm ci` in the new worktree (the pre-commit `verify-deps` gate false-fails without it). Confirm the branch is `feat/application-lot-capture` off the latest `origin/main` before any work.
- **Verify Codex** is usable: `codex --version` and `codex login status` (logged-in, exit 0). If not → **STOP** (the loop's gate is mandatory; can't proceed). Note: `codex exec` = helper, `codex review` = reviewer; run `codex exec --help` once to confirm flags.
- **Refresh the schema registry** (the session-staleness hook flags ~10 migrations newer than the registry): refresh via **Supabase MCP introspection** then `/regen-schema-registry` — the schema-aware PreToolUse hooks must validate against current live schema before you write the new migration. (`regenerate-schema-registry.mjs` only stamps; the real refresh is the MCP introspection.)
- **Re-ground:** read `SCOPE-OF-WORK.md` §3 and confirm against the live schema that `application_records`, `application_record_fields`, `receiving_records.lot_number`, `blend_ticket_products.lot_number` are as described. If reality differs, update SOW assumptions before building.
- Helper: `codex exec` a sanity check of the whole SOW approach.
- **Gate:** environment green, Codex up, registry fresh, SOW confirmed → `STATE.md` Phase 0 = DONE.

### Phase 1 — Database migration (the core)
- Helper: draft the `application_record_lots` table + RLS + the 3 RPC signatures + the blend-ticket propagation hook; `codex exec` to critique (RLS correctness, idempotency shape, strict-actor, search_path, overload risk, FK choices).
- Build the migration (one new file via `/create-migration` conventions): table + RLS + indexes; RPCs `set_application_record_lots`, `get_recent_lots_for_product`, `get_lot_application_trace`. For the blend-ticket propagation: this is a **`CREATE OR REPLACE` of the existing `create_application_record_from_blend_ticket` function** (find its LATEST live version first — migrations `20260609142548` / `20260610145350` area). **Reproduce its current body VERBATIM and add ONLY the lot-insert** — do not hand-summarize it. Then verify: no new overload (`SELECT proname,count(*) FROM pg_proc … GROUP BY proname HAVING count(*)>1` returns 0 rows for it), `SET search_path = public, pg_temp` preserved, idempotency preserved. (Reproducing an existing function body is the project's #1 historical drift bug class — copy exactly, md5/byte-verify against the live source.)
- **Prove:** dev-branch apply + run all three RPCs through realistic scenarios (incl. multiple lots per product, blend propagation, a trace lookup) **or** a rolled-back multi-statement smoke ending in `SMOKE_PASS_ROLLBACK`. Do **not** apply to prod.
- Review: `rls-security-reviewer` + `migration-drift-reviewer` + `compliance-reviewer` → fix → commit → `/codex-review --base main` → fix to SHIP.

### Phase 2 — Types
- Add `ApplicationRecordLot` + RPC result types to `src/types/index.ts`.
- Verify (`typecheck`); review: `typescript-types-drift-reviewer` + Codex → SHIP. Commit.

### Phase 3 — UI: lots-applied editor
- Helper: `codex exec` on the component design (multi-lot per product, suggestion dropdown, override, save shape).
- Build the editor on the canonical application-record screen; wire `get_recent_lots_for_product` (suggestions) + `set_application_record_lots` (save).
- **Prove:** exercise in the running app against the dev branch (preview tools — open the screen, add 2 lots to one product, save, reload, confirm persisted; screenshot). If no dev branch, component test with mocked RPCs + note that live UI proof moves to post-apply.
- Verify + `compliance-reviewer` + Codex → SHIP. Commit.

### Phase 4 — UI: lot-trace / recall lookup
- Build `src/pages/LotTrace.tsx` + lazy Route in `App.tsx` + nav link in `AppLayout.tsx`; wire `get_lot_application_trace`.
- **Prove:** enter a known lot (from dev-branch seed data), confirm the trace table is correct; screenshot.
- Verify + `compliance-reviewer` + Codex → SHIP. Commit.

### Phase 5 — Wire-up, tests, docs
- Confirm blend-ticket lot auto-propagation works end-to-end (create an app record from a blend ticket on the dev branch → lots appear).
- Tests: unit/component for the three RPCs + editor + trace; regression test for any bug found this run. `typecheck/lint/build/test` all green.
- Docs: update `database-schema.md`, `rpc-functions.md`, `pages-routes.md`, CLAUDE.md Snapshot counts, `docs/CHANGELOG.md`; run `node scripts/check-doc-drift.mjs` to zero.
- Review: full `/codex-review --base main` over the whole branch + any scoped subagents → SHIP. Commit.

### Phase 6 — Final gate + handoff packet  *(HARD STOP — loop ends here)*
- Final `/codex-review --base main` verdict = SHIP / SHIP-WITH-FOLLOWUPS (record it).
- Write the **apply-guard proof file** for the migration: `.claude/session-state/migration-review-<safe-name>.json` with `migration`, `timestamp` (real ISO-8601 UTC — machine is UTC-5), `reviewers`, `findings:"clean"`, `queryHash`. **Compute `queryHash` LOCALLY with Node** — `crypto.createHash('sha256').update(fs.readFileSync('<migration-path>')).digest('hex')` over the exact file bytes. **Do NOT call `apply_migration` to obtain the hash** — that would apply to prod; the loop never applies live (apply is the owner's gate). Write the proof file with **Node, not PowerShell** (PowerShell `Set-Content -Encoding utf8` adds a BOM → the guard silently skips the file).
- Push the feature branch to origin (final).
- Write **`HANDOFF.md`** in this folder: what was built, per-phase Codex verdicts, the proof method used (dev-branch / smoke), `STATE.md` summary, and the **exact ordered steps the owner must approve** to go live:
  1. apply the migration to live (`apply_migration`),
  2. `/regen-schema-registry`,
  3. run the smoke-chain (`node scripts/smoke/run-smoke.mjs --spec <rpc>` for each new RPC) + `npm run db-sweeps` post-apply (execute read-only via MCP, compare to allowlist),
  4. merge `feat/application-lot-capture` → main,
  5. deploy (Vercel auto-deploys on main push) + do the live UI proof,
  6. owner's in-app smoke.
- **STOP.** Mark `STATE.md` = AWAITING-OWNER-APPROVAL. Notify the owner the feature is built, reviewed, and parked for the live-apply gate.

---

## Hard safety gates (binding on the whole loop)
- **No live migration apply. No merge/push to main. No deploy. No data deletion.** All four require the owner's explicit OK and are deferred to the handoff. The loop builds + proves + reviews only.
- Codex review is **mandatory each phase**; if Codex can't run, STOP and hand off — do not self-certify.
- Pushing the **feature branch** to origin is allowed (it is not main). Auto-pushing to **main** is NOT (the feature depends on the not-yet-live migration).
- Never `--no-verify`, `@ts-ignore`, or `any`. Never weaken RLS or remove an existing migration.
- One session at a time writes the DB; this loop only touches a throwaway dev branch or rolled-back transactions — never prod.
- Stale-branch artifact rule: judge DB/migration "drift" against `origin/main`'s merge-base, never the checkout (see `.claude/commands/codex-gauntlet.md` §"Baseline against origin/main").
