## 2026-09-05 - armed mode now actually blocks push, force-push and PR landing

`.claude/hooks/autopilot-lib.mjs` matched `/git\s+push\b/` and `/\bgh\s+pr\s+merge\b/`. Both `git`
and `gh` accept **global options between the binary and the subcommand**, and `\s+` cannot span
them — so `git -C <dir> push`, `git -C <dir> push --force` and `gh -R <owner>/<repo> pr merge` were
**auto-approved while armed**. Armed mode did not prevent pushing or merging, and a merge lands on
`main` and auto-deploys production through Vercel.

Found on 2026-09-05 by running `autopilotDecision()` against a corpus rather than by reading the
regex — the pattern had been read and quoted accurately several times while still being wrong about
what it matched. Two real pushes (`2ff8bdafc`, `de2c43a83`) had already gone through the hole; both
were disclosed unprompted by the lane that made them, which is the only reason it was found.

The root cause spans two guards: the Codex push gate **refuses** `cd <path> && git push` and tells
callers to use `git -C <repo> push` — the exact shape this guard could not see. A guard's suggested
replacement shape is unaudited, not blessed.

## What changed

Option tokens between binary and subcommand are now enumerated (`GIT_OPTS` / `GH_OPTS`) and applied
to every affected pattern — not just push/force/merge, but `reset --hard`, `clean -fd`,
`worktree remove`, `branch -D` and `filter-branch`, which all shared the identical blind spot.

Deliberately **not** a `.*` wildcard: that would deny `git commit -m "fix the push bug"`. Both
directions are covered in `.claude/hooks/autopilot-lib.test.mjs` — 13 dangerous shapes that must be
denied, and 10 benign ones that must stay allowed.

## Proof

`node .claude/hooks/autopilot-lib.test.mjs` → 107 assertions passed (82 before).
`npm run test:agent-workflows` and `npm run agent-health` both pass.

This widens a deny-set only; nothing that was blocked becomes allowed.
