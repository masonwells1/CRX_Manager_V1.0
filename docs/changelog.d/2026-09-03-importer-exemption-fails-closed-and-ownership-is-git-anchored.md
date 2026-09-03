## 2026-09-03 - the importer exemption fails closed, and ownership is anchored outside the file it lives in

**Class:** two guard holes of the same shape - a check that answered "no problem" when what it
actually had was "no information". **Outcome:** unknown git state no longer buys an exemption, and
the durable ownership list can no longer be shrunk by editing the file that stores it.

Follows `docs/changelog.d/2026-09-03-importer-directory-ownership-must-survive-a-write.md`. Both
findings came from the frozen candidate `34b5df713`: one from Codex (P2), one from CodeRabbit.

## Ownership certified itself (Codex, P2)

`previousManifest()` reads the WORKING TREE copy of `generated-manifest.json`, and `buildExpected()`
regenerates the manifest from what it read there. So `ownedImporterDirs` validated itself: drop a
name from it by hand, or lose one to a careless merge resolution, and `--check` reproduces the
reduced set, compares it against the reduced file, finds them equal, and passes. The survivor in
that directory is then classified as importer litter again - precisely the silent widening the field
was added to prevent.

Anchored outside that file: ownership is now the union of the working tree with the git **index**
and **HEAD** blobs, so it can only ever grow. A dropped name is restored into `expected`, the
working-tree manifest no longer matches, and `--check` reports `generated-manifest.json is stale` -
a loud failure with a one-command remedy.

## Unknown tracking state was read as "nothing is tracked" (CodeRabbit)

`gitKnownTargetPaths()` returned an empty list when git failed, and the caller could not tell that
apart from a real "nothing is staged yet". Those are opposite defaults. The empty-list reading is
the most permissive answer available, and it was handed out at exactly the moment the check could no
longer tell whether the importer output had been staged.

It now reports `known: false`, and `classifyExtras()` withholds the exemption entirely on it: every
importer path is reported as ordinary drift, with a note on stderr naming the reason. An empty list
with `known: true` is still a real answer and still exempts, so the fix did not just delete the
exemption.

## Also fixed in passing

Both git invocations now go through one helper that strips inherited `GIT_DIR`, `GIT_WORK_TREE`, and
`GIT_INDEX_FILE`. This check runs inside the pre-commit hook, where those are set and point at the
hook's own view - inheriting them makes `git -C <root>` a lie, a failure mode this repo has hit
before in fixture tests.

## Verification

Ran, not inferred.

**The shrink attack, live on this repo.** Staged a manifest carrying
`ownedImporterDirs: ["source-command-demo"]`, then reverted the working-tree copy to `[]` - the
exact shape of a bad merge resolution:

| Step | Before | After |
|---|---|---|
| `--check` with git holding the entry and the file not | `PASS - 37 ... match` | `FAIL generated-manifest.json is stale`, exit 1 |

The index was then restored and `--check` returned `PASS - 37` on a clean tree.

**Mutation tests.** Both new assertions were proven to depend on their fix, not to pass by accident:

- forcing `trackingKnown` true fails case (e) with `unknown tracking state grants no exemption`,
  actual `['source-command-ship']` vs expected `[]`;
- dropping `previouslyOwnedDirs` from the owned set fails case (d), as recorded in the previous
  entry.

`node scripts/sync-agent-workflows.mjs --check` returns `PASS - 37` and
`npm run test:agent-workflows` exits 0.
