## 2026-09-27 — stop-wrap: a merge from main no longer triggers a false "no ledger" loop

`stop-wrap.mjs` warns when commits landed during a session but no ledger file was touched.
On 2026-09-26 it blocked session end in a loop even though the branch's changelog entry was
already committed. The only commit made after the session-start snapshot was a merge of
`main`, and `git log --name-status` lists no files for a merge commit, so the check saw
"commits, but no ledger".

Fix, refined across twelve Codex review rounds (PRs #824 and #827):

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
  (`rebase (continue)`) counts like any other replayed commit, as do the commits
  `git pull --rebase` replays (logged under the whole pull command line). That line can
  contain colons, from an `https://` or `file://` remote or a Windows `D:\` path, so the
  match does not stop at a colon. Excluding colons failed the Windows CI run. Which reflog entries belong
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
  `--write-tree`, fall back to the combined diff (`git diff-tree --cc`). An octopus merge
  counts only files it added, because git's octopus strategy refuses any merge that needs a
  hand resolution; its modified files were all merged automatically (CodeRabbit, PR #827).
  That exception covers only the commit the strategy itself wrote. An octopus later
  rewritten by `git commit --amend` keeps its parents, but the amend is hand-authored, so
  its modified files count (Codex P2, PR #827 round 14). The amended commit is compared
  against git's automatic octopus of the same parents, as a two-parent merge is. The
  combined diff alone missed an edit that makes a file equal to one parent, such as
  `git checkout <parent> -- <file>` before the amend (round 15). That automatic result is
  rebuilt with `git merge-tree`, one parent at a time, the way the octopus strategy builds
  it. It is not looked up in HEAD's reflog, which never saw an octopus made in another
  clone or worktree (round 16). On a git without `merge-tree --write-tree` the hook falls
  back to the combined diff.
- **A changelog entry written during a resolution counts.** A file the resolution adds keeps
  its "added" status, so it satisfies the rule that a changelog.d entry must be new. The
  comparison detects renames, so renaming an existing entry during a resolution is not
  mistaken for a new one.
- A session with a real, unrecorded commit is still warned.

### Known limitations

This hook is a reminder at session end. It blocks nothing and never touches data, so these
rare cases are accepted rather than chased further:

- A commit that was amended or rebased away still counts if some other ref keeps it
  reachable, such as a backup branch, tag or stale remote-tracking ref. If that
  superseded commit carried a ledger edit the replacement dropped, the reminder can be
  skipped (Codex P2, PR #827 round 13).
- A session commit that is squash-landed within the same session, and whose branch is
  then deleted (`gh pr merge --squash --delete-branch`), leaves no ref containing it. The
  squash commit arrives by fetch, so the reachability filter drops the original and the
  reminder can be skipped. That work has already passed the PR's own gates, so tying
  squash results back to their source commits is not worth the added complexity (Codex
  P2, PR #827 round 17).
- A session that uses `git commit --amend` to fold new work into a commit made before the
  session started is judged on the whole amended commit against its parent. If that
  earlier commit already added a changelog.d entry, the entry counts and the reminder can
  be skipped. The hook on `main` before this change had the same gap (its `git log
  --since` scan also diffed the amended commit against its parent), so this is not a
  regression (Codex P2, PR #827 round 18).
- Two reflog entries that are byte-identical (same commit, same second, same action)
  make the session anchor ambiguous. The newest match wins, which can undercount
  session entries.

### Proof observed

- New `.claude/hooks/stop-wrap-ledger.test.mjs`, wired into `npm run test:correction-guards`.
  It runs the real SessionStart and Stop hooks in a temp git repo with twenty cases:
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
  - an unrecorded session commit replayed by `git pull --rebase` still warns, pulling from
    a `file://` URL so the colon case runs on every platform;
  - a clean octopus merge of separate same-file hunks does not warn;
  - a hand edit amended into that octopus merge still warns;
  - an amend that makes a file equal to one octopus parent still warns;
  - for an octopus made in another worktree, rewording it does not warn, and a
    parent-equal amend still warns;
  - a session commit still warns when HEAD's reflog is larger than 1 MiB. The full
    reflog read had used `execFileSync`'s 1 MiB default buffer, so a long-lived
    checkout overflowed it, the read returned nothing and the check passed silently
    (CodeRabbit, PR #827). The read now allows 64 MiB;
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
  - With the rebase pattern matching only `rebase …`, the pull-rebase case fails.
  - Without the octopus filter in the combined-diff fallback, the octopus case fails.
  - With the filter applied to every three-parent commit, the amended-octopus case fails.
  - With only the combined diff for an amended octopus, the parent-equal case fails.
    Codex reproduced the foreign-worktree variant against the reflog lookup; the
    rebuild covers both.
  - With the default 1 MiB buffer on the reflog read, the large-reflog case fails.
- With the final version, all twenty cases pass. `npm run test:correction-guards`,
  `npm run check-doc-drift` and `npm run test:agent-workflows` pass.

### Not verified

- The tests run in temporary repositories on Linux (locally) and on the CI's Linux and
  Windows runners. No real multi-day Claude session was replayed against the hook.
- Git versions older than 2.38, which lack `merge-tree --write-tree`, were not run.
  The combined-diff fallback for them is covered only by reading the code.
- A reflog larger than 64 MiB was not tried. A read that overflows it still returns
  nothing and skips the reminder.
