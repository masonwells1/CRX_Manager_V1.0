## 2026-09-01 — Withdraw the stash reclaim claim from the 2026-08-31 audit; reachability was never settled

Corrects `docs/audits/2026-08-31-stash-and-object-store-cleanup-not-worth-doing.md` (landed via
PR #526) and its changelog entry. Documentation only.

**What was wrong.** The audit asserted that the four walkthrough-video blobs inside
`stash@{26}` were reachable from a branch/tag/remote, and concluded the ~1.18 GB was therefore
not reclaimable. It also documented its method as authoritative. Across three drafts the
document gave three different confident answers to "is this reclaimable?" — and every one was
wrong, in one direction or the other.

**What is claimed now: nothing.** The reclaim question is recorded as **unestablished**. The
document keeps only the raw observation — the four blobs appear in the output of
`git rev-list --objects --all` and not in `git rev-list --objects --branches --tags --remotes`
— and explicitly declines to draw a conclusion from it.

**Why no conclusion follows.** Two independent reasons, both from review:

- Neither command produces a complete set of GC roots, and they fall short differently. Git
  defines `--all` as every ref under `refs/` plus `HEAD`, across all working trees by default,
  so it *does* include `refs/notes/*`, `refs/archive/*`, and the `refs/stash` tip; what it
  misses are reflog entries and the index, which `gc` honours. `--branches --tags --remotes` is
  narrower still, omitting `HEAD` and every namespace outside those three.
- **A stash entry is not a ref.** `refs/stash` names only the current stash tip; older entries
  such as `stash@{26}` live in that ref's *reflog* — exactly the root class `--all` does not
  cover. Earlier drafts reasoned about `stash@{26}` as though it were an ordinary ref, which is
  unsound.

Settling the question would need a genuinely root-complete reachability test plus a
before-and-after measurement of volume free bytes — not a blob-size sum, and not the difference
between two partial `rev-list` sets.

**What did not change.** The verdict stands: the cleanup is still rejected, and never depended
on the disk figure. All but 538 bytes of the 316 MB of `.git/objects` garbage remains
hard-linked to `C:\CRX_CodexClones\codex-split-389-c2-gitdb` and frees nothing, and that
remaining 538-byte file is of unknown ownership; `git stash drop` remains
positional and races concurrent sessions; and `gc` must not run while the fleet is active.

**Evidence reproduced.** Deliberately not headed "Proof observed" like other entries: the point
here is that these checks establish nothing about reclaimability.
Both `rev-list` sets were rebuilt and each blob id tested for membership,
reproduced across separate sessions — that observation is real; only the conclusions drawn
from it were not. An earlier control blob was discarded as contaminated: it was reachable from
a real branch (`claude/main-checkout-snapshot-20260831`, which pins a different stash commit),
so it could not test what it was meant to test.

**Not verified.** Whether any part of `stash@{26}` is reclaimable; the stash-exclusive
remainder beyond those four blobs; and any post-`gc` byte delta.
