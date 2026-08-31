## 2026-08-31 — Pin branch classifications to tip OIDs; stop a lie surviving in a second file

CodeRabbit's review of `4bb9c05c` returned changes-requested with 14 findings. Four concern content
this PR authored and are fixed here. Nine concern the *contents* of archived historical records and
are declined, with reasoning below.

### Fixed

**The inventory identified branches by name only.** A name is not a fixed reference: a branch can be
pushed to after a scan, and every classification in the report is a snapshot. The report now records
each branch's **tip OID** — in full for the two mechanically-safe branches, abbreviated in the
all-branches table — and instructs the reader to confirm via `git ls-remote origin <branch>` that
the tip still matches before deleting. If it moved, the authored/unique comparison must be rerun.

CodeRabbit's phrasing of the underlying point is worth preserving: a cleanup tag preserves whatever
commit it points at; it does not make an out-of-date classification correct. The 2026-07-27 restore
ledger this report cites answers "how do I keep the commit", not "is this classification still
true".

**A changelog entry still claimed CI runs an E2E smoke job.** The previous round fixed that false
claim in `DEPLOYMENT.md` and left the identical claim in
`2026-08-31-docs-cleanup-and-branch-inventory.md`, where it directly contradicted the companion
entry stating CI has no browser coverage. Corrected to say `ci.yml` *defines* a disabled
`e2e-smoke` job. Fixing a lie in the file where it was reported, while an instance survived
elsewhere in the same PR, is the same error as fixing a rule in the section that prompted it.

**The fuzzy-matcher search claim was imprecise.** The entry said "a repository-wide search for
`fuzzyMatchProduct` returns nothing". The search actually run was `fuzzyMatchProduct\b`, and the
word boundary is load-bearing: a bare substring search matches `fuzzyMatchProductWithScore`. The
claim now states the exact-identifier form and why it matters.

**`DEPLOYMENT.md` omitted `npm run check:docs`** from the local verification list, though `ci.yml`
runs it as a gate. Added, with a line saying what it checks.

### Declined, with reasoning

Nine findings ask for edits to the *content* of archived audit and handoff records — reconciling a
July handoff's "NOT LIVE" claim against later state, changing a closeout's date header, narrowing a
verification claim, fixing a compound modifier, relabelling a pre-fix observation.

This PR **moved** those files; it did not author or alter their contents. They are point-in-time
records, and the repository treats them as evidence. Rewriting a July document to reflect what
became true in August destroys what it was written to record — the same class of harm as deleting
an open-work record, in the opposite direction. A reader needs to know what was believed and proven
on the day, not a version retrofitted to the present.

The concern behind them is nonetheless legitimate: a reader could mistake a stale in-document claim
for current status. The structural answer already exists — these files are under
`docs/archive/2026-summer-closeout/`, which is defined as point-in-time history — and it is not
improved by editing the records themselves. Anything genuinely still open in them belongs in the
synthesis layer, which is the gap already flagged for Mason in this PR (F06 and the H3/H4/H5
follow-ups), not in a retroactive edit.

Two of the nine (the compound modifier, the closeout date header) are pure copy-editing of
historical text and out of scope for a cleanup that deliberately preserves such records unchanged.

### Proof observed

- `.github/workflows/ci.yml` runs `npm run check:docs`; confirmed at its line.
- `grep -rn "fuzzyMatchProduct\b" src/` returns nothing, while the bare substring matches
  `fuzzyMatchProductWithScore` — both checked.
- Tip OIDs read from `git for-each-ref` over `refs/remotes/origin` at scan time.
- All nine CodeRabbit pre-merge checks pass on the reviewed head, including the five `mode: error`
  CRX Hard Rule gates and the Title check.
- `npm run check:docs` passes.
