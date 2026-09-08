## 2026-09-08 — PR #605: `git worktree add` is a protected-path writer

GitHub Codex (P1 on `06f0039a2`, thread on `review-proof-guard.mjs`): the read-only git
subcommand set listed `worktree` whole, so `git worktree add --detach .claude/skills/probe <sha>`
was silent although it populates the named path — an agent could commit a root `SKILL.md` and
materialise it under `.claude/skills/` without the protected-path approval. `move` relocates a
worktree onto the named path and `remove` deletes it; both were silent too.

Fix by class: `git worktree` is a namespace whose only reader is `list`. `gitWorktreeActionOf()`
reads the action word after `worktree` (options skipped); any action other than `list`, including
one the rule has never heard of, is a writer of the paths it names and denies when one of them is
on the enforcement surface. `git worktree list` (with or without `--porcelain`) stays silent.

Proof: eight new deny cases (`add` with `--detach`/`-b`, `move`, `remove`, an unknown action,
`cd … &&` and `git -C` forms) and three allow cases in `review-proof-guard.test.mjs`; the previous
hook, swapped in place, fails at `must deny: git worktree add --detach .claude/skills/probe 0123abc`.
review-proof-guard runs in every mode, so the denial holds during an armed autopilot run as well.
