## 2026-08-31 — A record's own status line does not establish that it is closed

Codex's review of `6da30722` found `handoffs/2026-08-12-live-sql-guard-maintenance-build-to-review.md`
archived by this PR while carrying a live `## NOT STARTED` section listing review, merge, activation,
and follow-up work. Its work *was* completed — but the evidence for that is later commits and
`docs/changelog.d/2026-08-28-escape-string-scanner-maintenance-complete.md`, not anything in the file.

The finding lands on the method, not one file. This PR's stated rule was "read what the file says
about itself", adopted after an earlier revision deleted 30 records on "dated and orphaned, therefore
closed." That was an improvement, and it was still wrong, in a way the earlier failure hid: **a record
can be written as open and closed later by other work, and nothing in the file says so.** Reading the
status line answers "was this open when written", never "is it open now."

### What the re-audit found

All 22 originally-moved records were re-checked for open-work markers. Ten carried them.

**Six were incidental** — `BLOCKED` appearing inside a verdict vocabulary (`COMPLETE`, `READY FOR
APPROVAL`, `BLOCKED`, `PARTIAL`), a "BLOCKED AS EXPECTED" note on a dry run that stopped where it was
supposed to, or text already annotated inline as historical and superseded with the closing PRs named.

**One is archived on cited evidence** — the live-SQL-guard handoff Codex flagged. It stays archived
because its later disposition was found and is now cited in the archive README, which is the standard
this correction establishes.

**Four had genuinely open sections and no citable later closure. They were moved back to the live
folders:**

- `docs/audits/2026-07-18-codex-to-claude-phase1b-golive-blockers-handoff.md` — a `NOT LIVE` state
  row, two parks, and an open owner decision: "Mason must name the intended recipient."
- `docs/audits/2026-07-31-codex-to-claude-factory-publication-review-handoff.md` — a `## Not Started`
  section; publication is to remain blocked until the code passes proof after rebasing.
- `docs/handoffs/2026-08-05-section2-historical-report-remediation.md` — a `## NOT DONE` section.
- `docs/handoffs/2026-08-09-codex-migrations-and-merge.md` — `## Two open questions for Mason` and
  `## Open blockers` added after an exact-SHA review returned BLOCKED.

Two of those four contain unresolved questions addressed to Mason by name. Burying an owner decision
in an archive folder is the same harm as deleting the H2 worksheet, which is what started this whole
sequence.

### The standard going forward

Where a record's own text says work is open, archiving it requires **citing the later evidence that
closed it**. Absent that citation it stays in the live folder. Recorded in the archive README so the
next cleanup inherits the rule rather than rediscovering it.

Archived count for this batch: **18**, not 22. Records kept live as unfinished: **12**, not 8.

### Proof observed

- `git diff --name-status origin/main -- docs/archive/2026-summer-closeout/` reports 18 added paths.
- All 22 originally-moved files scanned for `NOT STARTED`, `NOT DONE`, `NOT LIVE`, `NEEDS MASON`,
  `OPEN P<n>`, `PARKED`, `BLOCKED`, `still open`, and `unfinished`; each of the 10 hits read in
  context before classifying it as incidental, closed-with-evidence, or genuinely open.
- `docs/changelog.d/2026-08-28-escape-string-scanner-maintenance-complete.md` exists and records the
  completion of the live-SQL-guard work.
- `npm run check:docs` passes.
