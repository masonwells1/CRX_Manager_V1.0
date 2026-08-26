## 2026-08-26 — an entry must record something, and a rename is not a record

Two ways the ledger guard could still be satisfied without writing anything, both found by
Codex on PR #482 and both closed here.

- **A rename counted as an addition.** `--no-renames` reports a rename as `D(old)` plus
  `A(new)`, so a commit could satisfy the guard by MOVING someone else's entry while
  writing none of its own. Codex reproduced it against the real hook. An added entry is
  now refused when it is byte-identical to an entry the same commit deletes; deleting an
  old entry while genuinely adding a different one still counts.
- **An empty or malformed entry counted.** Acceptance was purely path-and-status, so an
  empty file, a prose-first file, or a heading whose date disagreed with the filename all
  satisfied the requirement while recording nothing. The guard now reads the staged blob
  and validates it — staged content for an addition, `HEAD` content for a deletion, since
  the deleted half is what proves the added half is only a move. Unreadable content is
  treated as unverifiable and does not count; that direction fails closed on purpose.

This matters more since the consolidation tool was split out: **the guard is now the only
thing that validates these files.** Acceptance rules that assume a downstream checker are
exactly the kind that quietly stop being true.

The refusal now names each staged entry and why it did not count, rather than reporting
"no ledger update" while entries sit right there — the earlier message would have sent
someone to add a second file when the real problem was the content of the first.

68 assertions (was 60). Mutation-tested: disabling the rename check turns the suite red.
