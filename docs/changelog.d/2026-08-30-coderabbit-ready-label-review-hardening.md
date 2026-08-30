## 2026-08-30 - CodeRabbit ready-label review hardening

- Added a production 30-second settling default when the final-review gate caller omits the
  quiet-period option, while preserving explicit zero/negative test and maintenance overrides.
- Added bounded polling when GitHub temporarily reports pull-request mergeability as unknown, so a
  healthy frozen candidate is not rejected while GitHub finishes computing its merge state.
- Added regression cases that prove the default settling wait is invoked and that temporary unknown
  mergeability recovers before the gate evaluates the candidate.
- Updated the canonical landing sentence to name the exact `ready-for-coderabbit` label.
- Ordered overlapping same-name check reruns by check-run ID, with a start/completion-time fallback,
  so a newer in-progress rerun cannot be hidden by an older run that finishes later.
- Cleared both workflow labels when recording the requested marker fails, including ambiguous
  failures after GitHub may have accepted the label.
- Bound required checks to their trusted GitHub App and workflow or status creator, and rejected
  same-name results with duplicate or untrusted provenance.
- Required exact success for the CI, SQL, and Vercel gates while retaining neutral/skipped support
  only for optional reported checks.
- Queued new-commit reset events behind an in-flight gate so its post-comment stale-head cleanup can
  finish before the reset removes workflow labels.
- Reconciled every pull-request edit that can replace a queued reset event: base-branch changes clear
  both labels, unrelated edits preserve a confirmed current-head command, and stale or unconfirmed
  workflow state clears so an old exact-head command cannot suppress review of a different candidate diff.
- Treated an edited event's label payload as potentially older than an in-flight marker write, preserving
  live dedupe state through pull-snapshot or command-lookup failures so a retry cannot post a second command.
- Resolved workflow provenance for optional GitHub Actions checks as well as required checks, preventing a
  later passing same-name job from another workflow from hiding a failed containment or security check.
- Required the landing operator to verify three identical SHAs: the gate marker, CodeRabbit's
  authenticated formal approval, and the live PR head. A post-snapshot commit cannot pass that check.
- Revalidated mergeability at approval time, rejecting behind, conflicting, or unresolved branch
  state before accepting the review event, and rechecked every reported check at that boundary.
- Reset both gate labels on close/reopen, draft transitions, base changes, auto-merge changes, and
  requested-marker removal. Metadata reconciliation preserves an exact marker only for dedupe.
- Documented that generic Actions-authored comments/statuses are not workflow-specific security
  identities; live branch protection and the authenticated CodeRabbit review remain the merge boundary.
- Required `ready-for-coderabbit` to remain attached at every live pull-request recheck, allowing a
  maintainer to cancel a queued request during the quiet period.
- Added marker and raced-command cleanup when final or post-comment GitHub API snapshots fail.
- Added a top-level recovery boundary so any other unexpected API failure either preserves a
  confirmed exact command for deduplication or clears the ready state for a deliberate retry.
- Bound the introducing-PR no-op to PR #516 and its immutable base SHA only; every later missing
  trusted-script state fails closed, while a present trusted script remains mandatory.
- Reconciled live head, labels, and exact-marker state on non-CodeRabbit review events so they cannot
  replace a queued synchronize reset and preserve authorization for a stale candidate.

Verification: all focused final-review gate cases, lint, typecheck, production build, workflow
parity, and documentation checks passed after the review fixes.
