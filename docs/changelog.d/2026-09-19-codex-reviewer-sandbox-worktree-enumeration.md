## 2026-09-19 - Codex reviewer sandbox: refuse reviews when worktree enumeration fails

**What changed.** `worktreeRoots()` used `runGit`'s empty-string fallback, so a failed `git worktree list` (Git unavailable, ownership rejected, timeout) looked exactly like "no worktrees". Sibling worktrees under `.claude/worktrees` hold their own `.env` files and are nested too deep for the one-level drive scan, so that silence was a hole in the deny list rather than an empty one. It now throws, and both wrappers already treat a sandbox build failure as fail-closed: no review runs and no proof is minted.

Found by the Codex connector on PR #725 at head e58b14983.

**Proof.** `node scripts/write-codex-push-proof.test.mjs` asserts the real, uninjected enumeration refuses for a directory that is not a repository. Both reviewer test files pass, and the real deny list still builds on this machine (15 paths).
