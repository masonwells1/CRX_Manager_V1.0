## 2026-08-30 - CodeRabbit ready-label review hardening

- Added a production 30-second settling default when the final-review gate caller omits the
  quiet-period option, while preserving explicit zero/negative test and maintenance overrides.
- Added bounded polling when GitHub temporarily reports pull-request mergeability as unknown, so a
  healthy frozen candidate is not rejected while GitHub finishes computing its merge state.
- Added regression cases that prove the default settling wait is invoked and that temporary unknown
  mergeability recovers before the gate evaluates the candidate.
- Updated the canonical landing sentence to name the exact `ready-for-coderabbit` label.

Verification: all 24 focused final-review gate cases, lint, typecheck, production build, workflow
parity, and documentation checks passed after the review fixes.
