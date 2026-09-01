## 2026-09-01 — the agent-health test ran against the real repository, and blocked every commit on the machine

`scripts/agent-health-check.test.mjs` builds throwaway git repositories and asserts on
`checkGitHooksInstalled()`. Git exports `GIT_DIR` (and the rest of `git rev-parse --local-env-vars`)
to hook child processes, and nothing in that file removed them. Both halves of the test therefore
targeted the **real** repository instead of the fixture:

- the fixture's `git config core.hooksPath .husky` wrote to the real repo, and
- `agent-health-check.mjs:203` read `core.hooksPath` back from the real repo, because it shells out
  with no `env` and the test calls it **in-process**.

So the assertion at line 213 — "the tracked directory is the correct target" — read a repository the
test never configured and got `FAIL`.

**Why it hid.** Standalone runs and CI have no `GIT_DIR`, so both stayed green. The bug existed only
on the git-hook path, which CI does not exercise. Meanwhile `git commit` failed in **every worktree
on the machine, in every session**, with an assertion that reads like genuine Claude/Codex workflow
drift and sends you hunting the wrong subsystem. Two sessions lost time to it independently on this
date.

**Collateral damage, which is the worse half.** Because the fixture's `git init` / `git config` land
on the real git dir, each blocked commit also flipped `core.bare = true` on the shared
`C:/CRX_Manager` repo — which then blocks commits everywhere with "must be run in a work tree" — and
injected `Hooks Test <hooks-test@example.invalid>` as the repo-local commit identity. The bare flag
fails loudly; the identity does not. A commit landing in a window where `core.bare` happened to be
correct would be silently misattributed.

**The fix.** Scrub the leaked variables from `process.env` once, before the first call. The seven
other test files with this hazard use `scratchHookEnvironment()` from `.claude/hooks/git-test-env.mjs`
to scrub a *spawned child's* environment; that shape does not work here, because the reader
(`checkGitHooksInstalled`) runs in-process and has no child to scrub. This reuses the same helper's
exported `gitLocalEnvironmentNames()` — so the variable list stays sourced from
`git rev-parse --local-env-vars` rather than hand-maintained — and additionally drops the indexed
`GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs, which git does not list. No production file was
changed.

**Proof observed.**

- **Mutation-tested in both directions**, using the documented absolute-`GIT_DIR` reproduction
  (a relative `GIT_DIR=.git` re-resolves against the child's cwd and falsely passes):
  - Pre-fix file under `GIT_DIR=C:/CRX_Manager/.git/worktrees/<name>` → **fails**, exit 128.
  - Fixed file under the identical `GIT_DIR` → **passes**.
  - Fixed file standalone → passes.
- The mutation run re-corrupted the shared repo exactly as described, which is itself confirmation of
  the mechanism: `core.bare` went `true` and the identity was replaced. Both were repaired and
  verified — `core.bare=false`, identity restored to the value observed before the run
  (`Mason Wells <masonwells1@users.noreply.github.com>`).
- **Blast radius checked:** `git log --all --author="hooks-test@example.invalid"` returns **0**
  commits. Nothing was misattributed. The 8 `Ledger Test <ledger-test@example.invalid>` commits are
  the separate, already-documented 2026-08-26 incident and are branch-only.

**Also repaired, separately.** This worktree carried a per-worktree `core.hooksPath` override pointing
into an abandoned PR #432 Codex checkout, so its commits were gated by that checkout's hooks rather
than this repo's. Cleared with `git config --worktree --unset core.hooksPath`; `--worktree` is
load-bearing, since the bare `--unset` form deletes the correct repo-wide `.husky` value and leaves
the foreign override winning. Verified back to exactly one line:
`file:C:/CRX_Manager/.git/config .husky`. A peer session reported two further worktrees in the same
state — `github-manual-review-override-975612` and `pr-517-ownership-f16039` — which are not this
session's to write to.

**Not fixed here.** `agent-health-check.mjs:203` still shells out to git without an `env`, so
`checkGitHooksInstalled()` will consult an ambient `GIT_DIR` if some other caller invokes it from a
hook. That is a production file and a separate change; the test no longer depends on it.
