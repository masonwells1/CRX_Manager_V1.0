Run a comprehensive pre-commit check on the CRX Manager project. This is the bridge between "I made changes" and "git commit" — it auto-dispatches the right subagent reviewers based on what changed, then runs the local validation suite.

## Step 1: Detect what changed in this session

Run these in parallel to figure out what changed since the last commit:

```bash
git status --short
git diff --name-only HEAD
git diff --name-only --cached
```

Categorize the changed files:

- **Migration files** changed → set `MIGRATION_CHANGED=true` (any `supabase/migrations/*.sql`)
- **TypeScript types** changed → set `TYPES_CHANGED=true` (any change to `src/types/index.ts`)
- **PDF code** changed → set `PDF_CHANGED=true` (any file under `src/` that contains `from 'jspdf'` or `from 'jspdf-autotable'`)
- **Edge Function** changed → set `EDGE_CHANGED=true` (any `supabase/functions/**/*.ts`)
- **Schema registry** changed → set `REGISTRY_CHANGED=true` (`.claude/schema-registry.json`)
- **Agent surface** changed → set `AGENT_SURFACE_CHANGED=true` (any `.claude/{commands,skills,hooks,workflows,agents}/` file, `.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, `scripts/check-*`, `scripts/validate-*`, `scripts/verify-*`, or `scripts/sync-agent-workflows.mjs`)

## Step 2: Dispatch reviewer subagents (in PARALLEL)

For each category that flipped to true, dispatch the matching subagent. CRITICAL: send ALL applicable Agent tool calls in a single message so they run concurrently — sequential dispatch wastes minutes.

| If this changed... | Dispatch this subagent |
|--------------------|------------------------|
| `MIGRATION_CHANGED` | `rls-security-reviewer` AND `migration-drift-reviewer` (both, parallel) |
| `TYPES_CHANGED` OR `MIGRATION_CHANGED` | `typescript-types-drift-reviewer` |
| `PDF_CHANGED` | `pdf-output-reviewer` |
| Any `src/`, `supabase/functions/`, or migration file changed (always) | `compliance-reviewer` (audits the Hard Red Lines / code-drift conventions — money-as-cents, RLS, `assertRpcResult`, `checkMutationResult` after `.update()`/`.delete()`, no `confirm()`/`alert()`, Sentry-from-lib, no `@ts-ignore`/`any`, lifecycle invariants — which lint/build/test cannot catch). Matches `/ship` Step 3. |

For each subagent, pass the list of changed files in scope. Wait for all reports to come back.

If NONE of the categories flipped (e.g., only docs changed), skip to Step 3.

**Stop-on-blocker rule:** If any subagent returns BLOCKER findings, STOP and report to Mason before running the local validation suite. The local checks will likely pass (lint doesn't know about RLS) and create a false sense of safety.

## Step 3: Local validation suite (in order)

Before the validation suite, if any `src/`, `supabase/migrations/`, `supabase/functions/`, or `scripts/` file changed, refresh the local architecture map:

```bash
npm run graph:refresh
```

Use the graph only to scope review efficiently: run `graphify affected "<changed symbol>"` or `graphify path "<page>" "<RPC/function>"` for shared logic, workflow, SQL, or refactor changes. Then verify every material connection in current source and, for database claims, live read-only evidence. The graph is not proof of the live schema.

Run each and capture pass/fail:

```bash
npm run lint
npm run typecheck
npm run build
npm run test -- --reporter=verbose 2>&1 | tail -15
```

These full checks run here, at pre-push where applicable, and in GitHub CI; they no longer repeat on every `git commit`. The fast pre-commit hook instead runs private-artifact containment, the hard ledger guard, staged SQL/frontend validation, and conditional agent-parity/dependency checks. If `AGENT_SURFACE_CHANGED` is true and the commit stages no ledger file (`docs/CHANGELOG.md`, any `docs/manual/*.md`, `docs/reference/agent-guardrails.md`, or a `docs/loops/` ledger), the commit is rejected — warn about this in the preflight report so the ledger entry gets written BEFORE the commit attempt, and never suggest `--no-verify`. `npm run typecheck` remains mandatory before build because `npm run build` (vite/esbuild) only *transpiles* — it never type-checks, so a pure type error (e.g. `TS2349`) can pass build; that exact gap shipped a Field Mode prod crash on 2026-06-14.

## Step 3b: Prevention-control checks

Run both:

```bash
npm run test:agent-workflows
node scripts/check-doc-drift.mjs
node scripts/verify-deps.mjs
```

- `test:agent-workflows` failing → Claude/Codex handoff, review, hook, or health-check wiring drifted; fix it before commit.
- `check-doc-drift` failing → a reference doc (migration-history rows, `docs/reference/` counts, etc.) is stale; fix the doc, don't commit around it.
- `verify-deps` failing → `node_modules` doesn't match the lockfile (or a peer range is violated); run `npm ci` and re-check.

**If `MIGRATION_CHANGED=true`,** also run the db-invariant sweeps: `npm run db-sweeps` prints each predicate's SQL — execute the blocks read-only via Supabase MCP `execute_sql` and compare `violation_key`s against `scripts/db-invariant-sweeps/allowlist.json`. Any unallowlisted violation is a BLOCKER.

**Smoke-chain hard rule (note, applies whenever a migration touched an RPC):** every migration-touched RPC must have a PASSING full business-chain spec in `scripts/smoke/smoke-specs.json` (`node scripts/smoke/run-smoke.mjs --spec <rpc>`, PASS = `SMOKE_PASS_ROLLBACK`). No spec (runner exit 2) = write a chain first; an isolated probe is never evidence of a fix. Flag any touched RPC without fresh chain PASS evidence.

## Step 4: Quick doc-drift check

```bash
echo "Pages: $(grep -c 'lazy(' src/App.tsx)" && echo "Migrations: $(ls supabase/migrations/*.sql | wc -l)"
```

`node scripts/check-doc-drift.mjs` (already run in Step 3b) is the authoritative drift check — always-loaded agent files intentionally carry no counts. Flag any mismatch it reports.

## Step 5: Print the verdict

```
═══════════════════════════════════════════════════
  PREFLIGHT — <YYYY-MM-DD HH:MM>
═══════════════════════════════════════════════════

What changed:
  - <N> migrations
  - <N> TS files
  - <N> Edge Function files
  - <N> PDF files
  - registry: changed/unchanged
  - <N> other

Subagent reviews:
  rls-security-reviewer:           <BLOCKERS / HIGH / clean / not-needed>
  migration-drift-reviewer:        <...>
  typescript-types-drift-reviewer: <...>
  pdf-output-reviewer:             <...>
  compliance-reviewer:             <...>

Local validation:
  Lint:      PASS / FAIL
  Typecheck: PASS / FAIL
  Build:     PASS / FAIL
  Tests:     X/Y passed
  Agent-wf:  PASS / FAIL
  Deps:      PASS / FAIL
  Docs:      in sync / N stale counts
  (if MIGRATION_CHANGED)
  DB-sweeps: clean / N violations
  Smoke:     <rpc> PASS/MISSING

─── OVERALL ─────────────────────────────────────────

<one of:
  "✅ READY TO COMMIT — all checks green, run `git commit -m ...`"
  "⚠️  YELLOW — non-blocking issues found, see above. Safe to commit if you accept them."
  "🛑 STOP — N blockers found. Fix before committing.">
```

## Step 6: Wait

Do NOT run `git commit` yourself. Mason commits. Even if everything is green.

If Mason types "commit" or "go ahead" after a green preflight, you may then assist with the commit (drafting the message) — but the actual `git commit` is Mason's call.

## Hard Rules

- ALWAYS dispatch subagents in Step 2 if applicable. Skipping them defeats the purpose of preflight.
- ALWAYS dispatch them in parallel (single message, multiple Agent tool calls).
- NEVER report "READY TO COMMIT" if any subagent returned BLOCKER findings, even if lint/build/test all pass.
- NEVER run `git commit` automatically.
- Keep the verdict report under one screen — full subagent reports stay in the agent's context, only summarize here.
