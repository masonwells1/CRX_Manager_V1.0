## 2026-09-02 — two guard test suites were never run by anything; CI now runs them

Found while auditing the GitHub test setup for coverage gaps. `.claude/hooks/pr-merge-guard.test.mjs`
(88 assertions) and `.claude/hooks/prompt-hooks.test.mjs` (155 assertions) existed, were maintained,
and passed — but no `npm` script referenced either file, so neither ran locally at commit or push time
and neither ran in GitHub CI. 243 assertions of regression protection were inert.

`pr-merge-guard.test.mjs` is the suite for the gate that stands between an agent and a production
merge. A regression in `pullRequestApproved()` — the function that decides whether a pull request has
a real approval — would have been caught by nobody.

Both are now appended to `test:correction-guards`, which CI already invokes as "Guard-hook regression
tests (safety net must not regress)". No workflow change was needed, so this collides with nothing in
the current merge queue.

**Proved by mutation, not by a green run.** Replacing the body of `pullRequestApproved()` in
`.claude/hooks/codex-push-lib.mjs` with `return true` (a guard that approves everything) makes
`pr-merge-guard.test.mjs` exit 1 with `AssertionError: REVIEW_REQUIRED fails`. Restored, the chain is
green end to end: 88 and 155 assertions both reported, and `SCHEMA_BASELINE_PASS` at the tail.

**Deliberately left out.** `scripts/apply-live-testdata-maintenance-20260812.test.mjs` is the third
unwired suite and passes today, but it is **blob-pinned** to the exact contents of
`.codex/hooks/production-action-guard.mjs` and `.claude/hooks/codex-push-lib.mjs`. Wiring it into CI
would turn every future edit of either guard into a hard red until the hashes are re-pinned — a real
policy change with fleet-wide blast radius while five pull requests are in flight. It is an owner call,
not a side effect of this one, and is recorded here rather than made silently.

Also corrected in this worktree (config only, nothing committed): `core.hooksPath` was seeded pointing
at `C:\Users\mason\.codex\worktrees\pr432-multitarget-20260825\CRX_Manager\.husky` — a different
checkout's hook code — and was repointed to `.husky`. The worktree-level value wins and is invisible to
`git config --local --get`; read it with `git config --show-origin --get-all core.hooksPath`.
