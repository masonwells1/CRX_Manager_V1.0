## 2026-09-28 - PR #795 brought up to date with `main` at `a169253` (#839)

- **What:** `main` moved to `a169253` (#839, removal of finished records). It touches no guard code and
  no file this PR changes, and it merged with no conflicts.
- **Proof:** `check-doc-drift` passes on the merge.
- **Not verified:** only `check-doc-drift` ran locally; the guard test suites, lint and the rest of CI ran on GitHub after the push.
