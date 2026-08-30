## 2026-08-30 - CodeRabbit ready-label review hardening

- Added a production 30-second settling default when the final-review gate caller omits the
  quiet-period option, while preserving explicit zero/negative test and maintenance overrides.
- Added bounded polling when GitHub temporarily reports pull-request mergeability as unknown, so a
  healthy frozen candidate is not rejected while GitHub finishes computing its merge state.
- Added regression cases that prove the default settling wait is invoked and that temporary unknown
  mergeability recovers before the gate evaluates the candidate.
- Updated the canonical landing sentence to name the exact `ready-for-coderabbit` label.
- Ordered overlapping same-name check reruns by creation time so a newer in-progress rerun cannot
  be hidden by an older run that finishes later.
- Cleared both workflow labels when recording the requested marker fails, including ambiguous
  failures after GitHub may have accepted the label.
- Bound required checks to their trusted GitHub App and workflow or status creator, and rejected
  same-name results with duplicate or untrusted provenance.
- Required exact success for the CI, SQL, and Vercel gates while retaining neutral/skipped support
  only for optional reported checks.
- Made new-commit reset events cancel an in-flight final-review run before it can post its command;
  the post-comment head check remains as recovery for the service boundary after GitHub accepts it.

Verification: all focused final-review gate cases, lint, typecheck, production build, workflow
parity, and documentation checks passed after the review fixes.
