## 2026-09-03 - `--write` overwriting an unusable manifest is ACCEPTED

**Class:** a deliberate stop, and an honest cost of the round-10 fix. Mason's call, in chat.

`scripts/sync-agent-workflows.mjs` — `previousManagedFiles()` and the `--write` prune path.

## The finding

Raised by the Codex PR reviewer against `a31b92b1e`. `previousManagedFiles()` returns
`previousManifest().managed` and drops `known`, so `--write` cannot tell "the last sync
generated nothing" from "the record is unusable" — both prune nothing — and it then overwrites
`generated-manifest.json` regardless. An adapter owned by the unusable manifest and no longer
generated survives on disk while the only record naming it is erased; later `--check` runs
report it as drift with a `--write` remedy that cannot remove it.

## The decision: accept and document

1. **Pre-existing.** The old reader answered a corrupt manifest with an empty list too, so it
   also pruned nothing. Round 10 did not create this path.
2. **Round 10 widened the set, not the behavior.** Requiring an own `version` equal to
   `MANIFEST_VERSION` means `{"version":2,…}` now reads as unavailable where it used to be
   parsed. That is the honest price of refusing to guess at an unknown schema — and refusing is
   right, because that list feeds a delete.
3. **The proposed remedy is the wrong shape.** "Abort the write when provenance is unavailable"
   collides with `--write` being the repair path an operator reaches for when the manifest is
   broken. Refusing there reads as a dead end unless the error names the escape — a new failure
   mode, in the function that had already produced eleven rounds of findings.

## Recovery, if it ever happens

Delete `.agents/generated-manifest.json` and re-run `--write`. With no manifest present,
`previousManifest()` returns `{ managed: [], known: true }` — a real answer, not an unknown —
so the write proceeds and the tree is rebuilt. The surviving stale file is removed by hand,
the same manual step the drift report already asks for.

## What this does NOT weaken

`--check` is not fooled. It still reports the stale file as drift, still withholds the importer
exemption while provenance is unknown, and still prints the operator note naming
`generated-manifest.json`. Nothing is silently accepted — the cost is that the printed remedy
is incomplete for this one case.

## Reopening condition

Not as "abort on `known: false`". A reopen must keep `--write` usable as the repair path — an
error naming the manifest deletion, or a warning that lets the write proceed — and must come
with a test proving the repair path still works starting from a corrupt manifest.

## Recorded in two places, on purpose

`docs/manual/KNOWN_ISSUES.md` carries the full entry; a comment sits at
`previousManagedFiles()` so the next reader meets the decision at the point of the gap.
