## 2026-09-27 — stop-wrap: a merge from main no longer triggers a false "no ledger" loop

`stop-wrap.mjs` warns when commits landed during a session but no ledger file was touched.
On 2026-09-26 it blocked session end in a loop even though the branch's changelog entry was
already committed. The only commit made after the session-start snapshot was a merge of
`main`, and `git log --name-status` lists no files for a merge commit, so the check saw
"commits, but no ledger".

Fix, refined across five Codex review rounds (PRs #824 and #827):

- **Only this session's own work counts.** The session scan skips commits already on the
  base branch (`main`/`master`, local or `origin`), so commits that merely arrive by merging
  `main` (including ones `main` gained after the snapshot) are not counted as this session's
  work. Those commits carry their own ledger through the pre-commit guard
  (`scripts/check-ledger-update.mjs`). A commit made this session on a side branch and then
  merged in is not on `main`, so it still counts. An earlier first-parent-only scan missed it.
- **A merge counts only for what its author wrote by hand.** Git's own automatic merge of the
  same two parents is recomputed with `git merge-tree --write-tree`. Every file where the
  committed merge differs from it was written by the resolver: a conflict fix, including one
  resolved by simply taking one side, or a newly added file. A clean automatic merge, even of
  separate edits to the same file, counts for nothing. Octopus merges, and a git without
  `--write-tree`, fall back to the combined diff (`git diff-tree --cc`).
- **A changelog entry written during a resolution counts.** A file the resolution adds keeps
  its "added" status, so it satisfies the rule that a changelog.d entry must be new.
- A session with a real, unrecorded commit is still warned.

### Proof observed

- New `.claude/hooks/stop-wrap-ledger.test.mjs`, wired into `npm run test:correction-guards`.
  It runs the real hook in a temp git repo with seven cases:
  - a clean-merge-only session gets no warning;
  - a merge with a hand-written conflict resolution still warns;
  - a merge whose resolution adds a changelog entry counts as recorded;
  - merging an unrecorded commit that `main` gained after the snapshot, including a clean
    same-file merge, does not warn;
  - a conflict resolved by taking one side still warns;
  - an unrecorded commit made on a side branch this session and merged in cleanly still warns;
  - an unrecorded real commit still warns.
- Each earlier version fails the case written for the gap that replaced it:
  - With no fix, the clean-merge case fails with the exact warning from 2026-09-26.
  - With only `--no-merges`, the conflicted-merge case fails.
  - With every resolution file forced to "modified", the added-entry case fails.
  - With the combined-diff version, the same-file clean-merge case fails.
  - With the first-parent-only scan, the side-branch case fails.
- With the final version, all seven cases pass. `npm run test:correction-guards`,
  `npm run check-doc-drift` and `npm run test:agent-workflows` pass.
