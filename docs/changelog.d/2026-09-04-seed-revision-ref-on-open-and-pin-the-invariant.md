## 2026-09-04 - Seed the cycle-count revision ref on open, and pin the rule instead of the sites

CodeRabbit reviewed `9787eb0d8` and found the THIRD lifecycle hole in `latestItemRevisionRef`.
Confirmed in source and fixed, together with the reason three rounds were needed to find three
instances of one bug.

### The finding

`openDetail` seeds the reviewed-revision baseline from the server into `activeCount`, but never
touched the ref. Because the completion read PREFERS the ref, an entry left from an earlier visit to
the same count survived the reopen and outranked the revision just loaded — so the first Complete
click reported a change the operator was already looking at. The ref is now seeded there too, and
DELETED on the revision-read error path, so an unconfirmed leftover cannot outrank the row actually
loaded.

The seed deliberately overwrites a newer value an in-flight write may have recorded. That is the
same fail-safe ordering the existing comment describes for `activeCount`: seeding the OLDER revision
makes completion warn rather than silently adopt a change the operator has not seen.

### Why this took three rounds — and what changed

Three sites establish a reviewed baseline: local save, remote refresh, reopen. Each review round
found exactly one of them, because each test written in response pinned **the site just fixed**
rather than the rule. A test that enumerates known-bad sites cannot find the next one.

The guard is now the invariant: **every** assignment of an authoritative `item_revision` into
`activeCount` must carry a `latestItemRevisionRef` write with it. A new baseline site added later
fails this without anyone remembering the rule.

### The guard laundered itself first

The first version of that invariant check asked only whether *some* ref mutation appeared nearby.
Mutation testing caught it: deleting the real `openDetail` seed still passed, because the
`latestItemRevisionRef.current.delete(...)` in the **sibling error branch** sat inside the window and
satisfied the check. Proximity is not pairing. The check now requires the ref write to carry the
SAME revision expression as the baseline it shadows (`revisionRow.item_revision`,
`countState.item_revision`, `result.item_revision`), which the sibling `delete` does not.

This is the same shape as the `exitsBranch` laundering already documented in the F1 ordering guard:
a marker in one branch excusing code in another.

### Verification

`typecheck`, `lint`, `test` pass. **357 files, 5050 passed, 0 failed.**

Mutation-proven at each baseline site independently — remove the openDetail seed → RED (only after
the expression-matching fix; it passed before, which is how the laundering was found), remove the
remote-refresh advance → RED, revert the completion read → RED, restored → green. The invariant
check also asserts it found at least three baseline sites, so a regex that silently stops matching
cannot pass as coverage.

**Not behaviourally verified:** none of the three paths were driven in a browser. Reproducing them
needs a reopened modal and two concurrent clients on one cycle count. They are pinned by a
source-contract test, not a runtime one.
