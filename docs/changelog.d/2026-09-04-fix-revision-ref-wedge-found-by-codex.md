## 2026-09-04 - Advance the cycle-count revision ref on the remote-refresh path

Codex reviewed `1973add81` and found a real defect **in the fix committed there**, not in the code
that fix was correcting. Confirmed in source and fixed.

### The regression

`latestItemRevisionRef` was introduced so the completion path reads a revision that a just-saved
local edit has already acknowledged. Because the read PREFERS the ref over `activeCount`, a ref that
is never advanced on the remote-refresh path pins the client to a superseded revision permanently:

1. This tab saves an item — ref for that count = 7.
2. Another client edits the same count — server revision = 8.
3. The operator clicks Complete. The mismatch is correct and expected: the refresh puts the real
   rows on screen and adopts revision 8 into `activeCount`, asking for a second, deliberate click.
4. **Every later click still reads 7 from the ref** and repeats the same mismatch. Completion is
   wedged until a page reload or another local write.

That is strictly worse than the single extra click the ref was added to remove. The code comment
immediately below the adoption already stated the invariant that was broken — "the next click
matches, because the reviewed baseline has advanced" — which is only true if BOTH baselines advance
together. Adding a ref that shadows state without advancing it where state advances falsified a
comment that was correct before.

### The fix

Advance the ref alongside the `setActiveCount` that adopts `countState.item_revision`.

### The lesson this encodes

The pairing has **three** members, not two: write on local save, **advance on remote adoption**, read
at completion. The test committed with the original fix pinned only the write and the read — and the
wedge satisfies both of them, which is exactly the "a guard pinning one half of a pairing is
satisfied by the bug" failure. The third member is now pinned too, with an ordering assertion that
the advance sits with the state adoption it shadows.

All three are mutation-proven independently: revert the read → RED, remove the write → RED, remove
the advance → RED, restored → green.

### Verification

`typecheck`, `lint`, `test` pass. **357 files, 5049 passed, 0 failed.**

**Not behaviourally verified:** the wedge needs two concurrent clients on one cycle count, which was
not staged live. It is pinned by a source-contract test, not a runtime one.
