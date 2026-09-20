## 2026-09-20 - Strict migration ordering after PR #726

### Context — after PR #726 merged

PR #726 landed `20260908140000_number_generators_year_chicago` (UNAPPLIED) while this
candidate was in flight. That migration sorts BELOW all four guards here, and its own
header states: "Once this merges, the pending guard refuses all of them until this
applies, so APPLY THIS FIRST."

**HIGH — fixed.** Three files here carried `-- ordering-guard: ahead-of-pending`
markers. Their stated reason (the 20260905 commission/invoice-number candidates) was
obsolete: that set was restamped to `20260914100100`..`20260914100900` and now sorts
ABOVE these files. Worse, the markers silently waved through `20260908140000`,
defeating exactly the refusal #726 documented and relied on. Applying the season guard
ahead of it would make `20260908140000` permanently fail the ordering guard and strand
the Chicago-year document-number correction, whose deadline is 31 December 2026.

All three markers are removed; ordering is now strict. Verified by running the real
`checkPendingMigrations` guard against the current registry and migration tree:

- `20260908190000` -> REFUSED, must wait for `20260908140000_number_generators_year_chicago`
- `20260912165758` -> REFUSED, must wait for `20260908140000` AND `20260908190000`

**MEDIUM — DEFERRED, owner decision required before any live apply.** With strict
ordering restored, the apply sequence is:

    20260908140000 (PR #726)
    20260908190000 (season guard)
    20260912165758 (cutover phase 1)
    20260913040359 (cutover phase 2)
    20260913152700 (unchanged-date correction)

`20260908190000` rejects an existing invoice whose supplied date computes to a
different season even when that date is UNCHANGED; the public preview always calls it.
The exception that fixes this lives in `20260913152700`, which now runs LAST — after
phase 2, which is deliberately designed to REFUSE installation while any other open
transaction, prepared transaction or still-valid receipt remains. If phase 2 refuses
for an extended window, production keeps broken previews for legitimate historical
job/blend-created invoices for that whole window.

Codex's recommended fix is to restamp `20260913152700` to sort immediately after
`20260908190000` and before both cutover phases (or fold its behaviour into the season
guard). **Not done here on purpose:** restamping changes the order these migrations run
against production, which is an apply-shaping decision for Mason, not a reviewer
finding to silently absorb, and it is not required for a clean verdict. Merging this
repository code applies nothing. Resolve this BEFORE the first live apply — either
restamp, or apply the season guard and the correction together in one approved window
and do not begin the cutover phases until the correction is in.
