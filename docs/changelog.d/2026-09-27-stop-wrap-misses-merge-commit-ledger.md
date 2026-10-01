## 2026-09-27 - Known issue: the stop-wrap ledger check cannot see a fragment added in a merge commit

- **What happens:** `.claude/hooks/stop-wrap.mjs` finds this session's ledger records with
  `git log --name-status --since=<session start>`. Without `-m` / `--first-parent -m`, git prints no
  file list for a merge commit, so a `docs/changelog.d/` fragment committed as part of a merge is
  invisible. A session whose only commit is a merge that adds its own fragment is told "no ledger file
  was touched" and cannot stop.
- **Seen on:** PR #795, merge `0a4a4a8`, which added
  `docs/changelog.d/2026-09-27-pr795-brought-up-to-date-with-804.md` (the pre-commit ledger guard,
  which reads the staged index, accepted it). Related to the resumed-session false positive recorded in
  `2026-09-25-stop-wrap-ledger-check-misses-resumed-session.md`.
- **Status:** not fixed here (guard file; out of PR #795's scope). Suggested fix: read merge commits'
  first-parent diff (`git log -m --first-parent --name-status`) so fragments a merge adds are counted,
  with a test for a merge-only session.
