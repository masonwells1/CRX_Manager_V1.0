---
name: deploy-check
description: Pre-deployment checklist for CRX Manager — verifies everything is safe to push to production. Use before deploying to Vercel or pushing migrations to Supabase.
---

# Pre-Deployment Check

A final gate before deploying to production. Checks code quality, unapplied migrations, environment safety, and production readiness.

## Step 1: Git Status

```bash
git status && git log --oneline -5
```

Check:
- Are there uncommitted changes? (WARN — should commit first)
- Are we on the `main` branch? (WARN if not — deploy from main)
- What was the last commit? (Show it to the user)

## Step 2: Code Quality Gate

Run these in sequence:

```bash
npm run lint && npm run typecheck && npm run build
```

ALL THREE must pass. If any fail, stop and report — do not proceed to deployment.

## Step 3: Unit Tests

```bash
npm run test -- --reporter=verbose 2>&1 | tail -20
```

Must have 0 failures. Report test count and any failures.

## Step 4: Check for Unapplied Migrations

```bash
# Count local migration files
echo "Local migrations: $(ls supabase/migrations/*.sql | wc -l)"
```

Compare to the CLAUDE.md count. If there are NEW migrations that haven't been pushed to Supabase yet, WARN the user:

```
⚠️  You have X new migration(s) not yet applied to production.
    Run 'supabase db push' BEFORE deploying, or the app will
    reference tables/columns/functions that don't exist yet.
```

## Step 5: Environment Check

Verify no secrets are exposed:

```bash
# Check for .env in git tracking
git ls-files | grep -i "\.env"
# Check for hardcoded keys in source
grep -r "service_role" src/ --include="*.ts" --include="*.tsx" -l
grep -r "sk_live\|sk_test\|SUPABASE_SERVICE" src/ --include="*.ts" --include="*.tsx" -l
```

If any results, BLOCK deployment and report.

## Step 6: Bundle Size Check

```bash
# Build already ran in step 2, check the output size
ls -lh dist/assets/*.js 2>/dev/null | head -5
```

Report the largest JS chunks. Warn if any single chunk is > 500KB.

## Step 7: Deployment Summary

```
╔══════════════════════════════════════════╗
║     PRE-DEPLOYMENT CHECK COMPLETE        ║
╠══════════════════════════════════════════╣
║                                          ║
║  Branch:          main / other           ║
║  Clean working tree: YES / NO            ║
║  Last commit:     <hash> <message>       ║
║                                          ║
║  Lint:            PASS                   ║
║  TypeScript:      PASS                   ║
║  Build:           PASS                   ║
║  Tests:           X/Y passed             ║
║  Secrets exposed: NONE                   ║
║  Unapplied migrations: X                 ║
║  Largest bundle:  XXX KB                 ║
║                                          ║
║  Verdict: READY TO DEPLOY / BLOCKED      ║
╚══════════════════════════════════════════╝
```

If ready: Ask the user if they want you to deploy now (via Vercel).
If blocked: List every issue that needs fixing first.

## Rules

- NEVER deploy if lint, typecheck, or build fails
- NEVER deploy if tests have new failures
- NEVER deploy if secrets are found in source code
- NEVER deploy if there are unapplied migrations (warn, don't block — user decides)
- NEVER auto-deploy without explicit user approval
