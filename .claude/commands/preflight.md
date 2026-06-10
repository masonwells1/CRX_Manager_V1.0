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

## Step 2: Dispatch reviewer subagents (in PARALLEL)

For each category that flipped to true, dispatch the matching subagent. CRITICAL: send ALL applicable Agent tool calls in a single message so they run concurrently — sequential dispatch wastes minutes.

| If this changed... | Dispatch this subagent |
|--------------------|------------------------|
| `MIGRATION_CHANGED` | `rls-security-reviewer` AND `migration-drift-reviewer` (both, parallel) |
| `TYPES_CHANGED` OR `MIGRATION_CHANGED` | `typescript-types-drift-reviewer` |
| `PDF_CHANGED` | `pdf-output-reviewer` |
| Any TS/TSX changed in `src/` | `pr-review-toolkit:code-reviewer` AND `pr-review-toolkit:silent-failure-hunter` (parallel) |
| Any new try/catch blocks, fallbacks, or error handling | `pr-review-toolkit:silent-failure-hunter` (already covered above if TS changed) |
| New types added to `src/types/index.ts` | `pr-review-toolkit:type-design-analyzer` |

For each subagent, pass the list of changed files in scope. Wait for all reports to come back.

If NONE of the categories flipped (e.g., only docs changed), skip to Step 3.

**Stop-on-blocker rule:** If any subagent returns BLOCKER findings, STOP and report to Mason before running the local validation suite. The local checks will likely pass (lint doesn't know about RLS) and create a false sense of safety.

## Step 3: Local validation suite (in order)

Run each and capture pass/fail:

```bash
npm run lint
npm run build
npm run test -- --reporter=verbose 2>&1 | tail -15
```

These also run automatically when Mason types `git commit` (via husky pre-commit hook). Running them here just surfaces failures earlier so Mason can fix before the commit attempt rejects.

## Step 3b: Prevention-control checks

Run both:

```bash
node scripts/check-doc-drift.mjs
node scripts/verify-deps.mjs
```

- `check-doc-drift` failing → a reference doc (CLAUDE.md counts, migration-history rows, etc.) is stale; fix the doc, don't commit around it.
- `verify-deps` failing → `node_modules` doesn't match the lockfile (or a peer range is violated); run `npm ci` and re-check.

**If `MIGRATION_CHANGED=true`,** also run the db-invariant sweeps: `npm run db-sweeps` prints each predicate's SQL — execute the blocks read-only via Supabase MCP `execute_sql` and compare `violation_key`s against `scripts/db-invariant-sweeps/allowlist.json`. Any unallowlisted violation is a BLOCKER.

**Smoke-chain hard rule (note, applies whenever a migration touched an RPC):** every migration-touched RPC must have a PASSING full business-chain spec in `scripts/smoke/smoke-specs.json` (`node scripts/smoke/run-smoke.mjs --spec <rpc>`, PASS = `SMOKE_PASS_ROLLBACK`). No spec (runner exit 2) = write a chain first; an isolated probe is never evidence of a fix. Flag any touched RPC without fresh chain PASS evidence.

## Step 4: Quick doc-drift check

```bash
echo "Pages: $(grep -c 'lazy(' src/App.tsx)" && echo "Migrations: $(ls supabase/migrations/*.sql | wc -l)"
```

Compare to the counts in CLAUDE.md "Current State". Flag mismatches.

## Step 5: Print the verdict

```
═══════════════════════════════════════════════════
  PREFLIGHT — <YYYY-MM-DD HH:MM>
═══════════════════════════════════════════════════

What changed:
  - <N> migrations
  - <N> TS files
  - <N> Edge Function files
  - <N> other

Subagent reviews:
  rls-security-reviewer:           <BLOCKERS / HIGH / clean / not-needed>
  migration-drift-reviewer:        <...>
  typescript-types-drift-reviewer: <...>
  pdf-output-reviewer:             <...>

Local validation:
  Lint:   PASS / FAIL
  Build:  PASS / FAIL
  Tests:  X/Y passed
  Docs:   in sync / N stale counts

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
