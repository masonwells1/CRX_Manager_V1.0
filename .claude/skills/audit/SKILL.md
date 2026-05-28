---
name: audit
description: Run a full project health audit — SQL validation, frontend validation, doc drift check, lint, build, and tests. Use when the user wants to check if everything is in good shape before committing or deploying.
---

# Full Project Audit

Run every validation check CRX Manager has in one pass. This catches SQL bugs, frontend safety issues, doc drift, lint errors, build failures, and test failures.

## Step 1: SQL Migration Validation

Run the SQL validation script:

```bash
cd /c/CRX_Manager && bash scripts/validate-sql-migrations.sh
```

If this fails, report each violation with the file and line number.

## Step 2: Frontend Validation

Run the frontend validation script:

```bash
cd /c/CRX_Manager && bash scripts/validate-frontend.sh
```

If this fails, report each violation.

## Step 3: ESLint

```bash
cd /c/CRX_Manager && npm run lint
```

Report the error count. If > 0, list each error with file and line.

## Step 4: TypeScript Check

```bash
cd /c/CRX_Manager && npm run typecheck
```

Report PASS or the specific errors.

## Step 5: Production Build

```bash
cd /c/CRX_Manager && npm run build
```

Report PASS or the specific errors.

## Step 6: Unit Tests

```bash
cd /c/CRX_Manager && npm run test -- --reporter=verbose 2>&1 | tail -20
```

Report total tests, passed, failed.

## Step 7: Doc Drift Check

Run these counts and compare to CLAUDE.md:

```bash
# Actual counts
echo "Pages: $(grep -c 'lazy(' src/App.tsx)"
echo "Migrations: $(ls supabase/migrations/*.sql | wc -l)"
echo "Edge Functions: $(ls -d supabase/functions/*/ | wc -l)"
echo "Unit test files: $(find src -name '*.test.ts' -o -name '*.test.tsx' | wc -l)"
```

Read CLAUDE.md and compare. Report any mismatches.

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
║  Doc Drift:         PASS / X stale   ║
║  Security Advisors: PASS / X issues  ║
║                                      ║
║  Overall:  READY TO SHIP / NEEDS FIX ║
╚══════════════════════════════════════╝
```

If everything passes: "All clear — safe to commit and deploy."
If anything fails: List each issue and ask the user if they want you to fix them.

## Rules

- NEVER auto-fix issues without telling the user what you're fixing
- NEVER skip any step — the whole point is a complete check
- NEVER report "PASS" if a command returned errors — read the output carefully
- Run all independent steps (1-6) before the report — don't stop at the first failure
