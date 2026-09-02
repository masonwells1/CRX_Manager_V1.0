## 2026-09-01 — corrected the last copy of a withdrawn blast-radius claim

Comment-only follow-up to
`2026-09-01-scrub-git-env-in-agent-health-test.md` (shipped in
[PR #543](https://github.com/masonwells1/CRX_Manager_V1.0/pull/543)).

That change fixed a real bug: `scripts/agent-health-check.test.mjs` leaked `GIT_DIR` into its
fixtures and operated on the **real** repository. The first draft described the impact as blocking
"every commit in every worktree." CodeRabbit flagged that as overstated, and it was corrected in the
changelog title, the changelog body, the PR title, and the session memory — but **not** in the
explanatory comment inside the test file itself, which shipped to `main` still carrying the wrong
claim.

**Why a stale comment is worth a commit.** The overstatement points a reader the wrong way. "Every
worktree was blocked" implies the fix closed the whole problem, so the next person skips checking
whether any worktree still points at a foreign hook path — which is exactly the residual exposure
the corrected text calls out. The comment sits directly above the scrub loop, so it is the first
thing a future maintainer reads when deciding whether that loop is still needed.

**The accurate scope**, verified from source on `main` at `379367bfe` rather than from the earlier
session's notes:

- `main`'s own `.husky/pre-commit` never runs this test. Its staged-path condition (line 43) matches
  `scripts/agent-health-check.mjs$` — anchored, so `…test.mjs` does not match — and it invokes
  `node scripts/check-agent-workflows.mjs`, not `npm run test:agent-workflows`.
- The blocked worktrees were those whose `core.hooksPath` pointed at the abandoned PR #432 Codex
  checkout, whose older `pre-commit` runs `npm run test:agent-workflows` unconditionally.
- Those two worktrees (`github-manual-review-override-975612`, `pr-517-ownership-f16039`) have since
  been cleared by another session; both now resolve to the single correct line
  `file:C:/CRX_Manager/.git/config  .husky`.

**Proof observed.** `node scripts/agent-health-check.test.mjs` → `OK - agent-health-check helpers
passed.` Immediately after, the shared repo still reported `core.bare=false` and the identity
`masonwells1@users.noreply.github.com`, confirming the scrub still holds and the run did not write
into the real repository. Comment text only; no executable line changed.
