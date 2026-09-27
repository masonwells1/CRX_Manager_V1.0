## 2026-09-27 - agents can run `gh pr merge`; the merge gate decides

Follow-up to #804 (autonomous landing). `.claude/settings.json` still listed `Bash(gh pr merge:*)` in
its `ask` tier. Under `defaultMode: "dontAsk"` that is a silent denial, so no agent could merge even
when every gate #804 added was clear. Mason approved removing that one entry in chat ("Yes do the
settings PR") and merges this PR by hand, because it is a gate change.

- Removed `Bash(gh pr merge:*)` from the `ask` tier. `Bash` is already in `allow`, so the command now
  reaches `pr-merge-guard.mjs`. That guard still denies a merge without a clean exact-SHA Sol proof,
  CodeRabbit's review of the final head, green checks, or one with `CHANGES_REQUESTED`, `--admin`, or
  a stale head.
- Nothing else changed: no `deny` entry, and the GitHub-MCP `merge_pull_request` tool stays in `ask`.
- DECISION_LOG 2026-09-26 residual (d) is marked closed.

Open PR #822 carries the same one-line change inside a much larger bundle. Whichever lands second
drops that line in its rebase.
