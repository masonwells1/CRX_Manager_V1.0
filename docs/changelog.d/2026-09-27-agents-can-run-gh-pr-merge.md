## 2026-09-27 - agents can run `gh pr merge`; the merge gate decides

Follow-up to #804 (autonomous landing). `.claude/settings.json` still listed `Bash(gh pr merge:*)` in
its `ask` tier. Under `defaultMode: "dontAsk"` that is a silent denial, so no agent could merge even
when every gate #804 added was clear. Mason approved removing that one entry in chat ("Yes do the
settings PR") and merges this PR by hand, because it is a gate change.

- Removed `Bash(gh pr merge:*)` from the `ask` tier. `Bash` is already in `allow`, so the command now
  reaches `pr-merge-guard.mjs`. For a merge **into `main`**, that guard still denies a missing
  clean exact-SHA Sol proof, a final head CodeRabbit has not reviewed, checks that are not green,
  `CHANGES_REQUESTED`, `--admin`, or an unpinned or stale head. It always blocks merges into `master`
  or `production`. A merge into any other branch is not a production landing, so it passes unchecked.
- Nothing else changed: no `deny` entry, and the GitHub-MCP `merge_pull_request` tool stays in `ask`.
- DECISION_LOG 2026-09-26 residual (d) is marked closed.

Open PR #822 carries the same one-line change inside a much larger bundle. Whichever lands second
drops that line in its rebase.
