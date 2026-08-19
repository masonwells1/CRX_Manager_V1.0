---
name: audit
description: Run a full project health audit — SQL validation, frontend validation, doc drift check, lint, build, and tests. Use when the user wants to check if everything is in good shape before committing or deploying.
---

# Full Project Audit

Run the project's standing validation gates in one pass — SQL bugs, frontend safety, contract
and schema drift, dependency audit, doc drift, lint, build, and tests.

This is a **broad** sweep, not an exhaustive one. It deliberately omits the expensive or
approval-gated checks: the Playwright E2E suites (`npm run test:e2e`), the live smoke chains
(`npm run smoke`), and the reviewer subagents. Say so in the report rather than implying total
coverage. If a step is skipped or a tool is unavailable, the overall verdict is **INCOMPLETE**,
never PASS.

Run `node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"` first and
flag any gate that exists in `package.json` but is not covered below — new gates get added here.

## Step 1: SQL Migration Validation

Run the SQL validation script:

```bash
bash scripts/validate-sql-migrations.sh
```

If this fails, report each violation with the file and line number.

## Step 2: Frontend Validation

Run the frontend validation script:

```bash
bash scripts/validate-frontend.sh
```

If this fails, report each violation.

## Step 3: ESLint

```bash
npm run lint
```

Report the error count. If > 0, list each error with file and line.

## Step 4: TypeScript Check

```bash
npm run typecheck
```

Report PASS or the specific errors.

## Step 5: Production Build

```bash
npm run build
```

Report PASS or the specific errors.

## Step 6: Unit Tests

```bash
npm run test -- --reporter=verbose 2>&1 | tail -20
```

Report total tests, passed, failed.

## Step 6a: Contract, Schema, and Drift Gates

```bash
npm run test:contracts
npm run test:drift
npm run test:schema-baseline
npm run test:correction-guards
```

`npm run test:schema-live` additionally compares against the **live** database — run it when the
Supabase connector is available and say explicitly whether it ran.

## Step 6b: Dependency Audit

```bash
npm run verify:deps
```

Report the vulnerability count by severity. A non-zero high/critical count is a finding.

## Step 6c: Database Invariant Sweeps

```bash
npm run db-sweeps:strict
```

Use the **strict** form. Plain `npm run db-sweeps` only prints the predicates and exits 0 without
executing anything — treating that zero exit as a pass is a false green. If the sweeps cannot
execute live, mark this step SKIPPED and downgrade the overall verdict to INCOMPLETE. Any
un-allowlisted violation is a real finding.

## Step 6d: Agent-Harness Gates

```bash
npm run check:agent-workflows
npm run test:agent-workflows
npm run agent-health
```

## Step 7: Doc Drift Check

Run the project's own doc gates first — they are the authority:

```bash
npm run check:docs
npm run check:agent-guidance
npm run check-doc-drift
```

`check:agent-guidance` enforces that volatile counts stay **out** of `CLAUDE.md` and `AGENTS.md`.
Counts live in `docs/reference/`, so compare against those files, **not** against `CLAUDE.md` —
`CLAUDE.md` has no "Current State" section and must never grow one. Live status belongs in
`docs/manual/CURRENT_STATE.md`.

```bash
# Actual counts, for comparison against docs/reference/
echo "Pages: $(grep -c 'lazy(' src/App.tsx)"
echo "Migrations: $(ls supabase/migrations/*.sql | wc -l)"
echo "Edge Functions: $(find supabase/functions -mindepth 1 -maxdepth 1 -type d ! -name _shared | wc -l)"
echo "Unit test files: $(find src -name '*.test.ts' -o -name '*.test.tsx' | wc -l)"
```

The Edge Function count excludes the `_shared` helper directory, matching `update-docs`.
Report any mismatches.

## Step 8: Supabase Security Advisors (if Supabase MCP available)

If the Supabase MCP tools are available, run:
- `get_advisors` with type `security` for project `rhyzpcqhnizqbxphqdkr`
- `get_advisors` with type `performance` for project `rhyzpcqhnizqbxphqdkr`

Report any HIGH or CRITICAL findings.

## Step 9: Print Report Card

```
╔══════════════════════════════════════╗
║       CRX MANAGER AUDIT REPORT      ║
╠══════════════════════════════════════╣
║                                      ║
║  SQL Validation:    PASS / X issues  ║
║  Frontend Valid.:   PASS / X issues  ║
║  ESLint:            PASS / X errors  ║
║  TypeScript:        PASS / X errors  ║
║  Build:             PASS / FAIL      ║
║  Unit Tests:        X/Y passed       ║
║  Contracts/Drift:   PASS / X issues  ║
║  Dependency Audit:  PASS / X vulns   ║
║  DB Sweeps:         PASS / SKIPPED   ║
║  Agent Harness:     PASS / X issues  ║
║  Doc Drift:         PASS / X stale   ║
║  Security Advisors: PASS / SKIPPED   ║
║                                      ║
║  Not run: E2E, live smokes           ║
║  Overall: PASS / INCOMPLETE / FAIL   ║
╚══════════════════════════════════════╝
```

If every step ran and passed: report PASS, and name what this audit did **not** cover (E2E,
live smokes, reviewer subagents) so it is not mistaken for a ship verdict. Landing still follows
the branch → PR → checks → CodeRabbit → merge flow in `AGENTS.md`.
If any step was skipped or a tool was unavailable: report INCOMPLETE and name the gap.
If anything fails: list each issue and ask the user whether to fix them.

## Rules

- NEVER auto-fix issues without telling the user what you're fixing
- NEVER skip any step — the whole point is a complete check
- NEVER report "PASS" if a command returned errors — read the output carefully
- NEVER report "PASS" for a step that was skipped or whose tool was unavailable; that is INCOMPLETE
- NEVER treat a print-only `db-sweeps` exit 0 as evidence — use `db-sweeps:strict`
- Run all steps (1–8, including 6a–6d) before the report — don't stop at the first failure
