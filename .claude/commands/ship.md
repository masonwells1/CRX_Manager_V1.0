Drive a coding job from "implement" all the way to "reviewed, applied, committed, and ready to push" — hands-off through the whole review-and-fix gate, pausing only at the two human gates Mason chose: **run Codex** (when the change warrants it) and **approve the push to prod**. This is the autonomous "work till completion" pipeline; it orchestrates the existing subagents, workflows, and hooks rather than reinventing them.

**The job** is everything after `/ship` (e.g. `/ship add a CSV export button to the AR aging report`). If no job text was given, ask Mason what the job is, then proceed.

Autonomy boundary (Mason's standing choice — do not exceed without asking):
- **Migrations:** auto-apply reviewed-clean migrations to the live DB (reversible via a follow-up migration).
- **Prod push:** NEVER push to `main` / deploy the frontend without explicit approval. `main` = live croprxsolutions.app.

## Step 0 — Set up a branch

Never work on `main`. Check the branch and create a feature branch if needed:

```bash
git branch --show-current
```

If on `main`, create one: `git checkout -b ship/<short-slug>`. Tell Mason the branch name. (Re-verify the branch right before any commit — a commit has landed on main before.)

## Step 1 — Implement the job to completion

Do the work. If the job is a non-trivial feature, FIRST invoke `superpowers:brainstorming` (required by Mason's system) and the relevant scaffold skill (`/new-page`, `/new-rpc`, `/create-migration`) — those encode the correct patterns. Your PreToolUse hooks (sql-safety, money-safety, idempotency-body-check, rls-on-new-tables, status-enum-check, generated-column-check, env-guard) will refuse a bad write as you go — treat any hook block as a real defect to fix, not an obstacle to route around.

Finish the whole job before moving on. Partial implementations do not enter the gate.

## Step 2 — Verify (local toolchain)

```bash
npm run typecheck
npm run lint
npm run build
npm run test
```

If `package.json` or `package-lock.json` changed, also run:

```bash
node scripts/verify-deps.mjs
```

Capture pass/fail for each. Any failure → fix it now and re-run before continuing. Do not enter the review gate on a red build.

## Step 3 — Review fan-out (parallel, scoped to what changed)

Detect what changed (`git diff --name-only HEAD` + `git status --short`) and dispatch ONLY the relevant reviewers — **all in a single message so they run concurrently:**

| If this changed | Dispatch |
|---|---|
| Any `supabase/migrations/*.sql` | `rls-security-reviewer` + `migration-drift-reviewer` |
| `src/types/index.ts` OR a migration | `typescript-types-drift-reviewer` |
| Any `src/` file importing `jspdf` / `jspdf-autotable` | `pdf-output-reviewer` |
| Any `src/` or migration change (always) | `compliance-reviewer` |
| Workflow / lifecycle / page↔RPC logic touched | run the `/review-workflow` workflow (4 layers + adversarial verify) |

Pass each reviewer the list of changed files. Wait for all reports.

## Step 4 — Auto-fix loop (the "till completion" engine)

For every **confirmed** BLOCKER or HIGH finding (the workflows already adversarially verify theirs; for subagent findings, confirm the finding is real by reading the cited line before acting):

1. Fix it.
2. Re-run Step 2 (verify) and re-dispatch the reviewers whose scope you touched (Step 3).
3. Repeat until: reviewers return **clean** (or BLOCKER/HIGH all fixed) AND build + tests are green.

MED/LOW findings: fix the cheap ones; list the rest in the final summary as accepted/deferred — do not loop on them. Cap the loop at a sane number of rounds; if a finding can't be resolved, STOP and surface it to Mason rather than thrashing.

## Step 5 — If a migration is involved: apply it live

Only after Step 4 is clean for the migration:

1. **Write the apply-guard proof file** so `migration-apply-guard.mjs` allows the apply. Path `.claude/session-state/migration-review-<safe-name>.json`:
   ```json
   { "migration": "<filename>", "timestamp": "<current ISO-8601>",
     "reviewers": ["rls-security-reviewer", "migration-drift-reviewer"],
     "findings": "clean" }
   ```
2. **Apply via Supabase MCP** `apply_migration`.
3. **Smoke-chain test (hard rule — chains, not probes):** EVERY RPC the migration creates or modifies must pass its full business-chain spec from `scripts/smoke/smoke-specs.json`. For each touched RPC run `node scripts/smoke/run-smoke.mjs --spec <rpc>`:
   - Runner exits 2 with "no spec covers" → **write or extend a chain first** (per `scripts/smoke/README.md` — investigate live catalog, house conventions, register in `smoke-specs.json`). This is a gate, not a suggestion.
   - Execute each printed chain as ONE statement via MCP `execute_sql`. PASS = the error text contains `SMOKE_PASS_ROLLBACK` (proves nothing persisted). Any other error, or no error → FAIL: fix it, then **re-run the FULL chain — never just the failing step** (clean reviewers + md5 fidelity have missed latently-broken prod RPCs before; an isolated statement probe is never evidence of a fix).
4. **B7 rename:** rename the disk migration file to the version stamp the MCP assigned (so it can't be re-applied later).
5. **Regen the schema registry** (`/regen-schema-registry` via MCP introspection) if the migration added a status enum, generated column, or table — otherwise the hooks run on stale data.
6. **Run the db-invariant sweeps (post-apply gate):** `npm run db-sweeps` prints each predicate's SQL — execute every block read-only via MCP `execute_sql` and compare returned `violation_key`s against `scripts/db-invariant-sweeps/allowlist.json`. **Any unallowlisted violation BLOCKS the ship** — fix it (or report it as a finding); NEVER allowlist a real hole to get green.

If the migration touches a CHECK constraint, function with an existing name, or an existing table, that is exactly what the two reviewers in Step 3 are for — do not skip them.

## Step 6 — Codex gate (pauses if worthy)

Decide if the change is **Codex-worthy**: it touches a migration, RLS/RPC security, a money path, or an Edge Function. (A pure CSS/copy/layout change is NOT worthy — note that and skip.)

If worthy: run `/codex-cross-review` to draft the packet (`docs/audits/<date>-codex-<slug>-prompt.md` + the file list), then **STOP and present it to Mason** with: "Codex-worthy change — here's the packet. Run Codex and paste the reply, and I'll write the disposition. Or say 'skip Codex' to proceed." Do not push while a Codex review is pending unless Mason waives it.

## Step 7 — Docs + commit (on the branch)

Update the docs the change touched (per CLAUDE.md "Documentation Maintenance"): CLAUDE.md Current State counts, `docs/reference/migration-history.md`, `rpc-functions.md`, `pages-routes.md`, `database-schema.md`, `docs/CHANGELOG.md` as applicable.

Before committing, run `node scripts/check-doc-drift.mjs` — fix any drift it reports (stale counts, missing migration-history rows) rather than committing around it.

Re-verify the branch (`git branch --show-current`), then commit **on the branch** with a clear message. The husky pre-commit hook re-runs lint/build/test — if it rejects, fix and retry (never `--no-verify`).

## Step 8 — Stop before push; present the decision

Print the summary and HAND THE PUSH DECISION TO MASON:

```
═══════════════════════════════════════════════════
  SHIP — <job>   (<YYYY-MM-DD HH:MM>)
═══════════════════════════════════════════════════
Branch:   <branch>
Changed:  <N migrations, N TS, N docs>

Review gate:
  rls-security:        <clean / fixed N / n-a>
  migration-drift:     <...>
  types-drift:         <...>
  pdf-output:          <...>
  compliance:          <...>
  /review-workflow:    <verdict / n-a>

Verify:   typecheck ✓  lint ✓  build ✓  tests X/Y
Migration: <applied live + smoke-tested / none>
Codex:    <packet drafted, PENDING your run / not worthy / waived>
Deferred: <MED/LOW items accepted, if any>

─── NEXT (your call) ───────────────────────────────
  Approve push to prod?  → I'll `git push` (and you can
  `/loop` the Vercel deploy to watch it go READY).
  Codex first?           → run the packet, paste the reply.
```

Then WAIT. Do not push.

## Hard Rules
- NEVER `git push` / deploy to prod without Mason's explicit approval in this turn. That is the one gate that never auto-fires.
- NEVER apply a migration without the two reviewers clean + the proof file written (the guard enforces this; don't try to route around it).
- NEVER report the gate "clean" while any confirmed BLOCKER/HIGH is open, even if lint/build/test pass.
- NEVER skip the review fan-out to "save time" — it is the entire point of `/ship`.
- NEVER `--no-verify`, `@ts-ignore`, or `any` (except `reportPdf.ts` columnStyles).
- Auto-applying a migration is allowed; auto-pushing is not. Keep that line bright.
- If a required safety gate is unavailable (e.g. a reviewer can't run), STOP and hand off — do not self-certify. (Mason's prod-gate-discipline rule.)
