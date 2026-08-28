---
name: deploy-check
description: Pre-merge checklist for CRX Manager — verifies a branch is safe to land. Since `main` is protected (2026-07-14), landing means branch → PR → checks → CodeRabbit → merge, and the merge is what deploys production via Vercel. Use before opening or merging a PR, or before applying migrations to Supabase.
---

# Pre-Deployment Check

A final gate before landing work on `main`. Checks code quality, unapplied migrations,
environment safety, and production readiness.

**How production actually deploys (updated 2026-07-14).** `main` is protected by the GitHub
`protect-main` ruleset, so **direct pushes to `main` are impossible for everyone** — Claude,
Codex, and Mason alike. The landing path is:

**push a branch → open a PR → finish required checks → freeze the candidate → post
`@coderabbitai review` → read and resolve that final review → merge with
`--match-head-commit <reviewed-head-sha>`.** The **merge** is what deploys production via Vercel's
git integration; Vercel's one-click rollback is the accepted safety net.

Run this skill on the branch **before** opening the PR (and again before merging if the branch
moved).

## Step 1: Git Status

```bash
git status && git log --oneline -5
```

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
```

Check:
- Are there uncommitted changes? (WARN — should commit first)
- Are we on a **feature branch**? Being on `main` is the problem case here, not the goal — work
  cannot land from `main` because direct pushes are blocked. If HEAD is `main`, tell the user to
  branch first.
- Is the branch behind `origin/main`? (WARN — rebase or merge before opening the PR, or the
  reviewed diff and the Vercel check will not reflect what actually lands.)
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
║  Branch:          <feature branch>       ║
║  Behind origin/main: X commits           ║
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
║  Verdict: READY FOR PR / BLOCKED         ║
╚══════════════════════════════════════════╝
```

If ready, state the remaining landing steps explicitly — this skill does **not** land anything:

1. Push the **branch** (never `main` — the `protect-main` ruleset rejects it).
2. Open a PR.
3. Finish implementation, bring the branch up to date, and wait for required checks;
   **Vercel is a required check**.
4. Freeze the candidate after the separate Codex review is clean, record its head SHA, then post
   exactly **`@coderabbitai review`**. Read the resulting review and fix every real issue; nitpicks
   may be dismissed with a one-line reason. If a fix or base update creates a new commit, restart
   required checks, rerun the exact-HEAD Codex proof when the corrected diff is Codex-worthy,
   freeze and record the new SHA, and request one follow-up review. Never use `@coderabbitai resume`, and reserve
   `@coderabbitai full review` for a deliberately justified complete reread. GitHub requires one
   current formal approval and dismisses it after a new commit. Before merge, verify live `main`
   protection still requires current approval with stale-review dismissal and confirm an
   `APPROVED` CodeRabbit review has `commit_id` equal to the final `headRefOid`; a green status row
   is insufficient. A separate exact-SHA
   `gpt-5.6-sol` high-effort proof remains the additional hard gate for risky money/RLS/migration
   diffs — both run, neither replaces the other.
5. Merge. **The merge is the deploy.**

Landing regular reversible code with the full pipeline green is covered by Mason's standing push
policy (2026-06-16, mechanics updated 2026-07-30); report that explicitly rather than assuming it. A direct `vercel --prod` deploy outside the push path or an Edge Function deploy still needs Mason's explicit yes. A live migration apply follows the settled 2026-07-13 rule: interactive session = Mason's in-chat OK; pre-authorized armed hands-free run = migration-apply-guard's full proof gate (hash-bound dual-reviewer proof + hash-bound Codex proof, both fresh ≤30 min); destructive migrations never apply autonomously.
If blocked: List every issue that needs fixing first.

## Rules

- NEVER push a branch, open a PR, or merge if lint, typecheck, or build fails
- NEVER merge if tests have new failures
- NEVER push/merge if secrets are found in source code
- NEVER merge with unapplied migrations pending without surfacing them (warn — Mason decides the ordering)
- NEVER attempt to push directly to `main`; the ruleset blocks it and the attempt is a bug in the plan
- NEVER trigger CodeRabbit while implementation or Codex review is still changing the branch
- NEVER merge without a CodeRabbit approval bound to the current candidate commit
- Edge Function deploys and direct Vercel CLI deploys always need Mason's explicit approval; only the regular push-to-`main` path is covered by the standing authorization. Live migration applies need his in-chat OK in an interactive session — the one exception is a pre-authorized armed hands-free run passing migration-apply-guard's full proof + Codex gate (destructive migrations: never autonomous)
