## 2026-09-28 - Known behaviour: a PR with a merge conflict gets no main CI run

- **What happens:** GitHub runs `pull_request` workflows against the PR's test-merge commit. When the PR
  conflicts with `main` there is no test-merge commit, so "CI -- Lint, Type Check, Test, Build" is never
  created for the new head. Nothing fails and nothing turns red; the run is simply absent. The
  `pull_request_target` workflows (containment, CodeRabbit lifecycle) still run, so the PR looks mostly
  green.
- **Seen on:** PR #795 twice — head `92d7d4b` after #802/#804 landed (fixed by merge `0a4a4a8`), and the
  conflict with #830 (fixed by merge `69b8899`).
- **What to do:** when an expected CI run is missing, check the PR's mergeable state first. If it is
  `dirty`, merge `main` into the branch and resolve the conflict; do not push an empty commit or close and
  reopen the PR to kick CI.
