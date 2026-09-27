## 2026-09-26 — Codex #794 P1 fix: delivery PRs #798 → #801 → current

The fix for the Codex post-merge P1 on #794 (a peer's dangling fence clearing Mason's
hold; recorded in `2026-09-26-codex-794-dangling-fence-clear.md`) was first opened as
PR #798. Its delivery then changed twice:

1. GitHub reported #798's branch behind `main` (#797 had landed). Per
   `.claude/commands/ship.md`, current `main` was merged into the branch. Per
   `docs/reference/coderabbit-native-review.md`, a head change needs a fresh delivery
   PR, so #798 was closed ("Replaced by #801").
2. The Codex GitHub App review of #801 (P2) found the fix's changelog still recorded
   260/260 hook assertions, while the merged head runs 275 (#797 added 15). That record
   was corrected and this file added, which changed the head again. #801 was therefore
   closed and replaced by a fresh delivery PR from the same branch.

### Proof observed

- #798 on `dff8028`: every CI check green; the Codex GitHub App reviewed it twice with no findings.
- After merging `main`: `prompt-hooks.test.mjs` 275/275,
  `npm run test:correction-guards` and `npm run check-doc-drift` pass.

### Not verified

- The CodeRabbit review and CI of the final delivery PR were still pending when this was written.

### Side finding

`stop-wrap.mjs` gives a false-positive "no ledger file was touched" when the only commit
since the session-start snapshot is a merge. `git log --name-status` lists no files for
merge commits. This is queued as a separate follow-up task.
