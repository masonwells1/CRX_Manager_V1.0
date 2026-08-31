# Archive — 2026 Summer Closeout (moved 2026-07-16)

Docs for work that is **fully shipped, merged, and live** (or reviews that are fully
dispositioned), moved out of the active folders during the 2026-07-16 full docs
review/cleanup so the live folders only contain in-flight work. Every "done" claim
was re-verified against code on disk and the live database before the move
(subagent verification pass, recorded in that day's `docs/CHANGELOG.md` entry).

⚠️ As with every archive folder: **verify current live behavior in code and the live
database before acting on anything in here.** Statuses inside these files are frozen
at their last edit and several were already stale at archive time (that's why they
were archived).

## What moved where

- **`loops/`** (from `docs/loops/`) — mission specs, morning reports, and ledgers for
  completed build loops: business-workflow fix nights 1–2, inventory Layer 2,
  mobile overhaul, UI overhaul, structure-fix Wave A, workflow-waves morning report,
  billing-day + money/inventory night mission docs.
  - Note: `structure-fix-ledger.md` contains the only record of the **deferred
    month-end-close picker UI** (A9) — that open item now lives in root `TODO.md` §4.
  - Kept live in `docs/loops/` (still cited by KNOWN_ISSUES/CHANGELOG/scripts):
    `owner-decisions-2026-07.md`, `business-workflow-fix-ledger.md`,
    `workflow-waves-ledger.md`, `billing-day-money-ledger.md`,
    `business-workflow-junk-customer-flags.md`, `structure-wave-2-*`,
    `workflow-waves-loop-2026-07.md`, `billing-day-money-loop-2026-07-08.md`.
- **`roadmap/`** (from `docs/roadmap/`) — plan/spec docs for shipped programs:
  sell-side G5 (execution plan, kickoff, go-live runbook), Inventory Layer 2 handoff,
  field mapping/per-acre billing trio, Field Mode build plan, app-wide structure
  audit, product-units scheduling deep-dive.
  - Note: the structure audit's **TIER-2 split-billing design decision** and the
    deep-dive's **Phase 4/5 scheduling leftovers** are still open — tracked in root
    `TODO.md` §4.
- **`plans/`** — the as-applied invoices plan (shipped 2026-06-21) and, kept live
  instead: the grower-portal vision docs (still the active vision) and
  `sprayer-packet-feature-todo.md` (still open).
- **`handoffs/`** — the Codex push-harness handoff (implemented, ACTIVE since 2026-07-14).
- **`audits/`** (from `docs/audits/`) — June 2–18 + early-July one-time review-cycle
  artifacts (Codex prompts, Claude dispositions, handoffs) whose findings are all
  dispositioned and whose fixes are all applied live. Anything still cited by
  `CLAUDE.md`, `docs/CHANGELOG.md`, `docs/reference/migration-history.md`,
  hooks, or scripts stayed in `docs/audits/`.

Related: the ChemMan-parity walkthrough research (`GAP-ANALYSIS.md` + extracted
transcripts) moved to `docs/archive/2026-summer/` alongside the rest of that program.

## Second batch — moved 2026-07-26

A follow-up sweep of `docs/build-loops/`, `docs/handoffs/`, and `docs/superpowers/`.
Only files that are both **finished** and **referenced by nothing else in the repo**
moved; every candidate was checked for inbound references (docs, scripts, hooks,
workflows, migrations) and for open owner decisions before being touched.

- **`build-loops/ui-overhaul/`, `build-loops/ui-overhaul-v2/`** (from
  `docs/build-loops/`) — both loops shipped live 2026-06-23/24 and were merged and
  deployed. Zero database changes in either.
  - Note: `ui-overhaul-v2/STATE.md` records one never-closed owner item — Mason's
    in-app click-test of the three write buttons (Convert / Complete / Receive)
    against real data. The features have been live since 2026-06-24.
- **`superpowers/plans/`, `superpowers/specs/`** (from `docs/superpowers/`) — the
  2026-06-14 design plan and spec for the Codex review gauntlet. The gauntlet was
  built; its live documentation is `docs/workflows/CODEX_REVIEW_GAUNTLET.md`.
- **`handoffs/`** — the 2026-07-16 scaffolding-review handoff (review delivered as
  `docs/audits/2026-07-16-scaffolding-design-review.md`) and the supplier-pricing
  Phase 1A goal (Phase 1A/1B closed out; Phase 3 Stage B2 shipped 2026-07-26).

Deliberately **kept live** in this sweep, with the reason:

- `docs/audits/nightly-debug/`, `docs/audits/overnight-bug-hunt/`,
  `docs/audits/codex-driven-bug-hunt/` — these are **live output paths** written by
  `.claude/workflows/` scripts, not finished artifacts.
- `docs/build-loops/b1-lot-capture-trace/` — its `HANDOFF.md` is the only record of
  a deferred `LotsEditorModal` save/close-race follow-up.
- `docs/build-loops/field-map-ux/` — holds a parked owner decision (the F2 auto-nudge).
- `docs/build-loops/field-acre-billing*/` — `PHASE0-GROUNDING.md` is cited by two
  applied migrations, which are immutable and cannot be repointed.
- `docs/audits/2026-06-19-future-projects-idea-mining/` — `UNIFIED-LONG-TERM-PLAN.md`
  is still the stated source of truth for future-project direction.
- `docs/plans/CRX-*label-data*.csv` — the label-data load is still an open owner
  data-entry job.

## Third batch — moved 2026-08-31

16 one-off audit and handoff records from `docs/audits/` and `docs/handoffs/`, dated late
July through August, moved during a full documentation cleanup. Contents were not altered
— only the paths changed.

⚠️ **This batch has a weaker verification basis than the two above, and the difference
matters.** The 2026-07-16 batch re-verified every "done" claim against code on disk *and
the live database*. This batch did not: each file was classified by reading its own text
and searching the repository for inbound references. No live-database check was performed
and none of these records' claims were re-proven. Do not attribute this batch to the
2026-07-16 live-verified pass.

**A record's own status line does not establish that it is closed, and this batch proves
it.** The rule started as "read what the file says about itself", which is better than the
revision before it — that one used "dated and orphaned, therefore closed", deleted 30
records, and was caught by Codex review; all 30 were restored and re-classified, and 8
stayed live because their own text says the work is unfinished.

But status-line reading is still not sufficient. A record can be *written* as open and
*closed later by other work*, and nothing in the file itself says so. Codex review of this
cleanup found `handoffs/2026-08-12-live-sql-guard-maintenance-build-to-review.md` archived
with a live `## NOT STARTED` section; its work was in fact completed later, evidenced only
by subsequent commits and
`docs/changelog.d/2026-08-28-escape-string-scanner-maintenance-complete.md`. It is archived
here **because that later disposition was found and cited**, not because its own status
said so.

### Full accounting of the 22 records originally moved

This took **two** audit passes, because the first one's pattern set was incomplete — it
omitted `NOT DONE`, `## Remaining`, `## Activation follow-ups`, and `## Also outstanding`,
and so missed four records. Codex review caught that. The numbers below are from the
corrected pass and are reproducible from the marker list at the end of this section.

**16 archived. 6 moved back to the live folders.**

Moved back — the record's open section states an obligation or decision that **still binds**:

| Record, now live at | Why |
|---|---|
| `docs/audits/2026-07-18-codex-to-claude-phase1b-golive-blockers-handoff.md` | `NOT LIVE` state row, two parks, and an open owner decision: "Mason must name the intended recipient." |
| `docs/audits/2026-07-31-codex-to-claude-factory-publication-review-handoff.md` | `## Not Started`; publication stays blocked until proof passes after rebasing. |
| `docs/audits/2026-07-14-offline-receipt-concurrency-interruption-proof.md` | The queued server contract must not be wired to driver phones until its stated conditions hold — a live activation gate. |
| `docs/handoffs/2026-08-05-section2-historical-report-remediation.md` | `## NOT DONE`. |
| `docs/handoffs/2026-08-09-codex-migrations-and-merge.md` | `## Two open questions for Mason` and `## Open blockers` added after an exact-SHA review returned BLOCKED. |
| `docs/handoffs/2026-07-30-push-guard-round23-codex-closeout.md` | `## Also outstanding` — a standing `--verify-remote` obligation after any `CRX_Backups` push. |

Archived **with the later disposition cited**, which is what the standard requires:

| Archived record | Closure evidence |
|---|---|
| `handoffs/2026-08-12-live-sql-guard-maintenance-build-to-review.md` (`## NOT STARTED`) | `docs/changelog.d/2026-08-28-escape-string-scanner-maintenance-complete.md` |
| `handoffs/2026-08-12-field-mode-reliability-gauntlet.md` (`## NOT DONE BY THIS OVERNIGHT CYCLE`) | `609968d6`, "fix: harden field mode async recovery (#391)", 2026-08-13 — the same commit that added this record. Its `NOT DONE` list scopes one overnight cycle, not the work. |
| `audits/2026-07-13-agent-pair-review-offline-stage1b-receipts.md` (`## Remaining approval gates`) | `docs/CHANGELOG.md`, 2026-07-14 entry: all three offline-receipt migrations applied live in order (Supabase stamps `20260714171331`, `20260714171800`, `20260714172135`), plus corrective `20260714203709`, each verified post-apply. The applied file `supabase/migrations/20260714171331_offline_action_receipts.sql` is on disk. **Not** the record's own `## Implementation follow-up — 2026-07-14` section: that section ends "The migration remains queued and unapplied live", so it closes nothing. |

The remaining archived records carried only **incidental** matches — `BLOCKED` inside a
verdict vocabulary (`COMPLETE`/`READY FOR APPROVAL`/`BLOCKED`/`PARTIAL`), a "BLOCKED AS
EXPECTED" note on a dry run that stopped where it should, or text already annotated inline
as historical and superseded with the closing PRs named.

**The standard for a future batch:** where a record's own text says work is open, archiving
it requires citing the later evidence that closed it. Absent that citation, it stays in the
live folder. Scan for at least these markers, as headings and inline: `NOT DONE`,
`NOT STARTED`, `NOT APPLIED`, `NOT LIVE`, `NEEDS MASON`, `OPEN P<n>`, `Still open`,
`Open blockers`, `Open questions`, `Remaining`, `Outstanding`, `Follow-ups`, `Awaiting`,
`Pending`. That list is written down because two passes here used narrower ones and both
missed records.

Full detail: `docs/changelog.d/2026-08-31-docs-cleanup-and-branch-inventory.md` and the
companion `2026-08-31-*` entries.
