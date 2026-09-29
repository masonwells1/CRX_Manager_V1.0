## 2026-09-27 — stop-wrap: a merge from main no longer triggers a false "no ledger" loop

`stop-wrap.mjs` warns when commits landed during a session but no ledger file was touched.
On 2026-09-26 it blocked session end in a loop even though the branch's changelog entry was
already committed. The only commit made after the session-start snapshot was a merge of
`main`, and `git log --name-status` lists no files for a merge commit, so the check saw
"commits, but no ledger".

Fix, refined across eleven Codex review rounds (PRs #824 and #827):

- **Only this session's own work counts.** The hook reads the commits this checkout
  created since the session started from git's own record of them (HEAD's reflog), instead
  of guessing from the branch layout. Commits that only arrive by fetching or merging
  `main` (including ones `main` gained after the snapshot) are not this session's work.
  Those commits carry their own ledger through the pre-commit guard
  (`scripts/check-ledger-update.mjs`). A commit made this session still counts, whether it
  was made on a side branch and merged in or has already landed on `main`. A commit that
  was amended, reset or rebased away stays in the reflog but no longer exists in the
  history, so it is ignored. Otherwise a ledger edit amended out of a commit would still
  count. The commit a rebase writes after a conflict resolution
  (`rebase (continue)`) counts like any other replayed commit. Which reflog entries belong
  to the session comes from an anchor: the newest reflog entry, which `session-snapshot.mjs`
  records at session start. Everything newer than the anchor is the session's. Entry
  timestamps are committer dates, which `rebase --committer-date-is-author-date` backdates,
  and the reflog's length changes when old entries expire, so neither is used as the
  boundary. Timestamps are only the fallback when no anchor was recorded or it has expired. Three earlier
  graph-based rules each missed one of these cases:
  - plain `git log --since` counted main's post-snapshot commits;
  - a first-parent scan dropped side-branch work;
  - subtracting main's tip dropped work that had already landed.
- **A merge counts only for what its author wrote by hand.** Git's own automatic merge of the
  same two parents is recomputed with `git merge-tree --write-tree`. Every file where the
  committed merge differs from it was written by the resolver: a conflict fix, including one
  resolved by simply taking one side, or a newly added file. A clean automatic merge, even of
  separate edits to the same file, counts for nothing. Octopus merges, and a git without
  `--write-tree`, fall back to the combined diff (`git diff-tree --cc`).
- **A changelog entry written during a resolution counts.** A file the resolution adds keeps
  its "added" status, so it satisfies the rule that a changelog.d entry must be new. The
  comparison detects renames, so renaming an existing entry during a resolution is not
  mistaken for a new one.
- A session with a real, unrecorded commit is still warned.

### Proof observed

- New `.claude/hooks/stop-wrap-ledger.test.mjs`, wired into `npm run test:correction-guards`.
  It runs the real SessionStart and Stop hooks in a temp git repo with thirteen cases:
  - a clean-merge-only session gets no warning;
  - a merge with a hand-written conflict resolution still warns;
  - a merge whose resolution adds a changelog entry counts as recorded;
  - merging an unrecorded commit that `main` gained after the snapshot (made in another
    clone and fetched), including a clean same-file merge, does not warn;
  - a conflict resolved by taking one side still warns;
  - an unrecorded commit made on a side branch this session and merged in cleanly still warns;
  - an unrecorded session commit that has already landed on `main` still warns;
  - a ledger edit amended out of the session's commit does not count, so it still warns;
  - an unrecorded session commit replayed through a conflict-resolved rebase still warns;
  - a merge resolution that only renames an existing changelog entry still warns;
  - a session commit backdated by `rebase --committer-date-is-author-date` still warns;
  - a session commit still warns when an old reflog entry expired during the session;
  - an unrecorded real commit still warns.
- Each earlier version fails the case written for the gap that replaced it:
  - With no fix, the clean-merge case fails with the exact warning from 2026-09-26.
  - With only `--no-merges`, the conflicted-merge case fails.
  - With every resolution file forced to "modified", the added-entry case fails.
  - With the combined-diff version, the same-file clean-merge case fails.
  - With the first-parent-only scan, the side-branch case fails.
  - With the "skip what is on `main`" scan, the landed-on-main case fails. Codex reproduced
    this, and the new test mirrors it.
  - Without the reachability filter, the amended-out case fails.
  - Without `continue` among the rebase actions, the rebase case fails.
  - Without rename detection in the merge comparison, the rename case fails.
  - With the timestamp-only cutoff, the backdated-rebase case fails.
  - With a length-based boundary, the expiry case finds no session entries. Codex
    reproduced this; the test mirrors it.
- With the final version, all thirteen cases pass. `npm run test:correction-guards`,
  `npm run check-doc-drift` and `npm run test:agent-workflows` pass.
