## 2026-08-31 — the pending-set preflight reads the checkout the session is actually in

`evaluateMigrationApply()` read HEAD and the working tree from `projectDir`. The harness pins
`CLAUDE_PROJECT_DIR` to the PRIMARY checkout even when the session runs in a linked worktree,
so on every worktree session that read resolved to the primary branch instead of the session's
own. A migration authored in the active worktree was therefore invisible to the union added in
the previous round, and the union fixed nothing for exactly the sessions it was written for.
Mason runs dozens of worktrees concurrently, so this is the normal case, not an edge.

New `resolveSessionWorktree(root, hookCwd, listWorktrees)` in `.claude/hooks/codex-push-lib.mjs`
answers "which checkout is this?" from `git worktree list` and the hook's cwd, and
`migration-apply-lib.mjs` now sources the branch/working-tree half of the tracked set from it.
It is extracted rather than duplicated because `sessionProofDirs()` already had to answer the
same question for reviewer proofs — that is the trap this resolution exists to avoid, and a
second copy would drift.

Two mechanics the naive version gets wrong. Worktrees NEST in this repo
(`C:/CRX_Manager/.claude/worktrees/*` under `C:/CRX_Manager`) and `git worktree list` prints the
primary checkout FIRST, so first-match-wins resolves a nested worktree's cwd to the primary and
reintroduces the original bug; the LONGEST containing path is taken instead. Windows reports
different case from `git worktree list` than from `process.cwd()`, so containment is compared on
a case-folded resolved key while the ORIGINAL path is returned. The function returns `null` when
the checkout cannot be established, preserving the module's abstain-and-let-the-caller-refuse
contract rather than silently falling back to the wrong branch.

Raised by Codex as P1 on round 3 of PR #502.
