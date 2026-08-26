## 2026-08-26 — a test on main was corrupting the repository for every session

`scripts/check-ledger-update.test.mjs` built a throwaway git repo and ran `git init` in it
without clearing the `GIT_*` environment. husky runs pre-commit with `GIT_DIR`,
`GIT_INDEX_FILE` and `GIT_WORK_TREE` exported at the real repository, so under the hook
that `git init` did not create a scratch repo — it re-initialised `C:/CRX_Manager` with a
working directory that is not its work tree, flipping `core.bare` to `true`.

That breaks **every worktree at once** with `fatal: this operation must be run in a work
tree`, and it does not announce itself. Over one night it surfaced as a private-artifact
containment failure, a dependency failure, and a doc-drift failure — three different
alarms, none of them the actual fault. Its `git config user.email` / `user.name` calls
were also writing the fixture identity into the real repository's config.

Two hypotheses were tested and **discarded** before the real one was found: the new
new git-spawning test of mine (a sandbox reproduction did not flip the flag) and concurrent commits
across worktrees (a peer session held every git operation and it still flipped). The hold
is what made the cause findable, by ruling out everything else.

A second defect falls out of the first. The test's spawned CLI inherited `GIT_DIR` too, so
it was reading the **real repository's** staged files rather than its fixture's — its
rename assertion had been passing for the wrong reason. Isolating the environment made it
fail immediately (`0 !== 1`); it now passes because it inspects the repo it actually built.

The fix routes through `scratchHookEnvironment()` in `.claude/hooks/git-test-env.mjs`
rather than a private sanitizer. That helper already existed for exactly this failure, and
every other git-spawning test already used it — `write-codex-push-proof`,
`backup-claude-memory`, `applied-source-containment`, `migration-apply-guard` (whose
comment describes this precise bug), `registry-freshness-lib`. This one file had opted
out. The defect was never a missing safeguard; it was one caller declining an existing
one, which is why adding a third private copy would have been the wrong fix.

Verified with `GIT_DIR` and `GIT_INDEX_FILE` set exactly as the hook sets them:
`check-ledger-update` 60 assertions pass and `core.bare` is
still `false` afterwards.
