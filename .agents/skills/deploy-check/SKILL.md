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

**push a branch → open a PR → finish required checks → freeze the candidate →
apply `ready-for-coderabbit` → let the default-branch workflow record its receipt and add `coderabbit-review-dispatch` once →
read and resolve that final review → merge with
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
    Apply them through /migration-review → scripts/apply-migration-file.mjs
    BEFORE merging (non-destructive: under Mason's 2026-09-26 landing rule
    once the final reviews are clean; destructive: his in-chat yes), or the
    app will reference tables/columns/functions that don't exist yet.
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
4. Once required checks are green, freeze the candidate, record its head SHA, then apply
   **`ready-for-coderabbit`**. The default-branch workflow waits out running checks, rechecks the
   exact head, draft/conflict/auto-merge state, actor permission, required checks, and every
   reported non-CodeRabbit check before recording a trusted head/base receipt and adding
   `coderabbit-review-dispatch` once, then releases that provider label once the review lands.
   The receipt and labels record attempts, not merge authorization. Pending or uncertain delivery
   preserves dedupe state; after late delivery, reapply the ready label to reconcile without
   another request. Never clear and re-add the provider label to retry. Follow
   `docs/reference/coderabbit-native-review.md`, including its introducing-PR bootstrap. Read the
   resulting review and fix every real issue; nitpicks may be dismissed with a one-line reason.
   **A fix goes on the SAME PR:** the push resets the labels, the trusted synchronize run records
   the new candidate epoch, and after checks pass a relabel earns one follow-up review — no
   replacement PR. Never use `@coderabbitai resume`, never post `@coderabbitai` commands by hand,
   and reserve `@coderabbitai full review` for a deliberately justified complete reread.
5. When CodeRabbit's latest verdict is **APPROVED on the exact head**, run the exact-SHA
   `gpt-6-sol` high-effort proof LAST (every change, since 2026-09-26), then apply the change's
   non-destructive migration if it has one, then merge with `--match-head-commit`. Both agent
   merge gates enforce Mason's autonomous-landing rule: CodeRabbit APPROVED on `headRefOid`, the
   newest run of every reported check green with `mergeStateStatus` CLEAN, and the Sol proof bound
   to that head and GitHub's real base. `CHANGES_REQUESTED`, `--auto` and `--admin` are refused;
   `enforce_admins` is off and no agent may act on that exemption. **The merge is the deploy.**

Landing under Mason's autonomous-landing rule (2026-09-26) needs no in-chat ask once those gates
pass; report the merge explicitly rather than silently. A direct `vercel --prod` deploy outside the
merge path or an Edge Function deploy still needs Mason's explicit yes. A non-destructive live
migration applies under the same rule through migration-apply-guard's full proof gate (hash-bound
dual-reviewer proof + hash-bound Sol proof, both fresh ≤30 min) in any session; a destructive one
needs his in-chat yes, every time.
If blocked: List every issue that needs fixing first.

## Rules

- NEVER push a branch, open a PR, or merge if lint, typecheck, or build fails
- NEVER merge if tests have new failures
- NEVER push/merge if secrets are found in source code
- NEVER merge with unapplied migrations pending without surfacing them (warn — Mason decides the ordering)
- NEVER attempt to push directly to `main`; the ruleset blocks it and the attempt is a bug in the plan
- NEVER trigger CodeRabbit while implementation or Codex review is still changing the branch
- NEVER merge over a `CHANGES_REQUESTED` verdict, and never without CodeRabbit's APPROVED review bound to the exact candidate commit (Mason's autonomous-landing rule, 2026-09-26)
- Edge Function deploys and direct Vercel CLI deploys always need Mason's explicit approval; only the reviewed merge path is covered by the autonomous-landing rule. Non-destructive live migrations apply under that rule once migration-apply-guard's full proof + Sol gate passes; destructive migrations need his in-chat yes
