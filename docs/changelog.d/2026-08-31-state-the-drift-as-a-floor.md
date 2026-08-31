## 2026-08-31 — Fourth baseline move; state the drift as a floor, not a count

`main` advanced a fourth time, to `3ff8dbb1` (PR #534 — git commit/push guards restored across
every worktree, plus a rewrite of the branch-protection paragraph in `AGENTS.md`). The branch
merged it as `800c16a8`, which was verified to alter no file this PR authored.

The move changed nothing in the inventory's tables. It changed something more useful: it made the
report's own sentence about drift wrong for the fourth time.

### The fix is not a bigger number

The report said `main` "moved three times in the few hours this report was in review". Bumping
that to four buys about an hour. It is the same fixed-point problem as the self-referential branch
row — a figure whose subject keeps moving while you write it down.

So the sentence is now written as a **floor**: at least four moves, and assume more since. A
report whose honesty depends on a decaying number is worse than one that says plainly which way
it decays and hands the reader the re-verification step instead. The pinned baseline
(`67e6da9d`) is unchanged and remains the correct design: every figure is stated relative to a
named commit, and the reader re-checks `git rev-parse origin/main` and the PR state at the moment
of deletion.

Two older entries carried the same decaying counts and now point forward rather than contradict:
`2026-08-31-baseline-moved-a-third-time.md` (three moves) and
`2026-08-31-sweep-instead-of-spot-fix.md` (the fix-in-one-file failure, three occurrences at the
time, six by the end).

### What #534 changed that agents should know

`AGENTS.md` now records that the approval rules on `main` — one approval, stale-approval
dismissal, approval from someone other than the last pusher, **branch up to date with `main`**,
and enforcement for admins — come from **classic branch protection**, not from the `protect-main`
ruleset. The ruleset supplies deletion, force-push, PR-required and status-check rules but
requires zero approvals and does not dismiss stale reviews. Removing classic protection believing
the ruleset equivalent would silently drop the merge gate to zero approvals. Both are live; read
the real state before changing either.

The up-to-date-with-`main` requirement is why this branch had to merge again rather than simply
waiting.

### Proof observed

- `git rev-parse origin/main` → `3ff8dbb1243e34d6da561efb55c61c56e8d1d2f2`.
- `git rev-list --left-right --count origin/main...HEAD` → `0 33`: the branch is not behind.
- `git diff c5539905 HEAD` over every file this PR authored is empty — the merge changed none of
  them.
- `npm run check:docs` passes.
