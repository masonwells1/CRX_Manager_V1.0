## 2026-08-31 — Archiving withdrawn from this cleanup; the classification could not be made reliable

This documentation cleanup originally moved closed audit and handoff records into
`docs/archive/2026-summer-closeout/`. **That part is withdrawn.** Every record is back in
`docs/audits/` and `docs/handoffs/`, and the archive folder is byte-identical to `main`. The
documentation corrections and the branch inventory are unaffected and remain the substance of the
change.

### Why

Deciding whether a record is closed proved not to be reliably doable from the record. Nine review
rounds, four of them consecutively on this one question, each finding records that the previous
pass had classified as finished and that were not:

1. **"Dated and orphaned, therefore closed."** Deleted 30 records. The rule never read their
   statuses. One was a `NEEDS MASON` negative-inventory worksheet matching an open
   `KNOWN_ISSUES.md` item. All 30 restored.
2. **"Read the file's own status line."** Better, and still wrong: a record can be written as open
   and closed later by other work, with nothing in the file saying so.
3. **"Cite the later evidence that closed it."** The right rule — but the scan enforcing it used a
   narrower marker list than the rule named, and missed four records including one headed
   `## NOT DONE`.
4. **The corrected scan still missed two.** `2026-07-20-codex-to-claude-review-wrapper-empty-result-handoff.md`
   states a production release gate is blocked and lists eight unfinished steps, under
   `## Risk Flags`. `2026-08-11-customer-360-adoption-pack.md` says PR #385 is unmerged, names
   finishing it as the next action, and records a live rollback smoke still pending Mason's literal
   `REAL-DATA-OK` authorization — under `## Morning next action`. Neither heading contains any
   marker a keyword scan would look for, because open work does not announce itself in a fixed
   vocabulary.

Each fix was correct and each left the next gap. That is the signature of a method that does not
converge, not of a rule one round away from working.

### The trade

Archiving buys a tidier folder listing. Getting it wrong buries work that is genuinely open —
including, in two of the records above, decisions and authorizations addressed to Mason by name.
Those are not equal stakes. Records left in the live folders are visible and cost nothing but
clutter; records archived in error are invisible in a directory defined as "fully shipped, merged
and live."

Withdrawing costs the listing and eliminates the entire error class. The corrected documentation
and the branch inventory — the parts that have been stable for five rounds — ship unchanged.

### What survives for a future attempt

The rule itself is sound and worth keeping: **archiving a record whose own text says work is open
requires citing the later evidence that closed it.** What is missing is a trustworthy way to find
those records. A keyword scan is not it. A future attempt should read each candidate in full rather
than grep it, and should expect roughly a third of them to be open — that was the rate here, and
every pass that assumed a lower one was wrong.

### Proof observed

- `git diff origin/main -- docs/archive/` is empty: no file added, removed, or modified under the
  archive.
- The 16 records are present in `docs/audits/` and `docs/handoffs/`, contents unchanged throughout
  (every move was a pure rename).
- `npm run check:docs` passes.
