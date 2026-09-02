## 2026-09-01 — a claim wrapped over three lines still escaped the ratchet

Two more P2s from the automatic PR reviewer on PR #530, both correct.

**The wrap window was one line too narrow.** The earlier fix joined a line with its single successor,
which caught `(fail` / `closed)` but not `// This cannot` / `// be` / `// bypassed.` — so any new
safety claim could still be hidden from the enforced audit just by wrapping it over three lines. The
window now runs to the end of the contiguous prose block: it stops at a blank or marker-only line, so
two unrelated comment paragraphs cannot be spliced into a claim neither of them makes, and it is
capped at five lines so a long comment block cannot make the scan quadratic. Tests pin three-line and
four-line wraps, and pin that a paragraph break ends the window.

Widening the window changed the stored identity of the handful of claims that genuinely wrap, so the
baseline was regenerated again. The count is unchanged at 163 — same claims, longer recorded text.

**The decision log contradicted the changelog.** The 2026-09-01 entry said there would be "no seventh
review", while the changelog and the test comments both number findings by a seventh round. Since
agents are required to read the decision log before reopening settled work, that inconsistency made
the cap unreadable — it looked either broken or unenforced.

Reconciled by stating what the cap actually covers: it caps reviews **this project commissions**, and
does not silence the repo's automatic PR reviewer, which fires on every push by configuration. That
reviewer produced the `rg --pre` and doubled-separator findings and the ratchet defects. Fixing a
finding that has already been delivered is not commissioning a round. The cap stands — do not
commission an eighth.
