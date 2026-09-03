## 2026-09-03 - ownership provenance reads the committing index and every merge parent

**Class:** two provenance sources reading the wrong git object, both reproduced by Codex on PR #565.

`scripts/sync-agent-workflows.mjs` decides whether a `skills/source-command-*/` directory is
importer litter or a directory this generator owns. Two of its provenance sources were reading the
wrong git object. Both were reproduced by Codex on PR #565.

## The candidate index was discarded

`git()` deleted `GIT_DIR`, `GIT_WORK_TREE` **and** `GIT_INDEX_FILE` from the environment. The first
two must go — they are absolute and outrank `-C ROOT`, so inheriting them makes the helper inspect
the hook's view instead of the repository root.

`GIT_INDEX_FILE` is the opposite. `git commit <paths>` and `git commit --only <paths>` build a
temporary index holding exactly the candidate tree and point their hooks at it. Deleting the
variable sent `gitKnownTargetPaths()` to the default index, so an imported adapter staged by a
partial commit was invisible to the staged-path guard: Codex staged
`skills/source-command-alt/SKILL.md` in an alternate index and `--check` warned and returned `PASS`.

The candidate index is now preserved, with a relative value resolved against the cwd git invoked the
hook from rather than against `ROOT`. It is honored **only when it belongs to this repository** —
`core.hooksPath` has pointed at a foreign checkout on this machine, and a stray `GIT_INDEX_FILE`
would otherwise have the check report on an unrelated repository's staged files. Anything outside our
own git dir is discarded rather than trusted.

## A merge could permanently discard ownership — SUPERSEDED

> **This half was removed the same day.** Round 8 found the same fail-open shape inside this fix, and
> Mason cut the whole durable-ownership layer rather than patch it a ninth time. See
> `2026-09-03-cut-the-durable-ownership-layer`. The candidate-index fix above is unaffected and
> stands. What follows is kept as the record of why the layer was tried.

`gitManifestOwnedDirs()` unioned the working tree with the index and `HEAD:` blobs. During an
unfinished merge the incoming side's `ownedImporterDirs` exists in neither: it lives only in
`MERGE_HEAD`. Resolving the manifest conflict in favor of the current branch dropped every name the
other branch recorded, silently and for good — and the orphaned directory went back to being
classified as importer litter, which is the exact widening the durable field exists to prevent.

Merge parents are now consulted too. `MERGE_HEAD` holds one SHA per line, so an octopus merge
contributes all of its parents; `git show MERGE_HEAD:` would have taken only the first.

## Verification

`gitEnvironment()` is exported and pinned by `scripts/sync-agent-workflows.test.mjs` case (g),
covering the kept candidate index, the relative-path resolution, the discarded foreign index, and the
unresolvable-git-dir case. Mutation-tested: restoring `delete env.GIT_INDEX_FILE` fails (g).

The merge-parent half was proven live before it was cut — a real merge whose incoming manifest owned
`source-command-ship`, resolved to our side, moved the check from `WARNING: ignoring 24` / `PASS` to
`ignoring 23` plus `FAIL generated-manifest.json is stale` and exit 1, and mutating the recovery off
restored the permissive result. That evidence is why the defect was real; it is not why the fix was
kept, because it was not.

`--check` continues to report the 24 real Codex-import directories as a warning and `PASS - 37`.
