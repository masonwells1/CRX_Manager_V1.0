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

### What the re-audit found — and why it took two passes

**The first re-audit pass was itself incomplete, and Codex caught that too.** Its marker list omitted
`NOT DONE`, `## Remaining`, `## Activation follow-ups`, and `## Also outstanding`, so it missed four
records — one of which (`2026-08-12-field-mode-reliability-gauntlet.md`) has a literal `## NOT DONE`
heading. Its summary also did not add up: five incidental records plus one archived-on-evidence plus
four moved back is ten, and the entry claimed six incidental. Both were reported, and both were
right.

Writing a stricter rule and then applying it with a narrower scan than the rule describes is the same
class of error as every other round here: the rule looked complete, and the thing that checked it
was not.

The corrected pass, run against the marker list now written into the archive README:

**Six moved back to the live folders** — the open section states an obligation or decision that still
binds:

- `docs/audits/2026-07-18-codex-to-claude-phase1b-golive-blockers-handoff.md` — a `NOT LIVE` state
  row, two parks, and an open owner decision: "Mason must name the intended recipient."
- `docs/audits/2026-07-31-codex-to-claude-factory-publication-review-handoff.md` — `## Not Started`;
  publication stays blocked until proof passes after rebasing.
- `docs/audits/2026-07-14-offline-receipt-concurrency-interruption-proof.md` — the queued server
  contract must not be wired to driver phones until its stated conditions hold. A live activation
  gate.
- `docs/handoffs/2026-08-05-section2-historical-report-remediation.md` — `## NOT DONE`.
- `docs/handoffs/2026-08-09-codex-migrations-and-merge.md` — `## Two open questions for Mason` and
  `## Open blockers` added after an exact-SHA review returned BLOCKED.
- `docs/handoffs/2026-07-30-push-guard-round23-codex-closeout.md` — `## Also outstanding`, a standing
  `--verify-remote` obligation after any `CRX_Backups` push.

**Three archived with their later disposition cited**, which is what the standard requires:

- `handoffs/2026-08-12-live-sql-guard-maintenance-build-to-review.md` (`## NOT STARTED`) →
  `docs/changelog.d/2026-08-28-escape-string-scanner-maintenance-complete.md`.
- `handoffs/2026-08-12-field-mode-reliability-gauntlet.md` (`## NOT DONE BY THIS OVERNIGHT CYCLE`) →
  `609968d6`, "fix: harden field mode async recovery (#391)", 2026-08-13 — the same commit that added
  the record. Its `NOT DONE` list scopes one overnight cycle, not the work.
- `audits/2026-07-13-agent-pair-review-offline-stage1b-receipts.md` (`## Remaining approval gates`) →
  the record's own `## Implementation follow-up — 2026-07-14` section.

The rest carried only incidental matches — `BLOCKED` inside a verdict vocabulary (`COMPLETE`, `READY
FOR APPROVAL`, `BLOCKED`, `PARTIAL`), a "BLOCKED AS EXPECTED" note on a dry run that stopped where it
should, or text already annotated inline as historical and superseded with the closing PRs named.

Two of the six moved back contain unresolved questions addressed to Mason by name. Burying an owner
decision in an archive folder is the same harm as deleting the H2 worksheet, which is what started
this whole sequence.

### The standard going forward

Where a record's own text says work is open, archiving it requires **citing the later evidence that
closed it**. Absent that citation it stays in the live folder. Recorded in the archive README so the
next cleanup inherits the rule rather than rediscovering it.

Archived count for this batch: **16**, not 22. Records kept live as unfinished: **14**, not 8.

### Proof observed

- `git diff --name-status origin/main -- docs/archive/2026-summer-closeout/` reports 16 added paths.
- All originally-moved files scanned twice. The corrected scan covers `NOT DONE`, `NOT STARTED`,
  `NOT APPLIED`, `NOT LIVE`, `NEEDS MASON`, `OPEN P<n>`, `Still open`, `Open blockers`,
  `Open questions`, `Remaining`, `Outstanding`, `Follow-ups`, `Awaiting`, and `Pending`, as headings
  and inline; every hit was read in context before classifying it as incidental,
  closed-with-evidence, or still binding.
- `609968d6` verified: dated 2026-08-13, titled "fix: harden field mode async recovery (#391)", and
  its diff touches `src/lib/offlineSync.ts`, `src/pages/FieldRoute.test.tsx`, and the gauntlet record
  itself.
- `docs/changelog.d/2026-08-28-escape-string-scanner-maintenance-complete.md` exists and records the
  completion of the live-SQL-guard work.
- `npm run check:docs` passes.
