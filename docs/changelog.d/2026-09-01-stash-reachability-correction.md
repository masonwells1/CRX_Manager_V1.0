## 2026-09-01 — Correct the stash reachability finding: `git rev-list --all` reaches `refs/stash`

Fixes a factually wrong claim that landed in `main` via PR #526, in
`docs/audits/2026-08-31-stash-and-object-store-cleanup-not-worth-doing.md` and its changelog
entry. Documentation only.

**What was wrong.** The audit stated that all four walkthrough-video blobs inside
`stash@{26}` were "reachable from a branch/tag/remote ref, not only from the stash," and
concluded the ~1.18 GB was therefore not reclaimable. It also documented the method as
`git rev-list --objects --all` "(which does **not** include `refs/stash`)".

Both are false. `--all` means all refs under `refs/`, and that **includes `refs/stash`**. So
the check asked "is this blob reachable?" of a stashed blob and always got yes — reachable
*from the stash itself*. Read as "something other than the stash holds this," it inverts the
answer.

**Corrected measurement.** `git rev-list --objects --branches --tags --remotes` excludes
`refs/stash` by construction:

| set | objects | four video blobs present? |
|---|---|---|
| `--all` | 54,293 | yes — via `refs/stash` |
| `--branches --tags --remotes` | 52,149 | no |

The four blobs are reachable **only** from `stash@{26}`, so dropping that entry and letting a
later `gc` prune it could reclaim up to ~1.18 GB.

**Bounds kept explicit.** Only those four blobs were measured, so the rest of the stash's 329
files is unsized, and ~1.18 GB is the sum of blob sizes rather than a post-`gc` measurement.
It is not a promised saving.

**What did not change.** The verdict stands: the cleanup is still rejected. The 316 MB of
`.git/objects` garbage remains hard-linked to `C:\CRX_CodexClones\codex-split-389-c2-gitdb`
and frees nothing; `git stash drop` remains positional and races concurrent sessions; and
`gc` still must not run while the fleet is active. Reclaiming the video space would require
the exclusive maintenance window this document argues for.

**Proof observed.** Both reachability sets rebuilt and the four blob IDs tested for
membership in each; result reproduced twice across separate sessions. An earlier control blob
was discarded as contaminated — it was reachable from a real branch
(`claude/main-checkout-snapshot-20260831`, which pins a different stash commit), so it could
not test the `--all` question; the video blobs themselves carry the finding.

**Not verified.** The stash-exclusive remainder of `stash@{26}` beyond those four blobs, and
the actual post-`gc` byte delta, were not measured.
