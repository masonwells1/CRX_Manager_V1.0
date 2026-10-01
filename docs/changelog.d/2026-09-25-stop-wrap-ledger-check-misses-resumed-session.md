## 2026-09-25 - Known issue: the stop-wrap ledger check misfires on a resumed session

- **What happened:** while driving PR #795 (guards read nested shells and refuse gh aliases),
  `.claude/hooks/stop-wrap.mjs` kept blocking the end of the session with "Commits exist this
  session but no ledger file was touched", even though that session's own commit `249901b`
  added `docs/changelog.d/2026-09-24-guards-read-nested-shells-and-gh-aliases.md` and edited
  `docs/reference/agent-guardrails.md`.
- **Why:** the check reads "this session" as `git log --since=<mtime of the session-start
  snapshot>`. A cloud container restart (here, during a scheduled PR check-in) re-runs the
  SessionStart hooks and rewrites that snapshot, so the window starts after the real work. The
  only commits left in it were merges of `origin/main` into the PR branch, whose own diffs
  `git log --name-status` does not list, so no ledger file appeared.
- **Status:** not fixed here — recorded so the next agent does not add a filler entry to quiet
  it. A fix would anchor the window on the first snapshot of the session (or on the branch's
  merge-base with `origin/main`) instead of the latest snapshot's mtime. Not verified beyond
  reading the check's source and this session's commit timeline.
