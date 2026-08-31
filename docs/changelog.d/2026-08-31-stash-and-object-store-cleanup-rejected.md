## 2026-08-31 — Stash and object-store cleanup investigated and rejected; local worktree sweep

Records why a tempting `.git/objects` + stash-stack cleanup on `C:\CRX_Manager` must not be
done, so it is not re-proposed. New file:
`docs/audits/2026-08-31-stash-and-object-store-cleanup-not-worth-doing.md`.

**Outcome: rejected.** Investigated by Claude, independently reviewed by Codex `gpt-5.6-sol`
at high reasoning effort — verdict NEEDS-CHANGES, 19 findings. **Nothing was executed:** no
stash dropped, no `git gc`/`git prune` run, no object file deleted.

Three claims that made the cleanup look worthwhile, each disproved:

- `git count-objects -vH` reports ~316 MB `size-garbage`, but six of the seven `tmp_obj_*`
  files carry hard-link count 2, with the second link in
  `C:\CRX_CodexClones\codex-split-389-c2-gitdb`. Deleting the `C:\CRX_Manager` names would
  lower Git's reported figure and free approximately zero physical bytes.
- Not all the temp files are stale: `.git/objects/09/tmp_obj_jODshA` was created the same
  morning (08:18). Whether it belonged to a still-running operation was never established,
  so a wildcard delete would have removed a freshly created file of unknown ownership.
- Stashes here are not small text diffs. `stash@{26}` (`063c7010d`) holds ~1.18 GB of
  walkthrough video.

Rejected because `git stash drop` is positional and a concurrent session can shift indices
between the SHA check and the drop (a time-of-check/time-of-use race a recheck narrows but
cannot close), and because its only real benefit duplicates the existing prohibition on
unqualified `git stash pop` in a shared checkout.

Two claims about disk savings are distinct: **"frees no disk" applies to the temp-object
cleanup**, whose paths are hard-linked. Separately, `git stash drop` is not itself a
reclaim — it only makes an entry's objects unreachable, and the space returns when a later
`git gc`/`git prune` removes them; archiving a stash to a ref keeps its objects reachable,
so archive-then-drop reclaims nothing by design.

**Proof observed.** Hard-link target directory confirmed present on disk. `tmp_obj_jODshA`
size and timestamp read directly. `stash@{26}` contents enumerated via
`git ls-tree -r -l <sha>^3`. The four videos were confirmed NOT unique — originals in
`C:\Users\mason\Videos\Screen Recordings` matched by exact git blob hash
(`git hash-object --no-filters` → `2868a2e2946ddd85f91d9f762341e85af91ff2ef`), not by
filename or size. Git version confirmed 2.54, so `git stash export --to-ref` exists if an
archive is ever genuinely needed.

Also recorded in the audit: `git stash push -u` stores untracked files in the stash commit's
**third parent (`^3`)**, not its tree — a ref pinned to a stash commit therefore looks like
it lost them when nothing is gone. Hit for real the same day while snapshotting the main
checkout (60 tracked changes in the tree, 56 untracked files only in `^3`).

**Not verified.** The producer of the `tmp_obj_*` files is unproven — `count-objects` only
classifies a path as neither a valid loose object nor a valid pack; it does not attest that
`gc`/repack created them. Remote-branch status for the stash inventory came from cached
`origin/*` refs, not a live `git ls-remote`. Process ownership of the same-morning temp file
and of a stale zero-byte `index.lock` in the Codex-owned `f624` worktree could not be
established under this identity; both were left untouched.
