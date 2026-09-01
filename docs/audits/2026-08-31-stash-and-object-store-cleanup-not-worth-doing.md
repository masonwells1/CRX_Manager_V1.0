# Stash stack + object-store cleanup: investigated, reviewed, NOT worth doing

**Date:** 2026-08-31
**Outcome:** **Do not do this cleanup.** Investigated by Claude (Opus 5), independently
reviewed by Codex `gpt-5.6-sol` at high effort (verdict: NEEDS-CHANGES, 19 findings).
Nothing was executed — no stash dropped, no `gc`/`prune` run, no object file deleted.

**Read this before proposing a stash or `.git/objects` cleanup again.** The obvious version
of this idea looks like it reclaims ~316 MB from `.git/objects`. That part reclaims
approximately zero — six of those seven files, carrying all but 538 bytes of that figure, are
hard-linked to a second Git database, and the seventh is of unknown ownership. **How much, if
anything, the stash stack would reclaim was never established** — three drafts of this
document each claimed a different confident figure and all were wrong; see the reachability
section below before trusting any number.

---

## The three claims that make this look worthwhile, and why each is false

### 1. "There is 316 MB of garbage in `.git/objects` to reclaim" — FALSE

`git count-objects -vH` on `C:\CRX_Manager` reports `size-garbage: 315.65 MiB` across seven
`tmp_obj_*` paths. That number is real but **logical, not physical**.

Six of those files carry a **hard-link count of 2**. Their second link lives in a separate
Git database at `C:\CRX_CodexClones\codex-split-389-c2-gitdb` (confirmed to exist). Deleting
the `C:\CRX_Manager` names lowers Git's reported garbage figure while the filesystem
allocation stays alive through the other link.

**Scoped cleanup here frees ~0 bytes.** Reclaiming that space means reviewing the *other*
Git database, which is separately owned and out of scope.

Corollary: `git count-objects` measures logical Git garbage. To claim disk savings, measure
**volume free bytes** before and after, and check remaining hard links.

### 2. "The temp files are all abandoned, 6+ weeks old" — FALSE

Six are from 2026-07-14/15. The seventh, `.git/objects/09/tmp_obj_jODshA`, is 538 bytes and
was created **2026-08-31 08:18** — the same day as this investigation. Whether it belonged
to a still-running operation was never established (process visibility was denied under the
inspection identity), so a wildcard delete would have removed a freshly created file of
unknown ownership. That is reason enough not to wildcard `.git/objects`.

Their producer is also unproven. `count-objects` only classifies a path as neither a valid
loose object nor a valid pack; it does not attest that `gc`/repack created it. The matching
names in the second database suggest a clone or object-copy operation may be involved.

### 3. "Stashes are small text diffs, so dropping them is low-stakes" — FALSE

`stash@{26}` (full object ID `063c7010d3143d7052fc05d0e2364210874510a1`, 2026-07-15,
"pre-main-sync preserve-local-audit-state") carries
**329 files including an upper bound of ~1.18 GB of video** (the figure is the sum of the
blob sizes below, not a stash-exclusive measurement):

| bytes | path in the stash |
|---|---|
| 516,860,438 | `docs/walkthroughs/Job Application Scheduling Layout.mp4` |
| 320,897,404 | `docs/walkthroughs/Field Mapping.mp4` |
| 217,009,091 | `docs/walkthroughs/Mixer_Loader Sheet setup.mp4` |
| 123,291,065 | `docs/walkthroughs/Job Printing for sprayer applicator.mp4` |

plus extracted audio and frame stills.

**These are NOT the sole copy.** The originals are in
`C:\Users\mason\Videos\Screen Recordings\` under their `Screen Recording 2026-07-11 *.mp4`
names. Verified by exact git-blob hash, not by filename or size alone:
`git hash-object --no-filters "…102658.mp4"` → `2868a2e2946ddd85f91d9f762341e85af91ff2ef`,
identical to the blob in the stash. Codex flagged these as possibly irreplaceable; that
specific worry is resolved, but only because it was checked.

---

## Why the cleanup was rejected

1. **It frees essentially no disk** (§1) — which was the entire premise.
2. **Doing it safely needs an exclusive maintenance window.** `git stash drop` addresses
   entries **by position**, and positions shift. A concurrent session pushing or dropping a
   stash between the check and the drop makes the wrong entry disappear. Re-reading the SHA
   immediately before each drop narrows but cannot close this race — it is a
   time-of-check/time-of-use flaw, unsafe by construction while other sessions run.
3. **The only real benefit is reducing a hazard already covered by a standing rule** — the
   existing prohibition on unqualified `git stash pop` in a shared checkout.

Cost and disruption exceed the benefit. Leave the 34-entry stack alone.

## Other conclusions worth keeping

- **"No surviving branch" never means "safe to drop."** A deleted branch can make its stash
  the *only* remaining copy of something. Any future pruning needs per-entry content and
  ownership adjudication, not age plus branch-existence heuristics.
- **`git worktree list` is not an ownership test.** It proves a branch is checked out in a
  registered worktree — not that a session is live there, nor that some other session
  intends to use an old stash.
- **Remote-branch status from cached `origin/*` refs can be stale.** Run a read-only
  `git ls-remote --heads origin` immediately before classifying, or record the status as
  UNVERIFIED.
- **`git stash push -u` stores untracked files in the stash commit's THIRD PARENT (`^3`),
  not in its main tree.** A branch or ref pinned to a stash commit therefore looks like it
  is missing the untracked files — they are reachable via `^3` and are not lost. This was
  hit for real on 2026-08-31 while snapshotting the main checkout, and it would read as
  data loss to anyone who did not know it.
- **Git here is 2.54**, so `git stash export --to-ref` / `git stash import` exist. If a
  stash archive is ever genuinely needed, that is the purpose-built mechanism — it preserves
  the whole chain and its ordering — plus a self-contained bundle stored **outside** this
  Git database, since same-repo archive refs share a failure domain with their source.
- **Do not run `git gc` or `git prune` on `C:\CRX_Manager` while the fleet is active.** Git
  documents corruption risk when GC overlaps another writer, and this repo hosts ~50
  worktrees. Automatic GC stays enabled but is not near its default thresholds (109 loose
  objects, 5 packs vs ~6,700 / 50).

## Open item found in passing, not acted on

A zero-byte `index.lock` dated 2026-08-31 08:15 sits at
`.git/worktrees/CRX_Manager26/index.lock`, belonging to
`C:\Users\mason\.codex\worktrees\f624\CRX_Manager`. **Whether it is stale was not verified**
— no owning process was identified (process visibility was denied under the inspection
identity), so it may equally belong to a Git operation still running in that tree. A lock
that *is* stale usually means a Git command died partway and can wedge further Git
operations there. That is a Codex-owned tree, so it was left untouched deliberately — flag
it to that session rather than removing it on this evidence.

## What is and is not reclaimable

Three separate things get conflated, so state them separately:

- **"Frees no disk" applies to the temp-object cleanup** (§1) — those paths are hard-linked,
  so unlinking our names reclaims nothing while the other links live.
- **Dropping a stash is not itself a reclaim.** `git stash drop` only makes that entry's
  objects *unreachable*; space returns later, when a `git gc`/`git prune` actually removes
  them. Archiving a stash to a ref keeps its objects reachable, so archive-then-drop
  reclaims nothing by design.
- **Objects are only prunable if NO ref reaches them.** External duplicates of a file prove
  the *content is recoverable*; they say nothing about whether Git can drop its copy.

### Reachability here was NOT settled — do not claim a reclaim figure

**Three drafts of this document each asserted a different confident answer about whether
`stash@{26}`'s ~1.18 GB is reclaimable, and every one of them was wrong.** That track record
is the finding worth carrying forward; the arithmetic is not.

What was actually measured, and nothing more: the four video blobs appear in the object set
produced by `git rev-list --objects --all`, and do **not** appear in the set produced by
`git rev-list --objects --branches --tags --remotes`. That is a raw observation about two
command outputs. It was repeatedly over-read into conclusions it does not support.

Why no conclusion is drawn from it:

- **Neither set is a complete list of GC roots, and they fall short differently.** Git's own
  documentation defines `--all` as every ref under `refs/` plus `HEAD`, examined across **all**
  working trees by default — so it *does* cover `refs/notes/*`, `refs/archive/*`, and the
  `refs/stash` tip. What `--all` still misses are reflog entries (`--reflog`) and the index
  (`--indexed-objects`), both of which `gc` honours. `--branches --tags --remotes` is narrower
  again: it omits `HEAD` and every namespace outside those three. So the difference between the
  two outputs does not isolate "unreachable".
- **A stash entry is not a ref.** `refs/stash` names only the current tip; older entries like
  `stash@{26}` live in that ref's *reflog* — precisely the root class `--all` does not cover.
  Reasoning that treats `stash@{26}` as an ordinary ref — as earlier drafts did — is unsound.

So: **whether dropping `stash@{26}` would free disk here is unestablished** — and the other 33
entries in the stack were never assessed at all. Settling it needs a genuinely root-complete
reachability test plus a before-and-after measurement of volume free bytes — not a blob-size
sum, and not a difference between two partial `rev-list` sets.

Separately, the external copies in `C:\Users\mason\Videos\Screen Recordings` show the videos
are *recoverable* if the stash is ever discarded. That is a different question from whether
Git can free the space, and conflating the two produced the first wrong answer.

**None of this changes the verdict.** The cleanup is still rejected on §1 (the 316 MB is
hard-linked and frees nothing) and the reasons above: the positional-drop race, and the
refusal to run `gc` while the fleet is active. Reclaiming the video space would require an
exclusive maintenance window and a `gc` this document otherwise warns against.

If some future entry *is* ever dropped, address it by object ID, never by position: record
its full OID, re-resolve the current `stash@{n}` immediately before removal, and abort
unless the OID still matches — and even then the positional race in §2 means it belongs in
an exclusive maintenance window.
