# Docs-only CI routing — verified build handoff

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Worktree: `C:\Users\mason\.codex\worktrees\docs-only-ci-routing-20260826\CRX_Manager`
- Branch: `codex/docs-only-ci-routing-20260826`
- Starting `origin/main`: `090bce6298150a2650f5d8333e034c2bc7926d7d`
- Current integrated `origin/main`: `08e773189bb71d0ddb3d80dd941e69ab70992dde`
- Production: `https://croprxsolutions.app`

## GOAL

Make ordinary documentation-only pull requests and their merge pushes use a fast CI lane without allowing code, database, configuration, agent-control, or uncertain changes to avoid the complete proof suite.

Done means the classifier is fail-closed, the required `Lint, Type Check, Test, Build` and `SQL Migration Validation` contexts still execute, adversarial boundary tests pass, the real workflow demonstrates both lanes, an independent exact-head review is clean, the protected PR is merged, and the exact merge is green and live.

## PROVEN

- The current `protect-main` ruleset requires `Vercel`, `Lint, Type Check, Test, Build`, and `SQL Migration Validation`; strict up-to-date mode is off.
- GitHub's required-check behavior makes a conditionally skipped job report success, so both required jobs must execute and bind failed prerequisites to a red result.
- The current exact main-push CI run for the prior docs closure (`32992010346`) ran from `2026-08-26T17:04:11Z` through `2026-08-26T17:13:11Z`, about nine minutes.
- `docs/manual/DECISION_LOG.md` lines 280-291 retain `edited` events for base-retarget proof and require any docs-only shortcut to exclude `.claude/**`, `.codex/**`, `.github/**`, `.husky/**`, `AGENTS.md`, `CLAUDE.md`, `.coderabbit.yaml`, `package.json`, `scripts/**`, `supabase/migrations/**`, and `.claude/schema-registry.json`.
- The shared `C:\CRX_Manager` checkout is dirty and actively changing `.github/workflows/ci.yml`; this branch therefore uses a separate clean worktree and does not touch or control that Claude lane.
- Graphify 0.9.16 refreshed the isolated worktree at the starting SHA. It is navigation evidence only, not verification.
- The branch was fast-forwarded to `08e773189bb71d0ddb3d80dd941e69ab70992dde` after PR #482 merged. Its new per-change changelog convention is preserved: this change now adds a new `docs/changelog.d/` record instead of appending to the shared changelog.
- The classifier comes from the exact comparison-base worktree. Missing base classifier, zero push base, invalid event/history, missing objects, ambiguous merge bases, non-UTF-8 output, unsafe path syntax, non-regular Git entries, empty ranges, and mixed/protected changes all select complete CI or fail the routing prerequisite red.
- Only newly added, correctly shaped `docs/changelog.d/` paths are checked with the trusted base's shared `entryContentVerdict`; modifying, deleting, or renaming an existing record, malformed names, impossible dates, invalid candidate content, and the folder README do not receive the fast route.
- `npm run test:ci-scope`: 70 assertions passed. Real temporary repositories cover PR merge-base semantics, push ranges, safe and unsafe renames, deletion, symlink-shaped entries, changelog content/status, and fallback errors.
- Mutation proof: removing the lowercase `.md` requirement, replacing the trusted-base worktree invocation, routing the Phase 3C packet suite to the docs lane, disabling changelog-content refusal, and accepting non-added changelog records each turned the owning test red; every guard was restored and rerun green.
- `npm run test:supplier-pricing-phase3c-packet`: passed after updating its workflow-topology assertions.
- `npm run lint` and `npm run typecheck`: passed.
- `npm run test:correction-guards`: passed on the implementation state before the non-overlapping PR #482 fast-forward; the commit hook remains the exact combined-state gate.
- `npm run test:agent-workflows`: passed again after integrating PR #482.
- `npm run test:contracts`: 3 files and 121 tests passed.
- `npm run test:coverage`: 340 files and 4,785 tests passed, with 123 intentional skips; configured coverage thresholds passed.
- `npm run check:pricing-phase2-live-smoke`: passed; the proof remains self-contained and rollback-only.
- `npm run check:docs`: passed after the decision and changelog-record updates.
- `npm audit --audit-level=critical`: zero vulnerabilities.
- `npm run build`: passed; Vite built 4,268 modules and the PWA outputs.
- `actionlint` v1.7.12 passed after ignoring only the pre-existing intentional `if: false` E2E warning; independent YAML parsing found the expected six jobs.

## WRITTEN

- `.github/workflows/ci.yml`: trusted classification job, fail-closed prerequisite binding, and conditional expensive steps while retaining both required contexts.
- `scripts/classify-ci-scope.mjs`: exact event-range classifier and CLI outputs.
- `scripts/classify-ci-scope.test.mjs`: 63 focused assertions and real Git fixtures.
- `scripts/supplier-pricing-phase3-private-artifacts.test.mjs`: updated topology assertions that keep the multi-minute packet suite explicit in full CI.
- `package.json`: `test:ci-scope` command.
- `docs/manual/DECISION_LOG.md` and `docs/changelog.d/2026-08-26-trusted-docs-ci-routing.md`: durable policy and shipped-change record.

## NOT STARTED / STILL REQUIRED

- The local Git Bash full SQL history audit was deliberately stopped after roughly 30 minutes and 370 of 892 unchanged migrations. It had emitted only known historical warning/violation classes, but no final baseline count is claimed. This branch contains no SQL; the identical audit remains mandatory in GitHub's required `SQL Migration Validation` check on Linux and must pass before merge.
- Commit-hook proof and exact commit SHA.
- Independent exact-head adversarial review.
- Protected implementation PR, GitHub checks, CodeRabbit resolution, Vercel, merge, and exact-main verification.
- A separate ordinary-docs proof PR after the classifier is on `main`; the introducing PR and its first merge push deliberately run complete CI.
- Measured fast-lane timing and production HTTP verification.

## APPROVAL STATE

Mason explicitly approved building and finishing this scope on 2026-08-26. Ordinary isolated edits, tests, branch publication, reviewed green PR merge, normal Vercel deployment, and post-merge verification are authorized under the standing delivery contract. No live migration, data mutation, secret, permission, billing, domain, force-push, or destructive action is part of this work.

## GATES AND BLOCKERS

- Classification defaults to full CI on empty, malformed, unknown, non-UTF-8, or mixed changes.
- Only a narrow allowlist of ordinary Markdown records may use the fast lane. Agent instructions, workflow/reference manuals, generated maps, configuration, source, tests, migrations, and tooling remain full CI.
- The classifier used by CI must come from the trusted comparison base when present. The introducing PR and any missing-classifier state force full CI.
- `Phase 3C Candidate Containment (CI)` still runs before candidate processing.
- `SQL Migration Validation` continues to execute on every event and bind prerequisite failures.
- The required `Lint, Type Check, Test, Build` job continues to execute on every event; only its expensive steps may be omitted after successful trusted classification.
- Independent exact-head review, all GitHub checks, CodeRabbit, Vercel, merge, exact-main CI, and production HTTP proof remain required.

## FIRST ACTION

Stage this refreshed handoff and commit through the repository hooks. Treat GitHub's required Linux SQL audit as the owning full-history proof rather than repeating the disproportionate Windows scan.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
