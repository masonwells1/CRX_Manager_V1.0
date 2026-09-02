## 2026-09-01 — two P1 guard bypasses closed: `rg --pre` executes, and `a//b` is the same file

A seventh exact-SHA `gpt-5.6-sol` review of PR #530 reproduced two live bypasses of
`review-proof-guard.mjs`. Both are fixed here with tests that were mutation-checked in both
directions.

**1. An allowlisted reader that executes.** `rg` sits on the fail-closed read-only head allowlist,
but ripgrep's `--pre COMMAND` runs `COMMAND PATH` for every input file. So

```
rg --pre rm pattern .github/workflows/ci.yml
```

runs `rm .github/workflows/ci.yml` while passing every registered Bash PreToolUse guard. The
reviewer reproduced the deletion. `--hostname-bin` names a program to run for the same reason.

This is not a new kind of rule: it is the shape already denied for `node -e` and `find -exec` — a
runner wearing a reader's name — applied to the one remaining allowlisted head that has an exec
escape. Plain `rg` searching of a guarded file stays allowed, and tests pin that.

**2. Doubled separators.** `.github//workflows/ci.yml` is the same file to both POSIX and Win32, and
a different string to a matcher that spells the separator once. So `rm -f .github//workflows/ci.yml`,
`rm -f .codex//hooks/production-action-guard.mjs`, and writes to `scripts//verify-deps.mjs` all
passed the complete hook chain.

The reviewer demonstrated only the shell channel. The path-field resolver used for MCP and tool-input
writes had the identical early return, so `.claude//hooks/review-proof-guard.mjs` would have slipped
that channel too. **Both are fixed** — fixing one and leaving the other is the same defect, still
reachable.

**Verified, not asserted.** Both bypasses were run against the real hook, with probes chosen to be
harmless if the guard failed (`cp .husky//pre-push /dev/null`, `rg --pre echo typecheck
.husky/pre-push`) — both refused by REVIEW PROOF GUARD specifically. `rg -c typecheck
.husky/pre-push` still returns its count, so ordinary reading is unaffected.

Each of the three code changes was then removed one at a time and the suite re-run: every mutation
failed on exactly the assertion meant to catch it (`rm -f .github//workflows/ci.yml`, the MCP
path-field case, and `rg --pre rm …`). One of the three — the separator collapse inside
`resolveDotSegments` — went **green** when removed, because its only caller already collapses. It is
kept as defense against a future second caller and is marked `@unproven` in the source rather than
described as load-bearing.

**Round count.** Mason capped adversarial iteration on this file at six rounds on 2026-09-01, and
that cap stands. These two findings were already sitting on the PR when the cap was set; fixing
delivered findings is not another round, and no new review was commissioned. The standing conclusion
is unchanged: a command-text guard does not converge, and the enforcement boundary is GitHub branch
protection plus required CI, not the local hook.
