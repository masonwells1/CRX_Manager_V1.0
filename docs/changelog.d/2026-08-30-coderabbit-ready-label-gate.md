## 2026-08-30 - CodeRabbit ready-label gate

- Added a default-branch workflow that turns `ready-for-coderabbit` into exactly one
  `@coderabbitai review` comment for a frozen pull-request head.
- The workflow fails closed unless the PR is open, non-draft, conflict-free, based on `main`, has
  auto-merge disabled, was labeled by a writer, and has all required and reported checks clear.
- `coderabbit-review-requested` prevents duplicate review comments; a new commit, reopened PR, or
  draft conversion resets both labels so a corrected candidate must earn the gate again.
- The hidden SHA marker is dedupe and operator-verification evidence, not an independent security
  identity. Landing still requires that marker, CodeRabbit's authenticated approval, and the final
  PR head to name the same commit immediately before a match-head merge.
- A failed comment post is verified against the live PR: if the command landed, dedupe state is
  preserved; if it did not, both labels clear and the failed run names the deliberate retry path.
- The privileged workflow never checks out or executes pull-request code. Its logic and duplicate,
  reset, stale-head, permission, and check-state behavior are covered by Node regression tests.
- Updated the active CRX shipping guidance to apply the ready label instead of posting the normal
  CodeRabbit command by hand.

Verification after rebuilding on the merged PR #514 head: all focused gate cases, 343 application
test files with 4,825 passing tests, lint, typecheck, the production build, workflow parity, and
documentation checks passed. Exact-head adversarial review, pull-request checks, and the live label
path remain delivery gates for the frozen branch.

Bootstrap limit: this workflow cannot trigger on its own introducing PR because GitHub loads a
`pull_request_target` workflow from `main`; that PR receives one manual final command after it is
frozen and green. Future PRs use only the label gate.
