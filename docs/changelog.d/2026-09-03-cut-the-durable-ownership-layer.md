## 2026-09-03 - the durable importer-ownership layer is cut, not patched again

**Class:** a feature retired because its defect rate did not converge. Mason's call, in chat.

`scripts/sync-agent-workflows.mjs` exempts `skills/source-command-*/` directories written by the
Codex CLI's `/import` so they stop failing the parity check and blocking every commit. That is the
change this PR exists for, and it is unaffected.

On top of it the PR grew a second mechanism: a durable, monotonic `ownedImporterDirs` field recording
every importer-shaped directory the generator had ever owned, so that deleting a canonical `.claude`
command named `source-command-*` could not make `--check` forget the directory was ours. Keeping that
record honest meant reconstructing it from the working tree, the git index, `HEAD`, and every merge
parent.

**Every one of the eight review findings on this PR was in that layer**, across eight rounds, from
CodeRabbit and the Codex GitHub App. Rounds 4-6 were one root shape (a source that could not
determine something answered with the most permissive value). Round 7 was two more of the same shape
one level down - reading the wrong index, and missing a merge parent. Round 8 found the shape again
**in the round-7 fix itself**: `mergeParentRevisions()` could not distinguish "no merge in progress"
from "could not tell", and answered *no merge*.

A layer that produces a fresh defect every round, including from the fix for the round before it, is
not converging. It is removed.

**Removed:** the `ownedImporterDirs` manifest field, `gitManifestOwnedDirs()`,
`durableOwnedImporterDirs()`, `mergeParentRevisions()`, `ownershipRevisions()`, and the
`previouslyOwnedDirs` option on `classifyExtras()`. Net -83 lines.

**Kept, because none of it depends on that layer:**

- the region-based exemption itself, and the 24 real imported directories reported rather than muted;
- ownership from the manifest's `managed` list, which still covers the sibling case - a hand-added
  file beside a generated adapter is drift, because ownership is decided per directory;
- the staged/tracked check, which fails closed when git cannot be consulted;
- `previousManifest()`'s `known` flag, separating an absent manifest (a real answer) from an
  unreadable one (not an answer);
- `gitEnvironment()`, which strips `GIT_DIR`/`GIT_WORK_TREE` but preserves a repository-local
  `GIT_INDEX_FILE` so a partial commit is inspected against the index it is actually committing.

**Knowingly given up.** Delete a canonical command whose name starts with `source-command-` while
another file remains in its mirror directory, and that survivor is classified as importer litter
instead of drift. Nothing in `.claude/` is named that way, so the sequence cannot occur today, and
the cost if it ever did is an unreferenced instruction file sitting under `.agents/` - not wrong
behavior in the app, and not a data or money path. The gap is pinned by test case (d), which now
asserts the permissive result on purpose so it cannot be mistaken for coverage, and case (h) asserts
the manifest carries only `version` and `managed` so the field cannot creep back without its
provenance handling.

## Verification

`--write` regenerated the manifest; `--check` reports the 24 real imported directories as a warning
and `PASS - 37`, unchanged. `scripts/sync-agent-workflows.test.mjs` and
`npm run test:agent-workflows` both pass.
