## 2026-08-28 - CodeRabbit final-review gate

- Disabled automatic CodeRabbit reviews so work-in-progress pull-request updates do not spend review budget.
- Moved the CodeRabbit trigger to the frozen, green release candidate after the separate Codex review.
- Recorded GitHub's required current approval, stale-review dismissal, last-pusher separation, and administrator enforcement.
- Aligned the active shipping checklist and failure guidance with the new exact-head approval gate.

Verification: the current CodeRabbit schema validation, agent-workflow suite, generated-workflow parity,
documentation drift check, and whitespace check passed locally.

External limit: the end-to-end CRX pull-request behavior remains unverified until the real pull request
shows no automatic review, then records one manual review and a formal approval on its frozen head.
