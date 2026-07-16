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

Compare against the live database (Supabase MCP `list_migrations`). If there are NEW migrations that haven't been applied to the live database yet, WARN the user:

```
⚠️  You have X new migration(s) not yet applied to production.
    Apply them through /migration-review → apply_migration BEFORE
    deploying (interactive: Mason's in-chat OK required), or the app
    will reference tables/columns/functions that don't exist yet.
    NEVER `supabase db push` — it bypasses the review gate and is blocked.
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

If ready: note that the deploy trigger IS the push — pushing `main` deploys production via Vercel's git integration (there is no separate deploy step). A push of regular reversible code with everything green is covered by Mason's standing 2026-06-16 auto-push authorization; report it explicitly. A direct `vercel --prod` deploy outside the push path or an Edge Function deploy still needs Mason's explicit yes. A live migration apply follows the settled 2026-07-13 rule: interactive session = Mason's in-chat OK; pre-authorized armed hands-free run = migration-apply-guard's full proof gate (hash-bound dual-reviewer proof + hash-bound Codex proof, both fresh ≤30 min); destructive migrations never apply autonomously.
If blocked: List every issue that needs fixing first.

## Rules

- NEVER push/deploy if lint, typecheck, or build fails
- NEVER push/deploy if tests have new failures
- NEVER push/deploy if secrets are found in source code
- NEVER push/deploy with unapplied migrations pending without surfacing them (warn — Mason decides the ordering)
- Edge Function deploys and direct Vercel CLI deploys always need Mason's explicit approval; only the regular push-to-`main` path is covered by the standing authorization. Live migration applies need his in-chat OK in an interactive session — the one exception is a pre-authorized armed hands-free run passing migration-apply-guard's full proof + Codex gate (destructive migrations: never autonomous)
