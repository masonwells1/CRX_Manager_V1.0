## 2026-09-01 — `agent-health-check` leaked GIT_DIR into fixtures and blocked every commit

`scripts/agent-health-check.test.mjs` runs in the pre-commit gate and creates throwaway
repositories to test against. Nine `execFileSync` git calls passed only `-C <fixture>` or `cwd`, and
neither beats an inherited `GIT_DIR`. Git exports the repository-local `GIT_*` variables to hook
children, so from pre-commit every one of those commands operated on `C:/CRX_Manager` itself.

**This blocked `git commit` in every session and every worktree at once.** It is the same defect
class fixed in `scripts/check-ledger-update.test.mjs` in August; that repair was applied file by
file and this file was missed.

### Why it hid, and why it looked like something else

The test passes standalone and in CI, because neither sets `GIT_DIR` — only the hook path is
destructive, so a green CI proved nothing. Worse, the symptom had changed. The August incident
announced itself with `Command failed: git add ... status: 128`. This one surfaced as:

```
❌ AGENT WORKFLOW CHECKS FAILED — commit blocked.
AssertionError: 'FAIL' !== 'PASS'  at scripts/agent-health-check.test.mjs:213
```

which reads like genuine Claude/Codex workflow drift and sends you auditing the workflow manifests
instead of the test harness.

### Two live hazards, one already realised

- **Loud:** the fixture's `git init` re-initialised the shared checkout, setting `core.bare=true`.
  Every worktree then failed with `fatal: this operation must be run in a work tree`. Hit twice
  while diagnosing this.
- **Silent, and the dangerous one:** the `installRepo` block calls
  `git config user.email hooks-test@example.invalid` / `user.name "Hooks Test"`. Under the leak those
  land in the real repository's config and outrank the global identity, so subsequent commits in
  *every* worktree are misattributed with no warning. This did not fire here only because the run
  aborted at line 213 first. The August instance of the same hazard did fire: 8 commits authored
  `Ledger Test <ledger-test@example.invalid>` still exist on branches. `origin/main` is clean —
  re-verified today.

### The fix

All nine call sites now pass `scratchHookEnvironment()` from `.claude/hooks/git-test-env.mjs`, the
existing helper already used by seven other test files. It asks git itself via
`rev-parse --local-env-vars` and additionally strips the indexed `GIT_CONFIG_KEY_n` /
`GIT_CONFIG_VALUE_n` payload that a hand-written denylist misses. That includes the spawned
`install-git-hooks.mjs` — the guard *under test* — which is the easiest scrub to omit and the one
that fails silently rather than loudly, letting an assertion pass for the wrong reason.

**Scrubbing the test alone was not sufficient**, which only the verification caught. The failure
persisted because `checkGitHooksInstalled()` in `scripts/agent-health-check.mjs` makes its own git
call and runs in-process, inheriting `GIT_DIR` directly. It accepts a `root` argument and promises to
report on it; ambient `GIT_DIR` silently redirected it, so it read the calling repository's
`core.hooksPath` while still comparing against `root/.husky` — a correctly installed target reported
FAIL. `checkBranchStaleness()` has the same defect (benign — it only downgrades to WARN) and is fixed
in the same pass rather than left as the surviving half of the class.

### Verification

- `node scripts/agent-health-check.test.mjs` — passes (as it always did).
- `GIT_DIR=<absolute worktree gitdir> node scripts/agent-health-check.test.mjs` — **failed at
  line 213 before, passes after.** This is the assertion that matters; a relative `GIT_DIR=.git`
  re-resolves against the child's cwd and falsely passes, so it must be absolute.
- Same run repeated with `GIT_INDEX_FILE`, `GIT_WORK_TREE`, and `GIT_PREFIX` also set, as a real
  hook exports them — passes.
- After each run: `core.bare` still `false`, `user.email` still Mason's, `core.hooksPath` still
  `.husky` on the shared checkout.

### Standing rule

When this recurs, do not grep for the old symptom text — the message changes with whichever test
leaks. Grep for the mechanism: test files calling `execFileSync("git", ...)` with no `env:` key.
