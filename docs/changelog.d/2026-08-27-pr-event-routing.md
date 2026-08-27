## 2026-08-27 — Route low-risk pull-request events without discarding proof

Changed the trusted-base CI classifier so title/body-only edits use the cheap lane only
when GitHub exposes a successful, completed, non-expired full-CI artifact for the exact
base and head commits. Only the newest matching proof attempt can count; a newer failed,
pending, expired, or current run blocks an older success. `ready_for_review`, base-branch
edits, ambiguous edits, unsupported events, malformed payloads, and API lookup failures
still force complete CI. Metadata runs also use a separate concurrency lane so they cannot cancel an
in-flight code-proof run, and API requests have a short fail-closed timeout.

Focused routing and containment regression suites passed, including mutations that
misclassified a base edit, accepted a failed workflow, or allowed the current run to
attest itself. Full local CI, exact-head adversarial review, GitHub checks, and
post-merge verification are recorded in the pull request rather than claimed here
before they occur.
